import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgClass } from '@angular/common';

import { Toast } from '../../models/rti.models';
import { ToastService } from '../../services/toast.service';

/**
 * Fixed-position toast stack. Purely presentational — every message comes from
 * ToastService, which is the single funnel for user-facing errors.
 */
@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [NgClass],
  templateUrl: './toast-container.component.html',
  styleUrls: ['./toast-container.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToastContainerComponent {
  private readonly toastService = inject(ToastService);

  readonly toasts = this.toastService.toasts;

  dismiss(id: number): void {
    this.toastService.dismiss(id);
  }

  /** Tailwind classes per toast kind. */
  classesFor(kind: Toast['kind']): string {
    switch (kind) {
      case 'success':
        return 'border-emerald-300 bg-emerald-50 text-emerald-900';
      case 'error':
        return 'border-red-300 bg-red-50 text-red-900';
      case 'warning':
        return 'border-amber-300 bg-amber-50 text-amber-900';
      default:
        return 'border-ink-200 bg-white text-ink-900';
    }
  }

  iconFor(kind: Toast['kind']): string {
    switch (kind) {
      case 'success':
        return '✓';
      case 'error':
        return '!';
      case 'warning':
        return '⚠';
      default:
        return 'i';
    }
  }
}
