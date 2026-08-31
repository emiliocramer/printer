import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFigure,
  estimateReadingTime,
  normalizeMetadata,
} from '../src/model.js';

test('normalizes metadata with stable defaults and derived reading time', () => {
  const metadata = normalizeMetadata({
    title: '  A useful article  ',
    author: '  Ada Lovelace ',
    published: ' 2026-08-30 ',
    sourceUrl: ' https://example.com/article ',
    retrieved: '2026-08-31',
    text: 'one two three four five',
  });

  assert.deepEqual(metadata, {
    title: 'A useful article',
    author: 'Ada Lovelace',
    published: '2026-08-30',
    sourceUrl: 'https://example.com/article',
    retrieved: '2026-08-31',
    estimatedReadingTime: 1,
  });

  assert.deepEqual(normalizeMetadata({}), {
    title: 'Untitled article',
    author: 'Unknown author',
    published: null,
    sourceUrl: null,
    retrieved: null,
    estimatedReadingTime: 0,
  });
});

test('estimates reading time from readable words and ignores markup', () => {
  assert.equal(estimateReadingTime('<p>one two</p> <p>three</p>', 2), 2);
  assert.equal(estimateReadingTime('one two three', 200), 1);
  assert.equal(estimateReadingTime(' <div> </div> '), 0);
});

test('classifies wide timelines and charts as stacked portrait panels', () => {
  assert.deepEqual(
    classifyFigure({ width: 1600, height: 700, type: 'timeline', caption: 'Key events' }),
    { treatment: 'stacked-portrait-panels', caption: 'Key events' },
  );
  assert.deepEqual(
    classifyFigure({ width: 1400, height: 600, semanticType: 'chart', caption: 'Results' }),
    { treatment: 'stacked-portrait-panels', caption: 'Results' },
  );
  assert.deepEqual(
    classifyFigure({ width: 1600, height: 700, type: 'photo', caption: 'Landscape' }),
    { treatment: 'normal', caption: 'Landscape' },
  );
  assert.deepEqual(
    classifyFigure({ width: 700, height: 500, type: 'chart', caption: 'Small chart' }),
    { treatment: 'normal', caption: 'Small chart' },
  );
});
