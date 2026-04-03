# Bonsai Capture

A Chrome extension that captures AI chat conversations from ChatGPT, Claude, Gemini, and Grok, and exports them for import into Bonsai.

## Features

- **Universal Capture**: Works with ChatGPT, Claude, Gemini, and Grok
- **Structured Export**: Captures messages, code blocks, artifacts, and metadata
- **Multiple Export Formats**: Markdown, JSON, TOON, and Bonsai Import format
- **Side Panel Editor**: Rich text editor for refining prompts
- **Send to AI**: Send editor content directly to the chat input
- **Capture Scopes**: Entire conversation, up to message, or single message

## Development

### Prerequisites

- Node.js 18+
- npm or bun

### Setup

```bash
# Install dependencies
npm install

# Development mode (with hot reload)
npm run dev

# Build for production
npm run build
```

> **Adding new providers/adapters**
> When you add a new content adapter under `src/content/adapters`, be sure to also update
> `build.js` so that the script is included in the `ADAPTERS` map. Otherwise the
> generated `manifest.json` will reference a `.js` file that doesn't exist, leading to
> "Could not load javascript" errors when loading the unpacked extension.


### Load in Chrome

1. Build the extension: `npm run build`
2. Open Chrome and go to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `dist/` folder

### Project Structure

```
src/
├── background.ts           # Service worker
├── content/
│   ├── adapters/           # Provider-specific parsers
│   │   ├── interface.ts    # Common adapter interface
│   │   ├── chatgpt.ts      # ChatGPT adapter
│   │   ├── claude.ts       # Claude adapter
│   │   ├── gemini.ts       # Gemini adapter
│   │   └── grok.ts         # Grok adapter
│   └── capture-engine.ts   # Capture orchestration
├── config/
│   └── selectors.ts        # Configurable DOM selectors
├── shared/
│   ├── schema.ts           # Canonical ConversationGraph types
│   ├── bonsai-adapter.ts   # Bonsai import format
│   └── exporters/
│       ├── markdown.ts     # Markdown export
│       ├── json.ts         # JSON export
│       └── toon.ts         # TOON format export
└── ui/
    ├── main.tsx            # React entry point
    ├── SidePanel.tsx       # Main UI component
    └── styles.css          # Styling
```

## Canonical Schema

The extension uses a `ConversationGraph` schema that captures:

- **Messages**: Role, sequence, content blocks, artifacts
- **Content Blocks**: Text, markdown, code (with language), images, tables, lists
- **Artifacts**: Embedded docs, images, code artifacts, deep research outputs
- **Provenance**: Provider, model, confidence level

## Export Formats

### Markdown
Human-readable format with role headers, code fences, and embedded artifacts.

### JSON
Full `ConversationGraph` serialization for programmatic access.

### TOON
Extended format with node mappings for branching support.

### Bonsai Import
Ready for import into Bonsai with message/attachment mapping.

## Updating Selectors

When chat UIs change, update `src/config/selectors.ts` with new CSS selectors per provider. The adapters use these centralized selectors instead of hardcoding.

## License

MIT
