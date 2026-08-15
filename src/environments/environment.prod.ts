/**
 * Production environment configuration.
 * Swapped in automatically by the `fileReplacements` rule in angular.json.
 *
 * The API key is a placeholder on purpose — `scripts/inject-gemini-key.mjs`
 * replaces it during the GitHub Actions build from the GEMINI_API_KEY repo
 * secret, so the real key never lands in git. Do not paste a key here.
 */
export const environment = {
  production: true,
  geminiApiKey: '__GEMINI_API_KEY__',
  // Keep in sync with environment.ts — see the note there on model availability.
  geminiModel: 'gemini-3.1-flash-lite',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  geminiTimeoutMs: 60_000,
  compression: {
    maxWidth: 1280,
    maxHeight: 1280,
    quality: 0.6,
    skipBelowBytes: 120 * 1024,
    maxFileBytes: 50 * 1024 * 1024
  }
};
