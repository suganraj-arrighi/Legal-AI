import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * Microphone capture that produces a **16 kHz mono WAV** blob.
 *
 * Why not MediaRecorder? Chrome's MediaRecorder only emits `audio/webm`, which
 * is not one of the container formats the Gemini API documents for audio input
 * (wav, mp3, aiff, aac, ogg, flac). So we tap the raw PCM out of the Web Audio
 * graph, box-filter it down to 16 kHz mono (plenty for speech, and ~6× smaller
 * than 48 kHz stereo) and write a WAV header ourselves.
 *
 * This path does not touch Google's speech service at all — it only needs the
 * microphone plus whatever network route already reaches the Gemini endpoint.
 */
@Injectable({ providedIn: 'root' })
export class AudioRecorderService {
  /** Target sample rate. Speech models downsample to this anyway. */
  private static readonly TARGET_RATE = 16_000;

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  /** Captured PCM, one Float32Array per processor callback. */
  private chunks: Float32Array[] = [];
  private capturedRate = 48_000;

  private ticker: ReturnType<typeof setInterval> | null = null;
  private maxSeconds = 180;

  /* ----------------------------- Public state ---------------------------- */

  readonly recording = signal(false);

  /** Elapsed seconds, for the on-screen timer. */
  readonly seconds = signal(0);

  /** Smoothed RMS level 0–1, drives the live level meter. */
  readonly level = signal(0);

  /** Fires when the recording hits the duration cap and was auto-stopped. */
  readonly limitReached = new Subject<void>();

  /** Everything we need is present in this browser? */
  get supported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) ===
        'function'
    );
  }

  /* ------------------------------- Control ------------------------------- */

  /**
   * Request the mic and begin capturing.
   * Throws a human-readable Error on permission/hardware failure.
   */
  async start(maxSeconds = 180): Promise<void> {
    if (this.recording()) {
      return;
    }
    if (!this.supported) {
      throw new Error(
        'இந்த உலாவி ஒலிப்பதிவை ஆதரிக்கவில்லை. (This browser cannot record audio — please type manually.)'
      );
    }

    this.maxSeconds = maxSeconds;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (err) {
      // Map the DOMException names to advice the advocate can act on.
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error(
          'ஒலிவாங்கி அனுமதி மறுக்கப்பட்டது. (Microphone permission denied — allow it via the padlock icon and retry.)'
        );
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error('ஒலிவாங்கி கண்டறியப்படவில்லை. (No microphone found — connect one and retry.)');
      }
      if (name === 'NotReadableError') {
        throw new Error(
          'ஒலிவாங்கி வேறொரு செயலியால் பயன்படுத்தப்படுகிறது. (The microphone is in use by another application.)'
        );
      }
      throw new Error(`ஒலிவாங்கியைத் திறக்க முடியவில்லை: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const Ctx =
        window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.context = new Ctx!();
      this.capturedRate = this.context.sampleRate;

      this.source = this.context.createMediaStreamSource(this.stream);

      // ScriptProcessorNode is deprecated in favour of AudioWorklet, but the
      // worklet route needs a separately-served module file. For a single
      // short mono capture the deprecated node is simpler and universally
      // supported; the main thread load is negligible at 16 kHz mono.
      this.processor = this.context.createScriptProcessor(4096, 1, 1);

      this.chunks = [];

      this.processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const input = event.inputBuffer.getChannelData(0);
        // getChannelData returns a view onto a reused buffer — copy it.
        this.chunks.push(new Float32Array(input));

        // RMS → level meter.
        let sumSquares = 0;
        for (let i = 0; i < input.length; i++) {
          sumSquares += input[i] * input[i];
        }
        const rms = Math.sqrt(sumSquares / input.length);
        // Smooth so the meter doesn't strobe, and scale for visibility.
        this.level.set(Math.min(1, this.level() * 0.6 + Math.min(1, rms * 6) * 0.4));
      };

      this.source.connect(this.processor);
      // ScriptProcessor only pulls audio when connected to a destination.
      // A zero-gain node keeps it running without echoing to the speakers.
      const mute = this.context.createGain();
      mute.gain.value = 0;
      this.processor.connect(mute);
      mute.connect(this.context.destination);

      this.seconds.set(0);
      this.recording.set(true);

      this.ticker = setInterval(() => {
        this.seconds.update((s) => s + 1);
        if (this.seconds() >= this.maxSeconds) {
          this.limitReached.next();
        }
      }, 1000);
    } catch (err) {
      this.teardown();
      throw new Error(
        `ஒலிப்பதிவைத் தொடங்க முடியவில்லை: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Stop capturing and return the recorded audio as a 16 kHz mono WAV blob.
   * Returns null when nothing audible was captured.
   */
  async stop(): Promise<Blob | null> {
    if (!this.recording()) {
      return null;
    }

    const captured = this.chunks;
    const rate = this.capturedRate;
    this.teardown();

    const total = captured.reduce((sum, c) => sum + c.length, 0);
    if (total === 0) {
      return null;
    }

    // Flatten → downsample → PCM16 WAV.
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of captured) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const resampled = this.downsample(merged, rate, AudioRecorderService.TARGET_RATE);
    return this.encodeWav(resampled, AudioRecorderService.TARGET_RATE);
  }

  /** Abandon the recording without producing a blob. */
  cancel(): void {
    this.teardown();
    this.chunks = [];
  }

  /* ------------------------------ Internals ------------------------------ */

  /** Release the mic and audio graph. Safe to call twice. */
  private teardown(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }

    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        /* already disconnected */
      }
      this.processor = null;
    }

    try {
      this.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.source = null;

    // Releasing the tracks is what turns off the browser's recording indicator.
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    void this.context?.close().catch(() => undefined);
    this.context = null;

    this.recording.set(false);
    this.level.set(0);
  }

  /**
   * Box-filter downsample (averages each source window), which avoids the
   * aliasing artefacts naive sample-dropping introduces.
   */
  private downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (toRate >= fromRate) {
      return input;
    }

    const ratio = fromRate / toRate;
    const outLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outLength);

    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += input[j];
        count++;
      }
      output[i] = count > 0 ? sum / count : 0;
    }
    return output;
  }

  /** Wrap Float32 PCM in a 16-bit mono WAV (RIFF) container. */
  private encodeWav(samples: Float32Array, sampleRate: number): Blob {
    const bytesPerSample = 2;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    const writeString = (offset: number, text: string): void => {
      for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * bytesPerSample, true); // chunk size
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // subchunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
    view.setUint16(32, bytesPerSample, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, samples.length * bytesPerSample, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += bytesPerSample) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }

    return new Blob([view], { type: 'audio/wav' });
  }
}
