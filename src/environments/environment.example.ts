/**
 * Template for the local development environment file.
 *
 * `src/environments/environment.ts` is gitignored — that is where your personal
 * Gemini key lives, and keeping it untracked is the only reliable way to stop it
 * reaching GitHub. `scripts/ensure-env.mjs` copies this file into place on
 * `npm start` / `npm run build` if it is missing, so a fresh clone just works.
 *
 * Restrict the key in Google AI Studio / Cloud Console:
 *   - API restriction: "Generative Language API" only
 *   - HTTP referrer restriction: http://localhost:4200/* (and your Pages URL)
 */
export const environment = {
  production: false,

  /** Paste the Gemini API key here. Get one at https://aistudio.google.com/apikey */
  geminiApiKey: 'PASTE_YOUR_GEMINI_API_KEY_HERE',

  /**
   * Model id — verified against this key with ListModels + a live call.
   *
   * On the lite tier because the free-tier daily quota on `gemini-3.7-flash`
   * was running out mid-session (429). `gemini-3.5-flash-lite` was confirmed
   * working for both text drafting and inline WAV audio transcription in JSON
   * mode. If drafting quality drops noticeably, step back up to
   * `gemini-3.6-flash` or `gemini-3.7-flash` — both still work on this key.
   *
   * Known-bad: `gemini-3.7-pro` and `gemini-2.5-flash-lite` do not exist (404);
   * `gemini-2.5-flash` returns "no longer available to new users"; the pro tier
   * (`gemini-pro-latest`, `gemini-3.1-pro-preview`) has zero free-tier quota.
   */
  geminiModel: 'gemini-3.5-flash-lite',

  /** Base REST endpoint for the Generative Language API. */
  geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',

  /** Abort the Gemini call after this many milliseconds. */
  geminiTimeoutMs: 60_000,

  /** Image compression defaults (Step 3). */
  compression: {
    maxWidth: 1280,
    maxHeight: 1280,
    quality: 0.6,
    /** Files at or below this size are left untouched — nothing to gain. */
    skipBelowBytes: 120 * 1024,
    /** Hard cap on a single upload (50 MB) to avoid locking up the browser. */
    maxFileBytes: 50 * 1024 * 1024
  }
};
