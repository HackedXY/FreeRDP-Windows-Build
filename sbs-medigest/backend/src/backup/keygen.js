// Génère la paire de clés de sauvegarde (RSA 4096).
//   BACKUP_KEY_PASSPHRASE=… node src/backup/keygen.js --out ./secrets
// → backup-public.pem  : à installer sur le serveur (chiffrement seul)
// → backup-private.pem : chiffrée par la phrase secrète ; à conserver HORS du serveur
//                        (clé USB au coffre + copie papier de la phrase). Nécessaire pour restaurer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const i = process.argv.indexOf('--out');
const out = i > 0 ? process.argv[i + 1] : null;
const pass = process.env.BACKUP_KEY_PASSPHRASE;
if (!out || !pass || pass.length < 12) {
  console.error('Usage : BACKUP_KEY_PASSPHRASE=<au moins 12 caractères> node src/backup/keygen.js --out <dossier>');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const pub = path.join(out, 'backup-public.pem'); const priv = path.join(out, 'backup-private.pem');
if (fs.existsSync(pub) || fs.existsSync(priv)) { console.error('Des clés existent déjà dans ce dossier : abandon.'); process.exit(2); }
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass },
});
fs.writeFileSync(pub, publicKey, { mode: 0o644 });
fs.writeFileSync(priv, privateKey, { mode: 0o600 });
console.log(`Clés créées dans ${out}. Déplacez backup-private.pem hors du serveur.`);
