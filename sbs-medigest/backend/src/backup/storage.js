// Stockage des sauvegardes HORS du serveur de base de données.
//   rclone:<remote>:<chemin>  — S3, Backblaze, SFTP, Google Drive… (identifiants dans la
//                                configuration rclone fournie par l'environnement, jamais dans le dépôt)
//   dir:<chemin>              — disque/NAS monté (doit être un stockage physiquement séparé ;
//                                refusé en production sans BACKUP_ALLOW_DIR_TARGET=true)
import fs from 'node:fs';
import path from 'node:path';
import { run } from './tools.js';

export function openStorage(target, { isProd = false, allowDir = false } = {}) {
  if (!target) throw new Error('BACKUP_TARGET non configuré');
  if (target.startsWith('dir:')) {
    if (isProd && !allowDir) throw new Error('Cible « dir: » refusée en production : utilisez rclone vers un stockage distant (ou BACKUP_ALLOW_DIR_TARGET=true pour un disque séparé monté)');
    return dirStorage(target.slice(4));
  }
  if (target.startsWith('rclone:')) return rcloneStorage(target.slice(7));
  throw new Error('BACKUP_TARGET doit commencer par « rclone: » ou « dir: »');
}

function dirStorage(root) {
  const abs = path.resolve(root);
  return {
    kind: 'dir',
    async put(local, name) {
      const dest = path.join(abs, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(local, `${dest}.partial`);
      fs.renameSync(`${dest}.partial`, dest);
      return fs.statSync(dest).size;
    },
    async get(name, local) { fs.copyFileSync(path.join(abs, name), local); },
    async size(name) { return fs.statSync(path.join(abs, name)).size; },
    async listSets() {
      if (!fs.existsSync(abs)) return [];
      return fs.readdirSync(abs).filter((n) => /^sbs-\d{8}-\d{6}$/.test(n) && fs.existsSync(path.join(abs, n, 'manifest.json'))).sort();
    },
    async removeSet(set) { fs.rmSync(path.join(abs, set), { recursive: true, force: true }); },
  };
}

function rcloneStorage(remote) {
  const base = remote.replace(/\/+$/, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('RCLONE_')));
  return {
    kind: 'rclone',
    async put(local, name) { await run('rclone', ['copyto', local, `${base}/${name}`], { env }); return this.size(name); },
    async get(name, local) { await run('rclone', ['copyto', `${base}/${name}`, local], { env }); },
    async size(name) {
      const chunks = []; const { Writable } = await import('node:stream');
      await run('rclone', ['lsjson', `${base}/${name}`], { env, stdout: new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }) });
      const list = JSON.parse(Buffer.concat(chunks).toString() || '[]');
      return list[0]?.Size ?? -1;
    },
    async listSets() {
      const chunks = []; const { Writable } = await import('node:stream');
      await run('rclone', ['lsjson', base, '--recursive', '--files-only'], { env, stdout: new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }) });
      const files = JSON.parse(Buffer.concat(chunks).toString() || '[]');
      return [...new Set(files.filter((f) => /^sbs-\d{8}-\d{6}\/manifest\.json$/.test(f.Path)).map((f) => f.Path.split('/')[0]))].sort();
    },
    async removeSet(set) { await run('rclone', ['purge', `${base}/${set}`], { env }); },
  };
}
