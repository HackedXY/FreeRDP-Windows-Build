// Justificatifs téléversés (reçus, factures) : inclus dans chaque sauvegarde et restaurés
// de façon vérifiable. L'archive est prise APRÈS le dump de la base : les justificatifs ne
// sont jamais supprimés, donc tout fichier référencé par la base sauvegardée est présent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encryptStreamToFile, decryptFile, sha256File } from './format.js';
import { spawnStream, run } from './tools.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  if (!fs.statSync(dir).isDirectory()) throw new Error('Le dossier des justificatifs n\'est pas un répertoire');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && SAFE_NAME.test(e.name) && !e.name.endsWith('.partial'))
    .map((e) => e.name).sort();
}

export function uploadsStep(uploadsDir) {
  return async ({ work, manifest, publicKeyPem }) => {
    const names = listFiles(uploadsDir);
    const files = [];
    for (const name of names) {
      const full = path.join(uploadsDir, name);
      files.push({ name, bytes: fs.statSync(full).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
    }
    const listFile = path.join(work, 'uploads.list');
    fs.writeFileSync(listFile, names.join('\n') + (names.length ? '\n' : ''), { mode: 0o600 });
    const tar = spawnStream('tar', ['-C', names.length ? uploadsDir : work, '--format=pax', '--numeric-owner', '--owner=0', '--group=0', '-cf', '-', '-T', listFile], {});
    const out = path.join(work, 'uploads.tar.sbsenc');
    let info;
    try {
      [info] = await Promise.all([encryptStreamToFile(tar.stdout, out, publicKeyPem), tar.done]);
    } catch (e) { tar.kill(); tar.done.catch(() => {}); throw new Error(`Archive des justificatifs impossible : ${e.message}`); }
    manifest.uploads = {
      file: 'uploads.tar.sbsenc', count: files.length, files,
      bytes_total: files.reduce((s, f) => s + f.bytes, 0),
      sha256_plain: info.sha256_plain, bytes_plain: info.bytes_plain,
      sha256_encrypted: await sha256File(out), bytes_encrypted: fs.statSync(out).size,
    };
  };
}

/** Restaure les justificatifs dans un dossier vide et vérifie chaque fichier. */
export async function restoreUploads({ storage, set, manifest, work, privateKey, uploadsDir }) {
  const u = manifest.uploads;
  if (fs.existsSync(uploadsDir) && fs.readdirSync(uploadsDir).length) throw new Error('Le dossier cible des justificatifs n\'est pas vide');
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o750 });
  const enc = path.join(work, u.file);
  await storage.get(`${set}/${u.file}`, enc);
  if ((await sha256File(enc)) !== u.sha256_encrypted) throw new Error('Empreinte de l\'archive des justificatifs incorrecte : fichier altéré ou incomplet');
  const tarPath = path.join(work, 'uploads.tar');
  const { sha256_plain } = await decryptFile(enc, tarPath, privateKey);
  if (sha256_plain !== u.sha256_plain) throw new Error('Empreinte de l\'archive déchiffrée incorrecte');
  // n'extraire que les noms attendus (pas de chemin, pas de lien)
  for (const f of u.files) if (!SAFE_NAME.test(f.name)) throw new Error(`Nom de fichier refusé dans l'archive : ${f.name}`);
  if (u.files.length) {
    await run('tar', ['-C', uploadsDir, '--no-same-owner', '--no-same-permissions', '-xf', tarPath, ...u.files.map((f) => f.name)]);
  }
  const present = fs.readdirSync(uploadsDir).sort();
  const expected = u.files.map((f) => f.name).sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) throw new Error('Contenu restauré différent du manifeste');
  for (const f of u.files) {
    const buf = fs.readFileSync(path.join(uploadsDir, f.name));
    if (buf.length !== f.bytes || crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) throw new Error(`Justificatif restauré altéré : ${f.name}`);
  }
  return { files: u.files.length, bytes: u.bytes_total, verified: true };
}
