import { documentTemplate } from './template.js';

/** Render a normalized article document into deterministic, printable HTML. */
export function renderDocument(document = {}) {
  return documentTemplate({
    metadata: document.metadata ?? document,
    content: document.content ?? '',
    figures: Array.isArray(document.figures) ? document.figures : [],
  });
}

export default renderDocument;
