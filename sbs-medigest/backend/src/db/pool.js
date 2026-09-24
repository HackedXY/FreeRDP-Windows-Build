import pg from 'pg';
import { config } from '../config.js';

// BIGINT (montants) -> Number : les montants en GNF restent largement sous 2^53
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// NUMERIC -> Number
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE -> chaîne YYYY-MM-DD (évite les décalages de fuseau)
pg.types.setTypeParser(1082, (v) => v);

// jit=off : requêtes transactionnelles courtes ; la compilation JIT (déclenchée par des estimations
// pessimistes, ex. generate_series) coûtait plus que l'exécution elle-même (mesuré : 534 → 122 ms).
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 15, options: '-c jit=off' });

// Connexion « propriétaire du schéma » : migrations et initialisation uniquement.
// En production, ces identifiants ne sont PAS fournis au conteneur de l'application.
export const ownerPool = config.migrationDatabaseUrl && config.migrationDatabaseUrl !== config.databaseUrl
  ? new pg.Pool({ connectionString: config.migrationDatabaseUrl, max: 3 })
  : pool;

export function query(text, params) {
  return pool.query(text, params);
}

/** Exécute fn(client) dans une transaction. */
export function tx(fn) { return txOn(pool, fn); }
export function ownerTx(fn) { return txOn(ownerPool, fn); }

async function txOn(p, fn) {
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
