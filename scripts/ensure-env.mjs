/**
 * Creates `src/environments/environment.ts` from `environment.example.ts` when
 * it is missing.
 *
 * That file is gitignored so a personal API key can never be committed, but
 * angular.json's `fileReplacements` rule still needs it on disk for any build to
 * start. Wired up as `prestart` / `prebuild` so a fresh clone works with no
 * manual step.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const envDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/environments');
const target = resolve(envDir, 'environment.ts');

if (existsSync(target)) {
  process.exit(0);
}

copyFileSync(resolve(envDir, 'environment.example.ts'), target);
console.log(
  'Created src/environments/environment.ts from the example file.\n' +
    'Paste your Gemini API key into it before running the app locally.'
);
