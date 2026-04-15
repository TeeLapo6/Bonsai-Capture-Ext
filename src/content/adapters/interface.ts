/**
 * Provider Adapter Interface
 * 
 * Common interface that all provider-specific adapters must implement.
 * This enables consistent capture behavior across ChatGPT, Claude, Gemini, Grok.
 */

import type {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ConversationGraph,
    ContentBlock
} from '../../shared/schema';
import type { ProviderCaptureSettings } from '../../shared/capture-settings';
import { createMarkdownBlock } from '../../shared/schema';

export interface SidebarItem {
    id: string;
    title: string;
    url: string;
    /** Populated when the conversation belongs to a ChatGPT Project (or equivalent). */
    projectName?: string;
    /** Project page URL used to reopen and scroll project conversation lists during bulk capture. */
    projectUrl?: string;
}

export interface ProjectInfo {
    /** URL of the project page, e.g. https://chatgpt.com/g/g-p-{hash}-{slug}/project */
    url: string;
    /** Human-readable project name extracted from the sidebar */
    name: string;
}

export interface ParsedConversation {
    url: string;
    container: Element;
    title?: string;
}

export interface ExtractedFrameContent {
    frameId?: number;
    url: string;
    title: string;
    text: string;
    html: string;
    isTop: boolean;
}

export interface OpenAIProbeEntry {
    kind: string;
    url: string;
    contentType?: string;
    body: string;
    timestamp: number;
    status?: number;
}

export interface OpenAIProbeSnapshot {
    frameId?: number;
    url: string;
    title: string;
    isTop: boolean;
    bodyText: string;
    bodyHtml: string;
    entries: OpenAIProbeEntry[];
}

export interface ProviderAdapter {
    /** Name of the provider for logging/diagnostics */
    readonly providerName: string;

    /** The site this adapter handles */
    readonly providerSite: string;

    /**
     * Detect if this adapter can handle the current page.
     * Returns conversation metadata if found, null otherwise.
     */
    detectConversation(): ParsedConversation | null;

    /**
     * List all message elements in the conversation, in order.
     */
    listMessages(): Element[];

    /**
     * Parse a message element into a MessageNode.
     */
    parseMessage(el: Element, sequence: number): Promise<MessageNode> | MessageNode;

    /**
     * Parse artifacts from a message element.
     */
    parseArtifacts(el: Element): Promise<ArtifactNode[]> | ArtifactNode[];

    /**
     * Get a deep link that can navigate back to this message.
     */
    getDeepLink(el: Element): DeepLink;

    /**
     * Subscribe to new messages being added (for live capture).
     * Returns an unsubscribe function.
     */
    subscribeNewMessages(callback: (el: Element) => void): () => void;

    /**
     * Get provenance information (model, provider) from the page.
     */
    getProvenance(): Provenance;

    /**
     * Send text to the AI input field.
     */
    sendToAI(text: string): Promise<boolean> | boolean;

    /**
     * Capture the entire conversation.
     */
    captureConversation(): Promise<ConversationGraph | null> | ConversationGraph | null;

    /**
     * Scan the sidebar for available conversations.
     * Returns only regular (non-project) history conversations.
     */
    scanSidebar(): Promise<SidebarItem[]> | SidebarItem[];

    /**
     * Discover all projects visible in the sidebar nav.
     * Fast — only reads the DOM, no navigation.
     */
    discoverProjects(): Promise<ProjectInfo[]> | ProjectInfo[];

    /**
     * Navigate to the given project page, scroll to lazy-load all conversations,
     * and return the full list tagged with the given projectName.
     */
    scanProjectConversations(projectUrl: string, projectName: string): Promise<SidebarItem[]>;

    /**
     * Load a conversation by ID/URL.
     */
    loadConversation(id: string, projectUrl?: string): Promise<boolean>;

    /**
     * Apply provider-specific capture settings from the sidepanel.
     */
    setCaptureSettings(settings: ProviderCaptureSettings): void;

    /**
     * Count visible artifact references for lightweight diagnostics.
     */
    getArtifactCount(): number;
}

/**
 * Base class with shared utility methods.
 */
export abstract class BaseAdapter implements ProviderAdapter {
    abstract readonly providerName: string;
    abstract readonly providerSite: string;

    abstract detectConversation(): ParsedConversation | null;
    abstract listMessages(): Element[];
    abstract parseMessage(el: Element, sequence: number): Promise<MessageNode> | MessageNode;
    abstract parseArtifacts(el: Element): Promise<ArtifactNode[]> | ArtifactNode[];
    abstract getDeepLink(el: Element): DeepLink;
    abstract getProvenance(): Provenance;
    abstract sendToAI(text: string): Promise<boolean> | boolean;

    async scanSidebar(): Promise<SidebarItem[]> {
        return [];
    }

    async discoverProjects(): Promise<ProjectInfo[]> {
        return [];
    }

    async scanProjectConversations(_projectUrl: string, _projectName: string): Promise<SidebarItem[]> {
        return [];
    }

    async loadConversation(id: string, _projectUrl?: string): Promise<boolean> {
        return false;
    }

    setCaptureSettings(_settings: ProviderCaptureSettings): void {
        // Default no-op for adapters without provider-specific capture settings.
    }

    getArtifactCount(): number {
        return 0;
    }

    protected async parseVisibleArtifacts(): Promise<ArtifactNode[]> {
        return [];
    }

    protected getArtifactDedupKey(artifact: ArtifactNode): string {
        const normalizedTitle = this.cleanArtifactText(artifact.title ?? '').toLowerCase();
        const content = typeof artifact.content === 'string'
            ? artifact.content.slice(0, 1200)
            : JSON.stringify(artifact.content).slice(0, 1200);
        const contentText = typeof artifact.content === 'string'
            ? this.cleanArtifactText(artifact.content.replace(/<[^>]+>/g, ' '))
            : '';
        const hasSubstantialCapturedContent = contentText.length >= 80;

        // Prefer content-first deduping when we captured meaningful inline content so
        // opener-based and visible-panel-based captures of the same artifact collapse
        // even if only one path exposed a download/view URL.
        if (artifact.type === 'code_artifact' || hasSubstantialCapturedContent) {
            return [
                artifact.type,
                normalizedTitle,
                content,
            ].join('|');
        }

        return [
            artifact.type,
            normalizedTitle,
            artifact.view_url ?? '',
            artifact.source_url ?? '',
            content,
        ].join('|');
    }

    protected getArtifactSemanticSignature(artifact: ArtifactNode): string | null {
        if (artifact.type === 'image' || artifact.type === 'file') {
            return null;
        }

        if (typeof artifact.content !== 'string') {
            return null;
        }

        const normalizedTitle = this.cleanArtifactText(artifact.title ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        const decodedContent = artifact.content
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'");
        const normalizedText = this.cleanArtifactText(decodedContent.replace(/<[^>]+>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        if (normalizedText.length < 12) {
            return null;
        }

        return [
            normalizedTitle,
            normalizedText.slice(0, 1200),
        ].join('|');
    }

    protected createArtifactReferenceBlock(artifacts: ArtifactNode[]): ContentBlock | null {
        if (artifacts.length === 0) {
            return null;
        }

        const appendixArtifacts = artifacts.filter((artifact) => {
            if (artifact.type === 'code_artifact') {
                return typeof artifact.content === 'string' && artifact.content.trim().length > 0;
            }

            if (artifact.type === 'deep_research') {
                // Only include deep_research in the appendix if it has a linkable URL;
                // phantom artifacts captured from stale/cross-conversation iframes lack URLs.
                return Boolean(artifact.view_url || artifact.source_url);
            }

            if (artifact.type === 'file') {
                return true;
            }

            if (artifact.type === 'artifact_doc' && (artifact.view_url || artifact.source_url)) {
                return true;
            }

            return artifact.type === 'artifact_doc'
                && typeof artifact.content === 'string'
                && artifact.content.length > 1800;
        });

        if (appendixArtifacts.length === 0) {
            return null;
        }

        const escapeHtml = (value: string): string => value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        const lines = appendixArtifacts.map((artifact, index) => {
            const title = artifact.title?.trim() || `${artifact.type.replace(/_/g, ' ')} ${index + 1}`;
            return `- <a href="#artifact-${artifact.artifact_id}">${escapeHtml(title)}</a>`;
        });

        return createMarkdownBlock(`See appendix:\n\n${lines.join('\n')}`);
    }

    /**
     * Replaces any content block in `message` that contains just a deep-research label
     * (e.g. "**Deep research report**" or the artifact's actual title) with a markdown link
     * pointing to the artifact.  `msgArtifacts` are the artifacts already scoped to this
     * message; `allDeepResearchArtifacts` is the global fallback for multi-turn chats where
     * the deep-research iframe ends up attached to a *different* message than the label.
     */
    protected linkDeepResearchLabels(
        message: MessageNode,
        msgArtifacts: ArtifactNode[],
        allDeepResearchArtifacts: ArtifactNode[] = [],
    ): void {
        // Prefer message-scoped artifact, then any conversation-level deep_research artifact.
        const candidates = [
            ...msgArtifacts.filter(a => a.type === 'deep_research'),
            ...allDeepResearchArtifacts,
        ];
        if (candidates.length === 0) return;
        const artifact = candidates[0];

        const GENERIC_LABEL = /^deep\s+research\s+report$/i;
        const artifactTitleLower = (artifact.title ?? '').toLowerCase();
        const escapeHtml = (value: string): string => value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        for (let i = 0; i < message.content_blocks.length; i++) {
            const block = message.content_blocks[i];
            if (block.type !== 'markdown' && block.type !== 'text') continue;
            // Strip bold/italic markers so "**Deep research report**" matches too.
            const rawText = block.value.trim().replace(/^\*+|\*+$/g, '').trim();
            if (!GENERIC_LABEL.test(rawText) && rawText.toLowerCase() !== artifactTitleLower) continue;
            message.content_blocks[i] = {
                type: 'markdown',
                value: `<a href="#artifact-${artifact.artifact_id}">${escapeHtml(rawText)}</a>`,
            };
        }
    }

    protected extractArtifactLinks(el: Element): { viewUrl?: string; sourceUrl?: string } {
        const candidates: Array<{ url: string; label: string; kind: 'link' | 'frame' }> = [];

        const pushUrl = (rawUrl: string | null | undefined, label: string, kind: 'link' | 'frame') => {
            if (!rawUrl) return;

            try {
                candidates.push({
                    url: new URL(rawUrl, window.location.href).href,
                    label: label.trim().toLowerCase(),
                    kind,
                });
            } catch {
                candidates.push({
                    url: rawUrl,
                    label: label.trim().toLowerCase(),
                    kind,
                });
            }
        };

        const selfLinkUrl = el.getAttribute('href')
            ?? el.getAttribute('data-href')
            ?? el.getAttribute('data-url');
        if (selfLinkUrl) {
            const selfLabel = el.getAttribute('aria-label')
                ?? el.getAttribute('title')
                ?? el.textContent
                ?? '';
            pushUrl(selfLinkUrl, selfLabel, 'link');
        }

        if (el.matches('iframe[src], embed[src], object[data]')) {
            const selfFrameUrl = el.getAttribute('src') ?? el.getAttribute('data');
            const selfFrameLabel = el.getAttribute('title') ?? el.getAttribute('aria-label') ?? 'embedded content';
            pushUrl(selfFrameUrl, selfFrameLabel, 'frame');
        }

        Array.from(el.querySelectorAll('a[href], [data-href], [data-url]')).forEach((candidate) => {
            const rawUrl = candidate.getAttribute('href')
                ?? candidate.getAttribute('data-href')
                ?? candidate.getAttribute('data-url');
            const label = candidate.getAttribute('aria-label')
                ?? candidate.getAttribute('title')
                ?? candidate.textContent
                ?? '';
            pushUrl(rawUrl, label, 'link');
        });

        Array.from(el.querySelectorAll('iframe[src], embed[src], object[data]')).forEach((candidate) => {
            const rawUrl = candidate.getAttribute('src') ?? candidate.getAttribute('data');
            const label = candidate.getAttribute('title') ?? candidate.getAttribute('aria-label') ?? 'embedded content';
            pushUrl(rawUrl, label, 'frame');
        });

        let viewUrl: string | undefined;
        let sourceUrl: string | undefined;

        for (const candidate of candidates) {
            if (!sourceUrl && (candidate.kind === 'frame' || /download|export|source|raw|file|open in new/.test(candidate.label))) {
                sourceUrl = candidate.url;
                continue;
            }

            if (!viewUrl && /open|view|preview|artifact|report|canvas|diagram/.test(candidate.label)) {
                viewUrl = candidate.url;
            }
        }

        if (!viewUrl) {
            viewUrl = candidates.find((candidate) => candidate.kind === 'link')?.url;
        }

        if (!sourceUrl) {
            sourceUrl = candidates.find((candidate) => candidate.kind === 'frame')?.url;
        }

        if (sourceUrl && !viewUrl) {
            viewUrl = sourceUrl;
        }

        return { viewUrl, sourceUrl };
    }

    protected cleanArtifactText(text: string): string {
        let sanitized = this.sanitizeMessageText(text);
        sanitized = sanitized.replace(/\b(chatgpt|claude|gemini)\s+said:\s*/gim, '');
        sanitized = sanitized.replace(/(^|\n)\s*(inserted\s*this\s*message|insert(?:ed)?|this\s*message|up\s*to\s*message|this\s*\+\s*following|artifact\s*links|open|download|source|copy|edit|retry|share)\s*(?=\n|$)/gim, '$1');
        sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim();
        return sanitized;
    }

    protected isNoiseOnlyArtifactText(text: string): boolean {
        const normalized = this.cleanArtifactText(text)
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        if (!normalized) {
            return true;
        }

        return /^(artifact|artifact links|open|download|source|insert(ed)?|this message|up to message|chatgpt said|claude said|gemini said)$/.test(normalized);
    }

    protected svgToDataUrl(svg: SVGSVGElement): string {
        const markup = new XMLSerializer().serializeToString(svg);
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    }

    protected canvasToDataUrl(canvas: HTMLCanvasElement): string | null {
        try {
            return canvas.toDataURL('image/png');
        } catch {
            return null;
        }
    }

    protected async fetchRemoteResource(url: string): Promise<{
        ok: boolean;
        contentType?: string;
        text?: string;
        dataUrl?: string;
        finalUrl?: string;
        contentDisposition?: string;
        error?: string;
    } | null> {
        if (!url || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
            return null;
        }

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'FETCH_REMOTE_RESOURCE',
                url,
            });

            if (!response || typeof response !== 'object') {
                return null;
            }

            return response;
        } catch {
            return null;
        }
    }

    protected async extractAllFrames(): Promise<ExtractedFrameContent[]> {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
            return [];
        }

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'EXTRACT_ALL_FRAMES',
            });

            if (!response || typeof response !== 'object' || !Array.isArray(response.frames)) {
                return [];
            }

            return (response.frames as unknown[]).flatMap((frame) => {
                if (!frame || typeof frame !== 'object') {
                    return [];
                }

                const candidate = frame as Partial<ExtractedFrameContent>;
                if (
                    typeof candidate.url !== 'string'
                    || typeof candidate.title !== 'string'
                    || typeof candidate.text !== 'string'
                    || typeof candidate.html !== 'string'
                    || typeof candidate.isTop !== 'boolean'
                ) {
                    return [];
                }

                return [candidate as ExtractedFrameContent];
            });
        } catch {
            return [];
        }
    }

    protected async getOpenAIResearchProbeData(): Promise<OpenAIProbeSnapshot[]> {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
            return [];
        }

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_OPENAI_RESEARCH_PROBE_DATA',
            });

            if (!response || typeof response !== 'object' || !Array.isArray(response.snapshots)) {
                return [];
            }

            return (response.snapshots as unknown[]).flatMap((snapshot) => {
                if (!snapshot || typeof snapshot !== 'object') {
                    return [];
                }

                const candidate = snapshot as Partial<OpenAIProbeSnapshot>;
                if (
                    typeof candidate.url !== 'string'
                    || typeof candidate.title !== 'string'
                    || typeof candidate.isTop !== 'boolean'
                    || typeof candidate.bodyText !== 'string'
                    || typeof candidate.bodyHtml !== 'string'
                    || !Array.isArray(candidate.entries)
                ) {
                    return [];
                }

                const entries = candidate.entries.flatMap((entry) => {
                    if (!entry || typeof entry !== 'object') {
                        return [];
                    }

                    const normalizedEntry = entry as Partial<OpenAIProbeEntry>;
                    if (
                        typeof normalizedEntry.kind !== 'string'
                        || typeof normalizedEntry.url !== 'string'
                        || typeof normalizedEntry.body !== 'string'
                        || typeof normalizedEntry.timestamp !== 'number'
                    ) {
                        return [];
                    }

                    return [normalizedEntry as OpenAIProbeEntry];
                });

                return [{
                    ...(candidate as OpenAIProbeSnapshot),
                    entries,
                }];
            });
        } catch {
            return [];
        }
    }

    protected extractFetchedDocumentContent(
        raw: string,
        baseUrl: string
    ): { html?: string; text: string; title?: string } | null {
        const trimmed = raw.trim();
        if (!trimmed) {
            return null;
        }

        const looksLikeHtml = /<(html|body|main|article|section|div|p|h1|h2)\b/i.test(trimmed);
        if (!looksLikeHtml) {
            const text = this.cleanArtifactText(trimmed);
            return text ? { text } : null;
        }

        const parsed = new DOMParser().parseFromString(raw, 'text/html');
        const title = this.cleanArtifactText(parsed.querySelector('title')?.textContent?.trim() ?? '');
        const root = parsed.querySelector(
            'main, article, [role="main"], .prose, .markdown, [data-testid*="research"], [class*="research"], [class*="report"]'
        ) ?? parsed.body;

        if (!root) {
            return null;
        }

        root.querySelectorAll('[href], [src]').forEach((node) => {
            const href = node.getAttribute('href');
            if (href) {
                try {
                    node.setAttribute('href', new URL(href, baseUrl).href);
                } catch {
                    // Keep original value if URL resolution fails.
                }
            }

            const src = node.getAttribute('src');
            if (src) {
                try {
                    node.setAttribute('src', new URL(src, baseUrl).href);
                } catch {
                    // Keep original value if URL resolution fails.
                }
            }
        });

        const html = this.sanitizeRichHtml(root, {
            removeSelectors: ['header nav', 'footer', 'button', '[role="button"]'],
        });
        const text = this.cleanArtifactText(root.textContent ?? '');

        if ((!html || this.isNoiseOnlyArtifactText(html.replace(/<[^>]+>/g, ' ')))
            && (!text || this.isNoiseOnlyArtifactText(text))) {
            return null;
        }

        return {
            html: html || undefined,
            text,
            title: title || undefined,
        };
    }

    protected guessArtifactFilename(
        title: string | undefined,
        contentType?: string,
        url?: string,
        contentDisposition?: string
    ): string {
        const dispositionMatch = contentDisposition?.match(/filename\*?=(?:UTF-8''|\")?([^;\"]+)/i);
        if (dispositionMatch?.[1]) {
            try {
                return decodeURIComponent(dispositionMatch[1].trim().replace(/^"|"$/g, ''));
            } catch {
                return dispositionMatch[1].trim().replace(/^"|"$/g, '');
            }
        }

        const fromUrl = (() => {
            if (!url) return '';

            try {
                const pathname = new URL(url).pathname;
                return pathname.split('/').filter(Boolean).pop() ?? '';
            } catch {
                return '';
            }
        })();

        if (fromUrl && /\.[a-z0-9]{2,8}$/i.test(fromUrl)) {
            return fromUrl;
        }

        const baseName = (title ?? 'captured-artifact')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'captured-artifact';

        const extension = (() => {
            switch ((contentType ?? '').split(';')[0].trim().toLowerCase()) {
                case 'application/pdf':
                    return 'pdf';
                case 'text/html':
                    return 'html';
                case 'text/markdown':
                case 'text/x-markdown':
                    return 'md';
                case 'text/plain':
                    return 'txt';
                case 'application/json':
                    return 'json';
                case 'image/svg+xml':
                    return 'svg';
                default:
                    return 'bin';
            }
        })();

        return `${baseName}.${extension}`;
    }

    /**
     * Normalize and sanitize the extracted text for markdown blocks.
     */
    protected sanitizeMessageText(text: string): string {
        let sanitized = text;

        // Remove chat quote markers (carats '>' from quoted blocks)
        sanitized = sanitized.replace(/^\s*>+\s?/gm, '');

        // Remove ChatGPT/Gemini/Claude labels that may appear in the text capture
        sanitized = sanitized.replace(/^\s*(👤\s*User|🤖\s*Assistant|\w+ AI|Conversation)\s*[\r\n]*/gim, '');

        // Remove source-specific prefix markers (including quoted variants)
        sanitized = sanitized.replace(/(^|\n)\s*(>\s*)*You said:?(\s*)/gim, '$1');
        sanitized = sanitized.replace(/(^|\n)\s*(show thinking\s+)?(?:chatgpt|claude|gemini)\s+said:?(\s*)/gim, '$1');
        sanitized = sanitized.replace(/(^|\n)\s*show thinking\s*(?=\n|$)/gim, '$1');

        // Remove excess markdown quote block indicators
        sanitized = sanitized.replace(/(^|\n)\s*>\s*/g, '$1');

        // Collapse excessive blank lines and trim
        sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim();

        return sanitized;
    }

    /**
     * Resolve a provider-visible link from an artifact element.
     */
    protected extractArtifactViewUrl(el: Element): string | undefined {
        const candidates: Array<Element | null> = [
            el.closest('a[href]'),
            el.querySelector('a[href]'),
            el.querySelector('[data-href]'),
            el.querySelector('[data-url]'),
            el.closest('[data-href]'),
            el.closest('[data-url]')
        ];

        for (const candidate of candidates) {
            if (!candidate) continue;

            const rawHref = candidate.getAttribute('href')
                ?? candidate.getAttribute('data-href')
                ?? candidate.getAttribute('data-url');

            if (!rawHref) continue;

            try {
                return new URL(rawHref, window.location.href).href;
            } catch {
                return rawHref;
            }
        }

        return undefined;
    }

    /**
     * Preserve provider-authored structure such as tables and code blocks while
     * stripping interactive or unsafe elements that do not belong in captures.
     */
    protected sanitizeRichHtml(
        el: Element,
        options?: {
            removeSelectors?: string[];
        }
    ): string {
        const clone = el.cloneNode(true) as Element;
        const removeSelectors = [
            'style',
            'script',
            'link',
            'meta',
            'noscript',
            'iframe',
            'form',
            'button',
            '[role="button"]',
            'svg',
            '.bonsai-insert-btn',
            ...(options?.removeSelectors ?? []),
        ];

        clone.querySelectorAll(removeSelectors.join(', ')).forEach((node) => node.remove());

        Array.from(clone.querySelectorAll('*'))
            .filter((node) => node.tagName.includes('-'))
            .forEach((node) => {
                const children = Array.from(node.childNodes);
                if (children.length > 0) {
                    node.replaceWith(...children);
                } else {
                    node.remove();
                }
            });

        const allowedAttributes = new Set([
            'href',
            'src',
            'alt',
            'title',
            'class',
            'colspan',
            'rowspan',
        ]);

        clone.querySelectorAll('*').forEach((node) => {
            Array.from(node.attributes).forEach((attr) => {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on') || !allowedAttributes.has(name)) {
                    node.removeAttribute(attr.name);
                }
            });
        });

        // Normalize provider-specific code markup into plain semantic pre/code blocks.
        clone.querySelectorAll('pre').forEach((pre) => {
            const codeEl = pre.querySelector('code') ?? pre;
            const language = this.detectCodeLanguage(codeEl).trim();
            const normalizedCode = document.createElement('code');

            if (language) {
                normalizedCode.className = `language-${language}`;
            }

            normalizedCode.textContent = pre.textContent ?? '';
            pre.replaceChildren(normalizedCode);
            pre.removeAttribute('class');
        });

        clone.querySelectorAll('code').forEach((codeEl) => {
            if (codeEl.closest('pre')) {
                return;
            }

            const language = this.detectCodeLanguage(codeEl).trim();
            codeEl.textContent = codeEl.textContent ?? '';

            if (language) {
                codeEl.className = `language-${language}`;
            } else {
                codeEl.removeAttribute('class');
            }
        });

        return clone.innerHTML.trim();
    }

    subscribeNewMessages(callback: (el: Element) => void): () => void {
        const conversation = this.detectConversation();
        if (!conversation) return () => { };

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node instanceof Element) {
                        // Check if this is a message element
                        const messages = this.listMessages();
                        if (messages.includes(node)) {
                            callback(node);
                        }
                        // Also check children
                        const childMessages = Array.from(node.querySelectorAll('*'))
                            .filter(el => messages.includes(el));
                        childMessages.forEach(callback);
                    }
                }
            }
        });

        observer.observe(conversation.container, {
            childList: true,
            subtree: true
        });

        return () => observer.disconnect();
    }

    async captureConversation(): Promise<ConversationGraph | null> {
        const conversation = this.detectConversation();
        if (!conversation) return null;

        const provenance = this.getProvenance();
        const messages = this.listMessages();

        const graph: ConversationGraph = {
            conversation_id: crypto.randomUUID(),
            title: conversation.title,
            source: {
                provider_site: this.providerSite as any,
                url: conversation.url,
                captured_at: new Date().toISOString(),
                capture_version: '0.1.0'
            },
            provenance,
            messages: [],
            artifacts: []
        };

        const artifactsByMessageId = new Map<string, ArtifactNode[]>();
        // Maps dedup key → the canonical ArtifactNode already in graph.artifacts.
        // When a later message references the same artifact content, we cross-link the
        // EXISTING artifact_id into that message's artifact_ids rather than silently
        // discarding the reference (which broke single-message capture for artifact edits).
        const seenArtifactKeyToArtifact = new Map<string, ArtifactNode>();
        const seenArtifactSignatureToArtifact = new Map<string, ArtifactNode>();

        const attachArtifacts = (message: MessageNode, artifacts: ArtifactNode[]) => {
            if (artifacts.length === 0) {
                return;
            }

            const messageArtifacts = artifactsByMessageId.get(message.message_id) ?? [];
            artifactsByMessageId.set(message.message_id, messageArtifacts);

            artifacts.forEach((artifact) => {
                const dedupeKey = this.getArtifactDedupKey(artifact);
                const semanticSignature = this.getArtifactSemanticSignature(artifact);
                const existingArtifact = seenArtifactKeyToArtifact.get(dedupeKey)
                    ?? (semanticSignature ? seenArtifactSignatureToArtifact.get(semanticSignature) : undefined);
                if (existingArtifact) {
                    // Artifact already in graph — cross-reference this message to it so that
                    // single-message capture (which filters by artifact_ids) can find it.
                    if (!message.artifact_ids.includes(existingArtifact.artifact_id)) {
                        message.artifact_ids.push(existingArtifact.artifact_id);
                        messageArtifacts.push(existingArtifact);
                    }
                    return;
                }

                seenArtifactKeyToArtifact.set(dedupeKey, artifact);
                if (semanticSignature) {
                    seenArtifactSignatureToArtifact.set(semanticSignature, artifact);
                }
                artifact.source_message_id = message.message_id;
                message.artifact_ids.push(artifact.artifact_id);
                graph.artifacts.push(artifact);
                messageArtifacts.push(artifact);
            });
        };

        for (const [index, el] of messages.entries()) {
            let message: MessageNode;

            try {
                message = await this.parseMessage(el, index);
            } catch (error) {
                console.warn(`[Bonsai Capture] Failed to parse message ${index} for ${this.providerSite}`, error);
                continue;
            }

            let artifacts: ArtifactNode[] = [];
            try {
                artifacts = await this.parseArtifacts(el);
            } catch (error) {
                console.warn(`[Bonsai Capture] Failed to parse artifacts for message ${index} on ${this.providerSite}`, error);
            }

            attachArtifacts(message, artifacts);

            graph.messages.push(message);
        }

        let visibleArtifacts: ArtifactNode[] = [];
        try {
            visibleArtifacts = await this.parseVisibleArtifacts();
        } catch (error) {
            console.warn(`[Bonsai Capture] Failed to parse visible artifacts on ${this.providerSite}`, error);
        }

        const targetMessage = [...graph.messages].reverse().find((message) => message.role === 'assistant')
            ?? graph.messages[graph.messages.length - 1];

        if (targetMessage) {
            attachArtifacts(targetMessage, visibleArtifacts);
        }

        graph.messages.forEach((message) => {
            const referenceBlock = this.createArtifactReferenceBlock(artifactsByMessageId.get(message.message_id) ?? []);
            if (referenceBlock) {
                message.content_blocks.push(referenceBlock);
            }
        });

        return graph;
    }

    /**
     * Extract text content from an element, handling common formatting.
     */
    protected extractTextContent(el: Element): string {
        // Clone to avoid modifying original
        const clone = el.cloneNode(true) as Element;

        // Remove code blocks (handled separately)
        clone.querySelectorAll('pre, code').forEach(code => code.remove());

        return clone.textContent?.trim() ?? '';
    }

    /**
     * Extract code blocks from an element.
     */
    protected extractCodeBlocks(el: Element): Array<{ language: string; code: string }> {
        const blocks: Array<{ language: string; code: string }> = [];

        el.querySelectorAll('pre code, .code-block code').forEach(codeEl => {
            const language = this.detectCodeLanguage(codeEl);
            const code = codeEl.textContent?.trim() ?? '';
            if (code) {
                blocks.push({ language, code });
            }
        });

        return blocks;
    }

    /**
     * Detect the programming language of a code block.
     */
    protected detectCodeLanguage(codeEl: Element): string {
        // Check class names for language hints
        const classes = Array.from(codeEl.classList);
        for (const cls of classes) {
            if (cls.startsWith('language-')) return cls.replace('language-', '');
            if (cls.startsWith('lang-')) return cls.replace('lang-', '');
        }

        // Check parent pre element
        const pre = codeEl.closest('pre');
        if (pre) {
            for (const cls of Array.from(pre.classList)) {
                if (cls.startsWith('language-')) return cls.replace('language-', '');
            }
        }

        // Check for language header
        const header = codeEl.closest('.code-container, .code-block')
            ?.querySelector('.code-header, [data-language]');
        if (header) {
            return header.textContent?.trim().toLowerCase() ?? '';
        }

        return '';
    }
}
