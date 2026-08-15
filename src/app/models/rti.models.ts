/**
 * Shared TypeScript contracts for the Advocate RTI Assistant.
 * Everything that crosses a component/service boundary is typed here.
 */

/* ------------------------------------------------------------------ *
 *  Gemini wire format
 * ------------------------------------------------------------------ */

/**
 * A single part inside a Gemini content block — either text or inline binary
 * data (used to ship the dictated WAV audio for transcription).
 */
export interface GeminiPart {
  text?: string;
  /**
   * True on reasoning parts emitted by thinking-capable models (Gemini 3.x).
   * These must be filtered out — they are not part of the answer.
   */
  thought?: boolean;
  /** Opaque reasoning token returned alongside answer parts; ignored. */
  thoughtSignature?: string;
  inlineData?: {
    /** e.g. 'audio/wav'. Gemini accepts wav, mp3, aiff, aac, ogg, flac. */
    mimeType: string;
    /** Base64 payload without the `data:` URL prefix. */
    data: string;
  };
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

/** Request body for `models/{model}:generateContent`. */
export interface GeminiRequest {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    /** 'application/json' forces the model into JSON mode. */
    responseMimeType?: string;
  };
  safetySettings?: Array<{ category: string; threshold: string }>;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  /** STOP | MAX_TOKENS | SAFETY | RECITATION | OTHER */
  finishReason?: string;
}

/** Response body for `models/{model}:generateContent`. */
export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  /** Present when the whole prompt was blocked before generation. */
  promptFeedback?: { blockReason?: string };
  error?: { code: number; message: string; status: string };
}

/* ------------------------------------------------------------------ *
 *  Domain model
 * ------------------------------------------------------------------ */

/**
 * What kind of document the dictation actually is.
 *
 * The tool started life as an RTI-only drafter, but the same dictate → format →
 * export flow serves any formal letter an advocate sends to a department. Gemini
 * classifies the dictation into one of these, and everything downstream — the
 * heading, the file name, the wording of the body — follows from that. Nothing
 * says "RTI" unless the kind is genuinely `rti`.
 */
export type DocumentKind =
  | 'rti'          // information request under the RTI Act, 2005
  | 'complaint'    // grievance / complaint to a department or authority
  | 'appeal'       // first or second appeal against an order or a refusal
  | 'legal_notice' // statutory or pre-litigation notice
  | 'request'      // representation asking for an action or a sanction
  | 'reminder'     // follow-up on an earlier letter that went unanswered
  | 'letter';      // anything else formal — the safe fallback

/** Presentation metadata for one document kind. See DOCUMENT_KINDS. */
export interface DocumentKindMeta {
  kind: DocumentKind;
  /** Default Tamil heading, used when the model does not supply its own. */
  headingTa: string;
  /** English line printed under the Tamil heading in the PDF. */
  headingEn: string;
  /** ASCII file-name prefix, e.g. "Complaint-…-2026-08-15.pdf". */
  filePrefix: string;
  /** Short bilingual label for the UI badge. */
  label: string;
}

/**
 * The JSON contract we require Gemini to emit.
 * See DRAFT_SYSTEM_PROMPT in rti.service.ts.
 */
export interface AiDraftResult {
  /** Which kind of document the model decided this dictation is. */
  doc_type: DocumentKind;
  /**
   * Tamil heading the model chose for this specific document, e.g.
   * "மனு" or "புகார் மனு". Falls back to the kind's default heading when the
   * model omits it.
   */
  doc_title: string;
  /** Formal Tamil subject line, e.g. "பொருள்: ... தொடர்பான கோரிக்கை". */
  subject: string;
  /** Rich-text petition body as HTML, safe for the Quill editor. */
  improved_html: string;
}

/** One attachment after (attempted) client-side compression. */
export interface RtiAttachment {
  /** Stable id used as the *ngFor trackBy key. */
  id: string;
  /** Name as it will appear inside the ZIP. */
  name: string;
  /** MIME type of the stored blob (may differ from the original if converted to JPEG). */
  type: string;
  /** Size of the file the user picked, in bytes. */
  originalSize: number;
  /** Size of the blob we will actually export, in bytes. */
  compressedSize: number;
  /** The bytes we export. Equals the original File when compression was skipped/failed. */
  blob: Blob;
  /** object URL for the thumbnail; revoked on removal. */
  previewUrl: string | null;
  /** true when the canvas pipeline actually produced a smaller file. */
  wasCompressed: boolean;
  /** Human-readable reason when compression was skipped or failed. */
  note?: string;
  isImage: boolean;
}

/** Options for the canvas compression pipeline. */
export interface CompressionOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  skipBelowBytes: number;
  maxFileBytes: number;
}

/* ------------------------------------------------------------------ *
 *  UI plumbing
 * ------------------------------------------------------------------ */

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  /** Short Tamil headline. */
  title: string;
  /** English / detail line — the advocate's staff may read this one. */
  detail?: string;
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed manually. */
  timeoutMs: number;
}

/** Mirrors the lifecycle of the Gemini call so buttons/spinners stay in sync. */
export type AiStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * Which dictation engine Step 1 is using.
 *  'browser' — webkitSpeechRecognition (live interim text, needs Google's speech service)
 *  'gemini'  — record locally, then transcribe via the Gemini API (no live text)
 */
export type DictationMode = 'browser' | 'gemini';

/** Which long-running export job (if any) is currently running. */
export type ExportJob = 'none' | 'pdf' | 'zip';

/** Everything the mic component reports upward. */
export interface MicState {
  supported: boolean;
  listening: boolean;
  interim: string;
}
