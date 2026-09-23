// Outils système (pg_dump, pg_restore, rclone, tar) lancés sans secret dans la
// ligne de commande : les identifiants passent par l'environnement du processus.
import { spawn } from 'node:child_process';

export function pgEnv(url) {
  const u = new URL(url);
  return {
    PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer',
  };
}

/** Lance une commande ; rejette avec un message expurgé (fin de stderr, sans variables d'environnement). */
export function run(cmd, args, { env = {}, stdin = null, stdout = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: process.env.TZ, ...env }, stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    if (stdout) child.stdout.pipe(stdout);
    if (stdin) stdin.pipe(child.stdin);
    child.on('error', (e) => reject(new Error(`${cmd} introuvable ou non exécutable (${e.code})`)));
    child.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`${cmd} a échoué (code ${code}) : ${sanitize(err)}`))));
  });
}

/** Retire d'un message d'erreur toute URL avec identifiants et les mots de passe éventuels. */
export function sanitize(msg) {
  return String(msg || '')
    .replace(/[a-z]+:\/\/[^\s@/]*:[^\s@/]*@/gi, '<url-masquée>@')
    .replace(/(password|passwd|secret|token|key)\s*[=:]\s*\S+/gi, '$1=<masqué>')
    .trim().slice(-500);
}

/** Démarre une commande et expose son flux de sortie (pour chiffrer à la volée). */
export function spawnStream(cmd, args, env) {
  const child = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`${cmd} introuvable (${e.code})`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} a échoué (code ${code}) : ${sanitize(err)}`))));
  });
  // en cas d'abandon (erreur en aval), le processus est arrêté pour ne rien laisser tourner
  return { stdout: child.stdout, done, kill: () => { if (child.exitCode === null) child.kill('SIGTERM'); } };
}
