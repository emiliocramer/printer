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

Intermediate HTML and asset files are removed automatically after a successful CLI run. The output directory therefore contains PDFs only.

For sites that require an interactive browser challenge, omit `--no-preview` or use the client-capture path when prompted:

```bash
printer print https://example.com/article
```

## What it preserves

- Article title, author, and publication date
- Headings, paragraphs, lists, tables, equations, quotations, and code
- Meaningful source images, SVGs, GIFs, and other visual assets
- Lazy-loaded graphics and responsive source media
- Interactive event timelines reconstructed as readable semantic cards
- Wide timelines and charts split into portrait-friendly panels

## Print conventions

- Letter portrait
- Consistent 1-inch left and right margins for hole punching
- White, graphic-free cover page with title, author, and date
- Article graphics constrained to the same printable column
- No visible URL decorations or web publication chrome
- Page numbers in the footer

## Development

```bash
npm test
```

The test suite covers capture fallbacks, extraction cleanup, metadata, asset localization, timeline reconstruction, portrait layout, X article handling, and PDF generation orchestration.

## Scope

The tool accepts public HTTP(S) URLs. Some sites deliberately block automated access or require account authentication; those may require completing a browser verification step. The extractor prefers faithful source content over inventing missing metadata or graphics.
