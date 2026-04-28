/**
 * ChatGPT Adapter
 * 
 * Captures conversations from chatgpt.com / chat.openai.com
 */

// DEBUG: Log start
console.log('!!! Bonsai Capture: ChatGPT Adapter Loading !!!');

import { BaseAdapter, ParsedConversation, SidebarItem } from './interface';
import type { ExtractedFrameContent, OpenAIProbeSnapshot } from './interface';
import {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ConversationGraph,
    ContentBlock,
    createMessageNode,
    createHtmlBlock,
    createCodeBlock,
    createMarkdownBlock
} from '../../shared/schema';
import {
    getSelectorsForSite,
    queryWithFallbacks,
    queryAllWithFallbacks
} from '../../config/selectors';

interface DeepResearchCandidate {
    label: string;
    score: number;
    text: string;
    html?: string;
    title?: string;
    url?: string;
    debugRef?: string;
}

interface DeepResearchSource {
    index?: number;
    aliases?: number[];
    title: string;
    url: string;
}

type ReferenceDerivedCitationIndexMap = {
    rawToCanonical: Map<number, number>;
    titleFallbackRawIndexes: Set<number>;
};

class ChatGPTAdapter extends BaseAdapter {
    readonly providerName = 'OpenAI';
    readonly providerSite = 'chatgpt.com';
    private extractedFrameContentPromise: Promise<ExtractedFrameContent[]> | null = null;
    private openAIProbeSnapshotsPromise: Promise<OpenAIProbeSnapshot[]> | null = null;

    private isVisibleElement(el: Element): boolean {
        const node = el as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();

        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
    }

    private getDeepResearchFrames(root: Element): HTMLIFrameElement[] {
        return Array.from(
            root.querySelectorAll('iframe[title="internal://deep-research"], iframe[src*="deep_research"], iframe[src*="oaiusercontent.com"]')
        ).filter((frame): frame is HTMLIFrameElement => frame instanceof HTMLIFrameElement);
    }

    private getDeepResearchEmbedRoot(frame: Element): Element {
        const explicitRoot = frame.closest(
            '[data-testid*="research"], [data-testid*="report"], figure, [role="article"], [class*="research"], [class*="report"]'
        );
        if (explicitRoot) {
            return explicitRoot;
        }

        let current = frame.parentElement;
        let compactRoot: Element = frame.parentElement ?? frame;

        for (let depth = 0; current && depth < 3; depth += 1) {
            if (this.getDeepResearchFrames(current).length !== 1) {
                break;
            }

            compactRoot = current;
            current = current.parentElement;
        }

        return compactRoot;
    }

    private getDeepResearchMessageRoot(frame: Element): Element {
        return frame.closest(
            '[data-message-author-role], section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], article, section, figure, [role="article"], [class*="research"], [class*="report"]'
        ) ?? this.getDeepResearchEmbedRoot(frame);
    }

    private hasDeepResearchEmbed(el: Element): boolean {
        return this.getDeepResearchFrames(el).length > 0;
    }

    private findSupplementalMessageElements(root: Element, explicitRoleElements: Element[] = []): Element[] {
        return this.getDeepResearchFrames(root)
            .map((frame) => this.getDeepResearchMessageRoot(frame))
            .filter((candidate, index, all) => all.indexOf(candidate) === index)
            .filter((candidate) => !explicitRoleElements.some((roleEl) => (
                roleEl === candidate
                || roleEl.contains(candidate)
                || candidate.contains(roleEl)
            )));
    }

    private sortByDocumentOrder(elements: Element[]): Element[] {
        return [...elements].sort((left, right) => {
            if (left === right) return 0;

            const position = left.compareDocumentPosition(right);
            if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });
    }

    private get selectors() {
        return getSelectorsForSite(window.location.hostname) ?? getSelectorsForSite('chatgpt.com')!;
    }

    detectConversation(): ParsedConversation | null {
        const isProjectPage = window.location.pathname.includes('/project');
        let container = queryWithFallbacks(document, this.selectors.conversationContainer);

        if (!container) {
            container = document.querySelector('[data-testid="chat-history"], div[role="log"], .chat-history, main');
        }

        if (!container && !isProjectPage) return null;

        // Extract title from page or heading
        const title = this.resolveCurrentConversationTitle(isProjectPage ? 'Project Overview' : 'Untitled');
        const projectInfo = this.getCurrentProjectInfo();

        return {
            url: window.location.href,
            container: container || document.body,
            title: title || undefined,
            projectName: projectInfo?.name,
            projectUrl: projectInfo?.url,
        };
    }

    private getCurrentProjectInfo(): { name: string; url: string } | undefined {
        const projectMatch = this.normalizePath(window.location.href).match(/(\/g\/g-p-[^/]+)(?:\/(?:c\/[a-z0-9-]+|project))?/i);
        if (!projectMatch) return undefined;

        const projectUrl = `${window.location.origin}${projectMatch[1]}/project`;
        const projectLink = this.findProjectLinkByUrl(projectUrl);

        let name = projectLink?.innerText?.trim() || projectLink?.textContent?.trim() || '';
        name = name.split('\n')[0].trim();

        if (!name) {
            const slugMatch = projectUrl.match(/\/g\/g-p-[^/]+-([^/]+)\/project/i);
            name = slugMatch ? slugMatch[1].replace(/-/g, ' ') : 'Unnamed Project';
        }

        return { name, url: projectUrl };
    }

    private extractConversationTitle(): string {
        // Only use DOM elements that reliably represent the sidebar/heading for the
        // *current* conversation. Do NOT use main h1/h2 — those are message content
        // headings (e.g. "Current Bolt.new Limitation") which are indistinguishable
        // from the page structural title.
        const candidates = [
            document.querySelector('[aria-current="page"][href*="/c/"]'),
            document.querySelector('[data-testid="history-item"].active'),
            document.querySelector('.conversation-item.selected'),
            document.querySelector('[data-testid*="conversation-title"]'),
        ];

        for (const candidate of candidates) {
            const title = candidate?.textContent?.trim();
            if (title && !/^(chatgpt|untitled|new chat|project overview)$/i.test(title)) {
                return title;
            }
        }

        return '';
    }

    private resolveCurrentConversationTitle(fallback: string): string {
        // document.title is the most reliable source — ChatGPT always sets it to the
        // conversation name (e.g. "Core Telemetry Categories - ChatGPT").
        // Prefer it over DOM heuristics which can pick up message-content headings.
        const documentTitle = document.title
            .replace(/\s*-\s*ChatGPT.*$/i, '')
            .replace(/^ChatGPT\s*$/i, '')
            .trim();

        return documentTitle || this.extractConversationTitle() || fallback;
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    private getConversationFingerprint(): string {
        const messageElements = this.listMessages();

        if (messageElements.length === 0) {
            return '';
        }

        return messageElements.map((messageElement, index) => {
            const snippet = this.cleanArtifactText(messageElement.textContent ?? '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120);

            return [
                index,
                messageElement.getAttribute('data-message-id') ?? '',
                messageElement.getAttribute('data-bonsai-msg-id') ?? '',
                messageElement.getAttribute('id') ?? '',
                messageElement.getAttribute('data-message-author-role') ?? '',
                snippet,
            ].join(':');
        }).join('|');
    }

    private async waitForConversationReady(targetId: string, baselineFingerprint: string, timeoutMs = 15000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        // Empty targetId means "just wait for any stable content at the current URL" (used by
        // the already-at-URL path after a full page reload).
        const targetPath = targetId ? `/c/${targetId}` : null;
        // Stabilisation: fingerprint must be non-empty, different from baseline, and unchanged
        // for stabilizeMs before we declare the conversation fully loaded.  Without this the
        // function returned as soon as the *first* message skeleton appeared and the capture
        // fired against a half-rendered page.
        const stabilizeMs = 1200;
        let lastFingerprint = '';
        let lastChangeAt = 0;

        while (Date.now() < deadline) {
            const currentUrl = window.location.href;
            const fingerprint = this.getConversationFingerprint();
            const contentReady = this.hasRenderedMessageContent();

            const urlOk = targetPath === null || currentUrl.includes(targetPath);
            if (urlOk && fingerprint && fingerprint !== baselineFingerprint && contentReady) {
                if (fingerprint !== lastFingerprint) {
                    // Content is still changing — reset the stability clock.
                    lastFingerprint = fingerprint;
                    lastChangeAt = Date.now();
                } else if (Date.now() - lastChangeAt >= stabilizeMs) {
                    // Fingerprint has been stable long enough — content is fully rendered.
                    return true;
                }
            }

            await this.delay(200);
        }

        return false;
    }

    /**
     * Lightweight, read-only check: do any assistant message elements contain
     * actual rendered text content (not just skeleton labels)?
     *
     * Safe to call on every 200 ms poll iteration because it never mutates the
     * DOM — unlike parseContentBlocks / extractCodeBlocks which stamp
     * data-bonsai-index attributes on live elements.
     */
    private hasRenderedMessageContent(): boolean {
        const messages = this.listMessages();
        if (messages.length === 0) return false;

        const contentSelectors =
            '.markdown, .message-content, [data-message-content], ' +
            '[data-testid="message-content"], .chat-message-text, .text-base';

        let foundAssistant = false;

        for (const msg of messages) {
            const role = msg.getAttribute('data-message-author-role') ?? '';
            if (role !== 'assistant') continue;
            foundAssistant = true;

            const bubble = this.resolveMessageBubble(msg);
            const contentArea = bubble.querySelector(contentSelectors);
            if (contentArea) {
                const text = (contentArea.textContent ?? '').replace(/\s+/g, ' ').trim();
                // Must have meaningful text — more than just "ChatGPT said:" labels
                if (text.length > 20) return true;
            }
            // Image-only responses (DALL-E, etc.)
            if (bubble.querySelector('img[src], canvas, svg')) return true;
        }

        // No assistant messages found — nothing to wait for (e.g. fresh prompt)
        return !foundAssistant;
    }

    private isLikelyMessageTurn(el: Element): boolean {
        if (!el.isConnected) return false;

        const nonMessageSelectors = ['header', 'footer', 'nav', 'aside', 'form'];
        if (nonMessageSelectors.includes(el.tagName.toLowerCase())) return false;

        // Never inject into the compose/input area (textarea or ProseMirror contenteditable).
        if (el.querySelector('[role="textbox"], textarea, [data-testid*="prompt-textarea"]')) return false;

        const hasRoleAttr = el.hasAttribute('data-message-author-role');
        const dataTestId = (el.getAttribute('data-testid') || '').toLowerCase();
        const className = (el.className || '').toLowerCase();
        const text = (el.textContent || '').trim();

        if (hasRoleAttr) return true;
        if (this.hasDeepResearchEmbed(el)) return true;
        if (dataTestId.includes('chat-message') || dataTestId.includes('conversation-turn')) return true;
        if (className.includes('chat-message') || className.includes('conversation-turn')) return true;
        if (text.length < 5) return false;

        // Prefer content-bearing descendants over generic text. This keeps
        // wrapper turns that contain the real message bubble, but avoids
        // treating hover controls and action rows as standalone messages.
        const childMessage = el.querySelector(
            '[data-testid*="chat-message"], [data-testid="message-content"], [data-message-content], ' +
            '[data-message-author-role], .markdown, .message-content, p, pre, code, img[src], canvas, svg'
        );
        if (childMessage) return true;

        const controlCluster = el.matches('[role="toolbar"], [role="menu"]')
            || !!el.querySelector('button, [role="button"], [role="toolbar"], [role="menu"], [aria-label], [aria-haspopup]');
        if (controlCluster) return false;

        // Fallback: if it has many words and no other disqualifying attributes.
        return text.split(/\s+/).length >= 4;
    }

    private isEditArtifactBubble(el: Element): boolean {
        const text = el.textContent?.trim() || '';
        return text.startsWith('You said:');
    }

    private expandMessageElements(elements: Element[]): Element[] {
        const expanded: Element[] = [];

        for (const el of elements) {
            if (!(el instanceof Element) || !el.isConnected) {
                continue;
            }

            if (el.hasAttribute('data-message-author-role')) {
                expanded.push(el);
                continue;
            }

            const explicitBubbles = Array.from(el.querySelectorAll('[data-message-author-role]'))
                .filter((candidate): candidate is Element => candidate instanceof Element)
                .filter((candidate) => !this.isEditArtifactBubble(candidate));

            if (explicitBubbles.length > 0) {
                expanded.push(...explicitBubbles);
                continue;
            }

            expanded.push(el);
        }

        return expanded;
    }

    private normalizeMessageElements(elements: Element[]): Element[] {
        const filtered = this.expandMessageElements(elements)
            .filter(el => el instanceof Element && this.isLikelyMessageTurn(el));

        // Remove nested elements (keep top-level message turns).
        const unique = Array.from(new Set(filtered));
        return this.sortByDocumentOrder(
            unique.filter(el => !unique.some(parent => parent !== el && parent.contains(el)))
        );
    }

    listMessages(): Element[] {
        const conversation = this.detectConversation();
        if (!conversation) return [];

        const explicitRoleElements = Array.from(conversation.container.querySelectorAll('[data-message-author-role]'));
        const supplementalElements = this.findSupplementalMessageElements(conversation.container, explicitRoleElements);

        // Prefer explicit ChatGPT message bubbles when available. Broad selector
        // fallbacks can also match hover-control rows and auxiliary UI, which
        // leads to duplicate button injection and inflated message counts.
        // Merge back only known supplemental non-role turns such as deep research
        // cards so they still get buttons and inline artifact anchors.
        if (explicitRoleElements.length > 0) {
            return this.normalizeMessageElements([
                ...explicitRoleElements,
                ...supplementalElements,
            ]);
        }

        let elements = this.normalizeMessageElements(
            [
                ...queryAllWithFallbacks(conversation.container, this.selectors.messageBlock),
                ...supplementalElements,
            ]
        );

        if (elements.length === 0) {
            const directSections = Array.from(conversation.container.querySelectorAll(':scope > section'))
                .filter((section) => section instanceof Element && this.isLikelyMessageTurn(section)) as Element[];

            elements = this.normalizeMessageElements(directSections);
        }

        if (elements.length === 0) {
            const sectionCandidates = Array.from(conversation.container.querySelectorAll('section'))
                .filter((section) => section instanceof Element && this.isLikelyMessageTurn(section)) as Element[];

            elements = this.normalizeMessageElements(sectionCandidates);
        }

        if (elements.length === 0) {
            elements = this.normalizeMessageElements(Array.from(conversation.container.querySelectorAll('[data-testid*="chat-message"], .chat-message, .message, div[role="listitem"]')));
        }

        return elements;
    }



    /**
     * Find the actual message bubble inside the turn element (Article).
     * Filters out "You said" edit artifacts.
     */
    private resolveMessageBubble(turn: Element): Element {
        // If turn is already a bubble (fallback), use it
        if (turn.hasAttribute('data-message-author-role')) return turn;

        // Find all bubbles
        const bubbles = Array.from(turn.querySelectorAll('[data-message-author-role]'));

        if (bubbles.length === 0) {
            // No explicit role bubbles found. Fall back to likely text containers inside the turn.
            const alt = Array.from(turn.querySelectorAll('[data-testid*="chat-message"], .chat-message, .message, .group, div[role="listitem"]'));
            if (alt.length === 1) return alt[0];
            if (alt.length > 1) return alt[alt.length - 1];
            return turn; // Fallback to turn itself
        }

        // Filter out "You said" artifacts
        const validBubbles = bubbles.filter((el) => !this.isEditArtifactBubble(el));

        if (validBubbles.length > 0) {
            // Return the last valid bubble (most recent edit)
            return validBubbles[validBubbles.length - 1];
        }

        // If all were filtered (e.g. user literally message "You said: ..."), 
        // fallback to the last bubble (likely the message).
        return bubbles[bubbles.length - 1];
    }

    private getDeepResearchEmbeds(el: Element): Array<{
        title: string;
        summary: string;
        sourceUrl?: string;
        viewUrl?: string;
    }> {
        const frames = this.getDeepResearchFrames(el);
        const seen = new Set<string>();
        const embeds: Array<{
            title: string;
            summary: string;
            sourceUrl?: string;
            viewUrl?: string;
        }> = [];

        for (const frameEl of frames) {
            const frame = frameEl as HTMLIFrameElement;
            const cardRoot = this.getDeepResearchEmbedRoot(frame);

            const { viewUrl: extractedViewUrl, sourceUrl: extractedSourceUrl } = this.extractArtifactLinks(cardRoot);

            // Try to read iframe content (works when same-origin or sandboxed with allow-same-origin)
            let iframeText = '';
            let iframeHtml = '';
            try {
                const doc = (frame as HTMLIFrameElement).contentDocument ?? (frame as HTMLIFrameElement).contentWindow?.document;
                if (doc?.body) {
                    iframeText = this.cleanArtifactText(
                        (doc.body as HTMLElement).innerText ?? doc.body.textContent ?? ''
                    );
                    iframeHtml = this.sanitizeRichHtml(doc.body, {
                        removeSelectors: ['script', 'style', 'button', '[role="button"]'],
                    });
                }
            } catch {
                // cross-origin — cannot access
            }

            if (!iframeHtml) {
                const srcDoc = frame.getAttribute('srcdoc');
                if (srcDoc) {
                    const parsedSrcDoc = this.extractFetchedDocumentContent(srcDoc, window.location.href);
                    if (parsedSrcDoc) {
                        iframeHtml = parsedSrcDoc.html ?? '';
                        iframeText = parsedSrcDoc.text;
                    }
                }
            }

            let title = cardRoot.querySelector('h1, h2, h3, h4, [role="heading"], strong')
                ?.textContent
                ?.trim() || 'Deep research report';
            title = this.cleanArtifactText(title);
            if (!title || /^(chatgpt\s+said|open|artifact|report)$/i.test(title)) {
                title = 'Deep research report';
            }

            // Prefer iframe content, then card text
            let summary = iframeText;
            if (!summary) {
                const rawSummary = this.cleanArtifactText(this.getTextContentPreservingLines(cardRoot))
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                summary = rawSummary.toLowerCase() === title.toLowerCase() ? '' : rawSummary;
            }

            const sourceUrl = extractedSourceUrl ?? frame.getAttribute('src') ?? frame.src ?? undefined;
            // Use iframe src as viewUrl (direct link to research) — don't fall back to conversation URL
            const viewUrl = extractedViewUrl ?? sourceUrl ?? undefined;
            const key = `${title}|${sourceUrl || ''}|${viewUrl || ''}`;

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            embeds.push({
                title,
                summary: iframeHtml || summary,
                sourceUrl,
                viewUrl,
            });
        }

        return embeds;
    }

    private isChatGPTShellContent(content: string): boolean {
        const normalized = this.cleanArtifactText(
            content.trimStart().startsWith('<')
                ? content.replace(/<[^>]+>/g, ' ')
                : content
        )
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        if (!normalized) {
            return false;
        }

        const shellSignals = [
            'skip to content',
            'chat history',
            'new chat',
            'search chats',
            'codex',
            'explore gpts',
            'chatgpt can make mistakes',
        ];

        const matchedSignals = shellSignals.filter((signal) => normalized.includes(signal)).length;
        return matchedSignals >= 3 && normalized.includes('chat history');
    }

    private hasMeaningfulArtifactContent(content: string, title?: string): boolean {
        if (!content) {
            return false;
        }

        if (this.isIrrelevantProbePayload(content)) {
            return false;
        }

        const normalized = this.cleanArtifactText(
            content.trimStart().startsWith('<')
                ? content.replace(/<[^>]+>/g, ' ')
                : content
        );

        if (!normalized || this.isNoiseOnlyArtifactText(normalized)) {
            return false;
        }

        if (this.isChatGPTShellContent(content)) {
            return false;
        }

        if (this.isDeepResearchShellContent(normalized)) {
            return false;
        }

        const normalizedTitle = this.cleanArtifactText(title ?? '').toLowerCase();
        if (normalizedTitle && normalized.toLowerCase() === normalizedTitle) {
            return false;
        }

        return normalized.length >= Math.max(80, normalizedTitle.length + 24);
    }

    private isDeepResearchShellContent(content: string): boolean {
        const normalized = this.cleanArtifactText(content)
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        if (!normalized) {
            return true;
        }

        const shellSummary = /research completed in .*? citations .*? searches/.test(normalized);
        const shellHeadingsOnly = /^(research completed in .*?)( executive summary)?$/.test(normalized)
            || /^(executive summary|introduction|overview|sources|citations)$/.test(normalized);

        if (shellHeadingsOnly) {
            return true;
        }

        if (shellSummary && normalized.split(/\s+/).length < 40) {
            return true;
        }

        if (shellSummary && /executive summary/.test(normalized) && normalized.split(/\s+/).length < 70) {
            return true;
        }

        return false;
    }

    private isIrrelevantProbePayload(content: string): boolean {
        const normalized = content.trim();
        const lower = normalized.toLowerCase();

        if (!normalized) {
            return true;
        }

        if (lower.startsWith('{"type":"init"')) {
            return true;
        }

        if (/"ports":\{.*runUserCode.*prepareEnvironment.*runWidgetCode/i.test(normalized)) {
            return true;
        }

        if (/runUserCode|buildUserCode|prepareEnvironment|runWidgetCode|notifyMcpAppsTool(Input|Result|Cancelled)|setWidget(Data|View)|setTheme|setSafeArea/i.test(normalized)) {
            return true;
        }

        if (/window\.__oai_loghtml|window\.__oai_ssr_html|requestanimationframe/i.test(lower)) {
            return true;
        }

        if (lower.includes('<!doctype html')
            && lower.includes('@layer theme,base,components,utilities')
            && !/executive summary|market size|monetization|rollout|enterprise|smb|sources|introduction|recommendations/i.test(lower)) {
            return true;
        }

        return false;
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private normalizeSourceIndex(value: unknown): number | undefined {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return Math.trunc(value);
        }

        if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
            return Number(value.trim());
        }

        if (typeof value === 'string') {
            const citationMatch = value.match(/[\[【]?(\d{1,3})(?=†|[\]】,\s]|$)/);
            if (citationMatch) {
                return Number(citationMatch[1]);
            }
        }

        return undefined;
    }

    private isExternalResearchUrl(rawUrl: string | undefined): rawUrl is string {
        if (!rawUrl) {
            return false;
        }

        try {
            const resolvedUrl = new URL(rawUrl, window.location.href);
            const hostname = resolvedUrl.hostname.toLowerCase();

            if (!/^https?:$/.test(resolvedUrl.protocol)) {
                return false;
            }

            if (!hostname) {
                return false;
            }

            if (/(^|\.)chatgpt\.com$|(^|\.)openai\.com$|(^|\.)oaiusercontent\.com$/i.test(hostname)) {
                return false;
            }

            if (/fonts\.gstatic\.com|fonts\.googleapis\.com|googletagmanager\.com|google-analytics\.com|doubleclick\.net|cdn\.jsdelivr\.net|unpkg\.com/i.test(hostname)) {
                return false;
            }

            return !/\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(?:[?#]|$)/i.test(resolvedUrl.pathname);
        } catch {
            return false;
        }
    }

    private canonicalizeResearchUrl(rawUrl: string, options?: { stripHash?: boolean }): string | null {
        try {
            const url = new URL(rawUrl, window.location.href);
            if (options?.stripHash !== false) {
                url.hash = '';
            }

            const trackingParams = [
                'utm_source',
                'utm_medium',
                'utm_campaign',
                'utm_term',
                'utm_content',
                'gclid',
                'fbclid',
                'ref',
                'ref_src',
                'feature',
                'si',
            ];

            trackingParams.forEach((key) => url.searchParams.delete(key));

            if (url.pathname.length > 1) {
                url.pathname = url.pathname.replace(/\/+$/, '');
            }

            return url.href;
        } catch {
            return null;
        }
    }

    private normalizeDeepResearchSourceTitle(title: string): string {
        return this.cleanArtifactText(title)
            .replace(/\s+/g, ' ')
            .trim();
    }

    private scoreDeepResearchSource(source: DeepResearchSource): number {
        const title = this.normalizeDeepResearchSourceTitle(source.title);
        let score = 0;

        if (source.index !== undefined) {
            score += 1000;
        }

        if (title && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) {
            score += 200;
        }

        if (/research|report|analysis|market|software|collaboration|productivity/i.test(title)) {
            score += 120;
        }

        score += Math.max(0, 120 - source.url.length);
        return score;
    }

    private shouldPreserveResearchUrlHash(rawUrl: string): boolean {
        try {
            const url = new URL(rawUrl, window.location.href);
            return url.hash.startsWith('#:~:text=');
        } catch {
            return false;
        }
    }

    private normalizeDeepResearchSource(candidate: {
        index?: unknown;
        title?: string;
        url?: string;
    }): DeepResearchSource | null {
        if (!this.isExternalResearchUrl(candidate.url)) {
            return null;
        }

        try {
            const resolvedUrl = this.canonicalizeResearchUrl(candidate.url, {
                stripHash: false,
            });
            if (!resolvedUrl) {
                return null;
            }

            const hostname = new URL(resolvedUrl).hostname.replace(/^www\./i, '');
            const title = this.normalizeDeepResearchSourceTitle(candidate.title ?? '') || hostname;

            return {
                index: this.normalizeSourceIndex(candidate.index),
                title,
                url: resolvedUrl,
            };
        } catch {
            return null;
        }
    }

    private dedupeDeepResearchSources(candidates: Array<{
        index?: unknown;
        title?: string;
        url?: string;
    }>): DeepResearchSource[] {
        const indexed = new Map<number, DeepResearchSource>();
        const unindexed = new Map<string, DeepResearchSource>();

        const chooseBetterSource = (current: DeepResearchSource | undefined, candidate: DeepResearchSource): DeepResearchSource => {
            if (!current) {
                return candidate;
            }

            return this.scoreDeepResearchSource(candidate) > this.scoreDeepResearchSource(current)
                ? candidate
                : current;
        };

        candidates
            .flatMap((candidate) => {
                const normalized = this.normalizeDeepResearchSource(candidate);
                return normalized ? [normalized] : [];
            })
            .forEach((candidate) => {
                const titleKey = this.normalizeDeepResearchSourceTitle(candidate.title).toLowerCase();
                const key = `${candidate.url}|${titleKey}`;

                if (candidate.index !== undefined) {
                    indexed.set(candidate.index, chooseBetterSource(indexed.get(candidate.index), candidate));
                    return;
                }

                unindexed.set(key, chooseBetterSource(unindexed.get(key), candidate));
            });

        const indexedSources = Array.from(indexed.values()).sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
        const indexedUrls = new Set(indexedSources.map((source) => source.url));
        const indexedTitles = new Set(indexedSources.map((source) => this.normalizeDeepResearchSourceTitle(source.title).toLowerCase()));

        const unindexedSources = Array.from(unindexed.values())
            .filter((source) => !indexedUrls.has(source.url))
            .filter((source) => !indexedTitles.has(this.normalizeDeepResearchSourceTitle(source.title).toLowerCase()))
            .sort((left, right) => this.scoreDeepResearchSource(right) - this.scoreDeepResearchSource(left));

        return [...indexedSources, ...unindexedSources];
    }

    private extractCitationIndices(content: string): number[] {
        const seen = new Set<number>();
        const segments = content.split(/(<section\s[^>]*data-bonsai-(?:observed-)?sources[^>]*>[\s\S]*?<\/section>)/gi);
        const contentHtml = segments.filter((_part, idx) => idx % 2 === 0).join('\n');

        const combinedPattern = /(?:[\[【](\d+(?:[,、 ]\d+)*)(?:†[^\]】]+)?[\]】])|(?:data-citation-index="(\d+)")|(?:<sup(?![^>]*class="bonsai-citation")[^>]*>(?:<a\s[^>]*>)?(\d+(?:[,、 ]\d+)*)(?:<\/a>)?<\/sup>)/gi;

        for (const match of contentHtml.matchAll(combinedPattern)) {
            const rawIndexes = match[1] || match[2] || match[3];
            if (!rawIndexes) {
                continue;
            }

            for (const raw of rawIndexes.split(/[,、 ]+/)) {
                const value = Number(raw.trim());
                if (Number.isFinite(value) && value > 0) {
                    seen.add(value);
                }
            }
        }

        return Array.from(seen).sort((left, right) => left - right);
    }

    private extractSourceCandidatesFromMarkdown(markdown: string): DeepResearchSource[] {
        const candidates: Array<{ index?: unknown; title?: string; url?: string }> = [];

        for (const line of markdown.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            let match = trimmed.match(/^(\d+)[\].):-]?\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/i);
            if (match) {
                candidates.push({
                    index: match[1],
                    title: match[2],
                    url: match[3],
                });
                continue;
            }

            match = trimmed.match(/^(\d+)[\].):-]?\s*(.+?)\s+(https?:\/\/\S+)/i);
            if (match) {
                candidates.push({
                    index: match[1],
                    title: match[2].replace(/\s*[-–—:]\s*$/, ''),
                    url: match[3].replace(/[),.;]+$/, ''),
                });
            }
        }

        for (const match of markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
            candidates.push({
                title: match[1],
                url: match[2],
            });
        }

        for (const match of markdown.matchAll(/\bhttps?:\/\/[^\s<>)\]]+/g)) {
            candidates.push({
                url: match[0].replace(/[),.;]+$/, ''),
            });
        }

        return this.dedupeDeepResearchSources(candidates);
    }

    private extractSourceCandidatesFromHtml(rawHtml: string, baseUrl: string): DeepResearchSource[] {
        try {
            const parsed = new DOMParser().parseFromString(rawHtml, 'text/html');
            const candidates: Array<{ index?: unknown; title?: string; url?: string }> = [];

            parsed.querySelectorAll('button[data-citation-index][aria-label^="Scroll report to citation "]').forEach((button) => {
                const rawHref = button.parentElement?.querySelector('a[href]')?.getAttribute('href');
                const titleText = button.parentElement?.querySelector('a[href]')?.textContent ?? '';
                if (!rawHref) {
                    return;
                }

                let resolvedHref = rawHref;
                try {
                    resolvedHref = new URL(rawHref, baseUrl).href;
                } catch {
                    // Keep original href if URL resolution fails.
                }

                candidates.push({
                    index: button.getAttribute('data-citation-index') ?? undefined,
                    title: this.cleanArtifactText(titleText),
                    url: resolvedHref,
                });
            });

            parsed.querySelectorAll('a[href]').forEach((anchor) => {
                const rawHref = anchor.getAttribute('href');
                if (!rawHref) {
                    return;
                }

                let resolvedHref = rawHref;
                try {
                    resolvedHref = new URL(rawHref, baseUrl).href;
                } catch {
                    // Keep original href if URL resolution fails.
                }

                const liWrapper = anchor.closest('li');
                let indexToUse: number | undefined;

                const explicitIndex = liWrapper?.getAttribute('data-citation-index');
                if (explicitIndex) {
                    indexToUse = Number(explicitIndex);
                } else if (liWrapper && liWrapper.parentElement?.tagName === 'OL') {
                    const siblings = Array.from(liWrapper.parentElement.children).filter(child => child.tagName === 'LI');
                    const position = siblings.indexOf(liWrapper);
                    if (position !== -1) {
                        const startObj = liWrapper.parentElement.getAttribute('start');
                        const start = startObj ? Number(startObj) : 1;
                        indexToUse = start + position;
                    }
                }

                if (indexToUse === undefined) {
                    const containerText = liWrapper?.textContent ?? anchor.textContent ?? '';
                    const match = containerText.match(/^\s*(\d{1,3})\b/);
                    if (match) {
                        indexToUse = Number(match[1]);
                    }
                }

                candidates.push({
                    index: indexToUse,
                    title: this.cleanArtifactText(anchor.textContent ?? liWrapper?.textContent ?? ''),
                    url: resolvedHref,
                });
            });

            return this.dedupeDeepResearchSources(candidates);
        } catch {
            return [];
        }
    }

    private extractSourceCandidatesFromJson(rawJson: string): DeepResearchSource[] {
        try {
            const parsed = JSON.parse(rawJson);
            const candidates: Array<{ index?: unknown; title?: string; url?: string }> = [];
            const seenObjects = new WeakSet<object>();

            const visit = (value: unknown, depth = 0, injectedIndex?: string) => {
                if (depth > 6 || value == null) {
                    return;
                }

                if (typeof value === 'string') {
                    candidates.push(...this.extractSourceCandidatesFromMarkdown(value));
                    return;
                }

                if (Array.isArray(value)) {
                    value.slice(0, 50).forEach((item, arrIdx) => visit(item, depth + 1, String(arrIdx + 1)));
                    return;
                }

                if (typeof value !== 'object') {
                    return;
                }

                if (seenObjects.has(value as object)) {
                    return;
                }
                seenObjects.add(value as object);

                const record = value as Record<string, unknown>;

                // Note: content_references uses an internal bucket-numbering
                // scheme (13 unique values) that does NOT match the display
                // citation numbers (1..N).  Skip it here; the canonical source
                // list is extracted upstream by extractSourcesFromWidgetStateCitations.

                if (Array.isArray(record.references)) {
                    record.references.slice(0, 200).forEach((reference) => {
                        if (!reference || typeof reference !== 'object') {
                            return;
                        }

                        const refRecord = reference as Record<string, unknown>;
                        candidates.push({
                            index: refRecord.index ?? refRecord.matched_text ?? refRecord.matchedText,
                            title: typeof refRecord.title === 'string' ? refRecord.title : undefined,
                            url: typeof refRecord.url === 'string' ? refRecord.url : undefined,
                        });
                    });
                }

                const explicitUrl = ['url', 'href', 'link', 'uri', 'sourceUrl', 'source_url']
                    .map((key) => record[key])
                    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
                const domain = ['domain', 'hostname', 'host']
                    .map((key) => record[key])
                    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
                const candidateUrl = explicitUrl
                    ?? (domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim()) ? `https://${domain.trim()}` : undefined);
                const title = ['title', 'name', 'label', 'sourceTitle', 'domain', 'hostname', 'siteName', 'site']
                    .map((key) => record[key])
                    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
                const index = ['index', 'sourceIndex', 'citationIndex', 'number', 'source_id', 'sourceId', 'matched_text', 'matchedText', 'id']
                    .map((key) => record[key])
                    .find((candidate) => candidate !== undefined) ?? injectedIndex;

                if (candidateUrl) {
                    candidates.push({
                        index,
                        title,
                        url: candidateUrl,
                    });
                }

                Object.entries(record)
                    .slice(0, 60)
                    .forEach(([key, nested]) => {
                        const nextInjectedIndex = /^\d+$/.test(key.trim()) ? key.trim() : undefined;
                        visit(nested, depth + 1, nextInjectedIndex);
                    });
            };

            visit(parsed);
            return this.dedupeDeepResearchSources(candidates);
        } catch {
            return [];
        }
    }

    /**
     * Extracts the canonical 1-indexed source list from the deep research widget-state
     * message-port probe entry.  OpenAI sends a CALL payload containing
     * `widgetState.report_message.metadata.citations` – a flat array of every
     * inline citation (including duplicates).  Deduplicating by URL in
     * first-appearance order reproduces exactly the numbered Sources panel
     * shown in the iframe (34 items for a 34-source report, etc.).
     */
    private async extractSourcesFromWidgetStateCitations(): Promise<DeepResearchSource[]> {
        const snapshots = await this.getOpenAIProbeSnapshots();
        console.log(`[Bonsai Citation Debug] v3 extractSourcesFromWidgetStateCitations: ${snapshots.length} snapshots`, snapshots.map(s => ({ url: s.url.slice(0, 80), entries: s.entries.length, kinds: s.entries.map(e => e.kind) })));
        for (const snapshot of snapshots) {
            for (const entry of snapshot.entries) {
                if (entry.kind !== 'message-port') {
                    continue;
                }

                try {
                    const parsed: unknown = JSON.parse(entry.body);
                    const payload = Array.isArray(parsed) ? parsed[1] : parsed;
                    if (!payload || typeof payload !== 'object') {
                        console.log('[Bonsai Citation Debug] message-port entry has non-object payload after parse', typeof payload);
                        continue;
                    }

                    const ws = (payload as Record<string, unknown>).widgetState;
                    if (!ws || typeof ws !== 'object') {
                        console.log('[Bonsai Citation Debug] message-port payload missing widgetState, keys:', Object.keys(payload as object).slice(0, 6));
                        continue;
                    }

                    const reportMsg = (ws as Record<string, unknown>).report_message;
                    if (!reportMsg || typeof reportMsg !== 'object') {
                        continue;
                    }

                    const metadata = (reportMsg as Record<string, unknown>).metadata;
                    if (!metadata || typeof metadata !== 'object') {
                        continue;
                    }

                    const citations = (metadata as Record<string, unknown>).citations;
                    if (!Array.isArray(citations) || citations.length === 0) {
                        continue;
                    }

                    // Deduplicate by full URL, preserving first-appearance order.
                    // Each unique URL becomes source index 1, 2, 3 … matching the
                    // numbered Sources panel rendered by the deep-research iframe.
                    const seen = new Set<string>();
                    const sources: DeepResearchSource[] = [];

                    for (const citation of citations) {
                        if (!citation || typeof citation !== 'object') {
                            continue;
                        }

                        const meta = (citation as Record<string, unknown>).metadata;
                        if (!meta || typeof meta !== 'object') {
                            continue;
                        }

                        const url = (meta as Record<string, unknown>).url;
                        const title = (meta as Record<string, unknown>).title;

                        if (typeof url !== 'string' || !url) {
                            continue;
                        }

                        if (seen.has(url)) {
                            continue;
                        }

                        seen.add(url);
                        const cleanTitle = this.cleanArtifactText(typeof title === 'string' ? title : '');
                        const resolvedTitle = cleanTitle || (() => {
                            try {
                                return new URL(url).hostname.replace(/^www\./i, '');
                            } catch {
                                return '';
                            }
                        })();
                        sources.push({
                            index: sources.length + 1,
                            title: resolvedTitle,
                            url,
                        });
                    }

                    if (sources.length >= 3) {
                        console.log(`[Bonsai Citation Debug] widgetState citations fast-path: ${sources.length} sources found`);
                        return sources;
                    }
                } catch {
                    // continue to next entry
                }
            }
        }

        console.log('[Bonsai Citation Debug] widgetState citations fast-path: no usable entry found, falling back');
        return [];
    }

    private async collectSourcesForEmbed(
        embed: { title: string; sourceUrl?: string; viewUrl?: string },
        preferredCandidate?: { html?: string; text: string; url?: string }
    ): Promise<DeepResearchSource[]> {
        // Fast path: the probe captures a message-port payload containing the
        // canonical citation array from the deep-research widget state.
        // Deduplicating by URL gives the exact numbered source list (1..N)
        // that matches the Sources panel rendered by the iframe.
        const widgetCitations = await this.extractSourcesFromWidgetStateCitations();
        if (widgetCitations.length >= 3) {
            return widgetCitations;
        }

        const candidates: Array<{ index?: unknown; title?: string; url?: string }> = [];
        const pushAll = (sources: DeepResearchSource[]) => {
            candidates.push(...sources);
        };
        const baseUrl = preferredCandidate?.url ?? embed.viewUrl ?? embed.sourceUrl ?? window.location.href;
        const preferredSources: DeepResearchSource[] = [];
        const preferredCitationIndexes = this.extractCitationIndices(preferredCandidate?.html ?? preferredCandidate?.text ?? '');

        if (preferredCandidate?.html) {
            preferredSources.push(...this.extractSourceCandidatesFromHtml(preferredCandidate.html, baseUrl));
        }

        if (preferredCandidate?.text) {
            preferredSources.push(...this.extractSourceCandidatesFromMarkdown(preferredCandidate.text));
        }

        const dedupedPreferredSources = this.dedupeDeepResearchSources(preferredSources);
        const preferredIndexedSources = dedupedPreferredSources.filter((source): source is DeepResearchSource & { index: number } => source.index !== undefined);

        if (preferredIndexedSources.length > 0) {
            return preferredIndexedSources;
        }

        if (dedupedPreferredSources.length >= 3 && preferredCitationIndexes.length === 0) {
            return dedupedPreferredSources.slice(0, 99);
        }

        pushAll(dedupedPreferredSources);

        const snapshots = await this.getOpenAIProbeSnapshots();
        for (const snapshot of snapshots) {
            if (!snapshot.isTop || /oaiusercontent|deep[_-]?research/i.test(snapshot.url)) {
                if (snapshot.bodyHtml) {
                    pushAll(this.extractSourceCandidatesFromHtml(snapshot.bodyHtml, snapshot.url || baseUrl));
                }

                if (snapshot.bodyText) {
                    pushAll(this.extractSourceCandidatesFromMarkdown(snapshot.bodyText));
                }
            }

            for (const entry of snapshot.entries) {
                if (this.isExternalResearchUrl(entry.url)) {
                    candidates.push({ url: entry.url });
                }

                const body = entry.body || '';
                const contentType = (entry.contentType ?? '').toLowerCase();
                if (!body || this.isIrrelevantProbePayload(body)) {
                    continue;
                }

                if (contentType.includes('json') || body.trimStart().startsWith('{')) {
                    pushAll(this.extractSourceCandidatesFromJson(body));
                    continue;
                }

                if (contentType.includes('html') || body.trimStart().startsWith('<')) {
                    pushAll(this.extractSourceCandidatesFromHtml(body, entry.url || snapshot.url || baseUrl));
                    continue;
                }

                pushAll(this.extractSourceCandidatesFromMarkdown(body));
            }
        }

        const frames = await this.getExtractedFrameContent();
        for (const frame of frames) {
            if (!frame.isTop || /oaiusercontent|deep[_-]?research/i.test(frame.url)) {
                if (frame.html) {
                    pushAll(this.extractSourceCandidatesFromHtml(frame.html, frame.url));
                }

                if (frame.text) {
                    pushAll(this.extractSourceCandidatesFromMarkdown(frame.text));
                }
            }
        }

        for (const candidateUrl of [embed.viewUrl, embed.sourceUrl]) {
            if (this.isExternalResearchUrl(candidateUrl)) {
                candidates.push({ url: candidateUrl });
            }
        }

        const dedupedSources = this.dedupeDeepResearchSources(candidates);
        const indexedSources = dedupedSources.filter((source): source is DeepResearchSource & { index: number } => source.index !== undefined);
        return (indexedSources.length > 0 ? indexedSources : dedupedSources).slice(0, 99);
    }

    private buildSourcesSectionHtml(title: string, sources: DeepResearchSource[], indexed: boolean): string {
        const items = sources
            .map((source) => {
                const escapedTitle = this.escapeHtml(source.title);
                const escapedUrl = this.escapeHtml(source.url);

                if (indexed && (source.aliases?.length || source.index !== undefined)) {
                    const indexes = (source.aliases && source.aliases.length > 0)
                        ? source.aliases
                        : [source.index!];

                    // Primary index goes directly on the <li> so TipTap's listItem node
                    // preserves the id attribute added by decorateRenderedResearchHtml.
                    // Any additional alias indexes get <span data-bonsai-source-index>
                    // markers inside the <li> for secondary anchor targets.
                    const [primaryIndex, ...aliasIndexes] = indexes;
                    const aliasMarkers = aliasIndexes
                        .map((index) => `<span data-bonsai-source-index="${index}"></span>`)
                        .join('');
                    const label = indexes.join(', ');

                    return `  <li data-bonsai-source-index="${primaryIndex}">${aliasMarkers}<sup>${this.escapeHtml(label)}</sup> <a href="${escapedUrl}" target="_blank" rel="noreferrer">${escapedTitle}</a></li>`;
                }

                return `  <li><a href="${escapedUrl}" target="_blank" rel="noreferrer">${escapedTitle}</a></li>`;
            })
            .join('\n');

        return `<section ${indexed ? 'data-bonsai-sources="true"' : 'data-bonsai-observed-sources="true"'}>\n<h2>${title}</h2>\n<ul>\n${items}\n</ul>\n</section>`;
    }

    private buildReferenceDerivedCitationIndexMap(
        metadata: Record<string, unknown>,
        canonicalSources: Array<DeepResearchSource & { index: number }>
    ): ReferenceDerivedCitationIndexMap {
        const exactCanonicalByUrl = new Map<string, number>();
        const normalizedCanonicalByUrl = new Map<string, number>();
        const normalizedCanonicalUrlCounts = new Map<string, number>();
        const titleCounts = new Map<string, number>();

        canonicalSources.forEach((source) => {
            const exactUrl = this.canonicalizeResearchUrl(source.url, { stripHash: false }) ?? source.url;
            exactCanonicalByUrl.set(exactUrl, source.index);

            const normalizedUrl = this.canonicalizeResearchUrl(source.url);
            if (normalizedUrl) {
                normalizedCanonicalByUrl.set(normalizedUrl, source.index);
                normalizedCanonicalUrlCounts.set(normalizedUrl, (normalizedCanonicalUrlCounts.get(normalizedUrl) ?? 0) + 1);
            }

            const titleKey = this.normalizeDeepResearchSourceTitle(source.title).toLowerCase();
            titleCounts.set(titleKey, (titleCounts.get(titleKey) ?? 0) + 1);
        });

        const canonicalByUniqueTitle = new Map<string, number>();
        canonicalSources.forEach((source) => {
            const titleKey = this.normalizeDeepResearchSourceTitle(source.title).toLowerCase();
            if ((titleCounts.get(titleKey) ?? 0) === 1) {
                canonicalByUniqueTitle.set(titleKey, source.index);
            }
        });

        const resolveCanonicalIndex = (candidate: { rawUrl?: string; normalizedUrl?: string; title?: string }): number | undefined => {
            const titleKey = this.normalizeDeepResearchSourceTitle(candidate.title ?? '').toLowerCase();
            const exactMatch = candidate.rawUrl ? exactCanonicalByUrl.get(candidate.rawUrl) : undefined;
            if (exactMatch !== undefined) {
                return exactMatch;
            }

            if (candidate.normalizedUrl && (normalizedCanonicalUrlCounts.get(candidate.normalizedUrl) ?? 0) === 1) {
                const normalizedMatch = normalizedCanonicalByUrl.get(candidate.normalizedUrl);
                if (normalizedMatch !== undefined) {
                    return normalizedMatch;
                }
            }

            return canonicalByUniqueTitle.get(titleKey);
        };

        const rawToCanonical = new Map<number, number>();
        const titleFallbackRawIndexes = new Set<number>();
        const maybeReferenceArrays = [
            metadata.content_references,
            metadata.contentReferences,
            metadata.references,
            metadata.reference_list,
            metadata.referenceList,
        ];

        maybeReferenceArrays.forEach((value) => {
            if (!Array.isArray(value)) {
                return;
            }

            value.slice(0, 500).forEach((entry) => {
                if (!entry || typeof entry !== 'object') {
                    return;
                }

                const record = entry as Record<string, unknown>;
                const nestedMeta = record.metadata && typeof record.metadata === 'object'
                    ? record.metadata as Record<string, unknown>
                    : undefined;

                const rawIndex = this.normalizeSourceIndex(
                    record.index
                    ?? record.sourceIndex
                    ?? record.citationIndex
                    ?? record.number
                    ?? record.source_id
                    ?? record.sourceId
                    ?? record.id
                    ?? record.matched_text
                    ?? record.matchedText
                );
                if (rawIndex === undefined) {
                    return;
                }

                const rawTitle = typeof record.title === 'string'
                    ? record.title
                    : typeof record.name === 'string'
                        ? record.name
                        : typeof nestedMeta?.title === 'string'
                            ? nestedMeta.title
                            : undefined;
                const rawUrl = typeof record.url === 'string'
                    ? record.url
                    : typeof record.href === 'string'
                        ? record.href
                        : typeof nestedMeta?.url === 'string'
                            ? nestedMeta.url
                            : typeof nestedMeta?.href === 'string'
                                ? nestedMeta.href
                                : undefined;

                const exactUrl = rawUrl && this.isExternalResearchUrl(rawUrl)
                    ? this.canonicalizeResearchUrl(rawUrl, { stripHash: false }) ?? undefined
                    : undefined;
                const normalizedUrl = rawUrl && this.isExternalResearchUrl(rawUrl)
                    ? this.canonicalizeResearchUrl(rawUrl) ?? undefined
                    : undefined;

                const matchedByUrl = exactUrl !== undefined || normalizedUrl !== undefined;
                const canonical = resolveCanonicalIndex({
                    rawUrl: exactUrl,
                    normalizedUrl,
                    title: rawTitle,
                });
                if (canonical !== undefined) {
                    rawToCanonical.set(rawIndex, canonical);
                    if (!matchedByUrl) {
                        titleFallbackRawIndexes.add(rawIndex);
                    }
                }
            });
        });

        return { rawToCanonical, titleFallbackRawIndexes };
    }

    private async buildCanonicalCitationIndexMap(
        sources: DeepResearchSource[],
        preferredDebugRef?: string,
        citedRawIndexes: number[] = []
    ): Promise<Map<number, number>> {
        const canonicalSources = sources.filter((source): source is DeepResearchSource & { index: number } => source.index !== undefined);
        if (canonicalSources.length === 0) {
            return new Map();
        }

        // Build URL → canonical index lookup from the already-deduplicated sources list.
        const urlToCanonical = new Map<string, number>();
        const normalizedUrlToCanonical = new Map<string, number>();
        const normalizedUrlCounts = new Map<string, number>();

        for (const source of canonicalSources) {
            urlToCanonical.set(source.url, source.index);

            const normalizedSourceUrl = this.canonicalizeResearchUrl(source.url);
            if (normalizedSourceUrl) {
                normalizedUrlToCanonical.set(normalizedSourceUrl, source.index);
                normalizedUrlCounts.set(normalizedSourceUrl, (normalizedUrlCounts.get(normalizedSourceUrl) ?? 0) + 1);
            }
        }

        const resolveCitationUrlToCanonical = (rawUrl: string): number | undefined => {
            const exactUrl = this.canonicalizeResearchUrl(rawUrl, { stripHash: false });
            if (exactUrl) {
                const exactMatch = urlToCanonical.get(exactUrl);
                if (exactMatch !== undefined) {
                    return exactMatch;
                }
            }

            const normalizedUrl = this.canonicalizeResearchUrl(rawUrl);
            if (normalizedUrl && (normalizedUrlCounts.get(normalizedUrl) ?? 0) === 1) {
                return normalizedUrlToCanonical.get(normalizedUrl);
            }

            return undefined;
        };

        const snapshots = await this.getOpenAIProbeSnapshots();
        let firstFullCoverage: { debugRef: string; map: Map<number, number> } | null = null;
        let preferredCoverage = 0;

        // Walk metadata.citations in position order (same structure as
        // extractSourcesFromWidgetStateCitations).  rawIndex = position + 1 (1-based)
        // matches the inline marker number 【N†…】 in the probe markdown.
        for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex += 1) {
            const snapshot = snapshots[snapshotIndex];
            for (let entryIndex = 0; entryIndex < snapshot.entries.length; entryIndex += 1) {
                const entry = snapshot.entries[entryIndex];
                if (entry.kind !== 'message-port') {
                    continue;
                }

                const entryDebugRef = this.buildProbeEntryDebugRef(snapshotIndex, entryIndex, entry.kind, entry.url || snapshot.url);
                const positionDerivedMap = new Map<number, number>();

                try {
                    const parsed: unknown = JSON.parse(entry.body);
                    const payload = Array.isArray(parsed) ? parsed[1] : parsed;
                    if (!payload || typeof payload !== 'object') {
                        continue;
                    }

                    const ws = (payload as Record<string, unknown>).widgetState;
                    if (!ws || typeof ws !== 'object') {
                        continue;
                    }

                    const reportMsg = (ws as Record<string, unknown>).report_message;
                    if (!reportMsg || typeof reportMsg !== 'object') {
                        continue;
                    }

                    const metadata = (reportMsg as Record<string, unknown>).metadata;
                    if (!metadata || typeof metadata !== 'object') {
                        continue;
                    }

                    const citations = (metadata as Record<string, unknown>).citations;
                    if (!Array.isArray(citations) || citations.length === 0) {
                        continue;
                    }

                    for (let i = 0; i < citations.length; i += 1) {
                        const rawIndex = i + 1;
                        const citation = citations[i];
                        if (!citation || typeof citation !== 'object') {
                            continue;
                        }

                        const citMeta = (citation as Record<string, unknown>).metadata;
                        if (!citMeta || typeof citMeta !== 'object') {
                            continue;
                        }

                        const url = (citMeta as Record<string, unknown>).url;
                        if (typeof url !== 'string' || !url) {
                            continue;
                        }

                        const canonical = resolveCitationUrlToCanonical(url);
                        if (canonical !== undefined) {
                            positionDerivedMap.set(rawIndex, canonical);
                        }
                    }

                    const {
                        rawToCanonical: referenceDerivedMap,
                        titleFallbackRawIndexes,
                    } = this.buildReferenceDerivedCitationIndexMap(metadata as Record<string, unknown>, canonicalSources);
                    const mergedMap = new Map(positionDerivedMap);
                    referenceDerivedMap.forEach((canonical, rawIndex) => {
                        if (titleFallbackRawIndexes.has(rawIndex) && mergedMap.has(rawIndex)) {
                            return;
                        }
                        mergedMap.set(rawIndex, canonical);
                    });

                    const citedRawSet = new Set(citedRawIndexes);
                    const referenceCoverage = citedRawSet.size > 0
                        ? citedRawIndexes.filter((rawIndex) => referenceDerivedMap.has(rawIndex)).length
                        : referenceDerivedMap.size;
                    const positionCoverage = citedRawSet.size > 0
                        ? citedRawIndexes.filter((rawIndex) => positionDerivedMap.has(rawIndex)).length
                        : positionDerivedMap.size;
                    const mergedCoverage = citedRawSet.size > 0
                        ? citedRawIndexes.filter((rawIndex) => mergedMap.has(rawIndex)).length
                        : mergedMap.size;
                    const canonicalCoverage = new Set(mergedMap.values()).size;

                    const isPreferred = Boolean(preferredDebugRef) && entryDebugRef === preferredDebugRef;
                    const isFullCoverage = citedRawSet.size > 0
                        ? mergedCoverage === citedRawSet.size
                        : canonicalCoverage >= canonicalSources.length;

                    if (isPreferred) {
                        preferredCoverage = mergedCoverage;
                        if (isFullCoverage) {
                            console.log('[Bonsai Citation Debug] Canonical citation map entry selected (preferred exact match)', {
                                preferredDebugRef,
                                chosenDebugRef: entryDebugRef,
                                coverage: mergedCoverage,
                                canonicalCoverage,
                                canonicalSourceCount: canonicalSources.length,
                                sampleMap: Array.from(mergedMap.entries()).slice(0, 12),
                                referenceCoverage,
                                positionCoverage,
                                mergedCoverage,
                                sampleReferenceMap: Array.from(referenceDerivedMap.entries()).slice(0, 12),
                            });
                            return mergedMap;
                        }
                    }

                    if (isFullCoverage && !firstFullCoverage) {
                        firstFullCoverage = {
                            debugRef: entryDebugRef,
                            map: new Map(mergedMap),
                        };
                    }
                } catch {
                    // continue to next entry
                }
            }
        }

        if (firstFullCoverage) {
            console.log('[Bonsai Citation Debug] Canonical citation map entry selected (full-coverage fallback)', {
                preferredDebugRef: preferredDebugRef ?? null,
                chosenDebugRef: firstFullCoverage.debugRef,
                preferredCoverage,
                canonicalSourceCount: canonicalSources.length,
                sampleMap: Array.from(firstFullCoverage.map.entries()).slice(0, 12),
            });
            return firstFullCoverage.map;
        }

        console.log('[Bonsai Citation Debug] Canonical citation map entry not found', {
            preferredDebugRef: preferredDebugRef ?? null,
            preferredCoverage,
            canonicalSourceCount: canonicalSources.length,
        });
        return new Map();
    }

    private rewriteCitationMarkersToCanonicalIndexes(text: string, rawToCanonical: Map<number, number>): string {
        if (!text || rawToCanonical.size === 0) {
            return text;
        }

        return text.replace(
            /([\[【])(\d+(?:[,、 ]\d+)*)(†[^\]】]+)?([\]】])/g,
            (_match, open: string, rawIndexes: string, lineInfo: string | undefined, close: string) => {
                const rewrittenIndexes = rawIndexes
                    .split(/([,、 ]+)/)
                    .map((part) => {
                        if (!/^\d+$/.test(part)) {
                            return part;
                        }

                        const rawIndex = Number.parseInt(part, 10);
                        return String(rawToCanonical.get(rawIndex) ?? rawIndex);
                    })
                    .join('');

                return `${open}${rewrittenIndexes}${lineInfo ?? ''}${close}`;
            }
        );
    }

    private async rewriteProbeMarkdownCitationIndexes(
        text: string,
        sources: DeepResearchSource[],
        selectedCandidate?: DeepResearchCandidate
    ): Promise<string> {
        const citedRawIndexes = this.extractCitationIndices(text);
        const rawToCanonical = await this.buildCanonicalCitationIndexMap(sources, selectedCandidate?.debugRef, citedRawIndexes);

        if (rawToCanonical.size === 0) {
            return text;
        }

        return this.rewriteCitationMarkersToCanonicalIndexes(text, rawToCanonical);
    }

    private stripExistingSourcesSections(content: string): string {
        return content
            .replace(/\s*<section\s[^>]*data-bonsai-(?:observed-)?sources[^>]*>[\s\S]*?<\/section>\s*/gi, '\n\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    private appendSourcesToResearchContent(content: string, sources: DeepResearchSource[]): string {
        const trimmedContent = content.trim();
        if (sources.length === 0) {
            return trimmedContent;
        }

        const contentWithoutSources = this.stripExistingSourcesSections(trimmedContent);

        const citedIndices = this.extractCitationIndices(contentWithoutSources);
        let indexedSources = sources.filter((source): source is DeepResearchSource & { index: number } => source.index !== undefined);
        let observedSources = sources.filter((source) => source.index === undefined);

        if (indexedSources.length === 0 && observedSources.length === 1 && citedIndices.length > 0) {
            indexedSources = [{
                ...observedSources[0],
                index: citedIndices[0],
                aliases: citedIndices,
            }];
            observedSources = [];
        }

        const sections = [contentWithoutSources];

        if (indexedSources.length > 0) {
            sections.push(this.buildSourcesSectionHtml('Sources', indexedSources, true));
        }

        if (observedSources.length > 0) {
            sections.push(this.buildSourcesSectionHtml(indexedSources.length > 0 ? 'Observed sources' : 'Sources', observedSources, false));
        }

        return sections.filter(Boolean).join('\n\n').trim();
    }

    private appendSourcesToResearchHtml(content: string, sources: DeepResearchSource[]): string {
        const trimmedContent = content.trim();
        if (sources.length === 0) {
            return trimmedContent;
        }

        const contentWithoutSources = this.stripExistingSourcesSections(trimmedContent);

        const citedIndices = this.extractCitationIndices(contentWithoutSources);
        let indexedSources = sources.filter((source): source is DeepResearchSource & { index: number } => source.index !== undefined);
        let observedSources = sources.filter((source) => source.index === undefined);

        if (indexedSources.length === 0 && observedSources.length === 1 && citedIndices.length > 0) {
            indexedSources = [{
                ...observedSources[0],
                index: citedIndices[0],
                aliases: citedIndices,
            }];
            observedSources = [];
        }

        const sections = [contentWithoutSources];

        if (indexedSources.length > 0) {
            sections.push(this.buildSourcesSectionHtml('Sources', indexedSources, true));
        }

        if (observedSources.length > 0) {
            sections.push(this.buildSourcesSectionHtml(indexedSources.length > 0 ? 'Observed sources' : 'Sources', observedSources, false));
        }

        return sections.filter(Boolean).join('\n');
    }

    private extractJsonArtifactContent(rawJson: string): string | null {
        try {
            const parsed = JSON.parse(rawJson);
            let bestMatch: { score: number; value: string } | undefined;

            const visit = (value: unknown, path: string) => {
                if (typeof value === 'string') {
                    const trimmed = value.trim();
                    if (trimmed.length < 80) {
                        return;
                    }

                    const pathBonus = /html|markdown|content|body|report|text/i.test(path) ? 500 : 0;
                    const htmlBonus = /<(html|body|main|article|section|div|p|h1|h2)\b/i.test(trimmed) ? 400 : 0;
                    const score = trimmed.length + pathBonus + htmlBonus;

                    if (!bestMatch || score > bestMatch.score) {
                        bestMatch = { score, value: trimmed };
                    }
                    return;
                }

                if (Array.isArray(value)) {
                    value.slice(0, 25).forEach((item, index) => visit(item, `${path}[${index}]`));
                    return;
                }

                if (value && typeof value === 'object') {
                    Object.entries(value as Record<string, unknown>)
                        .slice(0, 50)
                        .forEach(([key, nestedValue]) => visit(nestedValue, path ? `${path}.${key}` : key));
                }
            };

            visit(parsed, 'root');
            return bestMatch ? bestMatch.value : null;
        } catch {
            return null;
        }
    }

    private async getExtractedFrameContent(): Promise<ExtractedFrameContent[]> {
        if (!this.extractedFrameContentPromise) {
            this.extractedFrameContentPromise = this.extractAllFrames();
        }

        const frames = await this.extractedFrameContentPromise;
        return frames.filter((frame) => {
            const normalized = this.cleanArtifactText(frame.text || frame.html.replace(/<[^>]+>/g, ' '));
            return normalized.length >= 80 && !this.isNoiseOnlyArtifactText(normalized);
        });
    }

    private async getOpenAIProbeSnapshots(): Promise<OpenAIProbeSnapshot[]> {
        if (!this.openAIProbeSnapshotsPromise) {
            this.openAIProbeSnapshotsPromise = this.getOpenAIResearchProbeData();
        }

        const snapshots = await this.openAIProbeSnapshotsPromise;
        return snapshots.filter((snapshot) => snapshot.entries.length > 0 || /deep[_-]?research|research|report|oaiusercontent/i.test(snapshot.url));
    }

    private dedupeDeepResearchCandidates(candidates: DeepResearchCandidate[]): DeepResearchCandidate[] {
        const seen = new Set<string>();

        return candidates
            .sort((left, right) => right.score - left.score)
            .filter((candidate) => {
                const key = [
                    candidate.label,
                    this.cleanArtifactText(candidate.title ?? '').toLowerCase(),
                    this.cleanArtifactText(candidate.text).slice(0, 600).toLowerCase(),
                ].join('|');

                if (seen.has(key)) {
                    return false;
                }

                seen.add(key);
                return true;
            });
    }

    private extractMermaidCodeFromCandidateText(text: string): string | null {
        const normalized = text.replace(/\r\n?/g, '\n');
        const fencedMatch = normalized.match(/```mermaid\s*\n([\s\S]*?)```/i);
        if (fencedMatch?.[1]?.trim()) {
            return this.decodeMermaidEntities(fencedMatch[1].trim());
        }

        const lines = normalized.split('\n');
        const mermaidStartPattern = /^(gantt|flowchart(?:-elk)?|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gitGraph|pie|mindmap|timeline|quadrantChart|requirementDiagram|c4context|c4container|c4component|c4dynamic|c4deployment|xychart-beta|block-beta|kanban|packet-beta|architecture(?:-beta)?|sankey-beta)\b/i;

        for (let index = 0; index < lines.length; index += 1) {
            if (lines[index].trim().toLowerCase() !== 'mermaid') {
                continue;
            }

            let start = index + 1;
            while (start < lines.length && !lines[start].trim()) {
                start += 1;
            }

            if (start >= lines.length || !mermaidStartPattern.test(lines[start].trim())) {
                continue;
            }

            let end = start + 1;
            let blankRun = 0;

            for (; end < lines.length; end += 1) {
                const trimmed = lines[end].trim();
                if (!trimmed) {
                    blankRun += 1;
                    if (blankRun >= 2) {
                        break;
                    }
                    continue;
                }

                if (end > start + 1 && /^[A-Z][\w\s/&-]{3,}:/.test(trimmed)) {
                    break;
                }

                blankRun = 0;
            }

            const code = lines.slice(start, end).join('\n').trim();
            if (code) {
                return this.decodeMermaidEntities(code);
            }
        }

        return null;
    }

    private decodeMermaidEntities(value: string): string {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = value;
        return textarea.value;
    }

    private findMermaidCodeInCandidates(
        candidates: DeepResearchCandidate[],
        selectedCandidate?: DeepResearchCandidate
    ): string | null {
        for (const candidate of candidates) {
            if (candidate === selectedCandidate) {
                continue;
            }

            const mermaidCode = this.extractMermaidCodeFromCandidateText(candidate.text);
            if (mermaidCode) {
                return mermaidCode;
            }
        }

        return null;
    }

    private injectMermaidCodeIntoResearchHtml(html: string, mermaidCode: string): string {
        if (!html.trim() || !mermaidCode.trim()) {
            return html;
        }

        if (/<code\b[^>]*language-mermaid/i.test(html)) {
            return html;
        }

        const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        const body = parsed.body;

        const hasContent = (node: Element): boolean => {
            if (this.cleanArtifactText(node.textContent ?? '')) {
                return true;
            }

            return Boolean(node.querySelector('pre, code, table, ul, ol, li, img, video, audio, canvas, blockquote, p, h1, h2, h3, h4, h5, h6'));
        };

        Array.from(body.querySelectorAll('div, section, article, figure'))
            .reverse()
            .forEach((node) => {
                if (node.matches('[data-bonsai-sources="true"], [data-bonsai-observed-sources="true"]')) {
                    return;
                }

                if (hasContent(node)) {
                    return;
                }

                node.remove();
            });

        const pre = parsed.createElement('pre');
        const code = parsed.createElement('code');
        code.className = 'language-mermaid';
        code.textContent = mermaidCode;
        pre.append(code);

        const sourceSection = body.querySelector('[data-bonsai-sources="true"], [data-bonsai-observed-sources="true"]');
        if (sourceSection) {
            sourceSection.before(pre);
        } else {
            body.append(pre);
        }

        return body.innerHTML.trim();
    }

    private normalizeCandidateText(candidate: { text: string; html?: string }): string {
        return this.cleanArtifactText(candidate.text || (candidate.html ? candidate.html.replace(/<[^>]+>/g, ' ') : ''));
    }

    private buildProbeEntryDebugRef(snapshotIndex: number, entryIndex: number, kind: string, url?: string): string {
        const trimmedUrl = this.cleanArtifactText(url ?? '').slice(0, 120);
        return `snapshot:${snapshotIndex}:entry:${entryIndex}:${kind}${trimmedUrl ? `:${trimmedUrl}` : ''}`;
    }

    private async collectProbeCandidatesForEmbed(embed: {
        title: string;
        sourceUrl?: string;
        viewUrl?: string;
    }): Promise<DeepResearchCandidate[]> {
        const snapshots = await this.getOpenAIProbeSnapshots();
        const candidates: DeepResearchCandidate[] = [];

        const considerCandidate = (
            candidate: { html?: string; text: string; title?: string; url?: string },
            label: string,
            score: number,
            debugRef?: string
        ) => {
            const normalizedText = this.normalizeCandidateText(candidate);
            if (!normalizedText || this.isIrrelevantProbePayload(candidate.html ?? normalizedText)) {
                return;
            }

            if (!this.hasMeaningfulArtifactContent(candidate.html ?? normalizedText, embed.title)) {
                return;
            }

            candidates.push({
                label,
                score,
                text: normalizedText,
                html: candidate.html,
                title: candidate.title,
                url: candidate.url,
                debugRef,
            });
        };

        for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex += 1) {
            const snapshot = snapshots[snapshotIndex];
            if (!snapshot.isTop || /oaiusercontent|deep[_-]?research/i.test(snapshot.url)) {
                const parsedSnapshotHtml = snapshot.bodyHtml
                    ? this.extractFetchedDocumentContent(snapshot.bodyHtml, snapshot.url || window.location.href)
                    : null;

                if (parsedSnapshotHtml) {
                    considerCandidate({
                        html: parsedSnapshotHtml.html,
                        text: parsedSnapshotHtml.text,
                        title: parsedSnapshotHtml.title || snapshot.title,
                        url: snapshot.url,
                    }, snapshot.isTop ? 'Probe DOM snapshot' : 'Probe frame snapshot', this.scoreProbeCandidate(snapshot.url, parsedSnapshotHtml.title || snapshot.title, parsedSnapshotHtml.text, embed, snapshot.isTop ? 0 : 220), `snapshot:${snapshotIndex}:dom:${this.cleanArtifactText(snapshot.url).slice(0, 120)}`);
                }
            }

            for (let entryIndex = 0; entryIndex < snapshot.entries.length; entryIndex += 1) {
                const entry = snapshot.entries[entryIndex];
                let parsedContent: { html?: string; text: string; title?: string } | null = null;
                const body = entry.body || '';
                const contentType = (entry.contentType ?? '').toLowerCase();

                if (!body || this.isIrrelevantProbePayload(body)) {
                    continue;
                }

                if (contentType.includes('json') || body.trimStart().startsWith('{')) {
                    const extractedJsonContent = this.extractJsonArtifactContent(body);
                    if (extractedJsonContent) {
                        parsedContent = this.extractFetchedDocumentContent(extractedJsonContent, entry.url)
                            ?? { text: this.cleanArtifactText(extractedJsonContent) };
                    } else {
                        continue;
                    }
                }

                if (!parsedContent && (contentType.includes('html') || body.trimStart().startsWith('<'))) {
                    parsedContent = this.extractFetchedDocumentContent(body, entry.url);
                }

                if (!parsedContent && !/^[\[{]/.test(body.trimStart())) {
                    const text = this.cleanArtifactText(body);
                    if (text) {
                        parsedContent = { text };
                    }
                }

                if (!parsedContent) {
                    continue;
                }

                considerCandidate({
                    html: parsedContent.html,
                    text: parsedContent.text,
                    title: parsedContent.title || snapshot.title,
                    url: entry.url || snapshot.url,
                }, `Probe ${entry.kind}`, this.scoreProbeCandidate(entry.url || snapshot.url, parsedContent.title || snapshot.title, parsedContent.text, embed,
                    entry.kind === 'fetch' || entry.kind === 'xhr'
                        ? 400
                        : entry.kind === 'message'
                            ? 260
                            : 120), this.buildProbeEntryDebugRef(snapshotIndex, entryIndex, entry.kind, entry.url || snapshot.url));
            }
        }

        return this.dedupeDeepResearchCandidates(candidates);
    }

    private scoreProbeCandidate(
        url: string,
        title: string,
        text: string,
        embed: { title: string; sourceUrl?: string; viewUrl?: string },
        bonus = 0
    ): number {
        const normalizedText = this.cleanArtifactText(text).toLowerCase();
        const normalizedUrl = (url || '').toLowerCase();
        const normalizedTitle = this.cleanArtifactText(title).toLowerCase();
        const embedTitle = this.cleanArtifactText(embed.title).toLowerCase();
        const embedKeywords = embedTitle.split(/\W+/).filter((keyword) => keyword.length >= 4);

        let score = bonus;

        if (/deep[_-]?research|connector_openai_deep_research|ecosystem\/widget|oaiusercontent|report|analysis/.test(normalizedUrl)) {
            score += 700;
        }

        for (const candidateUrl of [embed.viewUrl, embed.sourceUrl]) {
            const normalizedCandidate = candidateUrl?.trim().toLowerCase();
            if (!normalizedCandidate) continue;

            if (normalizedUrl === normalizedCandidate) {
                score += 1800;
            } else if (normalizedUrl && (normalizedUrl.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedUrl))) {
                score += 1200;
            }
        }

        if (embedTitle && normalizedTitle.includes(embedTitle)) {
            score += 500;
        }

        if (embedTitle && normalizedText.includes(embedTitle)) {
            score += 350;
        }

        for (const keyword of embedKeywords) {
            if (normalizedText.includes(keyword)) {
                score += 60;
            }
            if (normalizedTitle.includes(keyword)) {
                score += 80;
            }
        }

        if (/executive summary|market size|rollout|monetization|sources|citations/.test(normalizedText)) {
            score += 450;
        }

        score += Math.min(normalizedText.length, 50000) / 120;

        return score;
    }

    private async findProbeContentForEmbed(embed: {
        title: string;
        sourceUrl?: string;
        viewUrl?: string;
    }): Promise<{ html?: string; text: string; title?: string; url?: string } | null> {
        const best = (await this.collectProbeCandidatesForEmbed(embed))[0];
        if (!best) {
            return null;
        }

        return {
            html: best.html,
            text: best.text,
            title: best.title,
            url: best.url,
        };
    }

    private scoreExtractedFrameForEmbed(
        frame: ExtractedFrameContent,
        embed: { title: string; sourceUrl?: string; viewUrl?: string }
    ): number {
        const normalizedFrameUrl = frame.url.trim().toLowerCase();
        const normalizedFrameTitle = this.cleanArtifactText(frame.title).toLowerCase();
        const normalizedFrameText = this.cleanArtifactText(frame.text).toLowerCase();
        const embedTitle = this.cleanArtifactText(embed.title).toLowerCase();
        const embedKeywords = embedTitle.split(/\W+/).filter((keyword) => keyword.length >= 4);

        let score = 0;

        if (!frame.isTop) {
            score += 200;
        }

        if (/deep[_-]?research|research|report|oaiusercontent|analysis/.test(normalizedFrameUrl)) {
            score += 500;
        }

        for (const candidateUrl of [embed.viewUrl, embed.sourceUrl]) {
            const normalizedCandidate = candidateUrl?.trim().toLowerCase();
            if (!normalizedCandidate) continue;

            if (normalizedFrameUrl === normalizedCandidate) {
                score += 2000;
            } else if (normalizedFrameUrl && (normalizedFrameUrl.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedFrameUrl))) {
                score += 1200;
            }
        }

        if (embedTitle && normalizedFrameTitle.includes(embedTitle)) {
            score += 600;
        }

        if (embedTitle && normalizedFrameText.includes(embedTitle)) {
            score += 400;
        }

        for (const keyword of embedKeywords) {
            if (normalizedFrameTitle.includes(keyword)) {
                score += 120;
            }
            if (normalizedFrameText.includes(keyword)) {
                score += 80;
            }
        }

        if (/executive summary|introduction|conclusion|references|sources/.test(normalizedFrameText)) {
            score += 250;
        }

        if (frame.html && /\bdata-citation-index="\d+"/i.test(frame.html)) {
            score += 2200;
        }

        if (frame.html && /aria-label="Scroll report to citation \d+"/i.test(frame.html)) {
            score += 2600;
        }

        score += Math.min(normalizedFrameText.length, 50000) / 100;

        return score;
    }

    private async findFrameContentForEmbed(embed: {
        title: string;
        sourceUrl?: string;
        viewUrl?: string;
    }): Promise<{ html?: string; text: string; title?: string; url?: string; score: number } | null> {
        const frames = await this.getExtractedFrameContent();
        if (frames.length === 0) {
            return null;
        }

        const bestFrame = frames
            .map((frame) => ({
                frame,
                score: this.scoreExtractedFrameForEmbed(frame, embed),
            }))
            .sort((left, right) => right.score - left.score)[0];

        if (!bestFrame || bestFrame.score < 350) {
            return null;
        }

        const parsed = bestFrame.frame.html
            ? this.extractFetchedDocumentContent(bestFrame.frame.html, bestFrame.frame.url || window.location.href)
            : null;

        if (parsed && this.hasMeaningfulArtifactContent(parsed.html ?? parsed.text, embed.title)) {
            return {
                html: parsed.html,
                text: parsed.text,
                title: parsed.title || bestFrame.frame.title || embed.title,
                url: bestFrame.frame.url,
                score: bestFrame.score,
            };
        }

        const plainText = this.cleanArtifactText(bestFrame.frame.text);
        if (this.hasMeaningfulArtifactContent(plainText, embed.title)) {
            return {
                text: plainText,
                title: bestFrame.frame.title || embed.title,
                url: bestFrame.frame.url,
                score: bestFrame.score,
            };
        }

        return null;
    }

    private async createDeepResearchArtifact(embed: {
        title: string;
        summary: string;
        sourceUrl?: string;
        viewUrl?: string;
    }): Promise<ArtifactNode | null> {
        let artifactType: ArtifactNode['type'] = 'deep_research';
        let title = embed.title || 'Deep research report';
        let content = embed.summary || '';
        let mimeType = content.trimStart().startsWith('<') ? 'text/html' : 'text/markdown';
        let sourceUrl = embed.sourceUrl || embed.viewUrl;
        let viewUrl = embed.viewUrl || embed.sourceUrl;
        const candidates: DeepResearchCandidate[] = [];

        if (this.hasMeaningfulArtifactContent(content, title)) {
            candidates.push({
                label: 'Visible summary',
                score: 180,
                text: this.cleanArtifactText(content.startsWith('<') ? content.replace(/<[^>]+>/g, ' ') : content),
                html: mimeType === 'text/html' ? content : undefined,
                title,
                url: viewUrl ?? sourceUrl,
            });
        }

        candidates.push(...await this.collectProbeCandidatesForEmbed(embed));

        const extractedFrame = await this.findFrameContentForEmbed(embed);
        if (extractedFrame && this.hasMeaningfulArtifactContent(extractedFrame.html ?? extractedFrame.text, title)) {
            candidates.push({
                label: 'Frame extract',
                score: extractedFrame.score,
                text: this.cleanArtifactText(extractedFrame.text),
                html: extractedFrame.html,
                title: extractedFrame.title || title,
                url: extractedFrame.url,
            });
        }

        let fileFallback: ArtifactNode | null = null;

        if (candidates.length === 0) {
            const candidateUrls = Array.from(new Set([
                embed.viewUrl,
                embed.sourceUrl,
            ].filter((url): url is string => Boolean(url))));

            for (const candidateUrl of candidateUrls) {
                const fetched = await this.fetchRemoteResource(candidateUrl);
                if (!fetched?.ok) {
                    continue;
                }

                const finalUrl = fetched.finalUrl || candidateUrl;
                const contentType = (fetched.contentType ?? '').split(';')[0].trim().toLowerCase();

                viewUrl = viewUrl || finalUrl;
                sourceUrl = sourceUrl || finalUrl;

                if (fetched.text) {
                    let fetchedContent = '';
                    let fetchedMimeType = 'text/markdown';
                    let fetchedTitle = title;

                    if (contentType.includes('json')) {
                        const extractedJsonContent = this.extractJsonArtifactContent(fetched.text);
                        if (extractedJsonContent) {
                            const parsedJsonDocument = this.extractFetchedDocumentContent(extractedJsonContent, finalUrl);
                            if (parsedJsonDocument) {
                                fetchedContent = parsedJsonDocument.html ?? parsedJsonDocument.text;
                                fetchedMimeType = parsedJsonDocument.html ? 'text/html' : 'text/markdown';
                                fetchedTitle = parsedJsonDocument.title ?? fetchedTitle;
                            } else {
                                fetchedContent = this.cleanArtifactText(extractedJsonContent);
                                fetchedMimeType = 'text/markdown';
                            }
                        }
                    }

                    if (!fetchedContent) {
                        const parsedDocument = this.extractFetchedDocumentContent(fetched.text, finalUrl);
                        if (parsedDocument) {
                            fetchedContent = parsedDocument.html ?? parsedDocument.text;
                            fetchedMimeType = parsedDocument.html ? 'text/html' : 'text/markdown';
                            fetchedTitle = parsedDocument.title ?? fetchedTitle;
                        }
                    }

                    if (!fetchedContent) {
                        const plainText = this.cleanArtifactText(fetched.text);
                        if (this.hasMeaningfulArtifactContent(plainText, title)) {
                            fetchedContent = plainText;
                            fetchedMimeType = contentType.includes('markdown') ? contentType : 'text/markdown';
                        }
                    }

                    if (this.hasMeaningfulArtifactContent(fetchedContent, title)) {
                        candidates.push({
                            label: 'Remote fetch',
                            score: 300,
                            text: this.cleanArtifactText(fetchedContent.startsWith('<') ? fetchedContent.replace(/<[^>]+>/g, ' ') : fetchedContent),
                            html: fetchedMimeType === 'text/html' ? fetchedContent : undefined,
                            title: fetchedTitle || title,
                            url: finalUrl,
                        });
                        break;
                    }

                    continue;
                }

                if (fetched.dataUrl) {
                    const resolvedMimeType = contentType
                        || fetched.dataUrl.match(/^data:([^;]+)/)?.[1]
                        || 'application/octet-stream';

                    artifactType = 'file';
                    mimeType = resolvedMimeType;
                    title = this.guessArtifactFilename(title, resolvedMimeType, finalUrl, fetched.contentDisposition);
                    content = fetched.dataUrl;
                    fileFallback = {
                        artifact_id: crypto.randomUUID(),
                        type: 'file',
                        title,
                        content,
                        source_message_id: '',
                        source_url: finalUrl,
                        view_url: finalUrl,
                        exportable: true,
                        mime_type: mimeType,
                    };
                    break;
                }
            }
        }

        const dedupedCandidates = this.dedupeDeepResearchCandidates(candidates);
        const selectedCandidate = dedupedCandidates[0];

        if (selectedCandidate) {
            const sources = await this.collectSourcesForEmbed(embed, selectedCandidate);
            const resolvedText = selectedCandidate.html
                ? selectedCandidate.text
                : await this.rewriteProbeMarkdownCitationIndexes(selectedCandidate.text, sources, selectedCandidate);

            // Diagnostic: identify winning candidate and citation structure
            const citSnippets = (selectedCandidate.html || resolvedText)
                .match(/.{0,80}\d{1,3}.{0,80}/g)?.slice(0, 5) || [];

            // Look for sources block at bottom of markdown
            const sourceMatches = resolvedText?.match(/[^]{0,300}$/);

            console.log(`[Bonsai Citation Debug] Winner: "${selectedCandidate.label}" (score=${selectedCandidate.score})`, {
                winnerRef: selectedCandidate.debugRef ?? null,
                hasHtml: !!selectedCandidate.html,
                citSnippets,
                sourceCount: sources.length,
                sources: sources.map(s => ({ i: s.index, url: s.url })),
                sourceStringTail: sourceMatches ? sourceMatches[0] : null
            });

            title = selectedCandidate.title || title;
            if (selectedCandidate.html) {
                const mermaidCode = this.findMermaidCodeInCandidates(dedupedCandidates, selectedCandidate);
                const resolvedHtml = mermaidCode
                    ? this.injectMermaidCodeIntoResearchHtml(selectedCandidate.html, mermaidCode)
                    : selectedCandidate.html;

                content = this.appendSourcesToResearchHtml(resolvedHtml, sources);
            } else {
                content = this.appendSourcesToResearchContent(resolvedText, sources);
            }
            mimeType = selectedCandidate.html ? 'text/html' : 'text/markdown';
            artifactType = 'deep_research';
            sourceUrl = undefined;
            viewUrl = undefined;
        } else if (fileFallback) {
            return fileFallback;
        }

        if (!content && !sourceUrl && !viewUrl) {
            return null;
        }

        if (artifactType === 'deep_research' && this.hasMeaningfulArtifactContent(content, title)) {
            sourceUrl = undefined;
            viewUrl = undefined;
        }

        return {
            artifact_id: crypto.randomUUID(),
            type: artifactType,
            title,
            content: content || title,
            source_message_id: '',
            source_url: sourceUrl,
            view_url: viewUrl,
            exportable: true,
            mime_type: mimeType || undefined,
        };
    }

    /**
     * Find ChatGPT Canvas / Artifact side-panel content directly in the DOM.
     * Canvas panels are rendered as rich-text editors (ProseMirror/TipTap/Monaco)
     * in a right-hand side panel — NOT inside a cross-origin iframe.
     */
    private findChatGPTCanvasPanelArtifact(): ArtifactNode | null {
        // Broad canvas/artifact panel selectors for ChatGPT's right-side panel
        const panelSelectors = [
            '[data-testid*="canvas"]',
            '[data-testid*="artifact"]',
            '[aria-label*="canvas" i]',
            '[aria-label*="artifact" i]',
            '[class*="canvas-panel"]',
            '[class*="artifact-panel"]',
            '[class*="side-panel"]',
            'aside',
        ];

        // Editor selectors in order of reliability
        const editorSelectors = [
            '.ProseMirror',
            '.tiptap',
            '.cm-content',        // CodeMirror
            '.view-lines',         // Monaco
            '[contenteditable="true"]',
        ];

        // The main chat stream container — we exclude editors found inside it
        const chatContainer = document.querySelector(
            '[data-testid="conversation-turn-list"], [role="log"], main'
        );

        for (const panelSel of panelSelectors) {
            const panels = Array.from(document.querySelectorAll(panelSel));
            for (const panel of panels) {
                if (!this.isVisibleElement(panel as HTMLElement)) continue;
                if (chatContainer && chatContainer.contains(panel)) continue;

                for (const edSel of editorSelectors) {
                    const editor = panel.querySelector(edSel);
                    if (!editor) continue;

                    const text = this.cleanArtifactText(editor.textContent ?? '');
                    if (!text || this.isNoiseOnlyArtifactText(text) || text.length < 30) continue;

                    const html = this.sanitizeRichHtml(editor, {
                        removeSelectors: ['button', '[role="button"]', '.bonsai-insert-btn'],
                    });

                    const title = this.cleanArtifactText(
                        panel.querySelector('h1, h2, h3, [data-testid*="title"], header [aria-label]')?.textContent?.trim()
                        ?? document.title.replace(/\s*-\s*ChatGPT.*$/i, '').trim()
                        ?? 'Canvas Artifact'
                    );

                    return {
                        artifact_id: crypto.randomUUID(),
                        type: 'artifact_doc',
                        title: title || 'Canvas Artifact',
                        content: html || text,
                        source_message_id: '',
                        view_url: window.location.href,
                        exportable: true,
                        mime_type: html ? 'text/html' : 'text/plain',
                    };
                }
            }
        }

        // Fallback: any visible ProseMirror / contenteditable outside the chat stream
        const editorCandidates = Array.from(
            document.querySelectorAll('.ProseMirror, .tiptap, .cm-content, [contenteditable="true"]')
        );
        for (const editor of editorCandidates) {
            if (chatContainer && chatContainer.contains(editor)) continue;
            if (!this.isVisibleElement(editor as HTMLElement)) continue;

            const text = this.cleanArtifactText(editor.textContent ?? '');
            if (!text || this.isNoiseOnlyArtifactText(text) || text.length < 50) continue;

            const html = this.sanitizeRichHtml(editor, {
                removeSelectors: ['button', '[role="button"]', '.bonsai-insert-btn'],
            });

            return {
                artifact_id: crypto.randomUUID(),
                type: 'artifact_doc',
                title: document.title.replace(/\s*-\s*ChatGPT.*$/i, '').trim() || 'Artifact',
                content: html || text,
                source_message_id: '',
                view_url: window.location.href,
                exportable: true,
                mime_type: html ? 'text/html' : 'text/plain',
            };
        }

        return null;
    }

    /**
     * Walk up from `el` to find the nearest project-section heading.
     * ChatGPT renders project sections as collapsible `<li>` or `<div>` blocks
     * where the heading/button text is the project name and the conversation links
     * are children. Returns `undefined` when the link is in the regular history
     * (i.e. not under any project section).
     */
    private resolveProjectName(el: Element): string | undefined {
        let node: Element | null = el.parentElement;
        while (node && node !== document.body) {
            // ChatGPT uses a <li> or <div> with a button/heading child whose text is
            // the project name. We recognise this by looking for a sibling/ancestor button
            // or heading that contains "project" in its data-testid or aria attributes, or
            // is the aria-label of the containing nav group.

            // Pattern 1: ancestor has an aria-label that isn't "Chat history" / navigation noise
            const ariaLabel = node.getAttribute('aria-label')?.trim();
            if (ariaLabel && !/^(chat history|recents?|history|today|yesterday|previous \d|last \d)/i.test(ariaLabel)) {
                return ariaLabel;
            }

            // Pattern 2: adjacent/previous-sibling heading or button inside the same container
            const heading = node.querySelector<HTMLElement>(
                'button[data-testid*="project"], ' +
                'span[data-testid*="project-name"], ' +
                '[class*="project-name"], ' +
                '[class*="projectName"]'
            );
            if (heading) {
                const name = heading.innerText?.trim() || heading.textContent?.trim();
                if (name && name.length > 0 && name.length < 100) return name;
            }

            // Pattern 3: li/div that has a direct button child whose text looks like a
            // project name (not a time bucket label) immediately before the link list.
            if (node.tagName === 'LI' || node.tagName === 'OL' || node.tagName === 'UL') {
                const btn = node.querySelector<HTMLElement>(':scope > button, :scope > div > button');
                if (btn) {
                    const btnText = btn.innerText?.trim() || btn.textContent?.trim() || '';
                    // Time bucket labels are short and date-like; skip them
                    if (btnText.length > 2 && !/^(today|yesterday|previous \d|last \d+|\d+ days? ago)/i.test(btnText)) {
                        return btnText;
                    }
                }
            }

            node = node.parentElement;
        }
        return undefined;
    }

    private normalizePath(url: string): string {
        try {
            return new URL(url, window.location.origin).pathname.replace(/\/$/, '');
        } catch {
            return url.split(/[?#]/)[0].replace(/\/$/, '');
        }
    }

    private findProjectLinkByUrl(projectUrl: string): HTMLAnchorElement | null {
        const targetPath = this.normalizePath(projectUrl);
        const projectLinks = Array.from(document.querySelectorAll('a[href*="/g/g-p-"][href*="/project"]')) as HTMLAnchorElement[];
        return projectLinks.find((link) => this.normalizePath(link.href || link.getAttribute('href') || '') === targetPath) ?? null;
    }

    private collectProjectConversationLinks(root?: ParentNode): HTMLAnchorElement[] {
        const scope = root ?? document;
        return Array.from(scope.querySelectorAll('a[href*="/c/"]')) as HTMLAnchorElement[];
    }

    private getScrollableAncestor(el: Element | null): HTMLElement | null {
        let node: Element | null = el;
        while (node && node !== document.body) {
            if (node instanceof HTMLElement) {
                const style = window.getComputedStyle(node);
                const overflowY = style.overflowY;
                if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 20) {
                    return node;
                }
            }
            node = node.parentElement;
        }
        return null;
    }

    private getProjectConversationRoot(): HTMLElement | null {
        const selectorRoot = this.selectors.projectConversationList
            ? queryWithFallbacks(document, this.selectors.projectConversationList)
            : null;

        const candidates = [
            selectorRoot,
            document.querySelector('.project-conversations-list'),
            document.querySelector('[data-testid*="project-conversations"]'),
            document.querySelector('main'),
            document.querySelector('[role="main"]'),
        ].filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);

        return candidates.find((candidate) => this.collectProjectConversationLinks(candidate).length > 0) ?? candidates[0] ?? null;
    }

    private getProjectConversationScrollContainer(root: HTMLElement | null): HTMLElement | null {
        if (!root) return null;

        const directScrollable = this.getScrollableAncestor(root);
        if (directScrollable) return directScrollable;

        const firstLink = this.collectProjectConversationLinks(root)[0] ?? null;
        if (firstLink) {
            const ancestor = this.getScrollableAncestor(firstLink);
            if (ancestor) return ancestor;
        }

        const descendants = Array.from(root.querySelectorAll('*')) as HTMLElement[];
        return descendants.find((node) => {
            const style = window.getComputedStyle(node);
            return (style.overflowY === 'auto' || style.overflowY === 'scroll')
                && node.scrollHeight > node.clientHeight + 20
                && this.collectProjectConversationLinks(node).length > 0;
        }) ?? (document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null);
    }

    private async loadProjectPage(projectUrl: string, timeoutMs = 15000): Promise<boolean> {
        const targetPath = this.normalizePath(projectUrl);

        if (this.normalizePath(window.location.href) === targetPath) {
            return this.waitForProjectPageReady(projectUrl, timeoutMs);
        }

        const projectLink = this.findProjectLinkByUrl(projectUrl);
        if (!projectLink) {
            console.warn(`[Bonsai Capture] Could not find project link in DOM: ${projectUrl}`);
            return false;
        }

        projectLink.click();
        return this.waitForProjectPageReady(projectUrl, timeoutMs);
    }

    private async scrollProjectConversationList(root: HTMLElement, timeoutMs = 45000): Promise<void> {
        const scrollContainer = this.getProjectConversationScrollContainer(root);
        const seenConversationIds = new Set<string>();
        const deadline = Date.now() + timeoutMs;
        let stableRounds = 0;
        let previousScrollTop = -1;

        if (scrollContainer) {
            scrollContainer.scrollTop = 0;
        } else {
            window.scrollTo({ top: 0, behavior: 'auto' });
        }
        await this.delay(300);

        while (Date.now() < deadline) {
            let newIdsThisRound = 0;
            for (const link of this.collectProjectConversationLinks(root)) {
                const href = link.getAttribute('href') || link.href || '';
                const match = href.match(/\/c\/([a-z0-9-]+)/i);
                if (!match) continue;
                if (!seenConversationIds.has(match[1])) {
                    seenConversationIds.add(match[1]);
                    newIdsThisRound += 1;
                }
            }

            if (newIdsThisRound === 0) {
                stableRounds += 1;
            } else {
                stableRounds = 0;
            }

            if (scrollContainer) {
                const nextScrollTop = Math.min(
                    scrollContainer.scrollTop + Math.max(320, scrollContainer.clientHeight - 120),
                    Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)
                );

                if (nextScrollTop === scrollContainer.scrollTop) {
                    if (stableRounds >= 2) break;
                } else {
                    previousScrollTop = scrollContainer.scrollTop;
                    scrollContainer.scrollTop = nextScrollTop;
                }
            } else {
                const nextScrollTop = window.scrollY + Math.max(500, Math.floor(window.innerHeight * 0.8));
                if (nextScrollTop === previousScrollTop && stableRounds >= 2) break;
                previousScrollTop = window.scrollY;
                window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
            }

            if (stableRounds >= 3) break;
            await this.delay(450);
        }
    }

    private async scrollProjectConversationToFindLink(id: string, timeoutMs = 30000): Promise<HTMLElement | null> {
        const root = this.getProjectConversationRoot();
        if (!root) return null;

        const initialMatch = this.collectProjectConversationLinks(root).find((link) => {
            const href = link.href || link.getAttribute('href') || '';
            return href.includes(`/c/${id}`);
        });
        if (initialMatch) return initialMatch;

        const scrollContainer = this.getProjectConversationScrollContainer(root);
        const deadline = Date.now() + timeoutMs;
        let stableRounds = 0;

        if (scrollContainer) {
            scrollContainer.scrollTop = 0;
        } else {
            window.scrollTo({ top: 0, behavior: 'auto' });
        }
        await this.delay(250);

        while (Date.now() < deadline) {
            const found = this.collectProjectConversationLinks(root).find((link) => {
                const href = link.href || link.getAttribute('href') || '';
                return href.includes(`/c/${id}`);
            });
            if (found) return found;

            let advanced = false;
            if (scrollContainer) {
                const nextScrollTop = Math.min(
                    scrollContainer.scrollTop + Math.max(320, scrollContainer.clientHeight - 120),
                    Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)
                );
                advanced = nextScrollTop !== scrollContainer.scrollTop;
                scrollContainer.scrollTop = nextScrollTop;
            } else {
                const nextScrollTop = window.scrollY + Math.max(500, Math.floor(window.innerHeight * 0.8));
                advanced = nextScrollTop !== window.scrollY;
                window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
            }

            stableRounds = advanced ? 0 : stableRounds + 1;
            if (stableRounds >= 2) break;
            await this.delay(350);
        }

        return null;
    }

    async scanSidebar(): Promise<SidebarItem[]> {
        const items: SidebarItem[] = [];
        console.log('[Bonsai Capture] Scanning for conversation links...');

        // Scroll the sidebar to lazy-load older conversations
        const sidebarScrollable = document.querySelector('nav') as HTMLElement | null;
        if (sidebarScrollable) {
            let prevCount = 0;
            let stableRounds = 0;
            for (let i = 0; i < 20; i++) {
                sidebarScrollable.scrollTop = sidebarScrollable.scrollHeight;
                await new Promise(r => setTimeout(r, 650));
                const count = document.querySelectorAll('a[href*="/c/"]').length;
                if (count === prevCount) {
                    if (++stableRounds >= 2) break;
                } else {
                    stableRounds = 0;
                }
                prevCount = count;
            }
            // Scroll back to top so page looks normal
            sidebarScrollable.scrollTop = 0;
        }

        // Expand any collapsed project/folder sections
        const collapsedBtns = document.querySelectorAll<HTMLButtonElement>(
            'button[aria-expanded="false"][data-testid*="folder"], ' +
            'button[aria-expanded="false"][data-testid*="project"], ' +
            'li button[aria-expanded="false"]'
        );
        for (const btn of collapsedBtns) btn.click();
        if (collapsedBtns.length > 0) await new Promise(r => setTimeout(r, 400));

        // Universal Scan: Find ANY link containing /c/ (conversation path)
        // This covers the standard sidebar, project folder lists, and Custom GPT views.
        const links = document.querySelectorAll('a[href*="/c/"]');
        console.log(`[Bonsai Capture] Found ${links.length} potential links`);

        links.forEach(el => {
            const link = el as HTMLAnchorElement;
            const href = link.getAttribute('href') || '';

            // Match the /c/ UUID pattern
            const match = href.match(/\/c\/([a-z0-9-]+)/i);
            if (match) {
                const id = match[1];

                // Extract Title: take the first non-empty line of text
                let title = link.innerText?.trim() || link.textContent?.trim() || 'Untitled';
                title = title.split('\n')[0].trim();

                // Exclude noise
                if (id && title.toLowerCase() !== 'new chat' && title.length > 1) {
                    const projectName = this.resolveProjectName(link);
                    // scanSidebar is sidebar-only: skip conversations that belong to a project.
                    // Project conversations are collected via scanProjectConversations().
                    if (!projectName) {
                        items.push({
                            id,
                            title,
                            url: href.startsWith('http') ? href : `https://chatgpt.com/c/${id}`,
                        });
                    }
                }
            }
        });

        // Dedup by ID
        const uniqueItems: SidebarItem[] = [];
        const seen = new Set<string>();
        for (const item of items) {
            if (!seen.has(item.id)) {
                seen.add(item.id);
                uniqueItems.push(item);
            }
        }

        console.log(`[Bonsai Capture] Scan complete. Found ${uniqueItems.length} unique conversations.`);
        return uniqueItems;
    }

    async discoverProjects(): Promise<import('./interface').ProjectInfo[]> {
        // Project links in the sidebar look like:
        //   /g/g-p-{hash}-{slug}/project
        const projectLinks = document.querySelectorAll<HTMLAnchorElement>('a[href*="/g/g-p-"]');
        const seen = new Set<string>();
        const projects: import('./interface').ProjectInfo[] = [];

        projectLinks.forEach(link => {
            const href = link.getAttribute('href') || '';
            if (!href.includes('/project')) return;

            const fullUrl = href.startsWith('http') ? href : `https://chatgpt.com${href}`;
            if (seen.has(fullUrl)) return;
            seen.add(fullUrl);

            // Name: take first non-empty text line from the link
            let name = link.innerText?.trim() || link.textContent?.trim() || '';
            name = name.split('\n')[0].trim();

            // Fallback: extract slug from URL
            if (!name) {
                const slugMatch = href.match(/\/g\/g-p-[^/]+-([^/]+)\/project/);
                name = slugMatch ? slugMatch[1].replace(/-/g, ' ') : 'Unnamed Project';
            }

            projects.push({ url: fullUrl, name });
        });

        console.log(`[Bonsai Capture] Discovered ${projects.length} projects.`);
        return projects;
    }

    async scanProjectConversations(projectUrl: string, projectName: string): Promise<import('./interface').SidebarItem[]> {
        console.log(`[Bonsai Capture] Scanning project: ${projectName} (${projectUrl})`);

        const loaded = await this.loadProjectPage(projectUrl, 45000);
        if (!loaded) {
            console.warn(`[Bonsai Capture] Timed out waiting for project page: ${projectUrl}`);
            return [];
        }

        const root = this.getProjectConversationRoot();
        if (!root) {
            console.warn(`[Bonsai Capture] Could not find project conversation root for: ${projectUrl}`);
            return [];
        }

        await this.scrollProjectConversationList(root, 45000);

        // Collect all conversation links on this project page
        const items: import('./interface').SidebarItem[] = [];
        const seen = new Set<string>();
        this.collectProjectConversationLinks(root).forEach(link => {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/c\/([a-z0-9-]+)/i);
            if (!match) return;

            const id = match[1];
            if (seen.has(id)) return;
            seen.add(id);

            let title = link.innerText?.trim() || link.textContent?.trim() || 'Untitled';
            title = title.split('\n')[0].trim();

            if (id && title.toLowerCase() !== 'new chat' && title.length > 1) {
                items.push({
                    id,
                    title,
                    url: href.startsWith('http') ? href : `https://chatgpt.com/c/${id}`,
                    projectName,
                    projectUrl,
                });
            }
        });

        console.log(`[Bonsai Capture] Found ${items.length} conversations in project "${projectName}".`);
        return items;
    }

    private async waitForProjectPageReady(projectUrl: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        const targetPath = this.normalizePath(projectUrl);
        while (Date.now() < deadline) {
            const onTargetPage = this.normalizePath(window.location.href) === targetPath;
            const root = this.getProjectConversationRoot();
            const links = this.collectProjectConversationLinks(root ?? document);
            if (onTargetPage && links.length > 0) return true;
            await this.delay(400);
        }
        return false;
    }

    private findSidebarLinkForId(id: string): HTMLElement | null {
        const candidateSelectors = [
            this.selectors.projectConversationItem,
            `a[href*="/c/${id}"]`,
            `a[href*="${id}"]`,
        ].filter((selector): selector is string => Boolean(selector)).join(', ');

        if (!candidateSelectors) return null;

        const candidates = Array.from(document.querySelectorAll(candidateSelectors)) as HTMLElement[];
        return (
            candidates.find(link => {
                const href = (link as HTMLAnchorElement).href || link.getAttribute('href') || '';
                return href.includes(`/c/${id}`) && this.isVisibleElement(link);
            }) ??
            candidates.find(link => {
                const href = (link as HTMLAnchorElement).href || link.getAttribute('href') || '';
                return href.includes(`/c/${id}`);
            }) ??
            null
        );
    }

    /**
     * Progressively scroll the sidebar nav to reveal the target conversation link.
     * Scrolls from the CURRENT scroll position (not from 0), so sequential calls for
     * items processed top-to-bottom are efficient — each call adds only a small scroll delta.
     * Does NOT reset scroll position after finding the link (we're navigating away anyway).
     */
    private async scrollSidebarToFindLink(id: string, timeoutMs = 9000): Promise<HTMLElement | null> {
        const nav = document.querySelector('nav') as HTMLElement | null;
        if (!nav) return null;

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const link = this.findSidebarLinkForId(id);
            if (link) return link;

            // Reached the bottom — nothing more to load
            if (nav.scrollTop + nav.clientHeight >= nav.scrollHeight - 5) break;

            nav.scrollTop += 320;
            await this.delay(350);
        }

        return null;
    }

    async loadConversation(id: string, projectUrl?: string): Promise<boolean> {
        // If already on the page
        if (window.location.href.includes(`/c/${id}`)) {
            const fp = this.getConversationFingerprint();
            if (fp && this.hasRenderedMessageContent()) return true;
            return this.waitForConversationReady(id, '', 45000);
        }

        const baselineFingerprint = this.getConversationFingerprint();

        if (projectUrl) {
            const projectLoaded = await this.loadProjectPage(projectUrl, 45000);
            if (projectLoaded) {
                const projectLink = await this.scrollProjectConversationToFindLink(id, 30000);
                if (projectLink) {
                    projectLink.click();
                    return this.waitForConversationReady(id, baselineFingerprint, 45000);
                }
            }
        }

        // 1. Check if the link is already in the DOM (visible or just off-screen)
        let sidebarLink = this.findSidebarLinkForId(id);

        // 2. Not in DOM — scroll the sidebar to lazy-load more history items
        if (!sidebarLink) {
            sidebarLink = await this.scrollSidebarToFindLink(id);
        }

        if (sidebarLink) {
            sidebarLink.click();
            return this.waitForConversationReady(id, baselineFingerprint, 45000);
        }

        // 3. Last resort: full URL navigation (causes page reload).
        //    The side panel must call waitForTabReadyAtUrl() after this to
        //    wait for the new content script to be ready before sending CAPTURE.
        window.location.href = `https://chatgpt.com/c/${id}`;
        return true;
    }

    async parseMessage(el: Element, sequence: number): Promise<MessageNode> {
        const bubble = this.resolveMessageBubble(el);
        const role = this.detectRole(bubble);
        const contentBlocks = this.parseContentBlocks(bubble, role);
        const deepLink = this.getDeepLink(el); // Deep link often on container or specific child, but keep el for now
        const origin = this.getProvenance();

        const message = createMessageNode(role, sequence, contentBlocks, deepLink, role === 'assistant' ? origin : undefined);

        // Preserve stable DOM message identifiers if available.
        // Prioritize the top-level element (article) over the bubble so the ID
        // matches what listMessages() returns for scoped-capture lookups.
        const stableId =
            el.getAttribute('data-message-id') ??
            el.getAttribute('data-bonsai-msg-id') ??
            el.getAttribute('id') ??
            bubble.getAttribute('data-message-id') ??
            bubble.getAttribute('data-bonsai-msg-id') ??
            bubble.getAttribute('id');

        if (stableId) {
            message.message_id = stableId;
        }

        return message;
    }



    private detectRole(el: Element): 'user' | 'assistant' | 'system' | 'tool' {
        // Check data attribute
        const roleAttr = el.getAttribute('data-message-author-role');
        if (roleAttr === 'user') return 'user';
        if (roleAttr === 'assistant') return 'assistant';
        if (roleAttr === 'system') return 'system';
        if (roleAttr === 'tool') return 'tool';

        // Check testid
        const testId = (el.getAttribute('data-testid') ?? '').toLowerCase();
        if (testId.includes('user') || testId.includes('you')) return 'user';
        if (testId.includes('assistant') || testId.includes('target-message') || testId.includes('bot')) return 'assistant';

        // Fallback: check classes and structure
        const classList = (el.className || '').toLowerCase();
        if (classList.includes('user') || classList.includes('your-message')) return 'user';
        if (classList.includes('assistant') || classList.includes('bot') || classList.includes('gpt')) return 'assistant';

        // Check for explicit avatar markers
        if (el.querySelector('[data-testid="bot-avatar"], .agent-avatar, .gpt-avatar, .icon-bot')) {
            return 'assistant';
        }
        if (el.querySelector('[data-testid="user-avatar"], .user-avatar, .icon-user')) {
            return 'user';
        }

        // Look at text hints inside the turn (e.g. ChatGPT name or You label)
        const text = el.textContent?.trim().toLowerCase() ?? '';
        if (text.startsWith('you') || text.startsWith('user') || text.includes('your message')) return 'user';
        if (text.includes('assistant') || text.includes('chatgpt') || text.includes('bot')) return 'assistant';

        // Fallback: even/odd sequence if we cannot infer a reliable role
        const messages = this.listMessages();
        const index = messages.indexOf(el);
        return index % 2 === 0 ? 'user' : 'assistant';
    }

    private parseContentBlocks(el: Element, role: 'user' | 'assistant' | 'system' | 'tool'): ContentBlock[] {
        const blocks: ContentBlock[] = [];
        const deepResearchEmbeds = this.getDeepResearchEmbeds(el);

        const contentArea = el.querySelector('.markdown, .message-content, [data-message-content], [data-testid="message-content"], .chat-message-text, .text-base') ?? el;

        if (role === 'assistant') {
            // Include ul/ol: bullet lists are rich formatting that the text-extraction path
            // cannot represent faithfully (list structure is lost). Going through sanitizeRichHtml
            // produces clean HTML that the markdown exporter can convert to proper bullet syntax.
            const hasStructuredCode = Boolean(
                contentArea.querySelector('pre, code, [data-testid*="code"], .code-block, table, ul, ol')
            );

            if (hasStructuredCode) {
                const html = this.sanitizeRichHtml(contentArea, {
                    removeSelectors: ['[data-testid="message-feedback-icon"]']
                });

                // Guard: only return structured HTML if it has meaningful content.
                // An empty/whitespace-only result can occur when streaming hasn't
                // finished rendering the .markdown container.
                if (html && html.replace(/<[^>]*>/g, '').trim().length > 0) {
                    return [createHtmlBlock(html)];
                }
            }
        }

        // 1. Mark and Extract Code Blocks
        const codeBlocks = this.extractCodeBlocks(el);

        // 2. Clone content for text extraction
        const clone = contentArea.cloneNode(true) as Element;

        // Cleanup noise
        clone.querySelectorAll('style, script, link, meta, noscript, .sr-only, [data-testid="message-feedback-icon"], .bonsai-insert-btn').forEach(el => el.remove());

        // Handle buttons
        clone.querySelectorAll('button, [role="button"]').forEach(btn => {
            const text = btn.textContent?.trim() || '';
            if (text.match(/Image created|Generating|image/i)) {
                const span = document.createElement('span');
                span.textContent = text;
                btn.replaceWith(span);
            } else {
                btn.remove();
            }
        });

        // Remove "Edit Image" specifically
        Array.from(clone.querySelectorAll('a, div, span')).forEach(el => {
            if (el.textContent?.trim() === 'Edit Image') el.remove();
        });

        // 3. Replace marked code blocks with Placeholders
        // The data-bonsai-index attribute was set by extractCodeBlocks (helper which we assume exists from BaseAdapter or implementation)
        // Wait, BaseAdapter likely has extractCodeBlocks but we need to ensure it uses data-bonsai-index.
        // Checking previous code: uses this.extractCodeBlocks(el). 
        // We will assume it returns objects and we interact with the DOM it modified? 
        // Actually, extractCodeBlocks usually modifies the DOM by adding attributes OR we need to find them again.
        // Let's stick to the logic: queryAll('pre') matching the count.

        clone.querySelectorAll('[data-bonsai-index]').forEach((captured) => {
            const index = captured.getAttribute('data-bonsai-index');
            if (index !== null) {
                const placeholder = document.createTextNode(`\n\n<<<BONSAI_CODE_BLOCK_${index}>>>\n\n`);
                captured.parentNode?.replaceChild(placeholder, captured);
            }
        });

        // 4. Get text using recursive walker to guarantee newlines
        const rawText = this.getTextContentPreservingLines(clone);

        // Normalize
        let textContent = rawText.replace(/\n{3,}/g, '\n\n').trim();
        textContent = textContent.replace(/^ChatGPT said:[\s\n]*/i, '').trim();

        // Sanitize chat-specific prefixes and quote markers (carats)
        textContent = this.sanitizeMessageText(textContent);

        // 6. Split and Reassemble
        const parts = textContent.split(/<<<BONSAI_CODE_BLOCK_(\d+)>>>/);
        const insertedCodeBlocks = new Set<number>();

        parts.forEach((part, i) => {
            if (i % 2 === 0) {
                // Text
                const text = part.trim();
                if (text) blocks.push(createMarkdownBlock(text));
            } else {
                // Code Index
                const blockIndex = parseInt(part, 10);
                const cb = codeBlocks[blockIndex];
                if (cb) {
                    insertedCodeBlocks.add(blockIndex);
                    blocks.push(createCodeBlock(cb.code, cb.language));
                }
            }
        });

        codeBlocks.forEach((cb, index) => {
            if (!insertedCodeBlocks.has(index)) {
                blocks.push(createCodeBlock(cb.code, cb.language));
            }
        });

        if (deepResearchEmbeds.length > 0) {
            const existingText = blocks
                .filter((block): block is Extract<ContentBlock, { value: string }> => 'value' in block && typeof block.value === 'string')
                .map((block) => block.value.toLowerCase())
                .join('\n');

            deepResearchEmbeds.forEach((embed) => {
                // Only add title/summary to content — links go in the artifact reference block
                const parts: string[] = [];

                if (!existingText.includes(embed.title.toLowerCase())) {
                    parts.push(`**${embed.title}**`);
                }

                if (embed.summary && !this.isNoiseOnlyArtifactText(embed.summary)) {
                    const summaryText = typeof embed.summary === 'string' && embed.summary.startsWith('<')
                        ? '' // HTML summary goes in the artifact, not inline text
                        : embed.summary;
                    if (summaryText && !existingText.includes(summaryText.slice(0, 50).toLowerCase())) {
                        parts.push(summaryText);
                    }
                }

                const markdown = parts.filter(Boolean).join('\n\n').trim();
                if (markdown) {
                    blocks.push(createMarkdownBlock(markdown));
                }
            });
        }

        if (blocks.length === 0 && deepResearchEmbeds.length > 0) {
            blocks.push(createMarkdownBlock(deepResearchEmbeds[0].title));
        }

        return blocks;
    }

    protected extractCodeBlocks(el: Element): Array<{ language: string; code: string }> {
        const blocks: Array<{ language: string; code: string }> = [];

        const capture = (container: Element, codeEl: Element) => {
            if (container.closest('[data-bonsai-index]')) return;

            const code = codeEl.textContent?.trim() ?? '';
            if (!code) return;

            const index = blocks.length;
            container.setAttribute('data-bonsai-index', index.toString());

            const wrapper = container.closest('.code-block, [data-testid*="code"]');
            if (wrapper && wrapper !== container && !wrapper.hasAttribute('data-bonsai-index')) {
                wrapper.setAttribute('data-bonsai-index', index.toString());
            }

            blocks.push({
                language: this.detectCodeLanguage(codeEl),
                code,
            });
        };

        el.querySelectorAll('pre').forEach((pre) => {
            const codeEl = pre.querySelector('code') ?? pre;
            capture(pre, codeEl);
        });

        el.querySelectorAll('.code-block, [data-testid*="code"]').forEach((candidate) => {
            if (candidate.matches('code') || candidate.closest('pre')) return;

            const codeEl = candidate.querySelector('code');
            if (!codeEl) return;

            capture(candidate, codeEl);
        });

        return blocks;
    }

    /**
     * Recursively extract text content while preserving newlines for block elements.
     * Crucial for nested divs/paragraphs where innerText fails or textContent merges lines.
     */
    private getTextContentPreservingLines(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent || '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        const el = node as Element;
        const tagName = el.tagName.toLowerCase();

        // Skip hidden or invisible
        if (tagName === 'style' || tagName === 'script' || tagName === 'noscript') return '';
        if (tagName === 'button' || tagName === 'svg' || el.classList.contains('bonsai-insert-btn') || el.getAttribute('role') === 'button') {
            return '';
        }

        let text = '';

        // Add newline BEFORE block elements if needed (not specifically requested but good practice)
        // Actually, simpler: process children, join.

        for (const child of Array.from(node.childNodes)) {
            text += this.getTextContentPreservingLines(child);
        }

        // Add newlines AFTER block elements
        const requestNewline = ['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'blockquote'].includes(tagName);
        if (requestNewline) {
            text += '\n';
            if (tagName === 'p' || tagName === 'br') text += '\n'; // Double newline for paragraphs
        }

        return text;
    }

    private hasMeaningfulMessageNode(message: MessageNode): boolean {
        if (message.artifact_ids.length > 0) {
            return true;
        }

        return message.content_blocks.some((block) => {
            switch (block.type) {
                case 'markdown':
                case 'text':
                case 'code':
                    return block.value.trim().length > 0;
                case 'html':
                    return block.value.replace(/<[^>]*>/g, ' ').trim().length > 0;
                case 'list':
                    return block.items.some((item) => item.trim().length > 0);
                case 'table':
                    return block.rows.some((row) => row.some((cell) => cell.trim().length > 0));
                case 'image_ref':
                    return block.artifact_id.trim().length > 0;
                default:
                    return false;
            }
        });
    }

    async captureConversation(): Promise<ConversationGraph> {
        this.extractedFrameContentPromise = null;
        this.openAIProbeSnapshotsPromise = null;
        const projectInfo = this.getCurrentProjectInfo();

        // Remove stale data-bonsai-index attributes left by previous capture attempts
        // so extractCodeBlocks doesn't skip already-tagged elements.
        document.querySelectorAll('[data-bonsai-index]').forEach(el => {
            el.removeAttribute('data-bonsai-index');
        });

        const title = this.resolveCurrentConversationTitle(
            window.location.pathname.includes('/project') ? 'Project Overview' : 'Untitled'
        );
        const messageEls = this.listMessages();
        const messages: MessageNode[] = [];
        const allArtifacts: ArtifactNode[] = [];
        const seenArtifactContent = new Set<string>();
        const artifactsByMessageId = new Map<string, ArtifactNode[]>();

        const attachArtifacts = (message: MessageNode, artifacts: ArtifactNode[]) => {
            const messageArtifacts = artifactsByMessageId.get(message.message_id) ?? [];
            artifactsByMessageId.set(message.message_id, messageArtifacts);

            for (const artifact of artifacts) {
                const dedupeKey = this.getArtifactDedupKey(artifact);
                if (seenArtifactContent.has(dedupeKey)) continue;
                seenArtifactContent.add(dedupeKey);

                artifact.source_message_id = message.message_id;
                message.artifact_ids.push(artifact.artifact_id);
                allArtifacts.push(artifact);
                messageArtifacts.push(artifact);
            }
        };

        for (const [index, el] of messageEls.entries()) {
            const message = await this.parseMessage(el, index);

            // Parse artifacts SCOPED to this message element
            const artifacts = await this.parseArtifacts(el);

            attachArtifacts(message, artifacts);

            messages.push(message);
        }

        const visibleArtifacts = await this.parseVisibleArtifacts();
        const targetMessage = [...messages].reverse().find((message) => message.role === 'assistant')
            ?? messages[messages.length - 1];

        if (targetMessage) {
            attachArtifacts(targetMessage, visibleArtifacts);
        }

        const allDeepResearchArtifacts = allArtifacts.filter(a => a.type === 'deep_research');

        messages.forEach((message) => {
            const msgArtifacts = artifactsByMessageId.get(message.message_id) ?? [];
            const referenceBlock = this.createArtifactReferenceBlock(msgArtifacts);
            if (referenceBlock) {
                message.content_blocks.push(referenceBlock);
            }
            this.linkDeepResearchLabels(message, msgArtifacts, allDeepResearchArtifacts);
        });

        const filteredMessages = messages.filter((message) => this.hasMeaningfulMessageNode(message));
        filteredMessages.forEach((message, sequence) => {
            message.sequence = sequence;
        });

        return {
            conversation_id: crypto.randomUUID(),
            title,
            source: {
                provider_site: this.providerSite as any,
                url: window.location.href,
                captured_at: new Date().toISOString(),
                capture_version: '0.1.0'
            },
            ...(projectInfo
                ? {
                    source_folder: {
                        name: projectInfo.name,
                        url: projectInfo.url,
                    },
                }
                : {}),
            provenance: this.getProvenance(),
            messages: filteredMessages,
            artifacts: allArtifacts
        };
    }

    async parseArtifacts(el: Element): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];
        const seenContent = new Set<string>();

        const deepResearchEmbeds = this.getDeepResearchEmbeds(el);

        for (const embed of deepResearchEmbeds) {
            const artifact = await this.createDeepResearchArtifact(embed);
            if (!artifact) continue;

            const dedupeKey = this.getArtifactDedupKey(artifact);

            if (seenContent.has(dedupeKey)) continue;
            seenContent.add(dedupeKey);

            artifacts.push(artifact);
        }

        // Look for artifact panel references
        const artifactRefs = el.querySelectorAll('[data-artifact-id], .artifact-reference');
        artifactRefs.forEach(ref => {
            const artifactId = ref.getAttribute('data-artifact-id') ?? crypto.randomUUID();
            const title = this.cleanArtifactText(ref.querySelector('.artifact-title')?.textContent?.trim() || 'Artifact');

            // Try to get artifact content from the panel
            const panel = document.querySelector(`[data-artifact-id="${artifactId}"]`);
            const sourceRoot = (panel?.querySelector('.artifact-content, .markdown, iframe, svg, canvas') ?? panel ?? ref.querySelector('.artifact-content, .markdown, iframe, svg, canvas') ?? ref) as Element;
            const { viewUrl, sourceUrl } = this.extractArtifactLinks(sourceRoot);
            const content = this.cleanArtifactText(sourceRoot.textContent ?? '');

            if (this.isNoiseOnlyArtifactText(content) && !viewUrl && !sourceUrl) {
                return;
            }

            // Find closest message
            const messageEl = ref.closest('[data-bonsai-msg-id]');
            const sourceMsgId = messageEl?.getAttribute('data-bonsai-msg-id') ?? '';

            artifacts.push({
                artifact_id: artifactId,
                type: 'artifact_doc',
                title: title || 'Artifact',
                content: content || title || 'Artifact',
                source_message_id: sourceMsgId,
                source_url: sourceUrl,
                view_url: viewUrl,
                exportable: true
            });
        });

        // Look for images
        // Query ALL images, then filter manually to avoid missing "presentation" images that are actually content
        const images = el.querySelectorAll('img');

        // Use for..of to allow awaiting async conversions
        for (const [idx, imgEl] of Array.from(images).entries()) {
            const img = imgEl as HTMLImageElement;
            const role = img.getAttribute('role');
            const alt = img.getAttribute('alt') || '';

            // Filter out presentation images UNLESS they have meaningful "Generated" alt text OR are user uploads (in buttons)
            const isUserUpload = !!img.closest('button');
            if (role === 'presentation' && !alt.match(/Generated|image|DALL|created/i) && !isUserUpload) {
                continue;
            }

            // Strategy: Gather all possible URL sources and pick the best one
            const candidates: string[] = [];

            // 1. Prefer explicit data attributes
            const dataSrc = img.getAttribute('data-src');
            if (dataSrc) candidates.push(dataSrc);

            // 2. Prefer srcset high-res
            const srcset = img.getAttribute('srcset');
            if (srcset) {
                const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
                if (urls.length) candidates.push(urls[urls.length - 1]);
            }

            // 3. Prefer parent link (often full res download link)
            const parentLink = img.closest('a');
            if (parentLink?.href) candidates.push(parentLink.href);

            // 4. Fallback to src attribute and property
            if (img.src) candidates.push(img.src);
            const attrSrc = img.getAttribute('src');
            if (attrSrc) candidates.push(attrSrc);

            // Find best URL (non-blob, non-data) if possible
            let src = candidates.find(url => !url.startsWith('blob:') && !url.startsWith('data:'));

            // If no clean URL, accept blob
            if (!src) src = candidates[0];

            if (!src) {
                continue;
            }

            const sourceUrl = src;
            const viewUrl = this.extractArtifactViewUrl(img) ?? this.extractArtifactViewUrl(img.closest('[data-bonsai-msg-id]') ?? img);

            // Ignore small icons/avatars (strict filter)
            // But ALLOW user uploads even if small (thumbnails)
            if (!isUserUpload) {
                if (src.includes('avatars') || src.includes('profile') || src.includes('user-content')) {
                    continue;
                }
                // Allow 0-size images if they have explicit generated alt, otherwise skip tiny
                if (!alt.match(/Generated|DALL/i) && img.width > 0 && img.width < 50 && img.height > 0 && img.height < 50) {
                    continue;
                }
            }

            // If it's a blob or likely to expire (signatures), convert to Data URI
            // We now force conversion for ALL generated images AND user uploads to ensure permanence
            if (src.startsWith('blob:') || src.includes('signatures') || src.includes('se=') || alt.match(/Generated|DALL/i) || isUserUpload) {
                try {
                    const dataUrl = await this.imageToDataUrl(img);
                    if (dataUrl) {
                        src = dataUrl;
                    }
                } catch (e) {
                    console.warn('[ChatGPT Adapter] Failed to convert image', e);
                }
            }

            // DEDUPLICATION: Check if we've seen this content before
            if (seenContent.has(src)) {
                continue;
            }
            seenContent.add(src);

            // Find closest message
            const messageEl = img.closest('[data-bonsai-msg-id]');
            const sourceMsgId = messageEl?.getAttribute('data-bonsai-msg-id') ?? '';

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'image',
                title: isUserUpload ? 'Uploaded image' : (alt || 'Generated Image'),
                mime_type: 'image/png',
                content: src,
                source_message_id: sourceMsgId,
                source_url: sourceUrl,
                view_url: viewUrl,
                exportable: true
            });
        }

        return artifacts;
    }

    protected async parseVisibleArtifacts(): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];
        const seenContent = new Set<string>();
        const seenResearchUrls = new Set<string>();

        // First: try to find ChatGPT Canvas / rich-text side-panel content (DOM, not iframe)
        const canvasArtifact = this.findChatGPTCanvasPanelArtifact();
        if (canvasArtifact) {
            seenContent.add(this.getArtifactDedupKey(canvasArtifact));
            artifacts.push(canvasArtifact);
        }

        // Scope deep-research scan to the conversation thread, not document.body,
        // so stale artifact panels from the previous conversation are not captured.
        const threadRoot: Element =
            document.querySelector('[data-testid="conversation-turn-list"], [data-testid="chat-history"], div[role="log"]')
            ?? document.querySelector('main')
            ?? document.body;

        for (const embed of this.getDeepResearchEmbeds(threadRoot)) {
            const artifact = await this.createDeepResearchArtifact(embed);
            if (!artifact) continue;

            const dedupeKey = this.getArtifactDedupKey(artifact);
            if (seenContent.has(dedupeKey)) continue;
            seenContent.add(dedupeKey);

            [artifact.view_url, artifact.source_url].forEach((url) => {
                if (url) {
                    seenResearchUrls.add(url);
                }
            });

            artifacts.push(artifact);
        }

        const visibleArtifacts = Array.from(
            // Intentionally omit [class*="research"] and [class*="report"] — those broad class
            // selectors match ChatGPT navigation items (e.g. the "Deep research" sidebar link
            // and recents containers), producing phantom appendix entries with nav content.
            document.querySelectorAll('[data-artifact-id], .artifact-reference, [data-testid*="artifact"], [data-testid*="research"], [class*="artifact"]')
        ).filter((candidate): candidate is Element =>
            candidate instanceof Element &&
            this.isVisibleElement(candidate) &&
            // Exclude anything inside the navigation sidebar
            !candidate.closest('nav, [role="navigation"], [data-testid*="sidebar"], [data-testid*="nav"], [data-testid*="history"]')
        );

        for (const ref of visibleArtifacts) {
            const descriptor = `${ref.className || ''} ${ref.getAttribute('data-testid') || ''} ${(ref.textContent || '').slice(0, 200)}`.toLowerCase();
            if (!/artifact|research|report|canvas|document/.test(descriptor)) {
                continue;
            }

            const contentRoot = (ref.querySelector('.artifact-content, .markdown, iframe, svg, canvas') ?? ref) as Element;
            let title = ref.querySelector('h1, h2, h3, h4, [role="heading"], strong, .artifact-title, [data-testid*="title"]')
                ?.textContent?.trim()
                || ref.getAttribute('aria-label')?.trim()
                || 'Artifact';
            title = this.cleanArtifactText(title) || 'Artifact';
            let { viewUrl, sourceUrl } = this.extractArtifactLinks(contentRoot);
            const structuredHtml = !contentRoot.matches('iframe, svg, canvas')
                ? this.sanitizeRichHtml(contentRoot, {
                    removeSelectors: ['.bonsai-insert-btn', '.bonsai-action-container', 'button', '[role="button"]']
                })
                : '';
            const content = this.cleanArtifactText(this.getTextContentPreservingLines(contentRoot).replace(/\n{3,}/g, '\n\n').trim());
            const type: ArtifactNode['type'] = /research|report/.test(descriptor)
                ? 'deep_research'
                : contentRoot.querySelector('pre, code')
                    ? 'code_artifact'
                    : 'artifact_doc';

            if (type === 'deep_research' && [viewUrl, sourceUrl].some((url) => url && seenResearchUrls.has(url))) {
                continue;
            }

            let artifact: ArtifactNode = {
                artifact_id: ref.getAttribute('data-artifact-id') ?? crypto.randomUUID(),
                type,
                title,
                content: structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? structuredHtml
                    : (content || title),
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl ?? sourceUrl,
                exportable: true,
                mime_type: structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? 'text/html'
                    : 'text/plain'
            };

            if (artifact.type === 'deep_research' && !this.hasMeaningfulArtifactContent(String(artifact.content), artifact.title)) {
                const hydratedArtifact = await this.createDeepResearchArtifact({
                    title: artifact.title ?? title,
                    summary: typeof artifact.content === 'string' ? artifact.content : '',
                    sourceUrl,
                    viewUrl,
                });

                if (hydratedArtifact) {
                    artifact = {
                        ...hydratedArtifact,
                        artifact_id: artifact.artifact_id,
                    };
                    viewUrl = artifact.view_url;
                    sourceUrl = artifact.source_url;
                }
            }

            const dedupeKey = this.getArtifactDedupKey(artifact);
            if (seenContent.has(dedupeKey)
                || (typeof artifact.content === 'string'
                    && this.isNoiseOnlyArtifactText(artifact.content.startsWith('<')
                        ? artifact.content.replace(/<[^>]+>/g, ' ')
                        : artifact.content)
                    && !artifact.view_url
                    && !artifact.source_url)) {
                continue;
            }

            seenContent.add(dedupeKey);
            [artifact.view_url, artifact.source_url].forEach((url) => {
                if (url) {
                    seenResearchUrls.add(url);
                }
            });
            artifacts.push(artifact);
        }

        return artifacts;
    }

    /**
     * Convert an image to a Base64 Data URL.
     * Tries Canvas first (using rendered pixels), then Fetch (downloading source).
     */
    private async imageToDataUrl(img: HTMLImageElement): Promise<string | null> {
        const src = img.currentSrc || img.src;

        // method 1: Canvas (fastest, works for blobs and same-origin)
        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.drawImage(img, 0, 0);
                return canvas.toDataURL('image/png');
            }
        } catch (e) {
            // security error (tainted canvas) is expected for cross-origin images
        }

        // Method 2: Fetch (works for cross-origin if permissions allowed)
        try {
            const response = await fetch(src);
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            console.error('[ChatGPT Adapter] Image conversion failed', e);
            return null;
        }
    }

    getDeepLink(el: Element): DeepLink {
        // ChatGPT uses URL-based navigation
        const messageId = el.getAttribute('data-message-id')
            ?? el.closest('[data-message-id]')?.getAttribute('data-message-id');

        return {
            url: window.location.href,
            message_anchor: messageId ?? undefined,
            selector_hint: `[data-message-id="${messageId}"]`
        };
    }

    getProvenance(): Provenance {
        // Try to detect model from UI
        const modelIndicator = queryWithFallbacks(document, this.selectors.modelIndicator ?? '');
        const modelText = modelIndicator?.textContent?.toLowerCase() ?? '';

        let model: string | undefined;
        let confidence: 'observed' | 'inferred' | 'unknown' = 'unknown';

        if (modelText.includes('gpt-4o')) {
            model = 'gpt-4o';
            confidence = 'observed';
        } else if (modelText.includes('gpt-4')) {
            model = 'gpt-4';
            confidence = 'observed';
        } else if (modelText.includes('gpt-3.5') || modelText.includes('gpt-35')) {
            model = 'gpt-3.5-turbo';
            confidence = 'observed';
        } else if (modelText.includes('o1')) {
            model = 'o1';
            confidence = 'observed';
        } else if (modelText) {
            model = modelText.trim();
            confidence = 'inferred';
        }

        return {
            provider: 'openai',
            model,
            confidence
        };
    }

    sendToAI(text: string): boolean {
        const input = queryWithFallbacks(document, this.selectors.inputField) as HTMLTextAreaElement | null;
        if (!input) return false;

        // Set the text
        if (input.tagName === 'TEXTAREA') {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (input.getAttribute('contenteditable')) {
            input.textContent = text;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        }

        // Optionally click send
        // const sendBtn = queryWithFallbacks(document, this.selectors.submitButton ?? '');
        // if (sendBtn) (sendBtn as HTMLButtonElement).click();

        return true;
    }
}

// Auto-register when loaded as content script
if (typeof window !== 'undefined') {
    (window as any).__bonsaiAdapter = new ChatGPTAdapter();
    console.log('[Bonsai Capture] ChatGPT adapter registered');

    // Initialize message handler and DOM injector AFTER adapter is set
    Promise.all([
        import('../message-handler'),
        import('../dom-injector')
    ]).then(([_, { domInjector }]) => {
        console.log('[Bonsai Capture] Message handler initialized');

        // Start injecting buttons into the DOM
        domInjector.start();
        console.log('[Bonsai Capture] DOM injector started');
    });
}

// export default ChatGPTAdapter;


