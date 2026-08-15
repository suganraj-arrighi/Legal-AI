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

  /**
   * True on iPhone, iPad and iPod — including the iPadOS 13+ disguise.
   *
   * Split out from {@link isMobile} because the two mobile platforms disagree
   * sharply on how much of a `mailto:` body survives the trip to the mail app:
   * Android passes the whole URI through an Intent and copes with tens of
   * kilobytes, while iOS hands it to Mail through a URL open that gives up far
   * sooner. The export step budgets for each separately.
   */
  readonly isIos = PlatformService.detectIos();

  private static detect(): boolean {
    if (typeof navigator === 'undefined') {
      return false; // Server-side render — assume the desktop path.
    }
    const ua = navigator.userAgent;
    if (/Android|iPhone|iPod|IEMobile|Opera Mini/i.test(ua)) {
      return true;
    }
    return PlatformService.detectIos();
  }

  private static detectIos(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }
    const ua = navigator.userAgent;
    if (/iPhone|iPod/i.test(ua)) {
      return true;
    }
    // iPadOS 13+ reports a desktop Safari user agent; only the touch points
    // give it away.
    return /iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  }
}
