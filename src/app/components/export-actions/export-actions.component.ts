import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { PlatformService } from '../../services/platform.service';
import { RtiService } from '../../services/rti.service';
import { ToastService } from '../../services/toast.service';

/**
 * Step 5 — export the finished document.
 *
 *  • PDF  — html2pdf.js renders a hidden, print-styled A4 node.
 *  • ZIP  — jszip bundles a .txt of the document plus every compressed file.
 *  • Mail — a Gmail compose tab on desktop, the phone's own mail app on mobile,
 *           either way pre-filled with subject + body.
 *
 * Both heavy libraries are loaded with dynamic `import()` so they are only
 * fetched the first time the advocate actually exports something.
 */
@Component({
  selector: 'app-export-actions',
  standalone: true,
  templateUrl: './export-actions.component.html',
  styleUrls: ['./export-actions.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ExportActionsComponent {
  private readonly rti = inject(RtiService);
  private readonly toast = inject(ToastService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly platform = inject(PlatformService);

  /** The off-screen node handed to html2pdf.js. */
  private readonly pdfRoot = viewChild.required<ElementRef<HTMLElement>>('pdfRoot');

  /** Heading + sub-heading follow the document kind Gemini detected. */
  readonly heading = this.rti.docHeading;
  readonly headingEn = this.rti.docHeadingEn;
  readonly subject = this.rti.subject;
  readonly attachments = this.rti.attachments;
  readonly canExport = this.rti.canExport;
  readonly exportJob = this.rti.exportJob;
  readonly hasContent = this.rti.hasContent;

  /** Today's date in Tamil-India format, printed on the PDF. */
  readonly todayLabel = signal(
    new Intl.DateTimeFormat('ta-IN', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date())
  );

  /**
   * Editor HTML, re-sanitised and marked trusted for the hidden PDF node.
   * Safe because `sanitizeHtml()` has already stripped scripts, event handlers
   * and javascript: URLs.
   */
  readonly safeContent = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(this.rti.sanitizeHtml(this.rti.contentHtml()))
  );

  /**
   * Gmail answers an over-long compose URL with a flat **400 Bad Request**, so
   * past this length the body travels by clipboard instead.
   *
   * Measured against Google's front end rather than guessed: a 8 057-character
   * URL is accepted (302 to the login page), 8 264 is refused with a 400 — the
   * familiar ~8 KB request-line limit. Adding an 8 KB dummy Cookie header did
   * not move that boundary, so the budget covers the request line alone and a
   * signed-in advocate gets the same allowance. 7 800 leaves a safety margin.
   *
   * Tamil consumes that budget fast: each character is three UTF-8 bytes and
   * percent-encoding turns every byte into three URL characters, so one dictated
   * character costs nine. This ceiling is therefore about 850 Tamil characters
   * of document — enough for most petitions, but not all.
   */
  private static readonly MAX_COMPOSE_URL_LENGTH = 7800;

  /**
   * Ceiling for the `mailto:` link used on phones and tablets.
   *
   * Here the limit is not a server but the OS: Android hands the URI to the
   * mail app through an Intent and iOS through a URL open, and both start
   * silently truncating the body well before the browser's own URL limit.
   * 2 000 characters is the length that survives intact on both — roughly 220
   * Tamil characters, since percent-encoding costs nine characters each.
   */
  private static readonly MAX_MAILTO_URL_LENGTH = 2000;

  /**
   * Phones and tablets get a `mailto:` link instead of Gmail's compose URL.
   *
   * The compose URL is right on a desktop, but on a phone it lands in the
   * browser's mobile Gmail page — the installed Gmail app never comes to the
   * front, and the compose parameters are often dropped along the way. A
   * `mailto:` has the opposite problem profile: on a desktop it may find no
   * mail handler at all, but every phone has one registered, which for these
   * advocates is Gmail.
   */
  readonly isMobile = this.platform.isMobile;

  /** True when the body must be pasted rather than carried in the link. */
  readonly emailNeedsPaste = computed(() =>
    this.isMobile
      ? this.buildMailtoUrl(true).length > ExportActionsComponent.MAX_MAILTO_URL_LENGTH
      : this.buildGmailComposeUrl(true).length > ExportActionsComponent.MAX_COMPOSE_URL_LENGTH
  );

  readonly isBusy = computed(() => this.exportJob() !== 'none');

  /* ------------------------------- PDF ---------------------------------- */

  async downloadPdf(): Promise<void> {
    if (!this.canExport() || this.isBusy()) {
      return;
    }

    this.rti.setExportJob('pdf');
    try {
      // Wait for the Tamil web fonts, otherwise html2canvas rasterises tofu.
      if ('fonts' in document) {
        await document.fonts.ready;
      }

      const { default: html2pdf } = await import('html2pdf.js');

      await html2pdf()
        .set({
          margin: [14, 14, 16, 14], // mm
          filename: `${this.rti.buildFileStem()}.pdf`,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: {
            scale: 2, // 2x for crisp Tamil glyphs
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false
          },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
          pagebreak: { mode: ['css', 'legacy'] }
        })
        .from(this.pdfRoot().nativeElement)
        .save();

      this.toast.success('PDF தயார்', 'The A4 petition PDF has been downloaded.');
    } catch (err) {
      console.error('[ExportActions] PDF generation failed:', err);
      this.toast.error(
        'PDF உருவாக்க முடியவில்லை',
        `Could not generate the PDF: ${err instanceof Error ? err.message : String(err)}. Try removing very large images, or use the ZIP export.`
      );
    } finally {
      this.rti.setExportJob('none');
    }
  }

  /* ------------------------------- ZIP ---------------------------------- */

  async downloadZip(): Promise<void> {
    if (!this.canExport() || this.isBusy()) {
      return;
    }

    this.rti.setExportJob('zip');
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const stem = this.rti.buildFileStem();

      // 1. The petition itself as UTF-8 plain text.
      zip.file(`${stem}.txt`, this.rti.buildPlainTextPetition());

      // 2. Every compressed attachment, in its own folder.
      const files = this.attachments();
      if (files.length) {
        const folder = zip.folder('இணைப்புகள்-attachments');
        const usedNames = new Set<string>();

        for (const file of files) {
          // Guard against two photos called IMG_0001.jpg overwriting each other.
          let name = file.name;
          let counter = 2;
          while (usedNames.has(name)) {
            name = file.name.replace(/(\.[^.]+)?$/, `-${counter}$1`);
            counter++;
          }
          usedNames.add(name);
          folder?.file(name, file.blob);
        }
      }

      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      this.saveBlob(blob, `${stem}.zip`);
      this.toast.success(
        'ZIP தொகுப்பு தயார்',
        `Bundled the petition text and ${files.length} attachment(s) — ${this.rti.formatBytes(blob.size)}.`
      );
    } catch (err) {
      console.error('[ExportActions] ZIP generation failed:', err);
      this.toast.error(
        'ZIP உருவாக்க முடியவில்லை',
        `Could not build the ZIP package: ${err instanceof Error ? err.message : String(err)}.`
      );
    } finally {
      this.rti.setExportJob('none');
    }
  }

  /* ------------------------------- Email -------------------------------- */

  /**
   * Hand the draft to the advocate's mail client, pre-filled.
   *
   * On a desktop that means Gmail's compose URL in a new tab. A `mailto:` link
   * handed the draft to whatever the OS registered as the default mail handler,
   * which on the office machines is the browser itself — so nothing useful
   * opened. Going straight at Gmail's compose URL skips the handler entirely,
   * and `window.open` is safe because the call sits inside a click handler, so
   * no popup blocker intervenes.
   *
   * On a phone the reasoning inverts — see {@link isMobile}.
   */
  async sendEmail(): Promise<void> {
    if (!this.canExport()) {
      return;
    }

    try {
      // Short enough to carry in the link? Then the advocate gets a compose
      // window that is ready to send. Otherwise the body goes via the clipboard.
      const bodyFitsInUrl = !this.emailNeedsPaste();
      let pasteReady = false;

      if (!bodyFitsInUrl) {
        pasteReady = await this.writeToClipboard(this.rti.buildPlainTextPetition());
      }

      if (this.isMobile) {
        // Same-tab navigation, not window.open: the mail app takes over the
        // foreground and a popped-open tab would be left behind empty.
        window.location.href = this.buildMailtoUrl(bodyFitsInUrl);

        if (bodyFitsInUrl) {
          this.toast.info(
            'மின்னஞ்சல் ஆப் திறக்கப்படுகிறது',
            'Your mail app (Gmail, if it is the default) is opening with the draft filled in. Attach the PDF/ZIP yourself — a browser cannot attach files for you.'
          );
        } else if (pasteReady) {
          this.toast.success(
            'உரை நகலெடுக்கப்பட்டது — மின்னஞ்சலில் ஒட்டவும்',
            'The document is too long to travel in a mail link, so only the subject was filled in and the full text was copied to your clipboard. Long-press the message body and tap Paste.'
          );
        } else {
          this.toast.warning(
            'பொருள் மட்டும் நிரப்பப்பட்டது',
            'The document is too long for a mail link and the clipboard was blocked. Tap "உரையை நகலெடு", then long-press the message body and tap Paste.'
          );
        }
        return;
      }

      const tab = window.open(
        this.buildGmailComposeUrl(bodyFitsInUrl),
        '_blank',
        'noopener,noreferrer'
      );

      if (!tab) {
        // Blocked despite the user gesture (some enterprise policies do this).
        this.toast.error(
          'Gmail-ஐத் திறக்க முடியவில்லை',
          'The browser blocked the pop-up. Allow pop-ups for this site, or use "உரையை நகலெடு" and paste into Gmail.'
        );
        return;
      }

      if (bodyFitsInUrl) {
        this.toast.info(
          'Gmail திறக்கப்படுகிறது',
          'A Gmail compose tab is opening. Attach the PDF/ZIP yourself — a browser cannot attach files for you.'
        );
      } else if (pasteReady) {
        this.toast.success(
          'உரை நகலெடுக்கப்பட்டது — Gmail-ல் Ctrl+V',
          'The document is too long to travel in a Gmail link, so only the subject was filled in and the full text was copied to your clipboard. Paste it into the compose window with Ctrl+V.'
        );
      } else {
        this.toast.warning(
          'பொருள் மட்டும் நிரப்பப்பட்டது',
          'The document is too long for a Gmail link and the clipboard was blocked. Use "உரையை நகலெடு", then paste into the compose window.'
        );
      }
    } catch (err) {
      console.error('[ExportActions] Gmail compose failed:', err);
      this.toast.error(
        'மின்னஞ்சலைத் திறக்க முடியவில்லை',
        'Could not open Gmail. Use "உரையை நகலெடு" to copy the text, or export the PDF/ZIP instead.'
      );
    }
  }

  /** Copy the plain-text document — handy when pasting into Gmail by hand. */
  async copyText(): Promise<void> {
    if (!this.canExport()) {
      return;
    }

    if (await this.writeToClipboard(this.rti.buildPlainTextPetition())) {
      this.toast.success('நகலெடுக்கப்பட்டது', 'The document text is on your clipboard.');
    } else {
      this.toast.error(
        'நகலெடுக்க முடியவில்லை',
        'Clipboard access was blocked by the browser. Select the text in the editor and copy manually.'
      );
    }
  }

  /* ------------------------------ Helpers ------------------------------- */

  /**
   * Gmail compose deep link. `view=cm` opens the compose view and `fs=1` makes
   * it a full-screen window rather than the corner pop-out.
   *
   * @param includeBody false fills in the subject only, for documents whose
   *   encoded body would push the URL past what Gmail's server accepts.
   */
  private buildGmailComposeUrl(includeBody: boolean): string {
    // encodeURIComponent, not URLSearchParams: the latter encodes spaces as "+",
    // which Gmail shows literally inside the body text.
    const su = encodeURIComponent(this.subject() || this.heading());
    const base = `https://mail.google.com/mail/?view=cm&fs=1&su=${su}`;
    if (!includeBody) {
      return base;
    }
    return `${base}&body=${encodeURIComponent(this.rti.buildPlainTextPetition())}`;
  }

  /**
   * `mailto:` link for phones and tablets — no recipient, so the mail app opens
   * on a fresh draft with the cursor in the To field.
   *
   * @param includeBody false fills in the subject only, for documents the OS
   *   would truncate on the way to the mail app.
   */
  private buildMailtoUrl(includeBody: boolean): string {
    const subject = encodeURIComponent(this.subject() || this.heading());
    const base = `mailto:?subject=${subject}`;
    if (!includeBody) {
      return base;
    }
    return `${base}&body=${encodeURIComponent(this.rti.buildPlainTextPetition())}`;
  }

  /** Clipboard write that reports success instead of throwing. */
  private async writeToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('[ExportActions] clipboard write failed:', err);
      return false;
    }
  }

  /** Trigger a browser download for an in-memory blob. */
  private saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Give the download a tick to start before revoking the URL.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
