# Bonsai Capture — PRD

## Original problem statement
> In this repo I have an application that captures Claude conversations and their artifacts. I want to capture the interactive html blocks that are rendered in the div elements with a id "vis-container".

## Architecture

Chrome MV3 extension. Side panel (React) + background service worker + per-provider content scripts (`chatgpt`, `claude`, `gemini`, `grok`).
Captured conversations are normalised into a `ConversationGraph` with `MessageNode` + `ArtifactNode` and exported to Markdown / HTML / JSON / TOON.

## What was implemented (2026-01)

- **New artifact type**: `interactive_html` added to `ArtifactType` (`src/shared/schema.ts`).
- **Cross-frame extractor**: `EXTRACT_VIS_CONTAINERS` message handler in `src/background.ts` uses `chrome.scripting.executeScript({ allFrames: true })` to query `<div id="vis-container">` in every frame of the active tab — including the cross-origin Claude artifact iframe (`claudeusercontent.com`). It clones each match, walks the tree and inlines a curated set of computed CSS properties onto every descendant, and returns a self-contained snapshot.
- **Manifest**: added `https://*.claudeusercontent.com/*` to `host_permissions` so background scripting can reach the iframe.
- **Claude adapter**: new `captureVisContainerArtifacts()` method invoked at the end of `parseArtifacts()`. Each returned snapshot becomes an `ArtifactNode { type: 'interactive_html', mime_type: 'text/html', content: <html with inlined styles> }`.
- **Exporters**:
  - HTML (`render-preview-html.ts`): renders the snapshot in an `<iframe sandbox="allow-scripts" srcdoc="...">` so the visualization is interactive in the export, with a `<details>` block for the raw source.
  - Markdown (`markdown.ts`): emits a fenced `\`\`\`html` block.
  - JSON / TOON: covered automatically because they serialize the schema directly.
- **Tests**: two new vitest cases in `src/content/adapters/claude.test.ts` validating the messaging round-trip and graceful fallback.

## Test status (2026-01)

- Vitest: 66 pass / 3 fail. The 3 failures are pre-existing baseline failures (chatgpt bulk loading timeout, claude code-artifact appendix linkage, render-regression artifact-only message) and exist on the un-modified `main` branch — confirmed via `git stash` baseline run. Not introduced by this change.
- TypeScript: `tsc --noEmit` clean.
- Build: `npm run build` produces `dist/` with `EXTRACT_VIS_CONTAINERS`, `interactive_html`, and `claudeusercontent.com` correctly bundled.

## Backlog / next ideas

- P1: capture computed styles from `<style>` and `<link rel=stylesheet>` inside the iframe in addition to inline computed styles, for higher visual fidelity.
- P1: add a screenshot fallback (canvas + html2canvas style) for very complex visualisations.
- P2: surface a UI control in the side panel to enable/disable interactive HTML capture per-conversation.
- P2: extend the same extractor to ChatGPT canvas / Gemini immersive interactive blocks if they ever expose a similar `vis-container` convention.
