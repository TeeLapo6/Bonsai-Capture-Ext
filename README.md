# Bonsai Capture

A Chrome extension (Manifest V3) that captures AI chat conversations — including artifacts, images, code, and research outputs — and exports them as structured local files.

**Landing page / install guide:** [https://taylorlaporte.me/Bonsai-Capture/](https://taylorlaporte.me/Bonsai-Capture/)

## Supported providers

| Provider | Conversations | Images | Code artifacts | Deep Research | Video / Canvas |
|---|---|---|---|---|---|
| ChatGPT | ✅ | ✅ | ✅ | ✅ | ✅ (Canvas) |
| Claude | ✅ | ✅ | ✅ | — | ✅ (Canvas) |
| Gemini | ✅ | ✅ | ✅ | ✅ | ✅ (Immersive) |
| Grok | ✅ | — | — | — | — |
| Jules | ✅ | — | ✅ | — | — |

## Features

- **Multi-provider capture** — one extension flow for ChatGPT, Claude, Gemini, Grok, and Jules
- **Artifact capture** — code artifacts, HTML previews, Claude Canvas, ChatGPT Deep Research, Gemini immersive artifacts, and generated images/video captured alongside the conversation
- **Capture scopes** — entire conversation, up to a message, this message only, or this message + following
- **Structured exports** — Markdown, HTML, JSON, TOON; YAML frontmatter, code fences, and artifact references preserved
- **Provenance** — per-message timestamps, provider, model, confidence level, and source links
- **Bulk capture** — capture and export multiple conversations at once
- **Side-panel editor** — rich text editor for refining prompts before sending back to the AI

## Quick start (load unpacked)

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build
```

Then in Chrome/Brave:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist/` folder

## Development

```bash
# Watch mode (rebuilds on save)
npm run dev

# Run unit tests
npm test

# Full test + build
npm test && npm run build
```

> **Adding new adapters:** When adding a new content adapter under `src/content/adapters/`, also update `build.js` so the script is included in the `ADAPTERS` map; otherwise the generated `manifest.json` will reference a missing `.js` file.

## Project structure

```
src/
├── background.ts              # MV3 service worker
├── config/
│   └── selectors.ts           # Per-provider CSS selectors
├── content/
│   ├── adapters/              # Provider-specific parsers
│   │   ├── interface.ts       # BaseAdapter + ProviderRegistry
│   │   ├── chatgpt.ts
│   │   ├── claude.ts
│   │   ├── gemini.ts
│   │   └── grok.ts
│   ├── capture-engine.ts      # Capture orchestration
│   └── dom-injector.ts        # In-page insert/capture buttons
├── shared/
│   ├── schema.ts              # ConversationGraph canonical types
│   └── exporters/
<<<<<<< HEAD
│       ├── html.ts
=======
>>>>>>> 5fb22e1 (docs: update README for v0.1.0 alpha launch — adds Jules, capability matrix, removes Bonsai import refs)
│       ├── markdown.ts
│       ├── json.ts
│       └── toon.ts
└── ui/
    ├── SidePanel.tsx          # Main React UI (tabs: Capture, History, Export, Bulk)
    └── styles.css
```

## Canonical schema

All captures produce a `ConversationGraph` that includes:

- **MessageNode** — role, sequence, content blocks, artifact IDs, deep link, provenance
- **ContentBlock** — `markdown` | `text` | `code` | `html` | `image_ref` | `table` | `list`
- **ArtifactNode** — `image` | `embedded_doc` | `artifact_doc` | `code_artifact` | `deep_research` | `file` | `canvas`
- **Provenance** — provider, model, confidence (`observed` | `inferred` | `unknown`)

## Export formats

| Format | Description |
|---|---|
| **Markdown** | Human-readable; role headers, code fences, YAML frontmatter |
| **HTML** | Standalone browser view with rendered artifacts and metadata |
| **JSON** | Full `ConversationGraph` serialization |
| **TOON** | Extended node-graph format for branching/evaluation workflows |

## Updating selectors

When a provider's UI changes, update `src/config/selectors.ts`. Adapters read selectors from there rather than hardcoding them.

## License

MIT
