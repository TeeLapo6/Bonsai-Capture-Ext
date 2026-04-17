# Privacy Policy — Bonsai Capture

**Effective Date:** April 16, 2026
**Last Updated:** April 16, 2026

## Overview

Bonsai Capture is a browser extension that captures AI chat conversations from supported providers and stores them locally for import into the Bonsai workflow engine. This policy describes what data the extension accesses, how it is used, and how it is stored.

## Data Collection

**Bonsai Capture does not collect, transmit, or sell any personal data.**

The extension operates entirely on-device. No data leaves your browser unless you explicitly export or send it to a self-hosted Bonsai instance that you control.

### What the extension accesses

| Data Type | Source | Purpose |
|-----------|--------|---------|
| Conversation text and structure | ChatGPT, Claude, Gemini, Grok page DOM | Capturing the conversation you initiated |
| Embedded media (images, generated videos) | Provider CDN domains (oaiusercontent.com, googleusercontent.com) | Preserving inline artifacts attached to conversations |
| Clipboard content | Claude artifact copy button | Extracting raw source of Claude artifacts when other methods are unavailable |

### What the extension stores

All captured data is stored in `chrome.storage.local` on your device. The extension retains the 50 most recent captures. Older captures are automatically removed on a first-in, first-out basis.

### What the extension does NOT do

- Does not transmit data to any remote server, analytics service, or third party.
- Does not track browsing history or activity outside of supported AI chat sites.
- Does not read or modify any page content on sites other than the declared host permissions.
- Does not access your identity, email, or account credentials.
- Does not run on any page that is not explicitly listed in the manifest's content_scripts or host_permissions.

## Permissions Justification

| Permission | Reason |
|------------|--------|
| `activeTab` | Enables the extension to interact with the currently active tab when the user clicks the extension icon. |
| `scripting` | Required to inject the Deep Research probe into ChatGPT sandbox frames at `document_start` for capturing research report content. |
| `sidePanel` | The extension UI is presented as a Chrome side panel. |
| `storage` / `unlimitedStorage` | Captured conversations (including embedded media as data URLs) can be large. Local storage is used exclusively. |
| `declarativeNetRequest` | Used to set `Origin` and `Referer` headers when fetching AI-generated video and image assets from provider CDNs that enforce CORS restrictions. Rules are created dynamically per-request and removed immediately afterward. |
| `clipboardRead` | Fallback method for capturing Claude artifact source code when the artifact panel's internal state is inaccessible via DOM or React fiber inspection. The extension triggers the panel's native "Copy" button, then reads the clipboard. |

## Host Permissions

| Host | Reason |
|------|--------|
| `chatgpt.com`, `chat.openai.com` | Content scripts extract conversation structure from the ChatGPT UI. |
| `claude.ai` | Content scripts extract conversation structure from the Claude UI. |
| `gemini.google.com` | Content scripts extract conversation structure from the Gemini UI. |
| `grok.com` | Content scripts extract conversation structure from the Grok UI. |
| `*.oaiusercontent.com` | Background worker fetches images and files hosted on OpenAI's CDN. Also hosts Deep Research sandbox frames that the probe script must access. |
| `*.googleusercontent.com` | Background worker fetches AI-generated video and image assets hosted on Google's media CDN. |
| `*.usercontent.google.com` | Background worker fetches canvas/artifact content from Gemini's user content domain. |

## Data Retention

Captures are stored locally until:
- They are pushed out by newer captures (50-capture rolling window), or
- The user clears extension storage via Chrome settings, or
- The extension is uninstalled.

## Third-Party Services

Bonsai Capture does not integrate with any third-party analytics, advertising, or tracking services.

The only external communication occurs when the user explicitly exports a capture to a self-hosted Bonsai instance via the `externally_connectable` mechanism, which is restricted to `localhost` origins.

## Children's Privacy

This extension is not directed at children under 13 and does not knowingly collect information from children.

## Changes to This Policy

Updates to this policy will be reflected in the extension's documentation and this file. The "Last Updated" date at the top will be revised accordingly.

## Contact

For questions about this privacy policy, open an issue on the project's GitHub repository or contact the developer through the Chrome Web Store listing.
