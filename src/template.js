import { classifyFigure } from './model.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function value(value, fallback = 'Not provided') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function displayDate(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 'Not provided';
  const date = new Date(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function sourceHref(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function metadataRow(label, content, className = '') {
  return `<div class="metadata-row${className ? ` ${className}` : ''}"><dt>${escapeHtml(label)}</dt><dd>${content}</dd></div>`;
}

export function provenancePage(metadata = {}) {
  const title = value(metadata.title, 'Untitled article');
  return `<section class="provenance-page academic-title-page" data-page="provenance" aria-labelledby="provenance-title">
  <div class="cover-title-block">
    <h1 id="provenance-title" class="provenance-title">${escapeHtml(title)}</h1>
    <p class="cover-author">${escapeHtml(value(metadata.author))}</p>
    <p class="cover-date">${escapeHtml(displayDate(metadata.published))}</p>
  </div>
</section>`;
}

function figureId(figure, index) {
  return String(figure.id ?? `figure-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '-');
}

function panelCount(figure) {
  const width = Number(figure.width);
  const height = Number(figure.height);
  return Number.isFinite(width) && Number.isFinite(height) && width / height >= 3 ? 3 : 2;
}

function figureCaption(caption) {
  return caption == null || String(caption).trim() === '' ? '' : `<figcaption>${escapeHtml(caption)}</figcaption>`;
}

export function renderFigure(figure = {}, index = 0) {
  const classification = classifyFigure(figure);
  const id = figureId(figure, index);
  const visual = String(figure.html ?? figure.content ?? '');
  if (classification.treatment !== 'stacked-portrait-panels') {
    return `<figure data-figure-id="${escapeHtml(id)}" data-figure-treatment="normal">${visual}${figureCaption(classification.caption)}</figure>`;
  }
  const count = panelCount(figure);
  const panels = Array.from({ length: count }, (_, panelIndex) => {
    const number = panelIndex + 1;
    if (panelIndex === 0) return `<div class="figure-panel" data-panel-index="${number}" data-panel-role="source">${visual}</div>`;
    return `<div class="figure-panel" data-panel-index="${number}" data-panel-role="continuation" data-populate-from="${escapeHtml(id)}"><span class="continuation-label">${escapeHtml(value(classification.caption, 'Figure'))} — continued (${number} of ${count})</span></div>`;
  }).join('');
  return `<figure class="wide-figure" data-figure-id="${escapeHtml(id)}" data-figure-treatment="stacked-portrait-panels" data-panel-count="${count}"><div class="figure-panels" data-panel-strategy="stacked-portrait"><!-- Browser print code may populate continuation panels without changing source prose. -->${panels}</div>${figureCaption(classification.caption)}</figure>`;
}

export function articlePage(content = '', figures = []) {
  const figureMarkup = figures.map(renderFigure).join('');
  return `<article class="article-page" data-page="article"><div class="article-content">${String(content ?? '')}${figureMarkup}</div></article>`;
}

export function documentTemplate({ metadata = {}, content = '', figures = [] } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(value(metadata.title, 'Untitled article'))}</title><link rel="stylesheet" href="./styles.css"></head><body>${provenancePage(metadata)}${articlePage(content, figures)}</body></html>`;
}
