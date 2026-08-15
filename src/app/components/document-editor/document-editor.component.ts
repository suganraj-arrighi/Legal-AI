import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { QuillModule } from 'ngx-quill';
import { debounceTime } from 'rxjs';

import { QUILL_TOOLBAR } from '../../app.config';
import { DocumentKind } from '../../models/rti.models';
import { DOCUMENT_KIND_OPTIONS, RtiService } from '../../services/rti.service';

/**
 * Step 3 — the editable document.
 *
 * Wraps ngx-quill and the Subject line, and keeps both in two-way sync with
 * RtiService:
 *   service → control : an `effect` (used when the AI writes a fresh draft)
 *   control → service : `valueChanges` (used while the advocate types)
 *
 * The service→control direction always uses `emitEvent: false` so the two
 * directions can never chase each other into an infinite loop.
 */
@Component({
  selector: 'app-document-editor',
  standalone: true,
  imports: [ReactiveFormsModule, QuillModule],
  templateUrl: './document-editor.component.html',
  styleUrls: ['./document-editor.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DocumentEditorComponent {
  private readonly rti = inject(RtiService);
  private readonly destroyRef = inject(DestroyRef);

  /** Toolbar comes from the shared app config so PDF/Quill stay in agreement. */
  readonly quillModules = { toolbar: QUILL_TOOLBAR };

  readonly subjectControl = new FormControl<string>('', { nonNullable: true });
  readonly contentControl = new FormControl<string>('', { nonNullable: true });

  readonly hasContent = this.rti.hasContent;
  readonly isLoading = this.rti.isLoading;

  /** Document kind Gemini detected, plus the list for the override dropdown. */
  readonly docKind = this.rti.docKind;
  readonly docKindOptions = DOCUMENT_KIND_OPTIONS;

  /** Quill takes a moment to boot; show a placeholder box until then. */
  readonly editorReady = signal(false);

  /** Rough word count of the plain-text projection — useful for RTI limits. */
  readonly wordCount = computed(() => {
    const text = this.rti.plainText().trim();
    return text ? text.split(/\s+/).length : 0;
  });

  readonly charCount = computed(() => this.rti.plainText().length);

  constructor() {
    /* ---------------- service → controls (AI draft arriving) ------------- */
    effect(() => {
      const subject = this.rti.subject();
      if (subject !== this.subjectControl.value) {
        this.subjectControl.setValue(subject, { emitEvent: false });
      }
    });

    effect(() => {
      const html = this.rti.contentHtml();
      if (html !== this.contentControl.value) {
        this.contentControl.setValue(html, { emitEvent: false });
      }
    });

    /* ---------------- controls → service (advocate typing) --------------- */
    this.subjectControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.rti.setSubject(value ?? ''));

    this.contentControl.valueChanges
      .pipe(
        // Quill fires on every keystroke; 150 ms keeps the derived signals
        // (plain text, word count, export enablement) cheap.
        debounceTime(150),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((value) => this.rti.setContentHtml(value ?? ''));
  }

  /**
   * The advocate corrects a misclassified document. This only swaps the
   * heading, the English sub-heading and the file-name prefix — the body text
   * is left alone, since rewriting it needs another trip through Gemini.
   */
  onDocKindChange(event: Event): void {
    this.rti.setDocKind((event.target as HTMLSelectElement).value as DocumentKind);
  }

  /** ngx-quill emits the Quill instance once it is mounted. */
  onEditorCreated(): void {
    this.editorReady.set(true);
  }

  clearContent(): void {
    if (!confirm('எடிட்டரின் உள்ளடக்கம் அழிக்கப்படும். தொடரலாமா? / Clear the editor content?')) {
      return;
    }
    this.contentControl.setValue('');
    this.rti.setContentHtml('');
  }
}
