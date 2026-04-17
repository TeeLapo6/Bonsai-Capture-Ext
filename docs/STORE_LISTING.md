# Chrome Web Store Submission — Bonsai Capture

## Single Purpose Description

> Bonsai Capture extracts and normalizes AI chat conversations from ChatGPT, Claude, Gemini, and Grok so they can be imported into the Bonsai workflow engine for branching, merging, and replay.

## Detailed Description (Store Listing)

Bonsai Capture is a developer tool that captures the full structure of AI chat conversations — including messages, code blocks, artifacts, generated images, and research reports — and normalizes them into a portable format for the Bonsai execution engine.

**Supported Providers:**
• ChatGPT (chatgpt.com, chat.openai.com) — including Deep Research reports
• Claude (claude.ai) — including Artifacts
• Gemini (gemini.google.com) — including Canvas and generated video
• Grok (grok.com)

**How It Works:**
1. Navigate to any supported AI chat page.
2. Click the Bonsai Capture icon to open the side panel.
3. Select individual messages or capture entire conversations.
4. Export to your local Bonsai instance.

**Key Features:**
• Preserves conversation tree structure, not just flat text
• Captures inline images, generated video, code blocks, and artifacts
• Extracts ChatGPT Deep Research reports from sandbox frames
• All data stays on your device — nothing is sent to external servers
• Side panel UI for non-intrusive workflow integration

**This extension is designed for developers and AI researchers who use Bonsai to manage conversation histories as executable workflow graphs.**

## Permission Justifications (Submission Form)

Use the following text when the Chrome Web Store review form asks you to justify each permission and host:

---

### `activeTab`
Required to access the currently active tab when the user clicks the extension icon. The extension only activates on supported AI chat sites.

### `scripting`
Used to inject a research probe script into ChatGPT Deep Research sandbox iframes (hosted on oaiusercontent.com) at document_start. This probe captures research report data that is otherwise inaccessible due to cross-origin isolation.

### `sidePanel`
The extension's entire UI is rendered as a Chrome side panel. This is the primary interaction surface.

### `storage` + `unlimitedStorage`
Captured conversations include embedded media (images, videos) stored as data URLs, which can be large. All storage is local to the user's device. The extension retains up to 50 captures in a rolling window.

### `declarativeNetRequest`
Used to temporarily set Origin and Referer request headers when the background service worker fetches AI-generated media (videos, images) from provider CDNs that enforce CORS. Dynamic rules are created per-request and removed immediately after each fetch completes. No persistent rules are installed.

### `clipboardRead`
Fallback method for extracting Claude artifact source code. When DOM-based extraction fails (due to React fiber inaccessibility or Radix UI blocking synthetic clicks), the extension triggers Claude's native "Copy" button and reads the resulting clipboard content. This only activates on claude.ai and only when other capture methods are exhausted.

---

### Host permissions: `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, `grok.com`
These are the AI chat provider sites that the extension captures conversations from. Content scripts run only on these domains to extract conversation structure from the page DOM.

### Host permission: `*.oaiusercontent.com`
OpenAI hosts Deep Research sandbox content and user-uploaded files on this domain. The extension's probe content script runs in these frames (at document_start, all_frames: true) to intercept research report data. The background worker also fetches images and files from this CDN.

### Host permission: `*.googleusercontent.com`
Google hosts AI-generated video and image assets on this CDN (e.g., video.googleusercontent.com). The background service worker fetches these resources with the user's credentials to preserve generated media in captures.

### Host permission: `*.usercontent.google.com`
Gemini serves canvas/artifact content from this domain (e.g., contribution.usercontent.google.com). The background worker fetches this content to preserve artifacts in the capture.

---

## Category

**Developer Tools**

## Language

English

## Privacy Policy URL

Host the content of `docs/PRIVACY_POLICY.md` at a publicly accessible URL and provide it during submission. Options:
- GitHub Pages: `https://<username>.github.io/Bonsai-Capture-Ext/PRIVACY_POLICY`
- Raw GitHub: `https://github.com/<org>/Bonsai-Capture-Ext/blob/main/docs/PRIVACY_POLICY.md`
- Dedicated page on your domain

## Screenshots Needed

The Chrome Web Store requires 1–5 screenshots (1280×800 or 640×400).

Recommended screenshots:
1. **Side panel open on ChatGPT** — showing a captured conversation with code blocks
2. **Side panel open on Claude** — showing an artifact capture
3. **Insert buttons on messages** — showing the Bonsai-branded action buttons injected into the chat UI
4. **Capture list view** — showing multiple stored captures in the side panel
5. **Export/connection flow** — showing the export to local Bonsai instance

## Promotional Images

- Small tile (440×280): Required
- Marquee (1400×560): Optional but recommended

## Review Tips

- The review team may test on chatgpt.com, claude.ai, or gemini.google.com. Ensure the extension works without authentication to the extent possible (at minimum, the side panel should open and the content script should load without errors on the login page).
- If asked about `declarativeNetRequest` header modification, emphasize that rules are ephemeral (created and removed per-request) and only target specific media URLs, not broad patterns.
- The `externally_connectable` section is restricted to localhost — this is standard for local development tools and should not raise flags.
