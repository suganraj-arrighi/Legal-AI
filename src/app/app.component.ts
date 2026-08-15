import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';

import { AiFormatterComponent } from './components/ai-formatter/ai-formatter.component';
import { DocumentEditorComponent } from './components/document-editor/document-editor.component';
import { ExportActionsComponent } from './components/export-actions/export-actions.component';
import { MediaAttachmentComponent } from './components/media-attachment/media-attachment.component';
import { ToastContainerComponent } from './components/toast-container/toast-container.component';
import { VoiceInputComponent } from './components/voice-input/voice-input.component';
import { RtiService } from './services/rti.service';
import { ToastService } from './services/toast.service';

/**
 * Shell component.
 *
 * Owns the page chrome and the step ordering only — all real state lives in
 * RtiService, so any step can be reordered or reused elsewhere untouched.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    VoiceInputComponent,
    AiFormatterComponent,
    DocumentEditorComponent,
    MediaAttachmentComponent,
    ExportActionsComponent,
    ToastContainerComponent
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  private readonly rti = inject(RtiService);
  private readonly toast = inject(ToastService);

  /** Anchor used to scroll the advocate to the editor after AI formatting. */
  private readonly editorAnchor = viewChild<ElementRef<HTMLElement>>('editorAnchor');

  readonly isLoading = this.rti.isLoading;
  readonly hasContent = this.rti.hasContent;
  readonly hasTranscript = this.rti.hasTranscript;
  readonly attachmentCount = this.rti.attachmentCount;

  /** Live connectivity indicator — Gemini needs the network, exports do not. */
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);

  constructor() {
    // Plain listeners (not RxJS) — these outlive nothing, the shell is the app.
    window.addEventListener('online', () => {
      this.online.set(true);
      this.toast.success('இணைப்பு மீண்டும் கிடைத்தது', 'You are back online.');
    });

    window.addEventListener('offline', () => {
      this.online.set(false);
      this.toast.warning(
        'இணைய இணைப்பு துண்டிக்கப்பட்டது',
        'You are offline. Voice input and AI formatting need a connection; editing and export still work.'
      );
    });

    // Guard against losing a long dictation to an accidental tab close.
    window.addEventListener('beforeunload', (event: BeforeUnloadEvent) => {
      if (this.hasContent() || this.hasTranscript()) {
        event.preventDefault();
        // Legacy browsers require returnValue to be set.
        event.returnValue = '';
      }
    });
  }

  /** Fired by AiFormatterComponent once a draft lands in the editor. */
  onDrafted(): void {
    // Defer so the editor has rendered the new content before we scroll.
    setTimeout(() => {
      this.editorAnchor()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }

  /** Start a fresh petition (with a confirmation — this is destructive). */
  startNew(): void {
    if (!this.hasContent() && !this.hasTranscript() && !this.attachmentCount()) {
      return;
    }
    if (
      confirm(
        'அனைத்து உரையும் இணைப்புகளும் அழிக்கப்படும். புதிய மனுவைத் தொடங்கவா?\n\nThis clears the transcript, the petition and all attachments. Start a new petition?'
      )
    ) {
      this.rti.resetAll();
      this.toast.info('புதிய மனு', 'Cleared. Ready for a new petition.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
}
