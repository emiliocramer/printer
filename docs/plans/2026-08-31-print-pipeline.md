# Pretty Print Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local `print <URL>` CLI that extracts readable web documents, preserves meaningful visual assets, previews a portrait-first print layout, and writes a polished PDF plus provenance artifacts to `~/Documents/printer`.

**Architecture:** A Bun/Node CLI uses Playwright Chromium for page loading and PDF generation, Mozilla Readability for article extraction, and a normalized document model for deterministic rendering. The renderer keeps article prose unchanged, classifies visual blocks, adds a provenance page, and applies portrait-first pagination with explicit continuation for wide figures.

**Tech Stack:** Node.js ESM, Playwright, @mozilla/readability, jsdom, Vitest or Node test runner, HTML/CSS print layout, Chromium PDF.

---

### Task 1: Establish the document contract

**Files:**
- Create: `package.json`
- Create: `src/model.js`
- Create: `test/model.test.js`

**Step 1:** Write failing tests for normalized metadata, provenance fields, and figure layout decisions.

**Step 2:** Run the focused tests and confirm failure because the model module is absent.

**Step 3:** Implement the smallest pure model helpers.

**Step 4:** Run focused tests and confirm pass.

### Task 2: Build extraction and asset collection

**Files:**
- Create: `src/extract.js`
- Create: `test/extract.test.js`

**Step 1:** Write failing tests using fixture HTML for title/byline/date, article body, image, SVG, table, quote, and canonical URL.

**Step 2:** Run focused tests and confirm failure.

**Step 3:** Implement browser-independent Readability extraction plus asset URL normalization.

**Step 4:** Run focused tests and confirm pass.

### Task 3: Add deterministic print renderer

**Files:**
- Create: `src/render.js`
- Create: `src/template.js`
- Create: `src/styles.css`
- Create: `test/render.test.js`

**Step 1:** Write failing tests for provenance page ordering, article content preservation, print metadata, and portrait figure continuation markup.

**Step 2:** Run focused tests and confirm failure.

**Step 3:** Implement HTML rendering and CSS page rules.

**Step 4:** Run focused tests and confirm pass.

### Task 4: Wire CLI preview and PDF output

**Files:**
- Create: `src/cli.js`
- Create: `src/browser.js`
- Modify: `package.json`
- Create: `test/cli.test.js`

**Step 1:** Write failing tests for URL validation, output slugging, and output location.

**Step 2:** Run focused tests and confirm failure.

**Step 3:** Implement `print <URL>`, local preview server, Chromium PDF output, and saved HTML/assets.

**Step 4:** Run focused tests and confirm pass.

### Task 5: Exercise live references and iterate

**Files:**
- Modify: `src/styles.css`, `src/render.js`, or extraction modules as evidence requires.
- Create: `scripts/render-fixtures.mjs`

**Step 1:** Render the five supplied URLs and inspect generated PDFs/preview screenshots.

**Step 2:** Render two additional recent long-form articles selected for visual diversity.

**Step 3:** Fix concrete layout failures: missing assets, bad page breaks, unreadable wide charts, orphan headings, footnote placement, or navigation leakage.

**Step 4:** Re-render all references and retain only evidence-backed refinements.

### Task 6: Verify delivery

**Files:**
- Modify: `README.md`

**Step 1:** Run focused tests, full tests, and one live smoke render.

**Step 2:** Confirm PDF files and provenance artifacts exist under `~/Documents/printer`.

**Step 3:** Review branch diff and document known unsupported surfaces honestly.
