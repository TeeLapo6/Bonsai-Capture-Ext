/**
 * Claude.ai Adapter
 * 
 * Captures conversations from claude.ai
 */

import { BaseAdapter, ParsedConversation, SidebarItem } from './interface';
import {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ContentBlock,
    createMessageNode,
    createCodeBlock,
    createHtmlBlock,
    createMarkdownBlock
} from '../../shared/schema';
import {
    getSelectorsForSite,
    queryWithFallbacks,
    queryAllWithFallbacks
} from '../../config/selectors';
import { captureEngine } from '../capture-engine';

export class ClaudeAdapter extends BaseAdapter {
    readonly providerName = 'Anthropic';
    readonly providerSite = 'claude.ai';

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    private isVisibleElement(el: Element): boolean {
        const node = el as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();

        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
    }

    private isClaudeArtifactNavigationLink(el: Element): boolean {
        const href = el.getAttribute('href')?.trim() ?? '';
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const label = (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

        return href.endsWith('/artifacts')
            || href === '/artifacts'
            || text === 'artifacts'
            || label === 'artifacts';
    }

    private getClaudeArtifactOpeners(root: ParentNode = document): HTMLElement[] {
        const candidates = Array.from(
            root.querySelectorAll('[aria-label*="Open artifact"], [aria-label*="open artifact"], .artifact-block-cell [role="button"], .artifact-block-cell button, .artifact-block-cell div[aria-label]')
        ).filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);

        return candidates.filter((candidate) => {
            if (!this.isVisibleElement(candidate) || this.isClaudeArtifactNavigationLink(candidate)) {
                return false;
            }

            const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`.replace(/\s+/g, ' ').trim();
            if (!/open artifact/i.test(label)) {
                return false;
            }

            // Claude artifacts live in div#main-content (NOT <main>), so requiring a <main>
            // ancestor always fails. Just verify the opener is not inside a nav/header/footer.
            const navContainer = candidate.closest('nav, aside, header, footer');
            return !navContainer;
        });
    }

    private getClaudeArtifactScopeSelector(): string {
        return [
            '[data-artifact]',
            '[data-artifact-id]',
            '[data-artifact-content]',
            '.artifact-card',
            '.artifact-preview',
            '.artifact-block-cell',
            '[aria-label^="Artifact panel"]',
            '[role="region"][aria-label*="Artifact"]',
            '[data-testid*="artifact-panel"]',
            '[data-testid*="artifact-view"]',
            '[class*="artifact-panel"]',
            '[class*="artifact-view"]',
            '[class*="artifact-editor"]',
        ].join(', ');
    }

    private isClaudeArtifactScopedElement(el: Element | null): boolean {
        if (!el) {
            return false;
        }

        return el.closest(this.getClaudeArtifactScopeSelector()) !== null;
    }

    private normalizeClaudeTitle(value: string | null | undefined): string {
        return this.cleanArtifactText(value ?? '').toLowerCase();
    }

    private claudeTitlesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
        const normalizedLeft = this.normalizeClaudeTitle(left);
        const normalizedRight = this.normalizeClaudeTitle(right);

        if (!normalizedLeft || !normalizedRight) {
            return false;
        }

        return normalizedLeft === normalizedRight
            || normalizedLeft.includes(normalizedRight)
            || normalizedRight.includes(normalizedLeft);
    }

    private getClaudeArtifactPanelSelectors(): string[] {
        return [
            // Claude panel aria-label is "Artifact panel: <title>" — use prefix match to avoid
            // matching the opener div ("<title>. Open artifact.").
            '[aria-label^="Artifact panel"]',
            '[role="region"][aria-label*="Artifact"]',
            '[data-testid*="artifact-panel"]',
            '[data-testid*="artifact-view"]',
            '[class*="artifact-panel"]',
            '[class*="artifact-view"]',
            '[class*="artifact-editor"]',
        ];
    }

    private getClaudeArtifactOpenerTitle(opener: Element | null): string {
        if (!opener) {
            return '';
        }

        return this.cleanArtifactText(
            ((opener.getAttribute('aria-label') ?? opener.textContent ?? '')
                .replace(/\.\s*open artifact\.?/i, '')
                .replace(/\s+open artifact\.?/i, '')
                .trim())
        );
    }

    private getClaudeArtifactPanelTitle(panelRoot: Element | null): string {
        if (!panelRoot) {
            return '';
        }

        return this.cleanArtifactText(
            panelRoot.querySelector('[role="heading"], h1, h2, h3, h4, strong')?.textContent?.trim()
            ?? panelRoot.getAttribute('aria-label')?.replace(/^artifact panel:\s*/i, '').trim()
            ?? ''
        );
    }

    private getClaudeArtifactPanelRoot(expectedTitle?: string): Element | null {
        const candidates = this.getClaudeArtifactPanelSelectors()
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .find((candidate): candidate is Element => {
                if (!(candidate instanceof Element) || !this.isVisibleElement(candidate)) {
                    return false;
                }

                const text = this.cleanArtifactText(candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '');
                return text.length > 40 || Boolean(candidate.querySelector('pre, code, .standard-markdown, .progressive-markdown, .markdown, iframe'));
            });

        if (!expectedTitle) {
            return candidates ?? null;
        }

        const panels = this.getClaudeArtifactPanelSelectors()
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .filter((candidate): candidate is Element => candidate instanceof Element && this.isVisibleElement(candidate));

        return panels.find((candidate) => this.claudeTitlesMatch(this.getClaudeArtifactPanelTitle(candidate), expectedTitle)) ?? null;
    }

    private getClaudeArtifactCloseButton(panelRoot: Element): HTMLElement | null {
        const panelContainer = panelRoot.closest('[role="dialog"], [aria-modal="true"], body') ?? document.body;
        const candidates = Array.from(panelContainer.querySelectorAll('button, [role="button"], a'))
            .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);

        return candidates.find((candidate) => {
            if (!this.isVisibleElement(candidate)) {
                return false;
            }

            const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`.replace(/\s+/g, ' ').trim();
            return /\b(close|dismiss|exit)\b/i.test(label);
        }) ?? null;
    }

    private async closeClaudeArtifactPanel(panelRoot: Element | null): Promise<boolean> {
        if (!panelRoot) {
            return true;
        }

        const closeButton = this.getClaudeArtifactCloseButton(panelRoot);
        if (closeButton) {
            closeButton.click();
        } else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
        }

        for (let attempt = 0; attempt < 12; attempt += 1) {
            if (!panelRoot.isConnected || !this.isVisibleElement(panelRoot)) {
                return true;
            }

            await this.delay(120);
        }

        return !panelRoot.isConnected || !this.isVisibleElement(panelRoot);
    }

    private getClaudeArtifactCodeToggle(panelRoot: Element): HTMLElement | null {
        return Array.from(panelRoot.querySelectorAll('button[aria-label="Code"], [role="radio"][aria-label="Code"], button[aria-label*="Code"], [role="radio"][aria-label*="Code"]'))
            .find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement && this.isVisibleElement(candidate)) ?? null;
    }

    private isClaudeArtifactCodeViewActive(panelRoot: Element): boolean {
        const codeToggle = this.getClaudeArtifactCodeToggle(panelRoot);
        if (!codeToggle) {
            return false;
        }

        const state = (codeToggle.getAttribute('data-state') ?? '').toLowerCase();
        return state === 'on'
            || state === 'active'
            || codeToggle.getAttribute('aria-checked') === 'true'
            || codeToggle.getAttribute('aria-selected') === 'true';
    }

    private getClaudeArtifactPreviewContentRoot(panelRoot: Element): Element {
        return (panelRoot.querySelector('.standard-markdown, .progressive-markdown, .markdown, [data-artifact-content], [data-testid*="artifact-content"], iframe[src], embed[src], object[data], svg, canvas') ?? panelRoot) as Element;
    }

    private getClaudeArtifactCodeContentRoot(panelRoot: Element): Element {
        return (panelRoot.querySelector('[class*="overflow-y-scroll"], pre, code, div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"], [data-testid*="code"]') ?? panelRoot) as Element;
    }

    private async captureClaudePanelArtifact(
        panelRoot: Element,
        options?: { artifactId?: string; fallbackTitle?: string }
    ): Promise<ArtifactNode | null> {
        const codeToggle = this.getClaudeArtifactCodeToggle(panelRoot);
        const codeViewWasActive = this.isClaudeArtifactCodeViewActive(panelRoot);

        if (codeToggle && !codeViewWasActive) {
            codeToggle.click();
            await this.delay(250);
        }

        const usingCodeView = this.isClaudeArtifactCodeViewActive(panelRoot);
        const contentRoot = usingCodeView
            ? this.getClaudeArtifactCodeContentRoot(panelRoot)
            : this.getClaudeArtifactPreviewContentRoot(panelRoot);
        const extractedCode = this.extractClaudeCodeArtifact(contentRoot);

        const title = this.cleanArtifactText(
            this.getClaudeArtifactPanelTitle(panelRoot)
            || options?.fallbackTitle
            || 'Artifact'
        ) || options?.fallbackTitle || 'Artifact';
        const { viewUrl, sourceUrl } = this.extractArtifactLinks(panelRoot);
        const descriptor = `${panelRoot.className || ''} ${panelRoot.getAttribute('data-testid') || ''} ${contentRoot.tagName} ${contentRoot.className || ''}`.toLowerCase();
        let type: ArtifactNode['type'] = 'artifact_doc';
        if (usingCodeView || /code|source/.test(descriptor) || Boolean(contentRoot.querySelector('pre, code')) || contentRoot.matches('pre, code') || Boolean(extractedCode)) {
            type = 'code_artifact';
        } else if (/document|doc|pdf/.test(descriptor)) {
            type = 'embedded_doc';
        }

        const structuredHtml = type !== 'code_artifact' && !contentRoot.matches('svg, canvas, iframe, embed, object')
            ? this.sanitizeRichHtml(contentRoot, {
                removeSelectors: ['.bonsai-insert-btn', '.bonsai-action-container', 'button', '[role="button"]', '[aria-label*="Copy"]', '[aria-label*="Retry"]', '[aria-label*="Edit"]']
            })
            : '';
        const content = type === 'code_artifact'
            ? (extractedCode?.code ?? this.normalizeClaudeCodeText(this.getTextContentPreservingLines(contentRoot), true))
            : this.cleanArtifactText(this.getTextContentPreservingLines(contentRoot).replace(/\n{3,}/g, '\n\n').trim());
        if (!structuredHtml && this.isNoiseOnlyArtifactText(content) && !viewUrl && !sourceUrl) {
            return null;
        }

        const artifactId = options?.artifactId ?? crypto.randomUUID();
        const svg = contentRoot.matches('svg') ? contentRoot as SVGSVGElement : contentRoot.querySelector('svg');
        if (svg) {
            return {
                artifact_id: `${artifactId}-svg`,
                type: 'image',
                title: title || 'Diagram',
                mime_type: 'image/svg+xml',
                content: this.svgToDataUrl(svg as SVGSVGElement),
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl ?? window.location.href,
                exportable: true,
            };
        }

        const canvas = contentRoot.matches('canvas') ? contentRoot as HTMLCanvasElement : contentRoot.querySelector('canvas');
        if (canvas) {
            const dataUrl = this.canvasToDataUrl(canvas as HTMLCanvasElement);
            if (dataUrl) {
                return {
                    artifact_id: `${artifactId}-canvas`,
                    type: 'image',
                    title: title || 'Diagram',
                    mime_type: 'image/png',
                    content: dataUrl,
                    source_message_id: '',
                    source_url: sourceUrl,
                    view_url: viewUrl ?? window.location.href,
                    exportable: true,
                };
            }
        }

        return {
            artifact_id: artifactId,
            type,
            title,
            content: type !== 'code_artifact' && structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                ? structuredHtml
                : (content || title),
            source_message_id: '',
            source_url: sourceUrl,
            view_url: viewUrl ?? window.location.href,
            exportable: true,
            mime_type: type !== 'code_artifact' && structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                ? 'text/html'
                : 'text/plain',
        };
    }

    private normalizeClaudeCodeText(text: string, collapseExtraNewlines = false): string {
        let normalized = text
            .replace(/\u00a0/g, ' ')
            .replace(/\u200b/g, '');

        if (collapseExtraNewlines) {
            normalized = normalized.replace(/\n{3,}/g, '\n\n');
        }

        return normalized.trim();
    }

    private extractClaudeCodeArtifact(root: Element | null): { code: string; language: string } | null {
        if (!root) {
            return null;
        }

        const explicitCodeBlocks = Array.from(root.querySelectorAll('pre code, code'))
            .filter((candidate): candidate is Element => candidate instanceof Element)
            .filter((candidate) => !candidate.querySelector('code'))
            .map((candidate) => ({
                code: this.normalizeClaudeCodeText(candidate.textContent ?? ''),
                language: this.detectCodeLanguage(candidate),
            }))
            .filter((candidate) => candidate.code.length > 0)
            .sort((left, right) => right.code.length - left.code.length);

        if (explicitCodeBlocks.length > 0) {
            return explicitCodeBlocks[0];
        }

        const preBlocks = Array.from(root.querySelectorAll('pre'))
            .map((candidate) => ({
                code: this.normalizeClaudeCodeText(candidate.textContent ?? ''),
                language: this.detectCodeLanguage(candidate),
            }))
            .filter((candidate) => candidate.code.length > 0)
            .sort((left, right) => right.code.length - left.code.length);

        if (preBlocks.length > 0) {
            return preBlocks[0];
        }

        const fallbackRoots = [
            ...(root.matches('[class*="overflow-y-scroll"], div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"], [data-testid*="code"]') ? [root] : []),
            ...Array.from(root.querySelectorAll('[class*="overflow-y-scroll"], div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"], [data-testid*="code"]')),
        ].filter((candidate, index, all): candidate is Element => candidate instanceof Element && all.indexOf(candidate) === index);

        const fallbackBlocks = fallbackRoots
            .map((candidate) => ({
                code: this.normalizeClaudeCodeText(this.getTextContentPreservingLines(candidate), true),
                language: this.detectCodeLanguage(candidate),
            }))
            .filter((candidate) => candidate.code.length > 0)
            .sort((left, right) => right.code.length - left.code.length);

        return fallbackBlocks[0] ?? null;
    }

    private async captureClaudeOpenedArtifact(
        opener: HTMLElement,
        options?: { artifactId?: string; fallbackTitle?: string }
    ): Promise<ArtifactNode | null> {
        const expectedTitle = options?.fallbackTitle || this.getClaudeArtifactOpenerTitle(opener);
        const existingPanel = this.getClaudeArtifactPanelRoot();
        const reuseExistingPanel = Boolean(existingPanel && (!expectedTitle || this.claudeTitlesMatch(this.getClaudeArtifactPanelTitle(existingPanel), expectedTitle)));

        let panelRoot: Element | null = reuseExistingPanel ? existingPanel : null;
        let openedPanelForCapture = false;
        let closedConflictingPanel = false;

        if (!reuseExistingPanel && existingPanel) {
            await this.closeClaudeArtifactPanel(existingPanel);
            closedConflictingPanel = true;
            await this.delay(120);
        }

        if (!panelRoot) {
            opener.click();
            openedPanelForCapture = true;
        }

        try {
            for (let attempt = 0; attempt < 15; attempt += 1) {
                panelRoot = expectedTitle ? this.getClaudeArtifactPanelRoot(expectedTitle) : this.getClaudeArtifactPanelRoot();
                if (panelRoot) {
                    break;
                }

                await this.delay(200);
            }

            if (!panelRoot) {
                return null;
            }

            return this.captureClaudePanelArtifact(panelRoot, {
                artifactId: options?.artifactId,
                fallbackTitle: expectedTitle,
            });
        } finally {
            if (panelRoot && (openedPanelForCapture || closedConflictingPanel)) {
                await this.closeClaudeArtifactPanel(panelRoot);
            }
        }
    }

    private get selectors() {
        const s = getSelectorsForSite('claude.ai');
        if (!s) {
            console.error('Bonsai: Failed to get selectors for claude.ai');
            // Emergency hardcoded fallback
            return {
                conversationContainer: 'body',
                messageBlock: '[data-testid="user-message"]',
                roleClassUser: 'font-user-message',
                roleClassAssistant: 'font-claude-response',
                inputField: '[contenteditable="true"]',
                modelIndicator: ''
            };
        }
        return s;
    }

    detectConversation(): ParsedConversation | null {
        try {
            console.log('Bonsai: Detecting conversation...');
            let container = queryWithFallbacks(document, this.selectors.conversationContainer);
            console.log('Bonsai: Container probe:', container);

            // Deep Inspect Fallback: If URL matches but container missing, force a capture
            if (!container && window.location.href.includes('/chat/')) {
                console.warn('Bonsai: Claude container not found, using body for inspection');
                container = document.querySelector('main') || document.body;
            }

            if (!container) {
                console.error('Bonsai: Container is null!');
                return null;
            }

            const title = document.title.replace(' - Claude', '').replace('Claude', '').trim()
                || this.extractConversationTitle();

            return {
                url: window.location.href,
                container,
                title: title || 'Claude Chat (Debug)'
            };
        } catch (e) {
            console.error('Bonsai: Fatal error in detectConversation', e);
            // Emergency Recovery
            return {
                url: window.location.href,
                title: 'Claude (Error Recovery)',
                container: document.body
            };
        }
    }

    private extractConversationTitle(): string {
        // Try sidebar or header
        const titleEl = document.querySelector('[data-testid="conversation-title"], .conversation-title');
        return titleEl?.textContent?.trim() ?? '';
    }

    listMessages(): Element[] {
        const conversation = this.detectConversation();
        if (!conversation) return [];

        const all = queryAllWithFallbacks(conversation.container, this.selectors.messageBlock);

        if (all.length === 0 && (conversation.container === document.body || conversation.container === document.querySelector('main'))) {
            // If in debug mode and no messages found, return header as dummy message to trigger artifact parsing
            return [conversation.container];
        }

        // Deduplicate
        return all.filter(msg => !all.some(ancestor => ancestor !== msg && ancestor.contains(msg)));
    }

    parseMessage(el: Element, sequence: number): MessageNode {
        // If debug mode (body), force assistant role
        if (el === document.body || el === document.querySelector('main')) {
            return createMessageNode('assistant', sequence, [], this.getDeepLink(el));
        }

        const role = this.detectRole(el);
        const contentBlocks = this.parseContentBlocks(el, role);
        const deepLink = this.getDeepLink(el);
        const origin = this.getProvenance();

        const message = createMessageNode(role, sequence, contentBlocks, deepLink, role === 'assistant' ? origin : undefined);

        const stableId = el.getAttribute('data-message-id')
            ?? el.getAttribute('data-bonsai-msg-id')
            ?? el.getAttribute('id')
            ?? el.closest('[data-message-id]')?.getAttribute('data-message-id')
            ?? el.closest('[data-bonsai-msg-id]')?.getAttribute('data-bonsai-msg-id')
            ?? el.closest('[id]')?.getAttribute('id');

        if (stableId) {
            message.message_id = stableId;
        }

        return message;
    }

    private detectRole(el: Element): 'user' | 'assistant' | 'system' | 'tool' {
        const classList = el.className.toLowerCase();
        const selectors = this.selectors;

        // Check class-based selectors
        if (selectors.roleClassUser) {
            const userClasses = selectors.roleClassUser.split(',').map(c => c.trim());
            if (userClasses.some(c => classList.includes(c))) return 'user';
        }

        if (selectors.roleClassAssistant) {
            const assistantClasses = selectors.roleClassAssistant.split(',').map(c => c.trim());
            if (assistantClasses.some(c => classList.includes(c))) return 'assistant';
        }

        // Check for Claude avatar/icon
        if (el.querySelector('.claude-avatar, [data-testid="claude-avatar"], svg.claude-icon')) {
            return 'assistant';
        }

        // Check for user avatar
        if (el.querySelector('.user-avatar, [data-testid="user-avatar"]')) {
            return 'user';
        }

        // Check data attributes
        const role = el.getAttribute('data-role') ?? el.getAttribute('data-message-role');
        if (role === 'user' || role === 'human') return 'user';
        if (role === 'assistant' || role === 'ai') return 'assistant';

        // Fallback to position
        const messages = this.listMessages();
        const index = messages.indexOf(el);
        return index % 2 === 0 ? 'user' : 'assistant';
    }

    private getAssistantStructuredContent(el: Element): Element | null {
        const fragments = Array.from(el.querySelectorAll('.standard-markdown, .progressive-markdown'))
            .filter((fragment): fragment is Element => fragment instanceof Element)
            .filter((fragment) => !this.isClaudeArtifactScopedElement(fragment))
            .filter((fragment) => (fragment.textContent || '').trim().length > 0);

        const uniqueFragments = fragments.filter(
            (fragment) => !fragments.some((parent) => parent !== fragment && parent.contains(fragment))
        );

        if (uniqueFragments.length === 0) {
            return null;
        }

        if (uniqueFragments.length === 1) {
            return uniqueFragments[0];
        }

        const wrapper = document.createElement('div');
        uniqueFragments.forEach((fragment) => wrapper.appendChild(fragment.cloneNode(true)));
        return wrapper;
    }

    private parseContentBlocks(el: Element, role: 'user' | 'assistant' | 'system' | 'tool'): ContentBlock[] {
        if (role === 'assistant') {
            const structured = this.getAssistantStructuredContent(el);
            if (structured) {
                const html = this.sanitizeRichHtml(structured, {
                    removeSelectors: ['[aria-label*="Copy"]', '[aria-label="Retry"]', '[aria-label="Edit"]']
                });

                if (html) {
                    return [createHtmlBlock(html)];
                }
            }
        }

        const blocks: ContentBlock[] = [];

        // 1. Mark and Extract Code Blocks (Only REAL code blocks)
        const codeBlocks = this.extractCodeBlocks(el);

        // 2. Clone content for text extraction
        // Prefer Claude-specific content containers to avoid capturing role labels and action buttons.
        const contentArea = Array.from(el.querySelectorAll('.font-claude-response, .prose, .message-content, [data-message-content]'))
            .find((candidate): candidate is Element => candidate instanceof Element && !this.isClaudeArtifactScopedElement(candidate))
            ?? el;
        const clone = contentArea.cloneNode(true) as Element;

        // 3. Replace marked code blocks with Placeholders
        // The data-bonsai-index attribute was set by extractCodeBlocks
        clone.querySelectorAll('[data-bonsai-index]').forEach(captured => {
            const index = captured.getAttribute('data-bonsai-index');
            if (index !== null) {
                const placeholder = document.createTextNode(`\n\n<<<BONSAI_CODE_BLOCK_${index}>>>\n\n`);
                captured.parentNode?.replaceChild(placeholder, captured);
            }
        });

        // Also remove artifact cards and action buttons from text
        clone.querySelectorAll(`${this.getClaudeArtifactScopeSelector()}, .font-claude-message-actions, .font-user-message-actions, [role="group"], button, [role="button"]`).forEach(art => art.remove());

        // 4. Get text using recursive walker to guarantee newlines between blocks
        // This handles deep nesting and grid layouts where innerText fails
        const rawText = this.getTextContentPreservingLines(clone);

        // Normalize whitespace: max 2 newlines
        let textContent = rawText.replace(/\n{3,}/g, '\n\n').trim();

        // Cleanup quote markers and conversational prefixes from text
        textContent = this.sanitizeMessageText(textContent);

        // Escape asterisks (The user wants literal asterisks, not bullets/italics)
        textContent = textContent.replace(/\*/g, '\u2217');

        const parts = textContent.split(/<<<BONSAI_CODE_BLOCK_(\d+)>>>/);

        parts.forEach((part, i) => {
            if (i % 2 === 0) {
                // Even indices are Text
                const text = part.trim();
                if (text) {
                    blocks.push(createMarkdownBlock(text));
                }
            } else {
                // Odd indices are the captured ID (from key group regex)
                const blockIndex = parseInt(part, 10);
                const cb = codeBlocks[blockIndex];
                if (cb) {
                    blocks.push(createCodeBlock(cb.code, cb.language));
                }
            }
        });

        return blocks;
    }

    /**
     * Recursive DOM walker that ensures block-level elements are separated by newlines.
     * Use this instead of innerText for grid/deeply nested layouts.
     */
    private getTextContentPreservingLines(root: Node): string {
        if (root.nodeType === Node.TEXT_NODE) {
            return root.textContent || '';
        }

        if (root.nodeType === Node.ELEMENT_NODE) {
            const el = root as Element;
            // Ignore artifacts/hidden
            if (el.matches('[data-artifact], .artifact-card, .artifact-preview, style, script')) return '';

            // Check if block level
            const tag = el.tagName.toLowerCase();
            const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'ul', 'ol', 'pre', 'blockquote'];
            const isBlock = blockTags.includes(tag);

            let text = '';

            // Recurse children
            root.childNodes.forEach(child => {
                text += this.getTextContentPreservingLines(child);
            });

            // Special handling for BR
            if (tag === 'br') return '\n';

            // If block, surround with newlines (unless empty)
            if (isBlock && text.trim().length > 0) {
                return '\n' + text + '\n';
            }
            return text;
        }

        return '';
    }

    protected extractCodeBlocks(el: Element): Array<{ language: string; code: string }> {
        const blocks: Array<{ language: string; code: string }> = [];

        // Helper to capture and mark with Index
        const capture = (element: Element, code: string, lang: string) => {
            const index = blocks.length;
            element.setAttribute('data-bonsai-index', index.toString());

            const wrapper = element.closest('.group, .code-container');
            if (wrapper && wrapper !== element) {
                wrapper.setAttribute('data-bonsai-index', index.toString());
            }

            blocks.push({ language: lang, code });
        };

        // 1. Standard pre/code via base implementation (Manual implementation to allow marking)
        const standard = el.querySelectorAll('pre code, pre');
        standard.forEach(node => {
            if (node.closest('[data-bonsai-index]')) return;

            const codeEl = node.querySelector('code') ?? node;
            const text = codeEl.textContent?.trim() ?? '';
            if (!text) return;

            let lang = '';
            const classes = (codeEl.className + ' ' + node.className).toLowerCase();
            const match = classes.match(/language-(\w+)/);
            if (match) lang = match[1];

            capture(node, text, lang);
        });

        // 2. Heuristic: Scrollable containers (overflow)
        const scrollable = el.querySelectorAll('div[class*="overflow"], div[style*="overflow"]');
        scrollable.forEach(div => {
            if (div.querySelector('table')) return;
            // Ignore if already captured or inside captured
            if (div.closest('[data-bonsai-index]')) return;

            const text = div.textContent?.trim() ?? '';
            // Check if it looks code-like (long, or structured)
            // Simple fallback: if > 50 chars and not a table
            if (text.length > 50 && text.length < (el.textContent?.length ?? 0) * 0.9) {
                // Check if it's already in blocks
                if (!blocks.some(b => b.code === text)) {
                    capture(div, text, '');
                }
            }
        });

        // 3. Heuristic: Copies Button
        const copyButtons = Array.from(el.querySelectorAll('button'));
        copyButtons.forEach(btn => {
            const label = btn.getAttribute('aria-label') || btn.textContent || '';
            if (label.toLowerCase().includes('copy')) {
                const container = btn.closest('.group') || btn.closest('.code-block') || btn.parentElement?.parentElement;
                if (container && !container.closest('[data-bonsai-index]')) {
                    const codePart = container.querySelector('pre')
                        || container.querySelector('code')
                        || container.querySelector('div[class*="overflow"]')
                        || container.querySelector('div[class*="font-mono"]'); // font-mono still useful

                    if (codePart) {
                        const code = codePart.textContent?.trim() ?? '';
                        if (code && code.length < 20000 && !blocks.some(b => b.code === code)) {
                            capture(container, code, '');
                        }
                    }
                }
            }
        });

        return blocks;
    }

    async parseArtifacts(el: Element): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];

        // DEBUG DUMP if we are capturing the main/body fallback
        if (el === document.body || el === document.querySelector('main')) {
            const dump = {
                url: window.location.href,
                mainClasses: document.querySelector('main')?.className,
                bodyStructure: this.analyzeStructure(document.querySelector('main') || document.body)
            };

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'artifact_doc', // Will show as document
                title: 'Claude DOM Dump',
                content: JSON.stringify(dump, null, 2),
                source_message_id: '',
                exportable: true,
                mime_type: 'application/json'
            });
            return artifacts;
        }

        const artifactRefs = Array.from(el.querySelectorAll('[data-artifact], .artifact-card, .artifact-preview'))
            .filter((ref): ref is Element => ref instanceof Element)
            .filter((ref, index, all) => !all.some((ancestor) => ancestor !== ref && ancestor.contains(ref)));

        for (const ref of artifactRefs) {
            const artifactId = ref.getAttribute('data-artifact-id') ?? crypto.randomUUID();
            const title = this.cleanArtifactText(ref.querySelector('.artifact-title, [data-testid="artifact-title"]')?.textContent?.trim() || 'Artifact');
            const opener = this.getClaudeArtifactOpeners(ref)[0] ?? null;
            if (opener) {
                const openedArtifact = await this.captureClaudeOpenedArtifact(opener, {
                    artifactId,
                    fallbackTitle: title || 'Artifact',
                });

                if (openedArtifact) {
                    artifacts.push(openedArtifact);
                    continue;
                }
            }

            const contentRoot = (document.querySelector(`[data-artifact-content="${artifactId}"]`)
                ?? ref.querySelector('.artifact-content, .standard-markdown, .progressive-markdown, .markdown, svg, canvas')) as Element | null;
            const sourceRoot = contentRoot ?? ref;
            const { viewUrl, sourceUrl } = this.extractArtifactLinks(sourceRoot);
            const extractedCode = sourceRoot instanceof Element ? this.extractClaudeCodeArtifact(sourceRoot) : null;

            let type: ArtifactNode['type'] = 'artifact_doc';
            const typeAttr = ref.getAttribute('data-artifact-type')?.toLowerCase();
            if (typeAttr?.includes('code') || extractedCode) type = 'code_artifact';
            if (typeAttr?.includes('doc')) type = 'embedded_doc';

            const svg = sourceRoot instanceof Element ? sourceRoot.querySelector('svg') : null;
            const canvas = sourceRoot instanceof Element ? sourceRoot.querySelector('canvas') : null;
            const structuredHtml = type !== 'code_artifact' && sourceRoot instanceof Element && !sourceRoot.matches('svg, canvas')
                ? this.sanitizeRichHtml(sourceRoot, {
                    removeSelectors: ['.bonsai-insert-btn', '.bonsai-action-container', 'button', '[role="button"]', '[aria-label*="Copy"]', '[aria-label*="Retry"]', '[aria-label*="Edit"]']
                })
                : '';
            const content = type === 'code_artifact'
                ? (extractedCode?.code ?? this.normalizeClaudeCodeText(this.getTextContentPreservingLines(sourceRoot), true))
                : this.cleanArtifactText(sourceRoot?.textContent ?? ref.textContent ?? '');

            if (svg) {
                artifacts.push({
                    artifact_id: `${artifactId}-svg`,
                    type: 'image',
                    title: title || 'Diagram',
                    mime_type: 'image/svg+xml',
                    content: this.svgToDataUrl(svg as SVGSVGElement),
                    source_message_id: '',
                    source_url: sourceUrl,
                    view_url: viewUrl,
                    exportable: true
                });
            } else if (canvas) {
                const dataUrl = this.canvasToDataUrl(canvas as HTMLCanvasElement);
                if (dataUrl) {
                    artifacts.push({
                        artifact_id: `${artifactId}-canvas`,
                        type: 'image',
                        title: title || 'Diagram',
                        mime_type: 'image/png',
                        content: dataUrl,
                        source_message_id: '',
                        source_url: sourceUrl,
                        view_url: viewUrl,
                        exportable: true
                    });
                }
            }

            if (this.isNoiseOnlyArtifactText(content) && !viewUrl && !sourceUrl) {
                continue;
            }

            artifacts.push({
                artifact_id: artifactId,
                type,
                title: title || 'Artifact',
                content: type !== 'code_artifact' && structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? structuredHtml
                    : (content || title || 'Artifact'),
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl,
                exportable: true,
                mime_type: type !== 'code_artifact' && structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? 'text/html'
                    : 'text/plain'
            });
        }

        // Look for images
        el.querySelectorAll('img:not([role="presentation"]):not(.avatar)').forEach(img => {
            const src = img.getAttribute('src');
            if (!src) return;
            const viewUrl = this.extractArtifactViewUrl(img);

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'image',
                title: img.getAttribute('alt') ?? undefined,
                mime_type: 'image/png',
                content: src,
                source_message_id: '',
                source_url: src,
                view_url: viewUrl,
                exportable: true
            });
        });

        return artifacts;
    }

    protected async parseVisibleArtifacts(): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];
        const seenContent = new Set<string>();

        const visiblePanels = this.getClaudeArtifactPanelSelectors()
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .filter((candidate): candidate is Element => candidate instanceof Element && this.isVisibleElement(candidate))
            .filter((candidate, index, all) => all.indexOf(candidate) === index);

        for (const panelRoot of visiblePanels) {
            const artifact = await this.captureClaudePanelArtifact(panelRoot, {
                fallbackTitle: this.getClaudeArtifactPanelTitle(panelRoot) || 'Artifact',
            });
            if (!artifact) {
                continue;
            }

            const dedupeKey = this.getArtifactDedupKey(artifact);
            if (seenContent.has(dedupeKey)) {
                continue;
            }

            seenContent.add(dedupeKey);
            artifacts.push(artifact);
        }

        const visibleImages = Array.from(
            document.querySelectorAll('[data-artifact] img, [data-artifact-id] img, .artifact-card img, .artifact-preview img, [class*="artifact"] img')
        ).filter((img): img is HTMLImageElement => img instanceof HTMLImageElement && this.isVisibleElement(img));

        for (const img of visibleImages) {
            const src = img.getAttribute('src');
            if (!src || src.includes('avatar')) continue;

            const dedupeKey = `image|${src}`;
            if (seenContent.has(dedupeKey)) continue;
            seenContent.add(dedupeKey);

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'image',
                title: img.getAttribute('alt') ?? 'Artifact image',
                mime_type: 'image/png',
                content: src,
                source_message_id: '',
                source_url: src,
                view_url: this.extractArtifactViewUrl(img) ?? window.location.href,
                exportable: true
            });
        }

        return artifacts;
    }

    private analyzeStructure(root: Element): any {
        return {
            tagName: root.tagName,
            classes: root.className,
            attributes: Array.from(root.attributes).map(a => `${a.name}="${a.value}"`),
            children: Array.from(root.children).slice(0, 5).map(c => ({
                tag: c.tagName,
                class: c.className,
                htmlPreview: c.outerHTML.slice(0, 200) + '...'
            }))
        };
    }

    getDeepLink(el: Element): DeepLink {
        const messageId = el.getAttribute('data-message-id')
            ?? el.getAttribute('id')
            ?? el.closest('[data-message-id]')?.getAttribute('data-message-id');

        return {
            url: window.location.href,
            message_anchor: messageId ?? undefined
        };
    }

    async scanSidebar(): Promise<SidebarItem[]> {
        const items: SidebarItem[] = [];

        // On the /recents page: click "Show more" until all conversations are loaded
        const onRecents = window.location.pathname.startsWith('/recents');
        if (onRecents) {
            for (let i = 0; i < 30; i++) {
                const showMoreBtn = Array.from(document.querySelectorAll('button')).find(
                    b => /show more|load more|see more/i.test(b.textContent?.trim() ?? '')
                ) as HTMLButtonElement | undefined;
                if (!showMoreBtn) break;
                showMoreBtn.click();
                await new Promise(r => setTimeout(r, 700));
            }
        } else {
            // Scroll the sidebar to lazy-load older conversations
            const sidebarScrollable = document.querySelector(
                'nav, [class*="sidebar"], [data-testid*="sidebar"], aside'
            ) as HTMLElement | null;
            if (sidebarScrollable) {
                let prevCount = 0;
                let stableRounds = 0;
                for (let i = 0; i < 15; i++) {
                    sidebarScrollable.scrollTop = sidebarScrollable.scrollHeight;
                    await new Promise(r => setTimeout(r, 650));
                    const count = document.querySelectorAll('a[href*="/chat/"], a[href*="/c/"]').length;
                    if (count === prevCount) {
                        if (++stableRounds >= 2) break;
                    } else {
                        stableRounds = 0;
                    }
                    prevCount = count;
                }
                sidebarScrollable.scrollTop = 0;
            }
        }

        const anchors = Array.from(document.querySelectorAll('a[href*="/chat/"], a[href*="/c/"], a[data-testid*="conversation"], a[class*="conversation"], [data-testid*="chat-item"] a')) as HTMLAnchorElement[];

        for (const link of anchors) {
            const rawHref = link.getAttribute('href') || '';
            if (!rawHref || rawHref.startsWith('javascript:')) continue;

            const href = rawHref.startsWith('http') ? rawHref : `${window.location.origin}${rawHref}`;
            const id = href;

            let title = link.innerText?.trim() || link.textContent?.trim() || '';
            if (!title && link.getAttribute('aria-label')) {
                title = link.getAttribute('aria-label')!.trim();
            }
            if (!title) title = 'Untitled';

            if (items.find(i => i.id === id)) continue;
            items.push({ id, title, url: href });
        }

        return items;
    }

    async loadConversation(id: string): Promise<boolean> {
        if (window.location.href.includes(id)) {
            return true;
        }

        const sidebarLink = document.querySelector(`a[href*="${id}"]`) as HTMLElement | null;
        if (sidebarLink) {
            sidebarLink.click();
            return true;
        }

        try {
            window.location.href = id;
            return true;
        } catch {
            return false;
        }
    }

    getProvenance(): Provenance {
        // Look for model indicator
        const modelEl = queryWithFallbacks(document, this.selectors.modelIndicator ?? '');
        const modelText = modelEl?.textContent?.toLowerCase()?.trim() ?? '';
        console.log('Bonsai: Detected model text:', modelText);

        let model: string | undefined;
        let confidence: Provenance['confidence'] = 'unknown';

        if (modelText) {
            const versionMatch = modelText.match(/(\d+(\.\d+)?)/);
            const version = versionMatch ? versionMatch[0] : '';

            if (modelText.includes('opus')) {
                model = version ? `claude-${version}-opus` : 'claude-3-opus';
                confidence = 'observed';
            } else if (modelText.includes('sonnet')) {
                model = version ? `claude-${version}-sonnet` : 'claude-3.5-sonnet';
                confidence = 'observed';
            } else if (modelText.includes('haiku')) {
                model = version ? `claude-${version}-haiku` : 'claude-3-haiku';
                confidence = 'observed';
            } else if (modelText.includes('claude')) {
                model = modelText.replace(/\s+/g, '-');
                confidence = 'inferred';
            }
        }

        if (!model) {
            const bodyText = document.body.innerText ?? document.body.textContent ?? '';
            const match = bodyText.match(/(Sonnet|Haiku|Opus)\s+(\d+(\.\d+)?)/i);
            if (match) {
                const variant = match[1].toLowerCase();
                const ver = match[2];
                model = `claude-${ver}-${variant}`;
                confidence = 'inferred';
            }
        }

        if (!model) {
            model = 'Claude';
            confidence = 'inferred';
        }

        return {
            provider: 'anthropic',
            model,
            confidence
        };
    }

    sendToAI(text: string): boolean {
        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (!input) return false;

        if (input.getAttribute('contenteditable')) {
            // ProseMirror-style editor
            input.innerHTML = `<p>${text}</p>`;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        } else if (input instanceof HTMLTextAreaElement) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        return true;
    }
}

// Auto-register
if (typeof window !== 'undefined') {
    const adapter = new ClaudeAdapter();
    (window as any).__bonsaiAdapter = adapter;
    captureEngine.setAdapter(adapter);
    console.log('Bonsai: ClaudeAdapter registered with engine');

    // Initialize DOM injector
    import('../dom-injector').then(({ domInjector }) => {
        domInjector.start();
        console.log('Bonsai: DOM Injector started for Claude');
    });
}

// Initialize message handler
import '../message-handler';

export default ClaudeAdapter;
