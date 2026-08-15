# வழக்கறிஞர் வரைவு உதவியாளர் — Advocate Drafting Assistant

Dictate in Tamil, let Gemini work out **what kind of document you just dictated** — an RTI
application, a complaint to a department, an appeal, a legal notice, a request or a reminder —
and draft it in that form. Then edit it, attach compressed evidence, and export a PDF / ZIP,
or send it straight to a Gmail compose window. All from the browser.

---

## Quick start

```bash
npm install
npm start          # http://localhost:4200
```

Then open the app in **Google Chrome** or **Microsoft Edge** (Firefox and Safari do not
implement `webkitSpeechRecognition` — everything except the microphone still works there).

> **Node version:** Angular 18 officially supports Node 18 / 20 / 22. It builds fine on
> Node 24 but the CLI will print an "unsupported engine" warning. Use Node 22 LTS to
> silence it.

### Model

`geminiModel` is set to **`gemini-3.7-flash`**, verified against this key with a live call
(both text drafting and WAV audio transcription). Checked and rejected:

| Model | Result |
|---|---|
| `gemini-2.5-flash` | 404 — "no longer available to new users" for this key |
| `gemini-3.7-pro` | 404 — no such model |
| `gemini-pro-latest`, `gemini-3.1-pro-preview` | 429 — zero free-tier quota on this key |

To re-check what the key can reach:
`curl -H "x-goog-api-key: $KEY" https://generativelanguage.googleapis.com/v1beta/models`

Because 3.x models are thinking-capable, both response parsers filter out parts flagged
`thought: true`, and `maxOutputTokens` is 8192 so reasoning cannot starve the answer.

### API key

The Gemini key lives in `src/environments/environment.ts` (`geminiApiKey`). There is no UI
field for it, by design.

- `environment.ts` — used by `npm start` and `ng build --configuration development`.
  **Gitignored.** `npm start` / `npm run build` create it from `environment.example.ts` if it
  is missing (`scripts/ensure-env.mjs`); paste your key into it once and it stays local.
- `environment.example.ts` — the committed template. Never put a real key here.
- `environment.prod.ts` — swapped in for `ng build` (production). Committed with the
  placeholder `__GEMINI_API_KEY__`, which the deploy workflow replaces from the
  `GEMINI_API_KEY` repository secret (`scripts/inject-gemini-key.mjs`). A production build
  made without that step stops at the "key not configured" guard rather than 401-ing.

⚠️ The key is compiled into the browser bundle and is readable by anyone who loads the page.
Keeping it out of git does **not** keep it out of the deployed JavaScript — GitHub Pages is
static hosting, so there is nowhere else for it to live. Restrict the key in Google AI Studio
to the *Generative Language API* and to an HTTP referrer of your Pages URL, or move the
Gemini call behind a small server proxy.

---

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push to `main` (and on demand
from the Actions tab). One-time setup:

1. **Create the repo and push.**

   ```bash
   git init -b main
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```

   Check `git status` before that first commit: `src/environments/environment.ts` must **not**
   be listed. If it is, the gitignore entry is not taking effect and your key would be pushed.

2. **Add the key as a secret.** Repo → Settings → Secrets and variables → Actions → New
   repository secret, named `GEMINI_API_KEY`.

3. **Turn on Pages.** Repo → Settings → Pages → Source: **GitHub Actions** (not "Deploy from
   a branch").

The site lands at `https://<user>.github.io/<repo>/`. The workflow derives `--base-href` from
the repo name, so renaming the repo needs no config change. For a user site
(`<user>.github.io`) or a custom domain, drop the `--base-href` flag so it stays `/`.

### Notes

- The build output is `dist/advocate-rti-assistant/browser/` — the `browser/` subfolder is
  what Angular 18's application builder emits and what gets uploaded.
- A `.nojekyll` file is added at deploy time so GitHub does not strip files beginning with `_`.
- The app has no router, so no `404.html` SPA fallback is needed. Add one (a copy of
  `index.html`) if you later introduce routing.
- Speech recognition needs a secure context. Pages serves over HTTPS, so the microphone works
  in Chrome/Edge — the browser will prompt for permission on first use.

---

## Architecture

```
src/app/
├── app.component.ts/html/css        Shell: layout, step ordering, online/offline, "New petition"
├── app.config.ts                    Standalone providers: HttpClient, Quill config, global ErrorHandler
├── models/rti.models.ts             Every cross-boundary interface (Gemini wire format, attachments, toasts)
├── services/
│   ├── rti.service.ts               ← state + Gemini API (draft + transcribe) + JSON repair + text utils
│   ├── audio-recorder.service.ts    Web Audio capture → 16 kHz mono WAV (Gemini dictation)
│   └── toast.service.ts             Signal-backed toast queue
└── components/
    ├── voice-input/                 Step 1 — webkitSpeechRecognition, live interim text, mic animation
    ├── ai-formatter/                Step 2 — Gemini trigger, loading skeleton, inline error + retry
    ├── document-editor/             Step 3 — ngx-quill + subject line, two-way synced with the service
    ├── media-attachment/            Step 4 — drag & drop, Canvas compression, size table
    ├── export-actions/              Step 5 — html2pdf.js, jszip, mailto, clipboard + hidden PDF template
    └── toast-container/             Renders ToastService
```

**State** lives entirely in `RtiService` as Angular signals (`rawTranscript`, `subject`,
`contentHtml`, `attachments`, `aiStatus`, `exportJob`) with derived `computed` signals
(`isLoading`, `hasContent`, `canExport`, `plainText`). Every component is `OnPush` and reads
those signals directly — no `@Input`/`@Output` chains to keep in sync.

### Data flow

```
mic → VoiceInput ──(final chunks)──▶ rti.rawTranscript
                                          │
                        AiFormatter ──────┼──▶ POST Gemini ──▶ parse/repair JSON
                                          │                        │
                                          ▼                        ▼
                            rti.subject + rti.contentHtml ◀── {subject, improved_html}
                                          │
        DocumentEditor ◀──── two-way ─────┤
                                          │
        MediaAttachment ──(compressed)──▶ rti.attachments
                                          │
                            ExportActions ┴──▶ PDF · ZIP · Gmail compose
```

---

## The five steps

**1. Voice input** — two selectable engines, because the browser one is not always available:

- **நேரடி / Live** (`webkitSpeechRecognition`, `lang='ta-IN'`, `continuous`, `interimResults`).
  Finalised chunks are appended to the transcript; interim words render in grey italic with a
  blinking caret, Google-Assistant style. Chrome silently ends a session after a few seconds
  of quiet, so `onend` transparently restarts it after a 300 ms settle pause (restarting
  immediately inside `onend` is itself a common cause of spurious `network` errors), rate-limited
  to 8 restarts per 20 s.
  ⚠️ Chrome does *not* transcribe locally — it streams audio to Google's speech servers, so
  this mode dies behind office proxies with a `network` error even when the machine is online.
- **Gemini பதிவு / Record** (`AudioRecorderService` + `RtiService.transcribeAudio`). Captures
  raw PCM through the Web Audio graph, box-filter downsamples to **16 kHz mono** and writes a
  WAV header, then posts it as `inlineData` to the same Gemini endpoint Step 2 uses. No live
  interim text (transcription arrives when you stop), but it works wherever Step 2 works, and
  in browsers with no speech API at all. Capped at 3 min per recording, auto-stopping and
  transcribing; results are *appended*, so several recordings build one petition. A live
  RMS level halo around the mic gives feedback in place of the missing interim text.

  MediaRecorder is deliberately not used: Chrome only emits `audio/webm`, which is not one of
  the container formats Gemini documents for audio input (wav, mp3, aiff, aac, ogg, flac).

The app starts on Live and **switches to Gemini automatically** after three `network` failures.

**2. AI formatting** — sends the transcript with `DRAFT_SYSTEM_PROMPT` and
`responseMimeType: 'application/json'` at `temperature: 0.25`. The prompt's first job is
**classification**: the model returns a `doc_type` and drafts in the conventional Tamil form
for that type, and is explicitly barred from mentioning the RTI Act anywhere unless
`doc_type` is `rti`. The response is run through a four-strategy JSON repair chain (as-is →
strip ``` fences → slice `{`…`}` → normalise smart quotes and trailing commas) and then
HTML-sanitised before it reaches Quill.

### Document types

| `doc_type` | Heading printed | File prefix |
|---|---|---|
| `rti` | தகவல் அறியும் உரிமைச் சட்டம் - 2005 விண்ணப்பம் | `RTI-` |
| `complaint` | புகார் மனு | `Complaint-` |
| `appeal` | மேல்முறையீட்டு மனு | `Appeal-` |
| `legal_notice` | சட்ட அறிவிப்பு | `Legal-Notice-` |
| `request` | கோரிக்கை மனு | `Request-` |
| `reminder` | நினைவூட்டல் கடிதம் | `Reminder-` |
| `letter` | மனு | `Letter-` |

The catalogue lives in `DOCUMENT_KINDS` (`rti.service.ts`); the detected kind drives the PDF
heading, the English sub-heading, the `.txt` header and the export file name. The model may
also return its own `doc_title`, which wins over the generic heading for that draft.

An unrecognised `doc_type` degrades to `letter`, never to `rti` — mislabelling a complaint as
an RTI application is exactly the failure the classification exists to prevent. Step 3 has a
**ஆவண வகை / Document type** dropdown so the advocate can correct a wrong guess; it re-labels
the document (heading, file name) but does not rewrite the body, which would need another
Gemini call.

**3. Editor** — ngx-quill with a deliberately small toolbar. Service→control sync uses
`emitEvent: false`, control→service is debounced 150 ms; the two directions cannot loop.

**4. Attachments** — images are decoded with `createImageBitmap` (falling back to
`<img>` + object URL), contain-fitted into 1280×1280, painted onto a **white** background
(JPEG has no alpha, so PNGs would otherwise go black) and re-encoded at quality 0.6. Each
row shows `5.2 MB → 210 KB  −96%`. Non-images, SVG/GIF, already-small files, and files where
JPEG re-encoding would *grow* the result are stored untouched with a reason shown.

**5. Export** — `html2pdf.js` renders a hidden, print-styled A4 node (headed with the detected
document type) at 2× scale, after awaiting `document.fonts.ready` so Tamil glyphs are loaded.
`jszip` bundles the document `.txt` plus every attachment (duplicate filenames get `-2`, `-3`
suffixes). Both libraries are dynamically `import()`ed, so neither is in the initial bundle.

**Email** opens a Gmail compose tab — `https://mail.google.com/mail/?view=cm&fs=1&su=…` via
`window.open` from inside the click handler, so no popup blocker fires. A `mailto:` link was
the earlier approach, but it hands the draft to whatever the OS registered as the default mail
handler — on a machine with no mail client that is the browser itself, so nothing useful
opened. Gmail cannot be handed attachments by a link, so the PDF/ZIP is still attached by hand.

**The compose-URL length limit.** Gmail answers an over-long compose URL with a flat
`400 Bad Request`. The boundary was measured against Google's front end, not guessed — an
unauthenticated GET returns `302` (redirect to login) while the URL is acceptable and `400`
once it is not:

| URL length | Response |
|---|---|
| 8 057 | 302 — accepted |
| 8 264 | 400 — rejected |

That is the familiar ~8 KB request-line limit. Repeating the probe with an 8 KB dummy `Cookie`
header did not move the boundary, so the budget applies to the request line alone and a
signed-in user gets the same allowance. `MAX_COMPOSE_URL_LENGTH` is set to **7 800** for
margin.

Tamil spends that budget fast: each Tamil character is three UTF-8 bytes, and percent-encoding
turns every byte into three URL characters, so one dictated character costs **nine** — roughly
850 Tamil characters of document per link. Past that, `sendEmail()` copies the full text to
the clipboard and opens Gmail with **the subject only**, then toasts "Ctrl+V". Under it, the
body rides in the link and the message is ready to send.

---

## Error handling

| Failure | Handling |
|---|---|
| No `webkitSpeechRecognition` | Banner + toast naming Chrome/Edge; the manual textarea stays fully usable |
| Mic permission denied (`not-allowed`) | Persistent red banner with the exact padlock → Microphone → Allow steps |
| No microphone (`audio-capture`) | Toast, listening stops, fall back to typing |
| `no-speech` / `aborted` | Silent — `no-speech` fires on every thinking pause; the red "கேட்கிறது…" pill already shows the session is alive |
| Speech service drops (`network`) | Absorbed **silently** for 5 consecutive drops (the service stutters and self-recovers constantly) — only a quiet inline "reconnecting (n/5)" strip, which clears the moment results resume. On the 6th, auto-switch to the Gemini record engine + a persistent banner explaining the cause |
| Recording: permission / no device / device busy | `getUserMedia` `DOMException` names mapped to specific advice |
| Recording captured nothing | Warned, no API call made |
| Recording too long (> 12 MB) | Blocked before upload with a "record shorter segments" message; 3-min auto-stop makes this hard to hit |
| Gemini heard no speech | Warning toast, transcript untouched |
| Mic drops repeatedly | Auto-restart capped at 8 per 20 s, then stops with an explanation |
| Offline | `navigator.onLine` guard before the call + live header pill + online/offline toasts |
| Unconfigured API key | Guarded before the request, names the file to edit |
| HTTP 0 / 400 / 401 / 403 / 404 / 429 / 5xx | Each mapped to a specific Tamil + English message in `describeError()` |
| Model overloaded (503) or rate-limited (429) | Retried automatically up to 3× with exponential backoff (1.5 s → 3 s → 6 s + jitter). Steps 1 and 2 show a "Gemini is busy — retrying (n/4)" strip so the wait does not read as a hang. Non-transient statuses (0/400/401/403/404) are never retried |
| Request hangs | RxJS `timeout(60 s)` → "did not respond" message |
| Gemini returns markdown or prose | Four-strategy JSON repair in `parseLooseJson()` |
| JSON unrecoverable | Raw text is escaped into the editor as paragraphs + warning toast — never a crash |
| Safety block / empty candidate | Reported with the `blockReason` / `finishReason` |
| Empty transcript | AI button disabled + explanatory text next to it |
| Empty editor | All export buttons disabled + amber notice |
| Corrupt / undecodable image | `try/catch` → original file attached, warning toast naming the file |
| File > 50 MB or 0 bytes | Skipped with a toast; the rest of the batch continues |
| `canvas.toBlob()` returns null | Throws into the same fallback path |
| PDF / ZIP generation throws | Caught, toasted with the real message, `exportJob` reset in `finally` |
| Gmail body too long for a URL | Above 7 800 URL chars (~850 Tamil characters) the body is put on the clipboard and Gmail opens with the subject only — avoids Gmail's `400 Bad Request` |
| Clipboard blocked on that path | Falls back to a subject-only compose window with a warning naming the "உரையை நகலெடு" button |
| Gmail tab blocked by a popup blocker | `window.open` returning null is detected and explained, pointing at "உரையை நகலெடு" |
| Unrecognised `doc_type` from Gemini | Falls back to `letter` — never to `rti` |
| Clipboard blocked | Caught and explained |
| Anything uncaught | `GlobalErrorHandler` turns it into a toast instead of a frozen page |
| Accidental tab close | `beforeunload` prompt when there is unsaved work |

Loading is a single derived signal — `isLoading = aiStatus==='loading' || exportJob!=='none'`
— which drives the top progress bar, every spinner and every disabled state at once.

---

## Dependencies

| Package | Version | Why |
|---|---|---|
| `@angular/*` | ^18.2 | Standalone components, signals, built-in control flow |
| `ngx-quill` / `quill` | ^26.0.10 / ^2.0.2 | Rich text editor (26.x is the Angular 18 line) |
| `html2pdf.js` | ^0.10.2 | A4 PDF via html2canvas + jsPDF |
| `jszip` | ^3.10.1 | ZIP bundling |
| `tailwindcss` | ^3.4 | Styling |

---

## Known limits

- Live speech recognition is Chromium-only, needs `https://` or `localhost`, and needs
  Google's speech service to be reachable — use the Gemini record mode when it is not.
- Gemini dictation costs one API call per recording and has no live interim text.
- `gemini-3.7-flash` returns 503 "experiencing high demand" in bursts on the free tier. The
  automatic retry absorbs short spikes; a longer outage still surfaces an error, and the
  dictation is preserved so "மீண்டும் முயற்சி / Retry" costs nothing but the wait.
- The Gmail compose link cannot carry attachments — the PDF/ZIP must be attached by hand. It
  also assumes Gmail; there is no default-mail-client path any more.
- Documents past ~850 Tamil characters arrive via the clipboard rather than in the link (see
  above). Removing that paste step for long petitions would mean the Gmail API and an OAuth
  consent flow, which needs a backend this app deliberately does not have.
- Classification is a model judgement. It is shown in the Step 2 success panel and in the
  Step 3 dropdown so a wrong guess is visible and correctable, but changing the type there
  re-labels the document without rewriting the body.
- Tamil rendering in the PDF depends on the Noto fonts loading; offline, the first PDF may
  fall back to a system Tamil font.
- Attachments live in memory only; a refresh clears them (hence the `beforeunload` guard).
