import { Injectable, signal } from '@angular/core';
import { Toast, ToastKind } from '../models/rti.models';

/**
 * Tiny signal-backed toast queue.
 *
 * Every user-facing error in the app funnels through here so that no failure
 * path is ever a silent `console.error`. Rendered by ToastContainerComponent.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;

  /** Read-only view consumed by the container component. */
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  /** Handles kept so we can clear timers if a toast is dismissed early. */
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  success(title: string, detail?: string): number {
    return this.push('success', title, detail, 4000);
  }

  info(title: string, detail?: string): number {
    return this.push('info', title, detail, 4000);
  }

  warning(title: string, detail?: string): number {
    return this.push('warning', title, detail, 7000);
  }

  /** Errors stay on screen longer — the advocate must be able to read them. */
  error(title: string, detail?: string): number {
    return this.push('error', title, detail, 9000);
  }

  push(kind: ToastKind, title: string, detail?: string, timeoutMs = 5000): number {
    const id = this.nextId++;
    const toast: Toast = { id, kind, title, detail, timeoutMs };

    // Cap the stack so a burst of failures cannot cover the whole screen.
    this._toasts.update((list) => [...list, toast].slice(-4));

    if (timeoutMs > 0) {
      this.timers.set(
        id,
        setTimeout(() => this.dismiss(id), timeoutMs)
      );
    }
    return id;
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }

  clear(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this._toasts.set([]);
  }
}
