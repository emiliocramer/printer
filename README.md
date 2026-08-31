# printer

Turn readable public web pages into clean, portrait-first PDFs for printing.

## Setup

```sh
npm install
npx playwright install chromium
```

## Use

```sh
node src/cli.js print https://example.com/article
```

The command opens a local preview and writes:

- `~/Documents/printer/<slug>.pdf`
- `~/Documents/printer/<slug>/index.html`
- `~/Documents/printer/<slug>/styles.css`
- `~/Documents/printer/<slug>/assets/`

Use `--no-preview` for unattended runs. Set `PRINTER_OUTPUT_DIR` to change the output directory. The preview is the same HTML that Chromium prints, so page breaks, figures, captions, and typography can be checked before printing.

## Rendering behavior

The pipeline loads client-rendered pages, removes navigation and subscription chrome, extracts readable content, preserves semantic rich content and meaningful figures, localizes downloadable images, and adds a provenance page. Wide charts and timelines are marked for portrait panel treatment; ordinary figures remain intact. Inline links stay readable while the source URL remains on the provenance page.

It can fall back from a browser interstitial to a direct public HTML request. It does not bypass authentication, paywalls, bot challenges, or private browser sessions; those pages currently require a public URL or an authenticated export workflow outside this CLI.

## Test

```sh
npm test
```
