import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  NgZone,
  OnDestroy,
  computed,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { DictationMode } from '../../models/rti.models';
import { AudioRecorderService } from '../../services/audio-recorder.service';
import { RtiService } from '../../services/rti.service';
import { ToastService } from '../../services/toast.service';

/** Hard cap on a single recording, in seconds (keeps the request well under the size limit). */
const MAX_RECORDING_SECONDS = 180;

/**
 * How many consecutive `network` drops to absorb before giving up on the live
 * engine. Google's speech service is frequently flaky-but-usable (it drops and
 * recovers mid-dictation), so this is deliberately tolerant.
 */
const MAX_NETWORK_RETRIES = 5;

/**
 * Small pause before every auto-restart. Calling `start()` immediately inside
 * `onend` is itself a common cause of spurious `network` errors, so we always
 * let the engine settle first.
 */
const BASE_RESTART_DELAY_MS = 300;

/**
 * Step 1 — "Google Assistant"-style Tamil dictation.
 *
 * Uses the Web Speech API with `continuous = true` and `interimResults = true`
 * so the advocate sees words forming as he speaks. Finalised chunks are pushed
 * into RtiService; interim text lives only in this component.
 *
 * Every failure path degrades to the manual textarea below the mic — the app
 * must remain fully usable with no microphone at all.
 */
@Component({
  selector: 'app-voice-input',
  standalone: true,
  templateUrl: './voice-input.component.html',
  styleUrls: ['./voice-input.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VoiceInputComponent implements OnDestroy {
  private readonly rti = inject(RtiService);
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly recorder = inject(AudioRecorderService);
  private readonly destroyRef = inject(DestroyRef);

  /** Live instance; null whenever we are not listening. */
  private recognition: SpeechRecognition | null = null;

  /** True while the user *intends* to keep dictating (survives auto-restarts). */
  private wantsToListen = false;

  /** Restart bookkeeping — prevents an infinite restart loop on a broken mic. */
  private restartCount = 0;
  private restartWindowStart = 0;

  /**
   * Consecutive `network` errors. Chrome streams audio to Google's speech
   * servers, so this fires when that service is unreachable even though the
   * machine itself is online (corporate proxy, TLS inspection, Chromium builds
   * shipped without the Google speech API key). Transient blips are common, so
   * we retry a couple of times before giving up.
   */
  private readonly networkErrorCount = signal(0);

  /** Exposed for the inline reconnect strip ("2 / 5"). */
  readonly retryAttempt = this.networkErrorCount.asReadonly();
  readonly maxRetries = MAX_NETWORK_RETRIES;

  /** Backoff applied before the next auto-restart (ms). */
  private restartDelayMs = 0;

  /** Pending restart timer, cleared on stop/destroy. */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /* ------------------------- Reactive UI state ------------------------- */

  /** Does this browser expose the API at all? (Chrome / Edge do; Firefox does not.) */
  readonly supported = signal<boolean>(this.detectSupport());

  readonly listening = signal(false);

  /** Interim (not yet finalised) words, shown in a lighter colour. */
  readonly interim = signal('');

  /** Set when permission is denied so we can show a persistent hint. */
  readonly micBlocked = signal(false);

  /**
   * Set when the speech *service* is unreachable (as opposed to the mic being
   * blocked). Drives a persistent banner, because a toast disappears before
   * the advocate has finished reading the fix.
   */
  readonly speechServiceBlocked = signal(false);

  /** "மீண்டும் முயல்கிறது (2/3)" indicator while we retry a network failure. */
  readonly reconnecting = signal(false);

  /* --------------------- Dictation engine selection -------------------- */

  /**
   * Which engine Step 1 uses. Starts on the browser engine (live interim text
   * is nicer) and falls back to Gemini automatically when that engine is
   * unavailable or blocked.
   */
  readonly mode = signal<DictationMode>(this.detectSupport() ? 'browser' : 'gemini');

  /** Can we record audio at all (getUserMedia + Web Audio)? */
  readonly recorderSupported = signal<boolean>(this.recorder.supported);

  /** Live recorder state, re-exported for the template. */
  readonly recording = this.recorder.recording;
  readonly recordSeconds = this.recorder.seconds;
  readonly level = this.recorder.level;

  /** True while Gemini is turning the recording into text. */
  readonly transcribing = this.rti.transcribing;

  /**
   * > 0 while transcription is waiting out a busy/overloaded Gemini.
   * Named apart from `retryAttempt` above, which counts speech-service
   * reconnects — the two are unrelated failure modes.
   */
  readonly geminiRetryAttempt = this.rti.retryAttempt;
  readonly geminiMaxAttempts = this.rti.maxAttempts;

  readonly maxSeconds = MAX_RECORDING_SECONDS;

  /** "01:23 / 03:00" for the recording timer. */
  readonly timerLabel = computed(() => {
    const s = this.recordSeconds();
    const mm = Math.floor(s / 60)
      .toString()
      .padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  });

  /** Seconds left before the auto-stop, once we are close enough to matter. */
  readonly secondsLeft = computed(() => Math.max(0, this.maxSeconds - this.recordSeconds()));

  /** The big button is "active" in either engine. */
  readonly active = computed(() => (this.mode() === 'gemini' ? this.recording() : this.listening()));

  /** Button must be inert while a transcription round-trip is in flight. */
  readonly busy = computed(() => this.transcribing());

  /** Finalised transcript from the service. */
  readonly transcript = this.rti.rawTranscript;

  readonly charCount = computed(() => this.transcript().length);

  /** Combined text for the live preview panel. */
  readonly livePreview = computed(() => {
    const base = this.transcript();
    const partial = this.interim();
    if (!base && !partial) {
      return '';
    }
    return partial ? `${base}${base ? ' ' : ''}${partial}` : base;
  });

  /* --------------------------- Public actions -------------------------- */

  constructor() {
    // Auto-stop when a recording hits the duration cap, then transcribe what
    // we have so nothing spoken is thrown away.
    this.recorder.limitReached.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (!this.recording()) {
        return;
      }
      this.toast.info(
        'பதிவு நேர வரம்பு',
        `Reached the ${Math.round(MAX_RECORDING_SECONDS / 60)}-minute limit — transcribing now. Press record again to continue; the text is appended.`
      );
      void this.stopRecording();
    });
  }

  /** The single big button — meaning depends on the active engine. */
  toggle(): void {
    if (this.busy()) {
      return;
    }

    if (this.mode() === 'gemini') {
      if (this.recording()) {
        void this.stopRecording();
      } else {
        void this.startRecording();
      }
      return;
    }

    if (this.listening()) {
      this.stop();
    } else {
      this.start();
    }
  }

  /** Switch dictation engine, shutting the current one down cleanly. */
  setMode(mode: DictationMode): void {
    if (mode === this.mode() || this.busy()) {
      return;
    }

    if (this.listening()) {
      this.stop();
    }
    if (this.recording()) {
      // Discard rather than transcribe — the advocate asked to switch, not to submit.
      this.recorder.cancel();
    }

    this.mode.set(mode);
  }

  /** Begin (or resume) dictation. */
  start(): void {
    if (!this.supported()) {
      this.toast.error(
        'குரல் உள்ளீடு ஆதரிக்கப்படவில்லை',
        'This browser does not support speech recognition. Please use Google Chrome or Microsoft Edge, or type the petition manually in the box below.'
      );
      return;
    }

    if (this.listening()) {
      return;
    }

    try {
      const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!Ctor) {
        throw new Error('SpeechRecognition constructor unavailable');
      }

      const recognition = new Ctor();
      recognition.lang = 'ta-IN'; // Tamil (India)
      recognition.continuous = true; // keep the session open between sentences
      recognition.interimResults = true; // live "assistant" feel
      recognition.maxAlternatives = 1;

      this.attachHandlers(recognition);

      this.recognition = recognition;
      this.wantsToListen = true;

      // A fresh press is a fresh attempt — clear the previous failure state.
      this.micBlocked.set(false);
      this.speechServiceBlocked.set(false);
      this.reconnecting.set(false);
      this.networkErrorCount.set(0);
      this.restartDelayMs = 0;

      recognition.start();
      this.listening.set(true);
    } catch (err) {
      // `start()` throws InvalidStateError if called twice, and can throw when
      // the page is not a secure context (http:// on a non-localhost host).
      this.wantsToListen = false;
      this.listening.set(false);
      this.recognition = null;
      console.error('[VoiceInput] start() failed:', err);
      this.toast.error(
        'ஒலிவாங்கியைத் தொடங்க முடியவில்லை',
        'Could not start the microphone. Ensure the page is served over https:// or localhost, then reload. You can type manually below.'
      );
    }
  }

  /** Stop dictation deliberately (user pressed the button). */
  stop(): void {
    this.wantsToListen = false;
    this.reconnecting.set(false);
    this.clearRestartTimer();

    // Commit whatever was still interim so no spoken words are lost.
    this.flushInterim();

    try {
      this.recognition?.stop();
    } catch (err) {
      console.warn('[VoiceInput] stop() threw (ignored):', err);
    } finally {
      this.listening.set(false);
    }
  }

  /* ------------------ Gemini dictation (record → transcribe) ------------- */

  /** Begin recording locally. Nothing is sent until the advocate stops. */
  private async startRecording(): Promise<void> {
    if (!this.recorderSupported()) {
      this.toast.error(
        'ஒலிப்பதிவு ஆதரிக்கப்படவில்லை',
        'This browser cannot record audio. Please type the petition manually below.'
      );
      return;
    }

    try {
      await this.recorder.start(MAX_RECORDING_SECONDS);
      this.micBlocked.set(false);
      this.toast.info(
        'பதிவு தொடங்கியது',
        'Recording. Press the button again when you finish — the audio is then transcribed by Gemini.'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // getUserMedia rejection with NotAllowed also means the padlock hint applies.
      if (message.includes('அனுமதி மறுக்கப்பட்டது')) {
        this.micBlocked.set(true);
      }
      this.toast.error('பதிவைத் தொடங்க முடியவில்லை', message);
    }
  }

  /** Stop recording and send the audio to Gemini for Tamil transcription. */
  private async stopRecording(): Promise<void> {
    let audio: Blob | null = null;

    try {
      audio = await this.recorder.stop();
    } catch (err) {
      console.error('[VoiceInput] recorder.stop() failed:', err);
      this.toast.error(
        'பதிவை முடிக்க முடியவில்லை',
        `Could not finalise the recording: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    if (!audio) {
      this.toast.warning('ஒலி எதுவும் பதிவாகவில்லை', 'Nothing was captured — check the microphone and try again.');
      return;
    }

    this.rti
      .transcribeAudio(audio)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (text) => {
          if (!text.trim()) {
            this.toast.warning(
              'பேச்சு எதுவும் கண்டறியப்படவில்லை',
              'Gemini found no speech in that recording. Try again, closer to the microphone.'
            );
            return;
          }
          // Appended, so several recordings build up one petition.
          this.rti.appendTranscript(text);
          this.toast.success('எழுத்தாக்கம் முடிந்தது', 'Transcription added to the text below.');
        },
        // RtiService has already toasted a readable message.
        error: (err: Error) => console.warn('[VoiceInput] transcription failed:', err.message)
      });
  }

  /** Manual typing fallback — also used to correct dictation mistakes. */
  onManualInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.rti.setTranscript(target.value);
  }

  clearTranscript(): void {
    this.rti.clearTranscript();
    this.interim.set('');
  }

  /* --------------------------- Internal wiring ------------------------- */

  private attachHandlers(recognition: SpeechRecognition): void {
    /**
     * Fires once the speech service has accepted the session. This — not the
     * next transcribed word — is the moment a reconnect has actually
     * succeeded. Clearing the strip here stops it from lingering through a
     * pause in dictation and looking like an ongoing failure.
     */
    recognition.onstart = () => {
      this.zone.run(() => {
        this.listening.set(true);
        this.reconnecting.set(false);
      });
    };

    /**
     * onresult fires continuously. `event.resultIndex` tells us where the new
     * results begin, so we only walk the tail of the list.
     */
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalChunk = '';
      let interimChunk = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          finalChunk += text;
        } else {
          interimChunk += text;
        }
      }

      // Speech events can arrive outside the Angular zone — run inside it so
      // the signal writes schedule change detection.
      this.zone.run(() => {
        // Any result at all proves the speech service is reachable again.
        this.networkErrorCount.set(0);
        if (this.reconnecting()) {
          this.reconnecting.set(false);
        }

        if (finalChunk.trim()) {
          this.rti.appendTranscript(finalChunk);
        }
        this.interim.set(interimChunk.trim());
      });
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.zone.run(() => this.handleRecognitionError(event));
    };

    /**
     * Chrome ends the session after a few seconds of silence even with
     * `continuous = true`. If the advocate is still holding the floor we
     * transparently restart so it behaves like Google Assistant.
     */
    recognition.onend = () => {
      this.zone.run(() => {
        this.flushInterim();

        if (!this.wantsToListen) {
          this.listening.set(false);
          this.recognition = null;
          return;
        }

        if (!this.canRestart()) {
          this.wantsToListen = false;
          this.listening.set(false);
          this.recognition = null;
          this.toast.warning(
            'குரல் உள்ளீடு நிறுத்தப்பட்டது',
            'The microphone kept dropping out, so listening was stopped. Press the mic again, or type below.'
          );
          return;
        }

        // Always pause briefly; back off further after a network failure.
        const delay = BASE_RESTART_DELAY_MS + this.restartDelayMs;
        this.restartDelayMs = 0;

        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.wantsToListen) {
            return;
          }
          try {
            recognition.start();
            this.listening.set(true);
          } catch (err) {
            console.warn('[VoiceInput] auto-restart failed:', err);
            this.listening.set(false);
            this.recognition = null;
          }
        }, delay);
      });
    };
  }

  /** Map SpeechRecognition error codes to advice the advocate can act on. */
  private handleRecognitionError(event: SpeechRecognitionErrorEvent): void {
    switch (event.error) {
      case 'not-allowed':
      case 'service-not-allowed':
        this.wantsToListen = false;
        this.micBlocked.set(true);
        this.listening.set(false);
        this.toast.error(
          'ஒலிவாங்கி அனுமதி மறுக்கப்பட்டது',
          'Microphone permission denied. Click the padlock icon in the address bar → Microphone → Allow, then reload. Meanwhile you can type the petition manually below.'
        );
        break;

      case 'audio-capture':
        this.wantsToListen = false;
        this.listening.set(false);
        this.toast.error(
          'ஒலிவாங்கி கண்டறியப்படவில்லை',
          'No microphone was found. Connect a microphone or headset and try again — or type the petition manually below.'
        );
        break;

      case 'network':
        this.networkErrorCount.update((n) => n + 1);

        // Transient drops are absorbed SILENTLY. Google's speech service
        // routinely stutters mid-session and recovers on its own; a toast per
        // stutter would bury the mic under warnings while dictation is in fact
        // working. The inline "reconnecting" strip is the only signal, and it
        // clears itself the moment results resume.
        if (this.networkErrorCount() <= MAX_NETWORK_RETRIES) {
          this.restartDelayMs = Math.min(1200 * this.networkErrorCount(), 4000);
          this.reconnecting.set(true);
          break;
        }

        // Third strike: stop and explain what is actually happening, because
        // "check your internet" is misleading — the machine IS online.
        this.wantsToListen = false;
        this.reconnecting.set(false);
        this.listening.set(false);
        this.speechServiceBlocked.set(true);

        // Fall back to the Gemini engine, which reaches a completely different
        // endpoint — the same one Step 2 already uses successfully.
        if (this.recorderSupported()) {
          this.mode.set('gemini');
          this.toast.warning(
            'Gemini ஒலிப்பதிவுக்கு மாற்றப்பட்டது',
            `The live speech service dropped ${MAX_NETWORK_RETRIES} times in a row, so dictation switched to Gemini: record, then it transcribes. Your text so far is untouched. Press the microphone to continue.`
          );
        } else {
          this.toast.error(
            'குரல் சேவையை அணுக முடியவில்லை',
            "Chrome sends your audio to Google's speech servers to transcribe it, and that service could not be reached — even though this machine is online. A company proxy/firewall is the usual cause. Please type the petition below; every other feature works normally."
          );
        }
        break;

      case 'no-speech':
        // Benign and frequent: fires every time he pauses to collect a thought.
        // onend restarts us automatically, so this must stay silent — the red
        // "கேட்கிறது…" pill already shows the session is alive.
        break;

      case 'aborted':
        // Fired by our own stop()/abort(); nothing to report.
        break;

      case 'language-not-supported':
        this.wantsToListen = false;
        this.listening.set(false);
        this.toast.error(
          'தமிழ் (ta-IN) ஆதரிக்கப்படவில்லை',
          'This browser build does not support Tamil speech recognition. Please use Google Chrome, or type manually below.'
        );
        break;

      default:
        this.toast.warning(
          'குரல் உள்ளீட்டில் சிக்கல்',
          `Speech recognition error: ${event.error}. ${event.message || ''}`.trim()
        );
    }
  }

  /**
   * Rate-limit auto-restarts: at most 8 restarts per 20 seconds. Beyond that
   * something is genuinely wrong (device unplugged, tab backgrounded) and we
   * bail out instead of hammering the API.
   */
  private canRestart(): boolean {
    const now = Date.now();
    if (now - this.restartWindowStart > 20_000) {
      this.restartWindowStart = now;
      this.restartCount = 0;
    }
    this.restartCount++;
    return this.restartCount <= 8;
  }

  /** Move any pending interim text into the permanent transcript. */
  private flushInterim(): void {
    const pending = this.interim().trim();
    if (pending) {
      this.rti.appendTranscript(pending);
    }
    this.interim.set('');
  }

  private detectSupport(): boolean {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);
  }

  /** Cancel a queued auto-restart. */
  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  ngOnDestroy(): void {
    this.wantsToListen = false;
    this.clearRestartTimer();
    // Release the microphone so the browser's recording indicator clears.
    this.recorder.cancel();
    try {
      // abort() (not stop()) so no trailing onresult fires after teardown.
      this.recognition?.abort();
    } catch {
      /* component is going away — nothing useful to do */
    }
    this.recognition = null;
  }
}
