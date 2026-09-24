// Chargeur de test : transpile les fichiers .jsx à la volée avec esbuild (déjà fourni par Vite),
// pour tester les composants React sous `node --test` sans dépendance supplémentaire.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const { code } = await transform(source, { loader: 'jsx', jsx: 'automatic', format: 'esm', sourcefile: fileURLToPath(url) });
    return { format: 'module', source: code, shortCircuit: true };
  }
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return nextLoad(url, context);
}
