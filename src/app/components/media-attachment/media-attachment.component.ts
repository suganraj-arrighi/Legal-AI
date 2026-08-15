import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { environment } from '../../../environments/environment';
import { CompressionOptions, RtiAttachment } from '../../models/rti.models';
import { RtiService } from '../../services/rti.service';
import { ToastService } from '../../services/toast.service';

/**
 * Step 4 — attachments with client-side image compression.
 *
 * Images are re-drawn onto a `<canvas>` at a bounded size and re-encoded as
 * JPEG. Every stage is wrapped in try/catch: if a file is corrupt, an exotic
 * format (HEIC), or simply too large to decode, we fall back to the original
 * bytes and tell the advocate — we never drop his evidence silently.
 */
@Component({
  selector: 'app-media-attachment',
  standalone: true,
  templateUrl: './media-attachment.component.html',
  styleUrls: ['./media-attachment.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MediaAttachmentComponent {
  private readonly rti = inject(RtiService);
  private readonly toast = inject(ToastService);

  private readonly options: CompressionOptions = environment.compression;

  /** Highlight state for the drag-and-drop zone. */
  readonly isDragging = signal(false);

  /** True while the canvas pipeline is chewing through a batch. */
  readonly isProcessing = signal(false);

  /** "3 / 7" progress label during a batch. */
  readonly progress = signal<{ done: number; total: number } | null>(null);

  readonly attachments = this.rti.attachments;
  readonly totalOriginal = this.rti.totalOriginalSize;
  readonly totalCompressed = this.rti.totalCompressedSize;

  /** Aggregate percentage saved, shown as the headline benefit. */
  readonly savedPercent = computed(() => {
    const before = this.totalOriginal();
    const after = this.totalCompressed();
    if (before <= 0 || after >= before) {
      return 0;
    }
    return Math.round(((before - after) / before) * 100);
  });

  /* ----------------------------- Input events ---------------------------- */

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    const files = event.dataTransfer?.files;
    if (files?.length) {
      void this.handleFiles(Array.from(files));
    }
  }

  onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
      void this.handleFiles(Array.from(input.files));
    }
    // Reset so selecting the same file twice still fires a change event.
    input.value = '';
  }

  remove(id: string): void {
    this.rti.removeAttachment(id);
  }

  removeAll(): void {
    if (this.attachments().length && confirm('அனைத்து இணைப்புகளையும் நீக்கவா? / Remove all attachments?')) {
      this.rti.clearAttachments();
    }
  }

  formatBytes(bytes: number): string {
    return this.rti.formatBytes(bytes);
  }

  /** Per-file saving, e.g. "-92%". Returns 0 when nothing was saved. */
  savingFor(file: RtiAttachment): number {
    if (file.originalSize <= 0 || file.compressedSize >= file.originalSize) {
      return 0;
    }
    return Math.round(((file.originalSize - file.compressedSize) / file.originalSize) * 100);
  }

  /* --------------------------- Processing pipeline ----------------------- */

  /**
   * Validate, compress and store a batch of files. Files are handled one at a
   * time so a 20-photo drop cannot freeze the tab.
   */
  private async handleFiles(files: File[]): Promise<void> {
    this.isProcessing.set(true);
    this.progress.set({ done: 0, total: files.length });

    const accepted: RtiAttachment[] = [];
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // --- Guard: absurdly large files would lock up the canvas -----------
      if (file.size > this.options.maxFileBytes) {
        skipped++;
        this.toast.warning(
          'கோப்பு மிகப் பெரியது',
          `"${file.name}" (${this.formatBytes(file.size)}) exceeds the ${this.formatBytes(
            this.options.maxFileBytes
          )} limit and was skipped.`
        );
        this.progress.set({ done: i + 1, total: files.length });
        continue;
      }

      // --- Guard: empty/unreadable placeholder -----------------------------
      if (file.size === 0) {
        skipped++;
        this.toast.warning('காலி கோப்பு', `"${file.name}" is empty and was skipped.`);
        this.progress.set({ done: i + 1, total: files.length });
        continue;
      }

      accepted.push(await this.toAttachment(file));
      this.progress.set({ done: i + 1, total: files.length });
    }

    if (accepted.length) {
      this.rti.addAttachments(accepted);
      const compressedCount = accepted.filter((a) => a.wasCompressed).length;
      this.toast.success(
        `${accepted.length} இணைப்பு சேர்க்கப்பட்டது`,
        compressedCount
          ? `${compressedCount} image(s) compressed. Total package: ${this.formatBytes(this.totalCompressed())}.`
          : 'Files added without compression.'
      );
    } else if (!skipped) {
      this.toast.info('எதுவும் சேர்க்கப்படவில்லை', 'No usable files were found in that selection.');
    }

    this.isProcessing.set(false);
    this.progress.set(null);
  }

  /** Turn a raw File into an RtiAttachment, compressing images when useful. */
  private async toAttachment(file: File): Promise<RtiAttachment> {
    const isImage = file.type.startsWith('image/');
    const id = this.makeId();

    // Non-images (PDF, DOCX, audio…) pass straight through — compressing them
    // client-side is out of scope and would risk corrupting evidence.
    if (!isImage) {
      return {
        id,
        name: file.name,
        type: file.type || 'application/octet-stream',
        originalSize: file.size,
        compressedSize: file.size,
        blob: file,
        previewUrl: null,
        wasCompressed: false,
        note: 'படம் அல்ல — அப்படியே சேர்க்கப்பட்டது / Not an image, stored as-is',
        isImage: false
      };
    }

    // SVG and GIF: rasterising them loses animation/vector fidelity.
    if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
      return this.passthrough(id, file, 'இந்த வடிவம் சுருக்கப்படவில்லை / Format kept unchanged', true);
    }

    // Already small enough — re-encoding could even make it bigger.
    if (file.size <= this.options.skipBelowBytes) {
      return this.passthrough(id, file, 'ஏற்கனவே சிறியது / Already small', true);
    }

    try {
      const compressed = await this.compressImage(file);

      // Guard against the pathological case where JPEG re-encoding grows the
      // file (happens with flat-colour PNG screenshots).
      if (compressed.size >= file.size) {
        return this.passthrough(id, file, 'சுருக்கம் பயனளிக்கவில்லை / Compression gave no benefit', true);
      }

      return {
        id,
        name: this.toJpegName(file.name),
        type: 'image/jpeg',
        originalSize: file.size,
        compressedSize: compressed.size,
        blob: compressed,
        previewUrl: URL.createObjectURL(compressed),
        wasCompressed: true,
        isImage: true
      };
    } catch (err) {
      // Requirement: corrupted image → skip compression, use the original,
      // and tell the user rather than failing the whole batch.
      console.error('[MediaAttachment] compression failed for', file.name, err);
      this.toast.warning(
        'சுருக்க முடியவில்லை',
        `"${file.name}" could not be compressed (it may be corrupt or in an unsupported format). The original file was attached instead.`
      );
      return this.passthrough(id, file, 'சுருக்கம் தோல்வி — அசல் பயன்படுத்தப்பட்டது / Compression failed, original used', true);
    }
  }

  /**
   * The actual Canvas API compression.
   *
   * 1. Decode the file (createImageBitmap, falling back to <img> + object URL
   *    for browsers/formats where bitmap decoding is unavailable).
   * 2. Scale down so neither side exceeds maxWidth/maxHeight, preserving ratio.
   * 3. Paint onto a white background (JPEG has no alpha channel).
   * 4. Re-encode as JPEG at the configured quality.
   */
  private async compressImage(file: File): Promise<Blob> {
    const source = await this.decode(file);

    try {
      const { width, height } = this.fitWithin(
        source.width,
        source.height,
        this.options.maxWidth,
        this.options.maxHeight
      );

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('2D canvas context unavailable (hardware acceleration disabled?)');
      }

      // Better downscale quality than the default nearest-neighbour-ish path.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Flatten transparency onto white so PNGs do not turn black as JPEG.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(source.image as CanvasImageSource, 0, 0, width, height);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', this.options.quality)
      );

      if (!blob) {
        // toBlob returns null on tainted canvases or out-of-memory.
        throw new Error('canvas.toBlob() returned null');
      }
      return blob;
    } finally {
      // Always release decoder resources, success or failure.
      source.release();
    }
  }

  /** Decode a File into something drawable, with a graceful fallback path. */
  private async decode(
    file: File
  ): Promise<{ image: ImageBitmap | HTMLImageElement; width: number; height: number; release: () => void }> {
    // Preferred: off-main-thread decode, no object URL needed.
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        return {
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: () => bitmap.close()
        };
      } catch (err) {
        console.warn('[MediaAttachment] createImageBitmap failed, falling back to <img>:', err);
      }
    }

    // Fallback: classic <img> decode via object URL.
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(`Browser could not decode "${file.name}"`));
        element.src = url;
      });

      if (!img.naturalWidth || !img.naturalHeight) {
        throw new Error(`Decoded image has zero dimensions ("${file.name}")`);
      }

      return {
        image: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url)
      };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  /* ------------------------------- Helpers ------------------------------- */

  /** Store a file unchanged, still reporting it in the size table. */
  private passthrough(id: string, file: File, note: string, isImage: boolean): RtiAttachment {
    return {
      id,
      name: file.name,
      type: file.type || 'application/octet-stream',
      originalSize: file.size,
      compressedSize: file.size,
      blob: file,
      previewUrl: isImage ? URL.createObjectURL(file) : null,
      wasCompressed: false,
      note,
      isImage
    };
  }

  /** Contain-fit `w x h` inside `maxW x maxH` without upscaling. */
  private fitWithin(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
    const ratio = Math.min(maxW / w, maxH / h, 1);
    return {
      width: Math.max(1, Math.round(w * ratio)),
      height: Math.max(1, Math.round(h * ratio))
    };
  }

  /** photo.png → photo.jpg (the bytes really are JPEG after compression). */
  private toJpegName(name: string): string {
    return name.replace(/\.[^.]+$/, '') + '.jpg';
  }

  private makeId(): string {
    // crypto.randomUUID is unavailable on http:// origins in some browsers.
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
