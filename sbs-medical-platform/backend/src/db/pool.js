import pg from 'pg';
import { config } from '../config.js';

// BIGINT (montants) -> Number : les montants en GNF restent largement sous 2^53
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// NUMERIC -> Number
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE -> chaîne YYYY-MM-DD (évite les décalages de fuseau)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 15 });

export function query(text, params) {
  return pool.query(text, params);
}

/** Exécute fn(client) dans une transaction. */
export async function tx(fn) {
  const client = await pool.connect();
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
