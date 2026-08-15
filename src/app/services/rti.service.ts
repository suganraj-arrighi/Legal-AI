import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import {
  MonoTypeOperatorFunction,
  Observable,
  TimeoutError,
  catchError,
  from,
  map,
  retry,
  switchMap,
  throwError,
  timeout,
  timer
} from 'rxjs';

import { environment } from '../../environments/environment';
import {
  AiDraftResult,
  AiStatus,
  DocumentKind,
  DocumentKindMeta,
  ExportJob,
  GeminiRequest,
  GeminiResponse,
  RtiAttachment
} from '../models/rti.models';
import { ToastService } from './toast.service';

/**
 * The system prompt that turns spoken Tamil into a formal document.
 *
 * The important instruction is the classification step. The model must work out
 * what the advocate actually dictated — an RTI application, a complaint, an
 * appeal, a legal notice — and draft in that form. The earlier version of this
 * prompt hard-coded the RTI format, which pushed "தகவல் அறியும் உரிமைச் சட்டம்"
 * into the subject and body of letters that had nothing to do with the RTI Act.
 *
 * Kept as a module constant so it is easy to audit and tune in one place.
 */
export const DRAFT_SYSTEM_PROMPT = `You are an expert Tamil legal drafter working for an advocate in Tamil Nadu. You receive raw spoken Tamil dictation and turn it into a finished formal document.

STEP 1 — CLASSIFY. Read the dictation and decide what document the speaker actually wants. Choose exactly one doc_type:
- "rti": the speaker is asking a public authority to supply information or records. Only this type may reference the Right to Information Act, 2005.
- "complaint": the speaker is reporting a grievance, misconduct, negligence, encroachment or inaction and wants it remedied.
- "appeal": the speaker is challenging an order, a rejection, or a failure to reply to an earlier application.
- "legal_notice": the speaker is putting a party on notice before litigation, or demanding compliance within a stated period.
- "request": the speaker is asking an authority to sanction, permit, issue, transfer or otherwise do something (not asking for information).
- "reminder": the speaker is following up on an earlier letter or application that went unanswered.
- "letter": any other formal correspondence.
Never default to "rti". If the speaker never asks for information or records, it is not an RTI application.

STEP 2 — CORRECT. Fix grammar, spelling and speech-to-text errors. Preserve every name, place, date, number, section reference and amount exactly as dictated. Never invent facts, file numbers, dates or authorities that were not spoken; if a detail is clearly required but missing, leave a bracketed blank such as [தேதி] for the advocate to fill in.

STEP 3 — STRUCTURE in the conventional Tamil form for THAT type:
- rti: addressed to the பொது தகவல் அலுவலர், a short factual preamble, the information sought as a numbered <ol> list, then the RTI Act, 2005 fee and undertaking lines.
- complaint: addressee and their office, the facts in chronological order, the specific grievance, then the relief sought.
- appeal: addressee (appellate authority), reference to the original application or order with its date, the grounds of appeal as a numbered list, then the relief sought.
- legal_notice: addressee, the facts, the legal default, the specific demand, and the time allowed to comply.
- request / reminder / letter: addressee, purpose, supporting facts, then the specific action requested. For a reminder, reference the earlier letter and its date.

STEP 4 — LANGUAGE. Write in formal written Tamil. Do NOT mention "RTI", "தகவல் அறியும் உரிமை", "தகவல் அறியும் உரிமைச் சட்டம்", the RTI Act, or a Public Information Officer anywhere in doc_title, subject or improved_html unless doc_type is exactly "rti".

STEP 5 — OUTPUT. improved_html must be editor-safe HTML using only <p>, <ol>, <ul>, <li>, <strong>, <em>, <br>. No <html>, <body>, <script>, <style> or inline style attributes. doc_title is the short Tamil heading for the document (for example "மனு", "புகார் மனு", "மேல்முறையீட்டு மனு", "சட்ட அறிவிப்பு"). subject is one concise formal Tamil line naming the matter.

Respond with ONLY a valid JSON object, no markdown fence, no commentary:
{"doc_type":"rti|complaint|appeal|legal_notice|request|reminder|letter","doc_title":"Tamil heading","subject":"Tamil subject line","improved_html":"<p>...</p>"}`;

/**
 * Per-kind presentation: the heading printed on the PDF, the English line under
 * it, and the file-name prefix. `letter` doubles as the fallback for anything
 * the model returns that we do not recognise.
 */
export const DOCUMENT_KINDS: Record<DocumentKind, DocumentKindMeta> = {
  rti: {
    kind: 'rti',
    headingTa: 'தகவல் அறியும் உரிமைச் சட்டம் - 2005 விண்ணப்பம்',
    headingEn: 'Right to Information Act, 2005 — Application',
    filePrefix: 'RTI',
    label: 'RTI விண்ணப்பம் / RTI application'
  },
  complaint: {
    kind: 'complaint',
    headingTa: 'புகார் மனு',
    headingEn: 'Formal Complaint',
    filePrefix: 'Complaint',
    label: 'புகார் / Complaint'
  },
  appeal: {
    kind: 'appeal',
    headingTa: 'மேல்முறையீட்டு மனு',
    headingEn: 'Appeal',
    filePrefix: 'Appeal',
    label: 'மேல்முறையீடு / Appeal'
  },
  legal_notice: {
    kind: 'legal_notice',
    headingTa: 'சட்ட அறிவிப்பு',
    headingEn: 'Legal Notice',
    filePrefix: 'Legal-Notice',
    label: 'சட்ட அறிவிப்பு / Legal notice'
  },
  request: {
    kind: 'request',
    headingTa: 'கோரிக்கை மனு',
    headingEn: 'Representation / Request',
    filePrefix: 'Request',
    label: 'கோரிக்கை / Request'
  },
  reminder: {
    kind: 'reminder',
    headingTa: 'நினைவூட்டல் கடிதம்',
    headingEn: 'Reminder',
    filePrefix: 'Reminder',
    label: 'நினைவூட்டல் / Reminder'
  },
  letter: {
    kind: 'letter',
    headingTa: 'மனு',
    headingEn: 'Formal Letter',
    filePrefix: 'Letter',
    label: 'கடிதம் / Letter'
  }
};

/** Used before anything is drafted, and whenever doc_type is unrecognised. */
export const DEFAULT_DOCUMENT_KIND: DocumentKind = 'letter';

/**
 * Statuses worth retrying: the request was fine, the service just could not
 * take it right now. 503 in particular is routine on the free tier — the flash
 * models shed load under demand spikes and recover within seconds.
 *
 * Deliberately excludes 0 (offline/CORS), 400/401/403 (the key or the request
 * is wrong) and 404 (bad model id) — retrying those just wastes the advocate's
 * time on a failure that will never resolve itself.
 */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Attempts after the first before a transient failure is reported. */
export const MAX_TRANSIENT_RETRIES = 3;

/** First backoff step; doubles each attempt (1.5s → 3s → 6s, plus jitter). */
const RETRY_BASE_DELAY_MS = 1500;

/**
 * System prompt for the audio-dictation fallback (Step 1b).
 * Deliberately narrow: transcribe, do not interpret, do not translate.
 */
export const TRANSCRIPTION_SYSTEM_PROMPT = `You are a precise Tamil speech transcription engine. Transcribe the supplied audio verbatim into Tamil script (தமிழ்). Rules: 1. Output ONLY the transcription — no commentary, no translation, no romanisation, no markdown, no quotation marks. 2. Preserve legal terms, names, place names, numbers, dates and section references exactly as spoken. 3. Use standard Tamil spelling and normal sentence punctuation. 4. If a passage is inaudible, write [கேட்கவில்லை] in its place. 5. If the audio contains no discernible speech, output nothing at all.`;

/**
 * The kinds the advocate can pick from when correcting a misclassification,
 * in the order they appear in the dropdown.
 */
export const DOCUMENT_KIND_OPTIONS: readonly DocumentKindMeta[] = Object.values(DOCUMENT_KINDS);

/**
 * Centralised state + API layer.
 *
 * State is held in Angular signals so every component reads the same source of
 * truth and change detection stays cheap (all components are OnPush).
 */
@Injectable({ providedIn: 'root' })
export class RtiService {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);

  /* ---------------------------------------------------------------- *
   *  Writable state
   * ---------------------------------------------------------------- */

  /** Step 1 — raw dictation, finalised chunks only (no interim text). */
  private readonly _rawTranscript = signal<string>('');
  readonly rawTranscript = this._rawTranscript.asReadonly();

  /** Step 2/3 — the formal subject line. */
  private readonly _subject = signal<string>('');
  readonly subject = this._subject.asReadonly();

  /** Step 2 — what Gemini decided this document is (drives every heading). */
  private readonly _docKind = signal<DocumentKind>(DEFAULT_DOCUMENT_KIND);
  readonly docKind = this._docKind.asReadonly();

  /**
   * The Tamil heading Gemini chose for this specific document. Empty until a
   * draft lands, at which point it wins over the kind's generic heading.
   */
  private readonly _docTitle = signal<string>('');
  readonly docTitle = this._docTitle.asReadonly();

  /** Step 3 — petition body as HTML (bound to the Quill editor). */
  private readonly _contentHtml = signal<string>('');
  readonly contentHtml = this._contentHtml.asReadonly();

  /** Step 4 — compressed attachments. */
  private readonly _attachments = signal<RtiAttachment[]>([]);
  readonly attachments = this._attachments.asReadonly();

  /** Lifecycle of the Gemini call. */
  private readonly _aiStatus = signal<AiStatus>('idle');
  readonly aiStatus = this._aiStatus.asReadonly();

  /** Which export job is running, so we can disable the other buttons. */
  private readonly _exportJob = signal<ExportJob>('none');
  readonly exportJob = this._exportJob.asReadonly();

  /** Last error message shown inline (in addition to the toast). */
  private readonly _lastError = signal<string | null>(null);
  readonly lastError = this._lastError.asReadonly();

  /** True while a dictated recording is being transcribed by Gemini. */
  private readonly _transcribing = signal(false);
  readonly transcribing = this._transcribing.asReadonly();

  /**
   * Which automatic retry is in flight (0 = none). Drives the "Gemini is busy,
   * retrying…" strip so a slow call does not look like a hung one.
   */
  private readonly _retryAttempt = signal(0);
  readonly retryAttempt = this._retryAttempt.asReadonly();

  /** Total attempts the UI can advertise, e.g. "முயற்சி 2/4". */
  readonly maxAttempts = MAX_TRANSIENT_RETRIES + 1;

  /* ---------------------------------------------------------------- *
   *  Derived state
   * ---------------------------------------------------------------- */

  /** Global busy flag — drives spinners and the disabled state of buttons. */
  readonly isLoading = computed(
    () => this._aiStatus() === 'loading' || this._exportJob() !== 'none' || this._transcribing()
  );

  /** Enough dictated text to be worth sending to Gemini? */
  readonly hasTranscript = computed(() => this._rawTranscript().trim().length > 0);

  /** Presentation metadata (heading, file prefix, badge label) for the kind. */
  readonly docMeta = computed<DocumentKindMeta>(
    () => DOCUMENT_KINDS[this._docKind()] ?? DOCUMENT_KINDS[DEFAULT_DOCUMENT_KIND]
  );

  /** Tamil heading for the PDF/TXT — the model's own title when it gave one. */
  readonly docHeading = computed(() => this._docTitle().trim() || this.docMeta().headingTa);

  /** English line printed under the Tamil heading on the PDF. */
  readonly docHeadingEn = computed(() => this.docMeta().headingEn);

  /** Plain-text projection of the editor HTML (used for TXT/mailto/validation). */
  readonly plainText = computed(() => this.htmlToPlainText(this._contentHtml()));

  /** The editor genuinely has content (Quill leaves `<p><br></p>` behind when empty). */
  readonly hasContent = computed(() => this.plainText().trim().length > 0);

  /** Export buttons are only live when there is something to export. */
  readonly canExport = computed(() => this.hasContent() && !this.isLoading());

  readonly attachmentCount = computed(() => this._attachments().length);

  /** Total exported bytes across all attachments — shown in the UI. */
  readonly totalCompressedSize = computed(() =>
    this._attachments().reduce((sum, a) => sum + a.compressedSize, 0)
  );

  readonly totalOriginalSize = computed(() =>
    this._attachments().reduce((sum, a) => sum + a.originalSize, 0)
  );

  /* ---------------------------------------------------------------- *
   *  Mutations
   * ---------------------------------------------------------------- */

  /** Append a finalised speech chunk, keeping spacing sane. */
  appendTranscript(chunk: string): void {
    const clean = chunk.trim();
    if (!clean) {
      return;
    }
    this._rawTranscript.update((prev) => (prev ? `${prev.trimEnd()} ${clean}` : clean));
  }

  setTranscript(value: string): void {
    this._rawTranscript.set(value);
  }

  clearTranscript(): void {
    this._rawTranscript.set('');
  }

  setSubject(value: string): void {
    this._subject.set(value);
  }

  setContentHtml(value: string): void {
    // Quill hands back `null` when the editor is emptied.
    this._contentHtml.set(value ?? '');
  }

  setAttachments(files: RtiAttachment[]): void {
    this._attachments.set(files);
  }

  addAttachments(files: RtiAttachment[]): void {
    this._attachments.update((prev) => [...prev, ...files]);
  }

  removeAttachment(id: string): void {
    this._attachments.update((prev) => {
      const target = prev.find((a) => a.id === id);
      // Release the object URL so long sessions don't leak blob memory.
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  }

  clearAttachments(): void {
    this._attachments().forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    this._attachments.set([]);
  }

  setExportJob(job: ExportJob): void {
    this._exportJob.set(job);
  }

  /** Reset everything — used by the "புதிய மனு" (new petition) button. */
  resetAll(): void {
    this.clearAttachments();
    this._rawTranscript.set('');
    this._subject.set('');
    this._docKind.set(DEFAULT_DOCUMENT_KIND);
    this._docTitle.set('');
    this._contentHtml.set('');
    this._aiStatus.set('idle');
    this._lastError.set(null);
    this._exportJob.set('none');
  }

  /* ---------------------------------------------------------------- *
   *  Step 2 — Gemini formatting
   * ---------------------------------------------------------------- */

  /**
   * Sends the raw dictation to Gemini 2.5 Flash and returns the parsed draft.
   *
   * The observable emits exactly once and never leaks a raw HttpErrorResponse —
   * subscribers always receive an `Error` carrying a Tamil+English message that
   * is safe to show on screen.
   */
  formatWithGemini(rawText?: string): Observable<AiDraftResult> {
    const input = (rawText ?? this._rawTranscript()).trim();

    // --- Guard 1: empty input (the UI also disables the button) -------------
    if (!input) {
      const msg = 'உரை காலியாக உள்ளது. முதலில் பேசவும் அல்லது தட்டச்சு செய்யவும். (No input text.)';
      this.fail(msg);
      return throwError(() => new Error(msg));
    }

    // --- Guards 2 & 3: API key configured + browser reports a network -------
    const preflight = this.preflightError();
    if (preflight) {
      this.fail(preflight);
      return throwError(() => new Error(preflight));
    }

    const url = `${environment.geminiBaseUrl}/${environment.geminiModel}:generateContent`;

    const body: GeminiRequest = {
      systemInstruction: { parts: [{ text: DRAFT_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      generationConfig: {
        temperature: 0.25, // low temperature: legal drafting should be predictable
        topP: 0.9,
        // Generous, because thinking-capable models spend part of this budget
        // on reasoning — too low and the answer is truncated to nothing with
        // finishReason MAX_TOKENS.
        maxOutputTokens: 8192,
        // JSON mode. Gemini still occasionally wraps output in ``` fences,
        // which is why extractDraft() below defends against that anyway.
        responseMimeType: 'application/json'
      }
    };

    this._aiStatus.set('loading');
    this._lastError.set(null);

    return this.http
      .post<GeminiResponse>(url, body, {
        headers: {
          'Content-Type': 'application/json',
          // Header auth avoids leaking the key into browser/server URL logs.
          'x-goog-api-key': environment.geminiApiKey
        }
      })
      .pipe(
        timeout(environment.geminiTimeoutMs),
        this.retryTransient(),
        map((response) => {
          const draft = this.extractDraft(response);
          this._retryAttempt.set(0);
          this._aiStatus.set('success');
          return draft;
        }),
        catchError((err: unknown) => {
          const message = this.describeError(err);
          this.fail(message);
          return throwError(() => new Error(message));
        })
      );
  }

  /** Push a successful draft into the editor-bound state. */
  applyDraft(draft: AiDraftResult): void {
    this._docKind.set(draft.doc_type);
    this._docTitle.set(draft.doc_title.trim());
    this._subject.set(draft.subject.trim());
    this._contentHtml.set(draft.improved_html);
  }

  /** Manual override — the advocate can correct a misclassified document. */
  setDocKind(kind: DocumentKind): void {
    this._docKind.set(kind);
    // Drop the model's bespoke title so the newly chosen kind's heading shows.
    this._docTitle.set('');
  }

  /* ---------------------------------------------------------------- *
   *  Step 1b — Gemini audio dictation (fallback for a blocked or
   *  unavailable browser speech service)
   * ---------------------------------------------------------------- */

  /**
   * Transcribe recorded audio to Tamil text via Gemini.
   *
   * Unlike `webkitSpeechRecognition` this never touches Google's speech
   * service — it reuses exactly the endpoint, key and network route that
   * Step 2 already uses, so it works wherever the AI formatting works.
   *
   * @param audio  a WAV/MP3/OGG/FLAC blob from AudioRecorderService
   */
  transcribeAudio(audio: Blob): Observable<string> {
    // --- Guard 1: nothing recorded ------------------------------------------
    if (!audio || audio.size === 0) {
      const msg = 'ஒலிப்பதிவு காலியாக உள்ளது. (The recording was empty.)';
      this.failTranscription(msg);
      return throwError(() => new Error(msg));
    }

    // --- Guard 2: request size. Inline data must stay well under the 20 MB
    //     total request limit, and base64 inflates the payload by ~33 %.
    const maxAudioBytes = 12 * 1024 * 1024;
    if (audio.size > maxAudioBytes) {
      const msg = `ஒலிப்பதிவு மிக நீளமானது (${this.formatBytes(audio.size)}). குறுகிய பகுதிகளாகப் பதிவு செய்யவும். (Recording too long — record in shorter segments.)`;
      this.failTranscription(msg);
      return throwError(() => new Error(msg));
    }

    // --- Guards 3 & 4: key + connectivity (shared with formatWithGemini) ----
    const preflight = this.preflightError();
    if (preflight) {
      this.failTranscription(preflight);
      return throwError(() => new Error(preflight));
    }

    this._transcribing.set(true);
    this._lastError.set(null);

    const url = `${environment.geminiBaseUrl}/${environment.geminiModel}:generateContent`;

    // Base64-encode off the main thread via FileReader — spreading a multi-MB
    // Uint8Array into btoa() blows the call stack.
    return from(this.blobToBase64(audio)).pipe(
      switchMap((base64) => {
        const body: GeminiRequest = {
          systemInstruction: { parts: [{ text: TRANSCRIPTION_SYSTEM_PROMPT }] },
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'Transcribe this Tamil dictation verbatim into Tamil script.' },
                { inlineData: { mimeType: audio.type || 'audio/wav', data: base64 } }
              ]
            }
          ],
          generationConfig: {
            temperature: 0, // transcription must not be creative
            maxOutputTokens: 8192
            // No responseMimeType — we want plain text back, not JSON.
          }
        };

        return this.http.post<GeminiResponse>(url, body, {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': environment.geminiApiKey
          }
        });
      }),
      timeout(environment.geminiTimeoutMs),
      this.retryTransient(),
      map((response) => {
        const text = this.extractPlainText(response);
        this._retryAttempt.set(0);
        this._transcribing.set(false);
        return text;
      }),
      catchError((err: unknown) => {
        const message = this.describeError(err);
        this.failTranscription(message);
        return throwError(() => new Error(message));
      })
    );
  }

  /** Read a Blob as a bare base64 string (no `data:` prefix). */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader returned a non-string result'));
          return;
        }
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error('ஒலிக் கோப்பைப் படிக்க முடியவில்லை (could not read the audio)'));
      reader.readAsDataURL(blob);
    });
  }

  /** Pull plain text out of a Gemini response (transcription path). */
  private extractPlainText(response: GeminiResponse): string {
    if (response?.error) {
      throw new Error(`Gemini பிழை: ${response.error.message} (${response.error.status})`);
    }
    if (response?.promptFeedback?.blockReason) {
      throw new Error(`ஒலிப்பதிவு Gemini-ஆல் தடுக்கப்பட்டது (${response.promptFeedback.blockReason}).`);
    }

    const candidate = response?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p?.thought !== true) // drop reasoning parts (Gemini 3.x)
      .map((p) => p?.text ?? '')
      .join('')
      .trim();

    // A silent recording legitimately produces no text — the caller decides
    // whether that is worth an error, so return '' rather than throwing.
    return text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  }

  /** Shared key/connectivity preflight for every Gemini call. */
  private preflightError(): string | null {
    // `__GEMINI_API_KEY__` means a production build shipped without the CI
    // secret being injected — surface it as "not configured" rather than a 401.
    const key = environment.geminiApiKey;
    if (!key || key.startsWith('PASTE_YOUR') || key === '__GEMINI_API_KEY__') {
      return 'Gemini API விசை அமைக்கப்படவில்லை. src/environments/environment.ts கோப்பில் விசையைச் சேர்க்கவும். (Gemini API key not configured.)';
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 'இணைய இணைப்பு இல்லை. இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும். (You appear to be offline.)';
    }
    return null;
  }

  /** Failure funnel for the transcription path. */
  private failTranscription(message: string): void {
    this._retryAttempt.set(0);
    this._transcribing.set(false);
    this._lastError.set(message);
    this.toast.error('ஒலி எழுத்தாக்கம் தோல்வி', message);
  }

  /* ---------------------------------------------------------------- *
   *  Response parsing (Requirement: strict JSON error handling)
   * ---------------------------------------------------------------- */

  /**
   * Pull the JSON payload out of a Gemini response, tolerating the common
   * failure modes:
   *   - markdown fences  ```json ... ```
   *   - leading/trailing prose around the object
   *   - smart quotes / stray trailing commas
   */
  private extractDraft(response: GeminiResponse): AiDraftResult {
    // The API can return 200 with an error envelope or a safety block.
    if (response?.error) {
      throw new Error(
        `Gemini பிழை: ${response.error.message} (${response.error.status})`
      );
    }
    if (response?.promptFeedback?.blockReason) {
      throw new Error(
        `உள்ளடக்கம் Gemini-ஆல் தடுக்கப்பட்டது (${response.promptFeedback.blockReason}). உரையை மாற்றி மீண்டும் முயற்சிக்கவும்.`
      );
    }

    const candidate = response?.candidates?.[0];
    // Thinking-capable models (Gemini 3.x) interleave reasoning parts — those
    // carry `thought: true` and must never reach the editor.
    const rawText = (candidate?.content?.parts ?? [])
      .filter((p) => p?.thought !== true)
      .map((p) => p?.text ?? '')
      .join('')
      .trim();

    if (!rawText) {
      const reason = candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : '';
      throw new Error(
        `Gemini-இலிருந்து வெற்று பதில் வந்தது${reason}. மீண்டும் முயற்சிக்கவும். (Empty response from Gemini.)`
      );
    }

    const parsed = this.parseLooseJson(rawText);

    if (!parsed) {
      // Salvage path: we could not get JSON, but we do have text. Rather than
      // crashing, surface the raw text as an editable paragraph and warn.
      this.toast.warning(
        'AI பதிலை JSON ஆக மாற்ற முடியவில்லை',
        'Raw text was recovered into the editor — please review it carefully.'
      );
      return {
        doc_type: DEFAULT_DOCUMENT_KIND,
        doc_title: '',
        subject: '',
        improved_html: `<p>${this.escapeHtml(rawText).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`
      };
    }

    const subject = typeof parsed['subject'] === 'string' ? (parsed['subject'] as string) : '';
    const html =
      typeof parsed['improved_html'] === 'string' ? (parsed['improved_html'] as string) : '';

    if (!html.trim()) {
      throw new Error(
        'AI பதிலில் "improved_html" புலம் இல்லை. மீண்டும் முயற்சிக்கவும். (Malformed AI response: missing improved_html.)'
      );
    }

    return {
      doc_type: this.toDocumentKind(parsed['doc_type']),
      doc_title: typeof parsed['doc_title'] === 'string' ? (parsed['doc_title'] as string) : '',
      subject,
      improved_html: this.sanitizeHtml(html)
    };
  }

  /**
   * Narrow whatever the model put in `doc_type` to a kind we know about.
   *
   * An unrecognised value degrades to a neutral formal letter rather than to
   * RTI — mislabelling a complaint as an RTI application is the exact failure
   * this classification was added to prevent.
   */
  private toDocumentKind(value: unknown): DocumentKind {
    if (typeof value !== 'string') {
      return DEFAULT_DOCUMENT_KIND;
    }
    const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return key in DOCUMENT_KINDS ? (key as DocumentKind) : DEFAULT_DOCUMENT_KIND;
  }

  /**
   * Best-effort JSON parse. Returns null when every strategy fails.
   * Deliberately does NOT throw — the caller decides how to degrade.
   */
  private parseLooseJson(input: string): Record<string, unknown> | null {
    const attempts: string[] = [];

    // 1. As-is.
    attempts.push(input);

    // 2. Strip markdown code fences: ```json ... ``` or ``` ... ```
    const fenced = input.replace(/^\s*```(?:json|JSON)?\s*/m, '').replace(/```\s*$/m, '');
    attempts.push(fenced.trim());

    // 3. Slice from the first "{" to the last "}" (drops surrounding prose).
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start !== -1 && end > start) {
      attempts.push(fenced.slice(start, end + 1));
    }

    // 4. Same slice, with smart quotes normalised and trailing commas removed.
    if (start !== -1 && end > start) {
      const repaired = fenced
        .slice(start, end + 1)
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, '$1');
      attempts.push(repaired);
    }

    for (const attempt of attempts) {
      if (!attempt) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(attempt);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      } catch {
        // Try the next repair strategy.
      }
    }
    return null;
  }

  /**
   * Remove anything executable before the HTML reaches Quill.
   * Quill itself normalises unknown tags, but a stray <script> in a copy/paste
   * path should never get near the DOM.
   */
  sanitizeHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    doc.body.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((el) =>
      el.remove()
    );

    doc.body.querySelectorAll('*').forEach((el) => {
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || (name === 'href' && value.startsWith('javascript:'))) {
          el.removeAttribute(attr.name);
        }
      });
    });

    return doc.body.innerHTML;
  }

  /* ---------------------------------------------------------------- *
   *  Error helpers
   * ---------------------------------------------------------------- */

  /**
   * Retry transient Gemini failures with exponential backoff.
   *
   * A 503 ("this model is currently experiencing high demand") is the common
   * one and it usually clears in a couple of seconds, so failing the whole
   * draft on the first one would throw away a perfectly good dictation. Any
   * non-transient error is rethrown immediately without burning an attempt.
   *
   * Placed downstream of `timeout()` so each attempt gets its own full timeout
   * budget rather than sharing one across all four.
   */
  private retryTransient<T>(): MonoTypeOperatorFunction<T> {
    return retry({
      count: MAX_TRANSIENT_RETRIES,
      delay: (error: unknown, attempt: number) => {
        if (!(error instanceof HttpErrorResponse) || !TRANSIENT_STATUSES.has(error.status)) {
          return throwError(() => error);
        }
        this._retryAttempt.set(attempt);
        // Jitter keeps repeated failures from re-colliding in lockstep.
        const wait = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 400;
        return timer(wait);
      }
    });
  }

  /** Record + surface a failure in one place. */
  private fail(message: string): void {
    this._retryAttempt.set(0);
    this._aiStatus.set('error');
    this._lastError.set(message);
    this.toast.error('AI வடிவமைப்பு தோல்வி', message);
  }

  /**
   * "Tried n times already" — so a transient-failure message does not read as
   * though nothing was attempted. Empty when no retry actually ran.
   */
  private retriedSuffix(): string {
    const attempts = this._retryAttempt();
    return attempts > 0 ? `(${attempts + 1} முறை முயற்சிக்கப்பட்டது / tried ${attempts + 1}×.)` : '';
  }

  /** Translate any thrown value into a message worth showing the advocate. */
  private describeError(err: unknown): string {
    if (err instanceof TimeoutError) {
      return `Gemini ${Math.round(environment.geminiTimeoutMs / 1000)} வினாடிகளுக்குள் பதிலளிக்கவில்லை. மீண்டும் முயற்சிக்கவும். (Request timed out.)`;
    }

    if (err instanceof HttpErrorResponse) {
      const apiMessage =
        (err.error as GeminiResponse | undefined)?.error?.message ?? err.message ?? '';

      switch (err.status) {
        case 0:
          return 'நெட்வொர்க் பிழை — Gemini சேவையை அணுக முடியவில்லை. இணைய இணைப்பு / firewall ஐச் சரிபார்க்கவும். (Network error or CORS/offline.)';
        case 400:
          return `கோரிக்கை தவறானது அல்லது API விசை செல்லாது. (400 Bad Request) ${apiMessage}`;
        case 401:
        case 403:
          return `API விசை நிராகரிக்கப்பட்டது. விசையையும் அதன் கட்டுப்பாடுகளையும் சரிபார்க்கவும். (${err.status} Forbidden) ${apiMessage}`;
        case 404:
          return `மாதிரி "${environment.geminiModel}" கிடைக்கவில்லை. (404 Model not found.)`;
        // 429 and 5xx have already been retried MAX_TRANSIENT_RETRIES times by
        // the time they land here, so the advice is "wait", not "try again".
        case 429:
          return `மிக அதிக கோரிக்கைகள். ${this.retriedSuffix()} ஒரு நிமிடம் கழித்து மீண்டும் முயற்சிக்கவும். (429 Rate limit exceeded.)`;
        case 500:
        case 502:
        case 504:
          return `Gemini சேவையகத்தில் தற்காலிக கோளாறு. ${this.retriedSuffix()} சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும். (Gemini server error.)`;
        case 503:
          return `Gemini மாதிரி "${environment.geminiModel}" தற்போது அதிக பயன்பாட்டில் உள்ளது. ${this.retriedSuffix()} உங்கள் உரை அப்படியே உள்ளது — ஒரு நிமிடம் கழித்து "மீண்டும் முயற்சி" ஐ அழுத்தவும். (503 Model overloaded — your dictation is safe, retry shortly.)`;
        default:
          return `எதிர்பாராத பிழை (HTTP ${err.status}). ${apiMessage}`;
      }
    }

    if (err instanceof Error) {
      return err.message;
    }
    return 'எதிர்பாராத பிழை ஏற்பட்டது. (An unexpected error occurred.)';
  }

  /* ---------------------------------------------------------------- *
   *  Text utilities (shared by PDF / ZIP / mailto)
   * ---------------------------------------------------------------- */

  /**
   * Convert editor HTML into readable plain text:
   *  - <li> inside <ol> becomes "1. ", inside <ul> becomes "• "
   *  - block elements become newlines
   */
  htmlToPlainText(html: string): string {
    if (!html) {
      return '';
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');

    doc.body.querySelectorAll('ol').forEach((ol) => {
      [...ol.children].forEach((li, i) => {
        if (li.tagName === 'LI') {
          li.textContent = `${i + 1}. ${li.textContent ?? ''}`;
        }
      });
    });

    doc.body.querySelectorAll('ul > li').forEach((li) => {
      li.textContent = `• ${li.textContent ?? ''}`;
    });

    doc.body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));

    doc.body
      .querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote')
      .forEach((el) => el.append('\n'));

    return (doc.body.textContent ?? '')
      .replace(/\u00a0/g, ' ') // Quill emits &nbsp; freely
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** The full document as a .txt payload (used by ZIP and the email body). */
  buildPlainTextPetition(): string {
    const lines = [
      this.docHeading(),
      '='.repeat(46),
      '',
      `பொருள் / Subject: ${this.subject() || '(குறிப்பிடப்படவில்லை)'}`,
      '',
      '-'.repeat(46),
      '',
      this.plainText(),
      ''
    ];

    const files = this._attachments();
    if (files.length) {
      lines.push('', 'இணைப்புகள் / Attachments:', '-'.repeat(46));
      files.forEach((f, i) => {
        lines.push(`${i + 1}. ${f.name} (${this.formatBytes(f.compressedSize)})`);
      });
    }

    return lines.join('\n');
  }

  /** 1536 -> "1.5 KB". Shared by the attachment list and the TXT export. */
  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 KB';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /**
   * Build a filesystem-safe file stem from the subject line.
   * Defaults to the detected document kind's prefix (RTI-, Complaint-, …).
   */
  buildFileStem(prefix = this.docMeta().filePrefix): string {
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = (this.subject() || 'petition')
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 40)
      .replace(/-+$/, '');
    return `${prefix}-${slug || 'petition'}-${stamp}`;
  }

  /** Escape user/AI text before injecting it into an HTML string. */
  escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
