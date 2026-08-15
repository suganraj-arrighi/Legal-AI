/**
 * Writes the Gemini API key into the production environment file just before
 * `ng build` runs in CI.
 *
 * Why this exists: `environment.prod.ts` is committed with the placeholder
 * `__GEMINI_API_KEY__` so the real key never enters git history. The GitHub
 * Actions runner checks out a throwaway copy of the repo, this script patches
 * that copy in place, and the copy is discarded when the job ends.
 *
 * ⚠️ The key still ends up inside the published JavaScript bundle — GitHub
 * Pages is static hosting, so there is nowhere else for it to live. Restrict
 * the key by HTTP referrer in Google Cloud Console to your Pages URL.
 *
 * Usage: GEMINI_API_KEY=... node scripts/inject-gemini-key.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PLACEHOLDER = '__GEMINI_API_KEY__';
const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/environments/environment.prod.ts'
);

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error(
    'GEMINI_API_KEY is not set.\n' +
      'In GitHub: Settings → Secrets and variables → Actions → New repository secret.'
  );
  process.exit(1);
}

const source = readFileSync(target, 'utf8');
if (!source.includes(PLACEHOLDER)) {
  // Either the key was already injected or someone edited the file by hand.
  // Failing loudly beats shipping a build with a stale or missing key.
  console.error(`Placeholder ${PLACEHOLDER} not found in ${target}.`);
  process.exit(1);
}

// JSON.stringify escapes any quote/backslash so a stray character in the secret
// cannot break out of the string literal.
writeFileSync(target, source.replace(`'${PLACEHOLDER}'`, JSON.stringify(key)), 'utf8');
console.log('Injected Gemini API key into environment.prod.ts');
