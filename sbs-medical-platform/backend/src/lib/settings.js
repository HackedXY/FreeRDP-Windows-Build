import { query } from '../db/pool.js';
import { DEFAULT_SETTINGS } from './permissions.js';

let cache = null;

export async function getSettings() {
  if (cache) return cache;
  const { rows } = await query('SELECT key, value FROM settings');
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const { key, value } of rows) {
    s[key] = value && typeof value === 'object' && !Array.isArray(value) && s[key] && !Array.isArray(s[key])
      ? { ...s[key], ...value }
      : value;
  }
  cache = s;
  return s;
}

export function invalidateSettings() { cache = null; }
