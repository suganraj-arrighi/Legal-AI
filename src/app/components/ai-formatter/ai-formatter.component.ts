import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, output } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AiDraftResult } from '../../models/rti.models';
import { RtiService } from '../../services/rti.service';
import { ToastService } from '../../services/toast.service';

/**
 * Step 2 — hand the raw dictation to Gemini 2.5 Flash and drop the formal
 * draft into the editor.
 *
 * This component owns only the trigger + loading/error presentation; the HTTP
 * call, JSON repair and error translation all live in RtiService.
 */
@Component({
  selector: 'app-ai-formatter',
  standalone: true,
  templateUrl: './ai-formatter.component.html',
  styleUrls: ['./ai-formatter.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AiFormatterComponent {
  private readonly rti = inject(RtiService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** Emitted after a draft is successfully applied (App scrolls to the editor). */
  readonly drafted = output<AiDraftResult>();

  /** Shown in the success panel so the detected type is never a surprise. */
  readonly docMeta = this.rti.docMeta;

  /** > 0 while an automatic retry is waiting out a busy/overloaded Gemini. */
  readonly retryAttempt = this.rti.retryAttempt;
  readonly maxAttempts = this.rti.maxAttempts;

  readonly status = this.rti.aiStatus;
  readonly lastError = this.rti.lastError;
  readonly hasTranscript = this.rti.hasTranscript;
  readonly isLoading = this.rti.isLoading;

  readonly isFormatting = computed(() => this.status() === 'loading');

  /** Empty-state guard: no dictation → no API call. */
  readonly disabled = computed(() => !this.hasTranscript() || this.isLoading());

  /** Warn before silently overwriting an edited draft. */
  private get hasExistingDraft(): boolean {
    return this.rti.hasContent();
  }

  format(): void {
    if (this.disabled()) {
      return;
    }

    if (
      this.hasExistingDraft &&
      !confirm(
        'எடிட்டரில் உள்ள தற்போதைய வரைவு மாற்றப்படும். தொடரலாமா?\n\nThis will replace the current draft in the editor. Continue?'
      )
    ) {
      return;
    }

    this.rti
      .formatWithGemini()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (draft) => {
          this.rti.applyDraft(draft);
          this.toast.success(
            'வரைவு தயார்',
            `Drafted as: ${this.rti.docMeta().label}. Please review every clause before filing — and correct the document type in Step 3 if that is wrong.`
          );
          this.drafted.emit(draft);
        },
        // RtiService has already toasted a human-readable message and set
        // `lastError`; this handler exists purely so the error does not
        // bubble to the global ErrorHandler as an unhandled rejection.
        error: (err: Error) => console.warn('[AiFormatter] Gemini call failed:', err.message)
      });
  }

  /** Retry after a failure without re-recording. */
  retry(): void {
    this.format();
  }
}
