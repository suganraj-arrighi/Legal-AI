import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

/**
 * Standalone bootstrap (no NgModules anywhere in this app).
 */
bootstrapApplication(AppComponent, appConfig).catch((err) =>
  // Last-resort guard: if bootstrap itself fails there is no Angular error
  // handler yet, so log loudly rather than showing a blank page silently.
  console.error('[AdvocateRTI] Application bootstrap failed:', err)
);
