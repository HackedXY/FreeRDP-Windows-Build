// Format de fichier chiffré des sauvegardes (« SBSBK1 ») :
//   MAGIC | longueur en-tête (uint32) | en-tête JSON | données AES-256-GCM | tag (16 o)
// Une clé de données aléatoire par fichier, enveloppée avec la clé PUBLIQUE RSA
// (OAEP-SHA256). Le serveur peut donc chiffrer mais jamais relire les sauvegardes :
// la clé privée reste hors ligne, chez le propriétaire. L'en-tête est authentifié (AAD).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';

const MAGIC = Buffer.from('SBSBK1\n');

export function keyFingerprint(key) {
  const pub = key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key);
  return crypto.createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function hashTap(hash) {
  return new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } });
}

/** Chiffre un flux vers un fichier. Retourne { sha256_plain, bytes_plain }. */
export async function encryptStreamToFile(input, outPath, publicKeyPem) {
  const pub = crypto.createPublicKey(publicKeyPem);
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({
    v: 1, alg: 'aes-256-gcm', wrap: 'rsa-oaep-sha256', key_fp: keyFingerprint(pub),
    wrapped_key: crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dataKey).toString('base64'),
    iv: iv.toString('base64'),
  }));
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  fs.writeFileSync(outPath, Buffer.concat([MAGIC, len, header]), { mode: 0o600 });
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(header);
  const plainHash = crypto.createHash('sha256');
  let bytes = 0;
  const count = new Transform({ transform(c, _e, cb) { bytes += c.length; cb(null, c); } });
  await pipeline(input, count, hashTap(plainHash), cipher, fs.createWriteStream(outPath, { flags: 'a' }));
  fs.appendFileSync(outPath, cipher.getAuthTag());
  dataKey.fill(0);
  return { sha256_plain: plainHash.digest('hex'), bytes_plain: bytes };
}

export function readHeader(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length + 4);
    fs.readSync(fd, head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Fichier de sauvegarde invalide (signature inconnue)');
    const len = head.readUInt32BE(MAGIC.length);
    if (len > 65536) throw new Error('En-tête de sauvegarde invalide');
    const header = Buffer.alloc(len);
    fs.readSync(fd, header, 0, len, head.length);
    return { header, meta: JSON.parse(header.toString()), dataStart: head.length + len };
  } finally { fs.closeSync(fd); }
}

/** Déchiffre et authentifie un fichier. Lève une erreur si la clé est mauvaise ou le fichier altéré. */
export async function decryptFile(inPath, outPath, privateKey) {
  const { header, meta, dataStart } = readHeader(inPath);
  const size = fs.statSync(inPath).size;
  if (size < dataStart + 16) throw new Error('Fichier de sauvegarde tronqué');
  const tag = Buffer.alloc(16);
  const fd = fs.openSync(inPath, 'r'); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
  let dataKey;
  try {
    dataKey = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(meta.wrapped_key, 'base64'));
  } catch { throw new Error('Clé privée de sauvegarde incorrecte pour ce fichier'); }
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(meta.iv, 'base64'));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const plainHash = crypto.createHash('sha256');
  try {
    const src = size - 16 > dataStart ? fs.createReadStream(inPath, { start: dataStart, end: size - 17 }) : Readable.from([]);
    await pipeline(src, decipher, hashTap(plainHash), fs.createWriteStream(outPath, { mode: 0o600 }));
  } catch {
    fs.rmSync(outPath, { force: true });
    throw new Error('Authentification du fichier de sauvegarde échouée : fichier altéré ou corrompu');
  } finally { dataKey.fill(0); }
  return { sha256_plain: plainHash.digest('hex') };
}

export async function sha256File(path) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(path), hashTap(h), new Transform({ transform(_c, _e, cb) { cb(); } }));
  return h.digest('hex');
}

export function loadPrivateKey(path, passphrase) {
  try { return crypto.createPrivateKey({ key: fs.readFileSync(path), passphrase }); }
  catch { throw new Error('Impossible de charger la clé privée (fichier ou phrase secrète incorrects)'); }
}
