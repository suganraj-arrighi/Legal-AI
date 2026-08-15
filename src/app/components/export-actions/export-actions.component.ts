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

  /** The document's name — used as the mail subject when none was typed. */
  readonly heading = this.rti.docHeading;

  /**
   * What the page itself is headed with — empty for everything but an RTI
   * application, so the statutory line never lands on a plain letter.
   */
  readonly printedHeading = this.rti.printedHeading;
  readonly printedHeadingEn = this.rti.printedHeadingEn;

  /** From/To blocks, printed on letters only. */
  readonly fromAddress = this.rti.fromAddress;
  readonly toAddress = this.rti.toAddress;
  readonly showAddresses = this.rti.hasAddresses;

  readonly subject = this.rti.subject;
  readonly attachments = this.rti.attachments;

  /**
   * The attachments the PDF can actually draw.
   *
   * A PDF is a page, not a container, so only the images can be printed into
   * it — a .docx enclosure has nothing to render and stays a name in the
   * list. `previewUrl` is the real precondition rather than `isImage` alone:
   * an image whose object URL was never created has no source to draw from.
   */
  readonly imageAttachments = computed(() =>
    this.attachments().filter((file) => file.isImage && file.previewUrl)
  );
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
   * Ceiling for the `mailto:` link on iOS.
   *
   * Here the limit is not a server but the OS: Safari hands the URI to Mail
   * through a plain URL open, which starts silently truncating the body well
   * before the browser's own URL limit. 2 000 characters is what survives
   * intact — roughly 220 Tamil characters, since percent-encoding costs nine
   * characters each.
   */
  private static readonly MAX_MAILTO_URL_LENGTH_IOS = 2000;

  /**
   * Ceiling for the `mailto:` link on Android — fifteen times the iOS one,
   * because the transport is completely different.
   *
   * Chrome turns the URI into an `ACTION_SENDTO` Intent and Gmail reads the
   * `body` query parameter straight off it. That travels over Binder, whose
   * transaction budget is about a megabyte, so the practical limit is orders
   * of magnitude above anything an advocate will dictate. The old shared
   * 2 000-character ceiling was the iOS figure applied to both, and it meant
   * every petition longer than a short paragraph reached Gmail with its
   * subject filled in and its body missing.
   *
   * 30 000 characters is roughly 3 300 Tamil characters of document — beyond
   * any petition this tool has produced — while still leaving the Binder
   * budget almost untouched.
   */
  private static readonly MAX_MAILTO_URL_LENGTH_ANDROID = 30000;

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

  /** How long a `mailto:` this device's mail handler accepts intact. */
  private readonly maxMailtoLength = this.platform.isIos
    ? ExportActionsComponent.MAX_MAILTO_URL_LENGTH_IOS
    : ExportActionsComponent.MAX_MAILTO_URL_LENGTH_ANDROID;

  /** True when the body must be pasted rather than carried in the link. */
  readonly emailNeedsPaste = computed(() =>
    this.isMobile
      ? this.buildMailtoUrl(true).length > this.maxMailtoLength
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

      // …and for the evidence photos, for the same reason. html2canvas clones
      // the node and draws whatever each <img> holds at that instant, so an
      // attachment still decoding comes out as an empty frame.
      await this.awaitPdfImages();

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

  /**
   * Resolve once every `<img>` in the hidden PDF node has finished decoding.
   *
   * A failed image resolves too rather than rejecting: a single unreadable
   * photo should cost the advocate that one frame, not the whole export.
   */
  private async awaitPdfImages(): Promise<void> {
    const images = Array.from(this.pdfRoot().nativeElement.querySelectorAll('img'));

    await Promise.all(
      images.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            })
      )
    );
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
        const names = this.uniqueAttachmentNames();
        files.forEach((file, i) => folder?.file(names[i], file.blob));
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
      // An attached photo can only reach the message through the OS share
      // sheet, so on a phone that route is tried first whenever there is one.
      if (this.isMobile && this.attachments().length) {
        const outcome = await this.shareWithAttachments();

        if (outcome === 'shared') {
          this.toast.success(
            'மின்னஞ்சல் ஆப்-க்கு அனுப்பப்பட்டது',
            `The draft and its ${this.attachments().length} attachment(s) were handed to the app you picked. Fill in the To field and send.`
          );
          return;
        }

        // A dismissed share sheet is a decision, not a failure — falling
        // through would re-open something the advocate just closed.
        if (outcome === 'cancelled') {
          return;
        }

        this.toast.warning(
          'இணைப்புகளைச் சேர்க்க முடியவில்லை',
          'This browser cannot hand files to the mail app, so the message will carry the text only. Download the ZIP and attach it in Gmail yourself.'
        );
      }

      // Short enough to carry in the link? Then the advocate gets a compose
      // window that is ready to send. Otherwise the body goes via the clipboard.
      const bodyFitsInUrl = !this.emailNeedsPaste();
      let pasteReady = false;

      if (!bodyFitsInUrl) {
        pasteReady = await this.writeToClipboard(this.emailBody());
      }

      if (this.isMobile) {
        // Raise the notice before navigating. The mail app comes straight to
        // the foreground, so a paste instruction on a four-second timer would
        // expire unread behind it — those two get no timeout at all and wait
        // on screen until the advocate switches back and dismisses them.
        if (bodyFitsInUrl) {
          this.toast.info(
            'மின்னஞ்சல் ஆப் திறக்கப்படுகிறது',
            'Your mail app (Gmail, if it is the default) is opening with the draft filled in. Attach the PDF/ZIP yourself — a browser cannot attach files for you.'
          );
        } else if (pasteReady) {
          this.toast.push(
            'success',
            'உரை நகலெடுக்கப்பட்டது — மின்னஞ்சலில் ஒட்டவும்',
            'The document is too long to travel in a mail link, so only the subject was filled in and the full text was copied to your clipboard. Long-press the message body and tap Paste.',
            0
          );
        } else {
          this.toast.push(
            'warning',
            'பொருள் மட்டும் நிரப்பப்பட்டது',
            'The document is too long for a mail link and the clipboard was blocked. Tap "உரையை நகலெடு", then long-press the message body and tap Paste.',
            0
          );
        }

        // Same-tab navigation, not window.open: the mail app takes over the
        // foreground and a popped-open tab would be left behind empty.
        window.location.href = this.buildMailtoUrl(bodyFitsInUrl);
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

  /**
   * Copy the plain-text document — handy when pasting into Gmail by hand.
   * Uses the email projection, since pasting into a message is what it is for.
   */
  async copyText(): Promise<void> {
    if (!this.canExport()) {
      return;
    }

    if (await this.writeToClipboard(this.emailBody())) {
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
    return `${base}&body=${encodeURIComponent(this.emailBody())}`;
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
    return `${base}&body=${encodeURIComponent(this.emailBody())}`;
  }

  /**
   * The document as an email body: no From/To blocks and no subject line,
   * since the message already carries all three in its own headers.
   */
  private emailBody(): string {
    return this.rti.buildPlainTextPetition(false);
  }

  /**
   * Attachment names with collisions broken, positionally matching
   * {@link attachments}.
   *
   * A gallery hands back several photos called IMG_0001.jpg often enough that
   * both export routes need this: inside a ZIP the later one would overwrite
   * the earlier, and on a mail compose two identically named attachments are
   * impossible to tell apart.
   */
  private uniqueAttachmentNames(): string[] {
    const used = new Set<string>();

    return this.attachments().map((file) => {
      let name = file.name;
      let counter = 2;
      while (used.has(name)) {
        name = file.name.replace(/(\.[^.]+)?$/, `-${counter}$1`);
        counter++;
      }
      used.add(name);
      return name;
    });
  }

  /**
   * Hand the draft to the OS share sheet, attachments and all.
   *
   * This is the only route by which a photo actually reaches the message. A
   * `mailto:` link and a Gmail compose URL both carry text and nothing else,
   * so an attached image could only ever be *named* in the body — which is
   * what the "இணைப்புகள்" list at the end of the text does. `navigator.share`
   * passes real `File` objects instead, and Gmail, the target these advocates
   * pick, turns them into attachments on a fresh compose.
   *
   * It also sidesteps the length problem entirely: there is no URL here, so
   * the whole petition travels however long it is.
   *
   * @returns 'shared' on success, 'cancelled' when the advocate dismissed the
   *   sheet, 'unsupported' when this browser cannot share files at all — only
   *   the last of which should fall back to a mail link.
   */
  private async shareWithAttachments(): Promise<'shared' | 'cancelled' | 'unsupported'> {
    if (!navigator.canShare || !navigator.share) {
      return 'unsupported';
    }

    const names = this.uniqueAttachmentNames();
    const payload: ShareData = {
      // Chrome maps `title` to EXTRA_SUBJECT, so Gmail opens with the subject
      // already filled in, exactly as the mailto path does.
      title: this.subject() || this.heading(),
      text: this.emailBody(),
      files: this.attachments().map(
        (file, i) => new File([file.blob], names[i], { type: file.type || 'application/octet-stream' })
      )
    };

    // canShare() is the only honest test: file sharing is refused per payload
    // (by type and by total size), not per browser.
    if (!navigator.canShare(payload)) {
      return 'unsupported';
    }

    try {
      await navigator.share(payload);
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'cancelled';
      }
      console.error('[ExportActions] share sheet failed:', err);
      return 'unsupported';
    }
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
