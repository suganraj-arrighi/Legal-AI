import { provideHttpClient, withFetch } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  importProvidersFrom,
  inject,
  provideZoneChangeDetection
} from '@angular/core';
import { QuillModule } from 'ngx-quill';

import { ToastService } from './services/toast.service';

/**
 * Toolbar shown above the Quill editor. Deliberately small: an advocate needs
 * bold/italic/underline, numbered clauses, indentation and alignment — nothing
 * that could inject media the PDF pipeline cannot render.
 */
export const QUILL_TOOLBAR = [
  ['bold', 'italic', 'underline'],
  [{ list: 'ordered' }, { list: 'bullet' }],
  [{ indent: '-1' }, { indent: '+1' }],
  [{ align: [] }],
  [{ header: [2, 3, false] }],
  ['clean']
];

/**
 * Global error handler.
 *
 * Anything that escapes a component's own try/catch still reaches the advocate
 * as a toast rather than a frozen screen.
 */
class GlobalErrorHandler implements ErrorHandler {
  private readonly toast = inject(ToastService);

  handleError(error: unknown): void {
    console.error('[AdvocateRTI] Uncaught error:', error);
    const detail = error instanceof Error ? error.message : String(error);
    this.toast.error('எதிர்பாராத பிழை', `Unexpected error: ${detail}`);
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    // Coalescing keeps the mic's high-frequency interim events cheap.
    provideZoneChangeDetection({ eventCoalescing: true }),

    // `withFetch` gives us the modern fetch backend (better abort semantics).
    provideHttpClient(withFetch()),

    // ngx-quill still ships an NgModule; bridge it into the standalone config.
    importProvidersFrom(
      QuillModule.forRoot({
        modules: { toolbar: QUILL_TOOLBAR },
        theme: 'snow',
        // Strip pasted styling so the PDF stays clean.
        formats: [
          'bold',
          'italic',
          'underline',
          'list',
          'indent',
          'align',
          'header',
          'link'
        ]
      })
    ),

    { provide: ErrorHandler, useClass: GlobalErrorHandler }
  ]
};
