import { Injectable } from '@angular/core';

/**
 * What kind of device is this?
 *
 * Only two features care, but both get the answer badly wrong if they guess:
 * the export step picks between a Gmail compose URL and a `mailto:` link, and
 * the attachment step picks between a drag-and-drop zone and separate
 * gallery/files pickers. Neither is a styling question, so a CSS breakpoint
 * cannot answer it — a narrow desktop window is still a desktop.
 */
@Injectable({ providedIn: 'root' })
export class PlatformService {
  /**
   * True on phones and tablets.
   *
   * Read once at construction: a device does not change category mid-session.
   * `maxTouchPoints` catches iPadOS 13+, which reports a desktop Safari user
   * agent and would otherwise be treated as a laptop.
   */
  readonly isMobile = PlatformService.detect();

  private static detect(): boolean {
    if (typeof navigator === 'undefined') {
      return false; // Server-side render — assume the desktop path.
    }
    const ua = navigator.userAgent;
    if (/Android|iPhone|iPod|IEMobile|Opera Mini/i.test(ua)) {
      return true;
    }
    return /iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  }
}
