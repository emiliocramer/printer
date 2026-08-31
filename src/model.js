const DEFAULT_WORDS_PER_MINUTE = 200;
const WIDE_FIGURE_RATIO = 1.6;

function cleanText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanOptional(value) {
  const cleaned = cleanText(value);
  return cleaned || null;
}

export function estimateReadingTime(content, wordsPerMinute = DEFAULT_WORDS_PER_MINUTE) {
  const words = cleanText(content).match(/\S+/g)?.length ?? 0;
  const rate = Number(wordsPerMinute);
  if (words === 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.ceil(words / rate);
}

export function normalizeMetadata(input = {}) {
  const source = input ?? {};
  const text = source.text ?? source.content ?? source.articleText ?? '';
  const explicitTime = Number(source.estimatedReadingTime ?? source.readingTime);
  const estimatedReadingTime = Number.isFinite(explicitTime) && explicitTime >= 0
    ? Math.ceil(explicitTime)
    : estimateReadingTime(text, source.wordsPerMinute ?? DEFAULT_WORDS_PER_MINUTE);

  return {
    title: cleanOptional(source.title) ?? 'Untitled article',
    author: cleanOptional(source.author ?? source.byline) ?? 'Unknown author',
    published: cleanOptional(source.published ?? source.publishedDate ?? source.date),
    sourceUrl: cleanOptional(source.sourceUrl ?? source.url),
    retrieved: cleanOptional(source.retrieved ?? source.retrievalDate),
    estimatedReadingTime,
  };
}

export function classifyFigure(figure = {}) {
  const width = Number(figure.width);
  const height = Number(figure.height);
  const semanticType = String(figure.semanticType ?? figure.type ?? '').trim().toLowerCase();
  const isWide = Number.isFinite(width) && Number.isFinite(height) && height > 0
    && width / height >= WIDE_FIGURE_RATIO;
  const isPanelCandidate = semanticType === 'timeline' || semanticType === 'chart';

  return {
    treatment: isWide && isPanelCandidate ? 'stacked-portrait-panels' : 'normal',
    caption: figure.caption ?? null,
  };
}
