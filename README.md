# Printer

`printer` turns a public web article into a print-ready Letter PDF.

It captures rendered pages in Chromium, removes web-only chrome, recovers readable article content, localizes images and SVG assets, reconstructs interactive timelines, and lays out the result for paper.

## Usage

```bash
npm install
npx playwright install chromium
npm run print -- https://example.com/article
```

Or, after linking the package:

```bash
npm link
printer print https://example.com/article
```

Use `printer print`, not bare `print`: `print` is a built-in command in zsh and
only echoes its arguments instead of running this CLI.

The PDF is written to:

```text
~/Documents/printer/<safe-url-slug>.pdf
```

Override the directory with `PRINTER_OUTPUT_DIR`.

Each run ends with a one-line summary and any warnings a reader would notice on paper:

```text
Wrote ~/Documents/printer/metr-org-blog-....pdf (86 pages, 33,416 words, 18 figures)
printer: warning: 1 image could not be loaded and was left out
```

Options:

- `--no-preview` skips opening the rendered document in your browser.
- `--keep-source` keeps the intermediate `index.html`, `styles.css`, and `assets/` next to the PDF for debugging. By default they are removed so the output directory contains PDFs only.

For sites that require an interactive browser challenge, omit `--no-preview` or use the client-capture path when prompted:

```bash
printer print https://example.com/article
```

## What it preserves

- Article title, author, and publication date
- Headings, paragraphs, lists, tables, equations, quotations, and code
- Meaningful source images, SVGs, GIFs, and other visual assets, placed where they appeared in the article
- Lazy-loaded graphics: the page is scrolled once during capture so deferred images resolve, and the copy the browser actually chose is saved locally
- Interactive event timelines reconstructed as readable semantic cards
- Wide timelines and charts split into portrait-friendly panels
- Video and audio embeds as a poster frame (when available) plus a printed address

## What it leaves out

- Interface icons, logos, avatars, share buttons, and other decorative graphics. Every visual is measured as it rendered in the browser; anything icon-sized or named like site furniture is dropped.
- Teasers, related-post cards, and other content that sits after the article body
- Images that fail to load. Nothing prints as a broken-image glyph.
- Responsive `srcset`/`<picture>` alternatives once a local copy exists, so the print browser cannot pick a variant that does not resolve

## Print conventions

- Letter portrait
- Consistent 1-inch left and right margins for hole punching
- White, graphic-free cover page with title, author, and date
- Article graphics constrained to the same printable column
- No visible URL decorations or web publication chrome
- Page numbers in the footer

## How a run is checked

1. Before the PDF is written, the print browser waits for every image and removes any that did not load, along with blocks left empty.
2. After the PDF is written, it is read back with pdf.js. Blank pages, pages carrying only graphics, and dropped images are reported as warnings.
3. If a site answers headless Chromium with an empty shell, the capture is retried once and then falls back to the interactive client browser.

## Development

```bash
npm test
```

The test suite covers capture fallbacks, extraction cleanup, metadata, asset localization, srcset parsing, decorative-visual filtering, inline placement of recovered figures, timeline reconstruction, portrait layout, X article handling, PDF generation orchestration, and PDF read-back.

## Scope

The tool accepts public HTTP(S) URLs. Some sites deliberately block automated access or require account authentication; those may require completing a browser verification step. The extractor prefers faithful source content over inventing missing metadata or graphics.
