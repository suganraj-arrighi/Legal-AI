/**
 * Minimal ambient typings for the Web Speech API.
 *
 * `webkitSpeechRecognition` is a non-standard Chrome/Edge API and is not part
 * of TypeScript's bundled `lib.dom.d.ts`, so we declare the slice we actually
 * use. This file is a GLOBAL script (no top-level import/export) so every
 * component can reference these types without importing anything.
 */

/** Error codes emitted by SpeechRecognition.onerror. */
declare type SpeechRecognitionErrorCode =
  | 'no-speech'
  | 'aborted'
  | 'audio-capture'
  | 'network'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'bad-grammar'
  | 'language-not-supported';

declare interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

declare interface SpeechRecognitionResult {
  readonly length: number;
  /** true once the engine has committed to this chunk (no longer interim). */
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

declare interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

declare interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

declare interface SpeechRecognitionErrorEvent extends Event {
  readonly error: SpeechRecognitionErrorCode;
  readonly message: string;
}

declare interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;

  start(): void;
  stop(): void;
  abort(): void;

  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
}

declare interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

/** Augment the global Window with the vendor-prefixed constructors. */
interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
