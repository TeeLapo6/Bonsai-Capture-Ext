/**
 * Gemini Adapter
 * 
 * Captures conversations from gemini.google.com
 */

import { BaseAdapter, ParsedConversation, SidebarItem } from './interface';
import {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ContentBlock,
    createMessageNode,
    createHtmlBlock,
    createMarkdownBlock,
    createCodeBlock
} from '../../shared/schema';
import { getSelectorsForSite, queryWithFallbacks, queryAllWithFallbacks } from '../../config/selectors';

export class GeminiAdapter extends BaseAdapter {
    readonly providerName = 'Google';
    readonly providerSite = 'gemini.google.com';

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

    private get selectors() {
        return getSelectorsForSite('gemini.google.com')!;
    }

    detectConversation(): ParsedConversation | null {
        const container = queryWithFallbacks(document, this.selectors.conversationContainer);
        if (!container) return null;

        return {
            url: window.location.href,
            container,
            title: document.title.replace(' - Gemini', '').trim() || undefined
        };
    }

    listMessages(): Element[] {
        const conversation = this.detectConversation();
        if (!conversation) return [];

        const containers = Array.from(conversation.container.querySelectorAll('.conversation-container'))
            .filter((container): container is Element => container instanceof Element);

        if (containers.length > 0) {
            const messages: Element[] = [];

            containers.forEach((container) => {
                const directChildren = Array.from(container.children).filter(
                    (child): child is Element => child instanceof Element
                );
                const userQuery = directChildren.find((child) => child.tagName.toLowerCase() === 'user-query');
                const modelResponse = directChildren.find((child) => child.tagName.toLowerCase() === 'model-response');

                if (userQuery && this.isLikelyMessageTurn(userQuery)) {
                    messages.push(userQuery);
                }

                if (modelResponse && this.isLikelyMessageTurn(modelResponse)) {
                    messages.push(modelResponse);
                }
            });

            if (messages.length > 0) {
                return messages;
            }
        }

        const candidates = queryAllWithFallbacks(conversation.container, this.selectors.messageBlock)
            .filter((el) => this.isLikelyMessageTurn(el))
            // Exclude nested quote-card elements: reject any element that is
            // a descendant of another user-query or model-response.
            .filter((el) => {
                const parent = el.parentElement?.closest('user-query, model-response');
                return !parent;
            });
        return candidates;
    }

    parseMessage(el: Element, sequence: number): MessageNode {
        const role = this.detectRole(el);
        const contentBlocks = this.parseContentBlocks(el, role);

        const message = createMessageNode(
            role,
            sequence,
            contentBlocks,
            this.getDeepLink(el),
            role === 'assistant' ? this.getProvenance() : undefined
        );

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

    private getTurnContainer(el: Element): Element | null {
        return el.classList.contains('conversation-container') ? el : el.closest('.conversation-container');
    }

    private isGeminiArtifactScopedElement(el: Element | null): boolean {
        if (!el) {
            return false;
        }

        return el.closest(
            '[data-test-id="container"].container.clickable, immersive-entry-chip, immersive-entry-chip-content, deep-research-entry-chip-content, deep-research-confirmation-widget, code-immersive-panel, immersive-panel, deep-research-immersive-panel, extended-response-panel'
        ) !== null;
    }

    private getPrimaryStructuredResponse(el: Element): Element | null {
        const candidates = Array.from(
            el.querySelectorAll(
                'structured-content-container message-content .markdown, structured-content-container .markdown, message-content .markdown'
            )
        )
            .filter((candidate): candidate is Element => candidate instanceof Element)
            // Exclude .markdown nodes inside nested quote-card responses
            .filter((candidate) => {
                const nestedParent = candidate.closest('user-query, model-response');
                // The candidate's closest message-turn ancestor should be `el` itself,
                // not some nested quoted message turn.
                return !nestedParent || nestedParent === el || el.contains(nestedParent) && !nestedParent.parentElement?.closest('user-query, model-response');
            })
            .filter(
                (candidate, _index, all) => !all.some((parent) => parent !== candidate && parent.contains(candidate))
            )
            // Exclude .markdown nodes inside canvas chips or open panels — those are artifact
            // descriptions, not the primary prose response. Selecting them would make the
            // length-sort pick chip/panel text over the real message text.
            .filter((candidate) => !this.isGeminiArtifactScopedElement(candidate))
            .map((candidate) => ({
                candidate,
                text: this.sanitizeMessageText((candidate.textContent || '').replace(/\s+/g, ' ').trim()).trim(),
            }))
            .filter((candidate) => candidate.text.length > 0)
            .sort((left, right) => right.text.length - left.text.length);

        return candidates[0]?.candidate ?? null;
    }

    private hasMeaningfulAssistantContent(el: Element): boolean {
        if (this.getPrimaryStructuredResponse(el)) {
            return true;
        }

        if (el.querySelector('code-block, pre, img, deep-research-confirmation-widget, deep-research-entry-chip-content, table-block')) {
            return true;
        }

        const text = this.sanitizeMessageText((el.textContent || '').replace(/\s+/g, ' ').trim())
            .replace(/^(show thinking\s+)?gemini said:?\s*/i, '')
            .trim();

        return text.length > 0;
    }

    private isLikelyMessageTurn(el: Element): boolean {
        if (!el.isConnected) return false;

        const tagName = el.tagName.toLowerCase();
        if (['header', 'footer', 'nav', 'aside', 'form'].includes(tagName)) return false;

        const className = (el.className || '').toLowerCase();
        if (className.includes('artifact') || className.includes('research') || className.includes('canvas')) return false;

        const dataTestId = (el.getAttribute('data-testid') || '').toLowerCase();
        if (dataTestId.includes('artifact') || dataTestId.includes('research') || dataTestId.includes('canvas')) return false;

        const turnContainer = this.getTurnContainer(el);
        if (turnContainer) {
            const modelResponse = Array.from(turnContainer.children)
                .find((child): child is Element => child instanceof Element && child.tagName.toLowerCase() === 'model-response');

            if (modelResponse && !this.hasMeaningfulAssistantContent(modelResponse)) {
                return false;
            }
        }

        if (tagName === 'user-query') {
            const text = this.sanitizeMessageText((el.textContent || '').trim());
            return text.length > 0;
        }

        if (tagName === 'model-response') {
            return this.hasMeaningfulAssistantContent(el);
        }

        const text = (el.textContent || '').trim();
        if (text.length < 10) return false;

        const childMessage = el.querySelector('user-query, model-response, .markdown, .query-text, .response-text');
        return Boolean(childMessage);
    }

    private parseContentBlocks(el: Element, role: 'user' | 'assistant'): ContentBlock[] {
        // Selectors for Gemini immersive/chip elements that should never appear in message text
        const chipSelectors = [
            'immersive-entry-chip',
            'immersive-entry-chip-content',
            'deep-research-entry-chip-content',
            'deep-research-confirmation-widget',
            '[data-test-id="container"].container.clickable',
        ].join(', ');

        if (role === 'assistant') {
            const structured = this.getPrimaryStructuredResponse(el);

            if (structured) {
                const html = this.sanitizeRichHtml(structured, {
                    removeSelectors: [
                        'sources-carousel-inline', 'source-inline-chip', 'sources-list',
                        // Strip canvas/chip elements so their descriptions don't leak into prose
                        'immersive-entry-chip', 'immersive-entry-chip-content',
                        'deep-research-entry-chip-content', 'deep-research-confirmation-widget',
                        '[data-test-id="container"]',
                    ]
                });

                if (html) {
                    return [createHtmlBlock(html)];
                }
            }
        }

        const blocks: ContentBlock[] = [];

        // 1. Mark and Extract Code Blocks
        const codeBlocks = this.extractCodeBlocks(el);

        // 2. Clone content for text extraction
        const contentArea = Array.from(el.querySelectorAll('.markdown, message-content, .query-text'))
            .find((candidate): candidate is Element => candidate instanceof Element && !this.isGeminiArtifactScopedElement(candidate))
            ?? el;
        const clone = contentArea.cloneNode(true) as Element;

        // Cleanup noise — including chip/immersive elements whose text must not bleed into prose
        clone.querySelectorAll(`style, script, link, meta, noscript, .sr-only, .bonsai-insert-btn, ${chipSelectors}`).forEach(el => el.remove());

        // 3. Replace marked code blocks with Placeholders
        // Note: Gemini uses `code-block` or `pre code`.
        // extractCodeBlocks logic likely targets these.
        // We need to replace them in the clone.
        const codeEls = clone.querySelectorAll('pre, code-block, .code-block');
        codeEls.forEach((pre, idx) => {
            const placeholder = document.createTextNode(`\n\n<<<BONSAI_CODE_BLOCK_${idx}>>>\n\n`);
            pre.parentNode?.replaceChild(placeholder, pre);
        });

        // 4. Get text using recursive walker to guarantee newlines
        // We bypass htmlToMarkdown and go straight to text extraction to be consistent with Claude/ChatGPT
        // and avoid fragile regex replacements.
        const rawText = this.getTextContentPreservingLines(clone);

        // Normalize
        let textContent = rawText.replace(/\n{3,}/g, '\n\n').trim();

        // 5. Remove chat quote markers and source prefix e.g., 'You said'
        textContent = this.sanitizeMessageText(textContent);

        // 6. Escape Asterisks
        textContent = textContent.replace(/\*/g, '\u2217');

        // 6. Split and Reassemble
        const parts = textContent.split(/<<<BONSAI_CODE_BLOCK_(\d+)>>>/);

        parts.forEach((part, i) => {
            if (i % 2 === 0) {
                // Text
                const text = part.trim();
                if (text) {
                    // Basic markdown blocks
                    blocks.push(createMarkdownBlock(text));
                }
            } else {
                // Code Index
                const blockIndex = parseInt(part, 10);
                const cb = codeBlocks[blockIndex];
                if (cb) {
                    blocks.push(createCodeBlock(cb.code, cb.language));
                }
            }
        });

        // Fallback if empty
        if (blocks.length === 0 && codeBlocks.length > 0) {
            codeBlocks.forEach(cb => blocks.push(createCodeBlock(cb.code, cb.language)));
        }

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

        let text = '';

        for (const child of Array.from(node.childNodes)) {
            text += this.getTextContentPreservingLines(child);
        }

        // Add newlines AFTER block elements
        const requestNewline = ['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'user-query', 'model-response'].includes(tagName);
        if (requestNewline) {
            text += '\n';
            if (tagName === 'p' || tagName === 'br') text += '\n';
        }

        return text;
    }

    /**
     * Convert HTML to basic markdown (preserving links, bold, italic, lists)
     */
    private htmlToMarkdown(el: Element): string {
        const html = el.innerHTML;

        let md = html
            // Links
            .replace(/<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)')
            // Bold
            .replace(/<(strong|b)>/gi, '**').replace(/<\/(strong|b)>/gi, '**')
            // Italic
            .replace(/<(em|i)>/gi, '*').replace(/<\/(em|i)>/gi, '*')
            // Line breaks
            .replace(/<br\s*\/?>/gi, '\n')
            // Paragraphs
            .replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '')
            // List items
            .replace(/<li[^>]*>/gi, '- ').replace(/<\/li>/gi, '\n')
            // Remove list wrappers
            .replace(/<\/?[ou]l[^>]*>/gi, '\n')
            // Headers
            .replace(/<h1[^>]*>/gi, '# ').replace(/<\/h1>/gi, '\n')
            .replace(/<h2[^>]*>/gi, '## ').replace(/<\/h2>/gi, '\n')
            .replace(/<h3[^>]*>/gi, '### ').replace(/<\/h3>/gi, '\n')
            // Strip remaining HTML tags
            .replace(/<[^>]+>/g, '')
            // Decode entities
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            // Clean up whitespace
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return md;
    }

    private getGeminiImmersiveEntryRoots(root: ParentNode = document): Element[] {
        const candidates = Array.from(
            root.querySelectorAll('immersive-entry-chip, immersive-entry-chip-content, deep-research-entry-chip-content, deep-research-confirmation-widget, [data-test-id="container"].container.clickable')
        ).filter((candidate): candidate is Element => candidate instanceof Element);

        const roots = candidates.map((candidate) => {
            if (candidate.matches('[data-test-id="container"].container.clickable')) {
                return candidate;
            }

            return candidate.closest('immersive-entry-chip, [data-test-id="container"].container.clickable, response-element, article, section') ?? candidate;
        });

        const filtered = roots
            .filter((candidate, index, all) => all.indexOf(candidate) === index)
            .filter((candidate) => this.isVisibleElement(candidate))
            .filter((candidate) => candidate.matches('[data-test-id="container"].container.clickable')
                || candidate.classList.contains('is-open')
                || candidate.querySelector('button[aria-label*="Open"][aria-label*="Canvas"], deep-research-entry-chip-content, deep-research-confirmation-widget, [data-test-id="artifact-text"]') !== null);

        // When scoped to a specific message element (not the whole document), apply smart
        // prioritisation so the "See appendix" section chips don't flood single-message captures.
        if (!(root instanceof Document)) {
            // 1. If any chip is currently marked open, the user is actively viewing it — capture ONLY those.
            const openChips = filtered.filter((c) => c.classList.contains('is-open'));
            if (openChips.length > 0) {
                return openChips;
            }

            // 2. No chip is open: return only canvas-card chips (code artifacts generated by this
            //    response). Skip deep-research and other supplementary chips which are typically
            //    cross-message references shown in the appendix section.
            return filtered.filter((c) => c.matches('[data-test-id="container"].container.clickable'));
        }

        return filtered;
    }

    private getGeminiImmersiveOpenButton(root: Element): HTMLElement | null {
        const candidates = [
            root,
            ...Array.from(root.querySelectorAll('button, [role="button"], a')),
        ].filter((candidate): candidate is Element => candidate instanceof Element);

        return (candidates.find((candidate) => {
            if (!this.isVisibleElement(candidate)) {
                return false;
            }

            const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`.replace(/\s+/g, ' ').trim();
            return /\bopen\b/i.test(label) && /immersive|canvas|research|response|artifact/i.test(label);
        }) as HTMLElement | undefined) ?? null;
    }

    private normalizeGeminiTitle(value: string | null | undefined): string {
        return this.cleanArtifactText(value ?? '').toLowerCase();
    }

    private geminiTitlesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
        const normalizedLeft = this.normalizeGeminiTitle(left);
        const normalizedRight = this.normalizeGeminiTitle(right);

        if (!normalizedLeft || !normalizedRight) {
            return false;
        }

        return normalizedLeft === normalizedRight
            || normalizedLeft.includes(normalizedRight)
            || normalizedRight.includes(normalizedLeft);
    }

    private getGeminiImmersiveCloseButton(panelRoot: Element): HTMLElement | null {
        const panelContainer = panelRoot.closest('chat-window.immersives-mode, [role="dialog"], body') ?? document.body;
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

    private async closeGeminiImmersivePanel(panelRoot: Element | null): Promise<boolean> {
        if (!panelRoot) {
            return true;
        }

        const closeButton = this.getGeminiImmersiveCloseButton(panelRoot);
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

    private getGeminiImmersivePanelRoot(expectedTitle?: string): Element | null {
        const selectors = [
            'chat-window.immersives-mode code-immersive-panel',
            'chat-window.immersives-mode immersive-panel',
            'chat-window.immersives-mode deep-research-immersive-panel',
            'chat-window.immersives-mode extended-response-panel',
            'chat-window.immersives-mode immersive-editor',
            'code-immersive-panel',
            'deep-research-immersive-panel',
            'extended-response-panel',
            'immersive-editor',
            // Note: bare '.markdown-main-panel' intentionally omitted — it matches regular
            // chat message areas and causes the wrong element to be captured as the panel.
        ];

        const candidates = selectors
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .filter((candidate): candidate is Element => {
                if (!(candidate instanceof Element) || !this.isVisibleElement(candidate)) {
                    return false;
                }

                const text = this.cleanArtifactText(candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '');
                return text.length > 80;
            });

        if (!expectedTitle) {
            return candidates[0] ?? null;
        }

        return candidates.find((candidate) => this.geminiTitlesMatch(this.getGeminiPanelTitle(candidate), expectedTitle))
            ?? candidates[0]
            ?? null;
    }

    private isGeminiCodePanel(panelRoot: Element): boolean {
        const tagName = panelRoot.tagName.toLowerCase();
        return tagName === 'code-immersive-panel'
            || panelRoot.querySelector('code-immersive-panel, .monaco-editor, .view-lines') !== null;
    }

    private getGeminiImmersiveContentRoot(panelRoot: Element): Element {
        const codeContent = panelRoot.querySelector(
            'code-immersive-panel .view-lines, code-immersive-panel .monaco-scrollable-element.editor-scrollable, .monaco-editor .view-lines, .monaco-scrollable-element.editor-scrollable .view-lines'
        );

        if (codeContent instanceof Element) {
            return codeContent;
        }

        return (panelRoot.querySelector('immersive-editor, .markdown-main-panel, .markdown, response-container, div[contenteditable="true"]') ?? panelRoot) as Element;
    }

    private parseMonacoLineOffset(line: Element): number | null {
        const style = line.getAttribute('style') ?? '';
        const topMatch = style.match(/top:\s*(-?[\d.]+)px/i);
        if (topMatch) {
            return Number(topMatch[1]);
        }

        const transform = (line as HTMLElement).style.transform ?? '';
        const transformMatch = transform.match(/translate(?:3d|Y)?\([^,]*,\s*(-?[\d.]+)px/i);
        if (transformMatch) {
            return Number(transformMatch[1]);
        }

        return null;
    }

    private collectRenderedMonacoLines(panelRoot: Element, linesByOffset: Map<number, string>): void {
        const renderedLines = Array.from(panelRoot.querySelectorAll('.view-lines .view-line'));

        renderedLines.forEach((line) => {
            if (!(line instanceof Element)) {
                return;
            }

            const offset = this.parseMonacoLineOffset(line);
            if (offset === null) {
                return;
            }

            const text = (line.textContent ?? '')
                .replace(/\u00a0/g, ' ')
                .replace(/\u200b/g, '');

            linesByOffset.set(offset, text.trim().length === 0 ? '' : text);
        });
    }

    private async getMonacoScrollableContent(panelRoot: Element): Promise<string | null> {
        const scroller = panelRoot.querySelector('.monaco-scrollable-element.editor-scrollable, .monaco-scrollable-element') as HTMLElement | null;
        if (!scroller) {
            return null;
        }

        const originalScrollTop = scroller.scrollTop;
        const originalScrollBehavior = scroller.style.scrollBehavior;
        const step = Math.max(Math.floor(scroller.clientHeight * 0.6), 120);
        const linesByOffset = new Map<number, string>();

        try {
            scroller.style.scrollBehavior = 'auto';
            scroller.scrollTop = 0;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            await this.delay(80);
            this.collectRenderedMonacoLines(panelRoot, linesByOffset);

            let safetyPass = 0;
            let stagnantPasses = 0;
            let previousLineCount = linesByOffset.size;

            while (safetyPass < 200) {
                const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                const currentScrollTop = scroller.scrollTop;

                if (maxScrollTop <= 0 || currentScrollTop >= maxScrollTop - 2) {
                    break;
                }

                const nextScrollTop = Math.min(currentScrollTop + step, maxScrollTop);
                if (nextScrollTop <= currentScrollTop + 1) {
                    break;
                }

                scroller.scrollTop = nextScrollTop;
                scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
                await this.delay(50);
                this.collectRenderedMonacoLines(panelRoot, linesByOffset);

                const actualScrollTop = scroller.scrollTop;
                const currentLineCount = linesByOffset.size;

                if (actualScrollTop <= currentScrollTop + 1 && currentLineCount <= previousLineCount) {
                    stagnantPasses += 1;
                    if (stagnantPasses >= 3) {
                        break;
                    }
                } else {
                    stagnantPasses = 0;
                }

                previousLineCount = currentLineCount;
                safetyPass += 1;
            }
        } finally {
            scroller.style.scrollBehavior = originalScrollBehavior;
            scroller.scrollTop = originalScrollTop;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        }

        if (linesByOffset.size === 0) {
            return null;
        }

        return Array.from(linesByOffset.entries())
            .sort((left, right) => left[0] - right[0])
            .map(([, line]) => line)
            .join('\n');
    }

    /**
     * Extract the full source text from a Monaco editor panel.
     *
     * First try the page-level Monaco model if it is exposed. Gemini often blocks inline
     * script execution via CSP, so we also fall back to DOM-based scrolling capture across
     * Monaco's virtualized viewport.
     */
    private async getMonacoFullContent(panelRoot: Element): Promise<string | null> {
        const monacoContainer = panelRoot.querySelector('.monaco-editor');
        if (!monacoContainer) {
            return null;
        }

        const eventName = `__bonsai_monaco_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        const fromPage = await new Promise<string | null>((resolve) => {
            const handler = (e: Event) => {
                document.removeEventListener(eventName, handler);
                clearTimeout(timer);
                resolve((e as CustomEvent<string | null>).detail ?? null);
            };

            document.addEventListener(eventName, handler);

            // Fallback: resolve null if the page script doesn't respond in 1 s
            const timer = setTimeout(() => {
                document.removeEventListener(eventName, handler);
                resolve(null);
            }, 1000);

            // Script runs in the page's JS context and therefore has access to window.monaco
            const script = document.createElement('script');
            script.textContent = [
                '(function(){',
                '  try {',
                '    var editors = window.monaco && window.monaco.editor && typeof window.monaco.editor.getEditors === "function"',
                '      ? window.monaco.editor.getEditors()',
                '      : [];',
                '    var value = editors.length > 0 ? (editors[0].getModel && editors[0].getModel() ? editors[0].getModel().getValue() : null) : null;',
                '    document.dispatchEvent(new CustomEvent(' + JSON.stringify(eventName) + ', { detail: value }));',
                '  } catch(e) {',
                '    document.dispatchEvent(new CustomEvent(' + JSON.stringify(eventName) + ', { detail: null }));',
                '  }',
                '})();',
            ].join('\n');

            (document.head ?? document.documentElement).appendChild(script);
            script.remove();
        });

        if (fromPage && fromPage.trim().length > 0) {
            return fromPage;
        }

        return this.getMonacoScrollableContent(panelRoot);
    }

    private getGeminiArtifactTitle(root: Element): string {
        const explicitTitle = root.querySelector('[data-test-id="artifact-text"], [data-test-id="title"], [data-test-id="title-text"], .title-text, [role="heading"], h1, h2, h3, strong')
            ?.textContent
            ?.trim();

        if (explicitTitle) {
            return this.cleanArtifactText(explicitTitle);
        }

        const openLabel = root.querySelector('button[aria-label*="Open"][aria-label*="Canvas"]')?.getAttribute('aria-label')
            ?? root.getAttribute('aria-label')
            ?? '';

        return this.cleanArtifactText(
            openLabel
                .replace(/^open\s+/i, '')
                .replace(/\s+in\s+canvas$/i, '')
                .trim()
        );
    }

    private getGeminiPanelTitle(panelRoot: Element | null): string {
        if (!panelRoot) {
            return '';
        }

        return this.cleanArtifactText(
            panelRoot.querySelector('[data-test-id="artifact-text"], [data-test-id="title"], [data-test-id="title-text"], .title-text, [role="heading"], h1, h2, h3, strong')
                ?.textContent
                ?.trim()
            ?? ''
        );
    }

    private async captureGeminiImmersiveArtifact(root: Element): Promise<ArtifactNode | null> {
        const openButton = this.getGeminiImmersiveOpenButton(root);
        const expectedTitle = this.getGeminiArtifactTitle(root);
        const chip = root.matches('[data-test-id="container"].container.clickable, immersive-entry-chip')
            ? root
            : root.querySelector('[data-test-id="container"].container.clickable, immersive-entry-chip');
        const existingPanel = this.getGeminiImmersivePanelRoot();
        const reuseExistingPanel = Boolean(existingPanel && this.geminiTitlesMatch(this.getGeminiPanelTitle(existingPanel), expectedTitle));

        let openedPanelForCapture = false;
        let closedConflictingPanel = false;
        let panelRoot: Element | null = reuseExistingPanel ? existingPanel : null;

        if (!reuseExistingPanel && existingPanel) {
            await this.closeGeminiImmersivePanel(existingPanel);
            closedConflictingPanel = true;
            await this.delay(120);
        }

        if (!panelRoot) {
            const clickTarget = openButton ?? (chip as HTMLElement | null);
            if (!clickTarget) {
                return null;
            }

            clickTarget.click();
            openedPanelForCapture = true;
        }

        try {
            for (let attempt = 0; attempt < 15; attempt += 1) {
                panelRoot = this.getGeminiImmersivePanelRoot(expectedTitle);
                if (panelRoot) {
                    const panelTitle = this.getGeminiPanelTitle(panelRoot);

                    if (!expectedTitle || !panelTitle || this.geminiTitlesMatch(panelTitle, expectedTitle)) {
                        break;
                    }
                }

                if (attempt < 14) {
                    panelRoot = null;
                }

                if (panelRoot) {
                    break;
                }

                await this.delay(200);
            }

            if (!panelRoot) {
                return null;
            }

            const contentRoot = this.getGeminiImmersiveContentRoot(panelRoot);
            const isCodeArtifact = this.isGeminiCodePanel(panelRoot)
                || root.querySelector('mat-icon[fonticon="code_blocks"], mat-icon[data-mat-icon-name="code_blocks"], [data-mat-icon-name="code_blocks"]') !== null;

            // For code artifacts, try to read full content from the Monaco editor model (page JS context)
            // before falling back to DOM text extraction (which only captures visible virtual-scroll lines).
            let codeContent: string | null = null;
            if (isCodeArtifact) {
                codeContent = await this.getMonacoFullContent(panelRoot);
            }

            const structuredHtml = !isCodeArtifact
                ? this.sanitizeRichHtml(contentRoot, {
                    removeSelectors: ['sources-carousel-inline', 'source-inline-chip', 'sources-list', 'button', '[role="button"]', '.bonsai-insert-btn'],
                })
                : '';
            // For code, do NOT run cleanArtifactText — it strips words like "open"/"source"/"copy"
            // that may appear legitimately in code. For prose artifacts, clean is still needed.
            const content = isCodeArtifact
                ? (codeContent ?? this.getTextContentPreservingLines(contentRoot).replace(/\n{3,}/g, '\n\n').trim())
                : this.cleanArtifactText(this.getTextContentPreservingLines(contentRoot).replace(/\n{3,}/g, '\n\n').trim());
            if (!structuredHtml && this.isNoiseOnlyArtifactText(content)) {
                return null;
            }

            // Do NOT include root.textContent in the descriptor — it contains the surrounding message
            // text which often includes "research" contextually, causing canvas artifacts to be
            // misclassified as deep_research.
            const descriptor = `${root.tagName} ${root.className || ''} ${root.getAttribute('data-test-id') || ''} ${panelRoot.tagName} ${panelRoot.className || ''}`.toLowerCase();
            const isPanelDeepResearch = panelRoot.tagName.toLowerCase() === 'deep-research-immersive-panel';
            const isChipDeepResearch = root.querySelector('deep-research-entry-chip-content, deep-research-confirmation-widget') !== null;
            const type: ArtifactNode['type'] = isCodeArtifact
                ? 'code_artifact'
                : isPanelDeepResearch || isChipDeepResearch || /deep.?research/.test(descriptor)
                    ? 'deep_research'
                    : 'artifact_doc';
            const title = this.cleanArtifactText(
                panelRoot.querySelector('[data-test-id="title"], [data-test-id="title-text"], [data-test-id="artifact-text"], .title-text, [role="heading"], h1, h2, h3, strong')
                    ?.textContent?.trim()
                || root.querySelector('[data-test-id="title"], [data-test-id="title-text"], [data-test-id="artifact-text"], .title-text, [role="heading"], h1, h2, h3, strong')
                    ?.textContent?.trim()
                || root.getAttribute('aria-label')?.trim()
                || (type === 'deep_research' ? 'Deep Research' : 'Immersive Artifact')
            ) || (type === 'deep_research' ? 'Deep Research' : 'Immersive Artifact');
            const { viewUrl, sourceUrl } = this.extractArtifactLinks(panelRoot);

            return {
                artifact_id: crypto.randomUUID(),
                type,
                title,
                content: structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? structuredHtml
                    : (content || title),
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl ?? window.location.href,
                exportable: true,
                mime_type: structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? 'text/html'
                    : type === 'deep_research'
                        ? 'text/markdown'
                        : 'text/plain',
            };
        } finally {
            if (panelRoot && (openedPanelForCapture || closedConflictingPanel)) {
                await this.closeGeminiImmersivePanel(panelRoot);
            }
        }
    }

    private detectRole(el: Element): 'user' | 'assistant' {
        const tagName = el.tagName.toLowerCase();
        if (tagName === 'user-query') return 'user';
        if (tagName === 'model-response') return 'assistant';

        const classList = el.className.toLowerCase();
        if (classList.includes('user') || classList.includes('query')) return 'user';
        if (classList.includes('response') || classList.includes('model')) return 'assistant';

        const messages = this.listMessages();
        return messages.indexOf(el) % 2 === 0 ? 'user' : 'assistant';
    }

    async parseArtifacts(el: Element): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];
        const seenContent = new Set<string>();

        for (const root of this.getGeminiImmersiveEntryRoots(el)) {
            const artifact = await this.captureGeminiImmersiveArtifact(root);
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

        const images = el.querySelectorAll('img');

        for (const [idx, imgEl] of Array.from(images).entries()) {
            const img = imgEl as HTMLImageElement;
            const alt = img.getAttribute('alt') || '';
            const src = img.src;

            if (!src) continue;
            const viewUrl = this.extractArtifactViewUrl(img);

            if (img.width > 0 && img.width < 50 && img.height > 0 && img.height < 50) {
                continue;
            }
            if (src.includes('profile_photo') || src.includes('avatar') || img.classList.contains('avatar')) {
                continue;
            }

            let finalSrc = src;

            try {
                const dataUrl = await this.imageToDataUrl(img);
                if (dataUrl) {
                    finalSrc = dataUrl;
                }
            } catch (e) {
                console.error(`Gemini: Failed to convert image ${idx}:`, e);
            }

            if (seenContent.has(finalSrc)) {
                continue;
            }
            seenContent.add(finalSrc);

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'image',
                title: alt || 'Generated Image',
                mime_type: 'image/png',
                content: finalSrc,
                source_message_id: '',
                source_url: src,
                view_url: viewUrl,
                exportable: true
            });
        }

        return artifacts;
    }

    protected async parseVisibleArtifacts(): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];
        const seenContent = new Set<string>();

        const visiblePanels = Array.from(
            document.querySelectorAll('code-immersive-panel, immersive-panel, deep-research-immersive-panel, extended-response-panel, immersive-editor')
        ).filter((candidate): candidate is Element => candidate instanceof Element && this.isVisibleElement(candidate));

        for (const root of visiblePanels) {
            const descriptor = `${root.tagName} ${root.className || ''} ${root.getAttribute('data-test-id') || ''}`.toLowerCase();
            const contentRoot = this.getGeminiImmersiveContentRoot(root);
            const { viewUrl, sourceUrl } = this.extractArtifactLinks(contentRoot);
            let title = root.querySelector('[data-test-id="title"], [data-test-id="title-text"], .title-text, [role="heading"], h1, h2, h3, strong')
                ?.textContent?.trim()
                || root.getAttribute('aria-label')?.trim()
                || (/research|report|analysis/.test(descriptor) ? 'Deep Research' : 'Artifact');
            title = this.cleanArtifactText(title) || (/research|report|analysis/.test(descriptor) ? 'Deep Research' : 'Artifact');
            const svg = contentRoot.querySelector('svg');
            const canvas = contentRoot.querySelector('canvas');
            const isCodeArtifact = this.isGeminiCodePanel(root);
            let codeContent: string | null = null;
            if (isCodeArtifact) {
                codeContent = await this.getMonacoFullContent(root);
            }
            const structuredHtml = !isCodeArtifact && !contentRoot.matches('svg, canvas, iframe')
                ? this.sanitizeRichHtml(contentRoot, {
                    removeSelectors: ['.bonsai-insert-btn', '.bonsai-action-container', 'button', '[role="button"]']
                })
                : '';
            const content = isCodeArtifact
                ? (codeContent ?? this.getTextContentPreservingLines(contentRoot).replace(/\n{3,}/g, '\n\n').trim())
                : this.cleanArtifactText(this.getTextContentPreservingLines(contentRoot).replace(/\n{3,}/g, '\n\n').trim());
            const type: ArtifactNode['type'] = isCodeArtifact
                ? 'code_artifact'
                : /research|report|analysis|deep.?research/.test(descriptor)
                ? 'deep_research'
                : 'artifact_doc';
            const dedupeKey = `${type}|${title}|${viewUrl}|${content.slice(0, 200)}`;

            if (seenContent.has(dedupeKey) || (this.isNoiseOnlyArtifactText(content) && !viewUrl && !sourceUrl)) {
                continue;
            }

            seenContent.add(dedupeKey);

            if (svg) {
                artifacts.push({
                    artifact_id: `${crypto.randomUUID()}-svg`,
                    type: 'image',
                    title: title || 'Artifact image',
                    mime_type: 'image/svg+xml',
                    content: this.svgToDataUrl(svg as SVGSVGElement),
                    source_message_id: '',
                    source_url: sourceUrl,
                    view_url: viewUrl ?? window.location.href,
                    exportable: true
                });
            } else if (canvas) {
                const dataUrl = this.canvasToDataUrl(canvas as HTMLCanvasElement);
                if (dataUrl) {
                    artifacts.push({
                        artifact_id: `${crypto.randomUUID()}-canvas`,
                        type: 'image',
                        title: title || 'Artifact image',
                        mime_type: 'image/png',
                        content: dataUrl,
                        source_message_id: '',
                        source_url: sourceUrl,
                        view_url: viewUrl ?? window.location.href,
                        exportable: true
                    });
                }
            }

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type,
                title,
                content: structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? structuredHtml
                    : (content || title),
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl ?? window.location.href,
                exportable: true,
                mime_type: structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? 'text/html'
                    : type === 'deep_research'
                        ? 'text/markdown'
                        : 'text/plain'
            });
        }

        const visibleImages = Array.from(
            document.querySelectorAll('.canvas-container img, [class*="artifact"] img, [class*="research"] img')
        ).filter((img): img is HTMLImageElement => img instanceof HTMLImageElement && this.isVisibleElement(img));

        for (const img of visibleImages) {
            const alt = img.getAttribute('alt') || '';
            const src = img.src;
            if (!src || src.includes('profile_photo') || src.includes('avatar')) continue;

            let finalSrc = src;
            try {
                const dataUrl = await this.imageToDataUrl(img);
                if (dataUrl) {
                    finalSrc = dataUrl;
                }
            } catch {
                // Fall back to the original src.
            }

            const dedupeKey = `image|${finalSrc}`;
            if (seenContent.has(dedupeKey)) continue;
            seenContent.add(dedupeKey);

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'image',
                title: alt || 'Artifact image',
                mime_type: 'image/png',
                content: finalSrc,
                source_message_id: '',
                source_url: src,
                view_url: this.extractArtifactViewUrl(img) ?? window.location.href,
                exportable: true
            });
        }

        return artifacts;
    }

    private async imageToDataUrl(img: HTMLImageElement): Promise<string | null> {
        // 1. Try Canvas Capture with "Clean" Image (CORS-enabled)
        try {
            const cleanImg = new Image();
            cleanImg.crossOrigin = 'Anonymous';

            await new Promise((resolve, reject) => {
                cleanImg.onload = resolve;
                cleanImg.onerror = reject;
                cleanImg.src = img.src;
            });

            const canvas = document.createElement('canvas');
            canvas.width = cleanImg.naturalWidth;
            canvas.height = cleanImg.naturalHeight;
            const ctx = canvas.getContext('2d');

            if (ctx) {
                ctx.drawImage(cleanImg, 0, 0);
                return canvas.toDataURL('image/png');
            }
        } catch (e) {
            // Fallback
        }

        // 2. Try Fetch (fallback)
        try {
            const response = await fetch(img.src, { credentials: 'include', mode: 'cors' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const blob = await response.blob();
            return await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            // Fallback
        }

        // 3. Try Background Fetch (Final Resort - bypasses Page CSP/CORS)
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'FETCH_IMAGE_BLOB',
                url: img.src
            });

            if (response.dataUrl) {
                return response.dataUrl;
            }
        } catch (e) {
            // Failed
        }

        return null;
    }

    getDeepLink(el: Element): DeepLink {
        return { url: window.location.href };
    }

    async scanSidebar(): Promise<SidebarItem[]> {
        const items: SidebarItem[] = [];

        // Scroll the sidebar panel to lazy-load older conversations
        const sidebarScrollable = document.querySelector(
            'nav, mat-sidenav, [class*="sidebar"], [data-testid*="sidebar"], aside'
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

        const anchors = Array.from(document.querySelectorAll('a[href*="/chat/"], a[href*="/c/"], a[data-testid*="conversation"], a[class*="conversation"]')) as HTMLAnchorElement[];

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
        return {
            provider: 'google',
            model: 'gemini-pro',
            confidence: 'inferred'
        };
    }

    sendToAI(text: string): boolean {
        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (!input) return false;

        if (input.getAttribute('contenteditable')) {
            input.textContent = text;
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        return true;
    }
}

if (typeof window !== 'undefined') {
    (window as any).__bonsaiAdapter = new GeminiAdapter();
    console.log('[Bonsai Capture] Gemini adapter registered');

    Promise.all([
        import('../message-handler'),
        import('../dom-injector')
    ]).then(([_, { domInjector }]) => {
        console.log('[Bonsai Capture] Gemini message handler initialized');
        domInjector.start();
        console.log('[Bonsai Capture] Gemini DOM injector started');
    }).catch(err => {
        console.error('[Bonsai Capture] Failed to initialize:', err);
    });
}

export default GeminiAdapter;
