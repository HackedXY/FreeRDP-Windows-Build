/** Numérotation séquentielle par année : PREFIX-2026-000123 */
export async function nextNumber(client, key, prefix, { yearly = true, pad = 6 } = {}) {
  const year = yearly ? new Date().getFullYear() : 0;
  const { rows } = await client.query(
    `INSERT INTO counters (key, year, value) VALUES ($1, $2, 1)
     ON CONFLICT (key, year) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [key, year],
  );
  const n = String(rows[0].value).padStart(pad, '0');
  return yearly ? `${prefix}-${year}-${n}` : `${prefix}-${n}`;
}
