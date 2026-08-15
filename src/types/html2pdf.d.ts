/**
 * Ambient module declaration for `html2pdf.js`, which ships no TypeScript
 * types. We model the fluent/chainable API surface we actually use.
 */
declare module 'html2pdf.js' {
  export interface Html2PdfOptions {
    /** Page margin in the unit given by `jsPDF.unit` — [top, left, bottom, right] or a single number. */
    margin?: number | [number, number] | [number, number, number, number];
    filename?: string;
    image?: { type?: 'jpeg' | 'png' | 'webp'; quality?: number };
    /** Passed straight through to html2canvas. */
    html2canvas?: {
      scale?: number;
      useCORS?: boolean;
      allowTaint?: boolean;
      backgroundColor?: string | null;
      logging?: boolean;
      letterRendering?: boolean;
      windowWidth?: number;
    };
    /** Passed straight through to jsPDF. */
    jsPDF?: {
      unit?: 'pt' | 'mm' | 'cm' | 'in';
      format?: string | [number, number];
      orientation?: 'portrait' | 'landscape';
      compress?: boolean;
    };
    /** Page-break strategy, e.g. { mode: ['css', 'legacy'] }. */
    pagebreak?: { mode?: string | string[]; before?: string[]; after?: string[]; avoid?: string[] };
  }

  export interface Html2PdfWorker extends Promise<void> {
    set(options: Html2PdfOptions): Html2PdfWorker;
    from(element: HTMLElement | string, type?: 'element' | 'string' | 'canvas' | 'img'): Html2PdfWorker;
    toPdf(): Html2PdfWorker;
    save(filename?: string): Promise<void>;
    outputPdf(type?: 'blob' | 'datauristring' | 'arraybuffer'): Promise<Blob | string | ArrayBuffer>;
    output(type?: string): Promise<unknown>;
    then<TResult1 = void, TResult2 = never>(
      onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2>;
  }

  function html2pdf(): Html2PdfWorker;
  function html2pdf(element: HTMLElement | string, options?: Html2PdfOptions): Html2PdfWorker;

  export default html2pdf;
}
