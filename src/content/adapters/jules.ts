/**
 * Jules Adapter
 *
 * Jules renders three lanes on the same page:
 * - the recent-session list on the left
 * - the active session thread in the center
 * - the review/code panel on the right
 *
 * The adapter anchors itself to the active composer so message capture only uses the
 * center lane and the right lane is exposed as visible artifacts.
 */

import { BaseAdapter, ParsedConversation } from './interface';
import {
    MessageNode,
    ArtifactNode,
    ContentBlock,
    DeepLink,
    Provenance,
    createMessageNode,
    createMarkdownBlock,
} from '../../shared/schema';
import { getSelectorsForSite, queryWithFallbacks } from '../../config/selectors';
import { ProviderRegistry } from './factory';

export class JulesAdapter extends BaseAdapter {
    readonly providerName = 'Jules';
    readonly providerSite = 'jules.google.com';

    /** Lazily cached sidebar container, detected by the "Recent sessions" heading. */
    private _cachedSidebar: Element | null | 'unset' = 'unset';

    private get selectors() {
        return getSelectorsForSite('jules.google.com')!;
    }

    private isVisibleElement(el: Element | null): el is HTMLElement {
        if (!(el instanceof HTMLElement)) {
            return false;
        }

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
    }

    private getClassName(el: Element | null): string {
        if (!el) {
            return '';
        }

        const rawClassName = (el as HTMLElement).className;
        return typeof rawClassName === 'string'
            ? rawClassName.toLowerCase()
            : String(rawClassName ?? '').toLowerCase();
    }

    private normalizeWhitespace(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }

    private getConversationTitle(): string | undefined {
        const title = document.title
            .replace(/\s*-\s*jules$/i, '')
            .replace(/^session\s*[-:]\s*/i, '')
            .trim();

        return title || undefined;
    }

    private getTextContentPreservingLines(root: Node): string {
        if (root.nodeType === Node.TEXT_NODE) {
            return root.textContent ?? '';
        }

        if (!(root instanceof Element)) {
            return '';
        }

        if (root.tagName === 'BR') {
            return '\n';
        }

        const BLOCK_TAGS = new Set([
            'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'PRE', 'CODE',
            'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'TH'
        ]);

        let text = '';
        root.childNodes.forEach((child) => {
            text += this.getTextContentPreservingLines(child);
        });

        if (BLOCK_TAGS.has(root.tagName)) {
            return `${text.trim()}\n`;
        }

        return text;
    }

    private getComposer(): HTMLElement | HTMLTextAreaElement | null {
        const candidates = Array.from(document.querySelectorAll(this.selectors.inputField))
            .filter((candidate): candidate is HTMLElement | HTMLTextAreaElement => this.isVisibleElement(candidate))
            .filter((candidate) => {
                const descriptor = this.normalizeWhitespace([
                    candidate.getAttribute('placeholder') ?? '',
                    candidate.getAttribute('aria-label') ?? '',
                    candidate.getAttribute('title') ?? '',
                    candidate.textContent ?? '',
                ].join(' ')).toLowerCase();

                return !/search|repo or sessions|recent sessions/.test(descriptor);
            })
            .sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                const leftScore = leftRect.top + leftRect.width;
                const rightScore = rightRect.top + rightRect.width;
                return rightScore - leftScore;
            });

        return candidates[0] ?? null;
    }

    private getComposerRect(): DOMRect | null {
        return this.getComposer()?.getBoundingClientRect() ?? null;
    }

    /**
     * Find Jules's left-sidebar container by locating the "Recent sessions" heading.
     * Cached after the first successful lookup.
     */
    private findSidebarContainer(): Element | null {
        if (this._cachedSidebar !== 'unset') return this._cachedSidebar;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const text = (node.textContent ?? '').trim();
                return /^recent sessions$/i.test(text)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            },
        });

        const textNode = walker.nextNode();
        if (textNode?.parentElement) {
            this._cachedSidebar =
                textNode.parentElement.closest('aside, nav, section, [role="navigation"], [role="complementary"]')
                ?? textNode.parentElement.parentElement?.parentElement
                ?? textNode.parentElement.parentElement;
        } else {
            this._cachedSidebar = null;
        }

        return this._cachedSidebar;
    }

    private isCenterLaneElement(el: Element): boolean {
        // Always reject semantic sidebar/nav regions.
        if (el.closest('aside, nav, header, [role="navigation"], [role="complementary"]')) {
            return false;
        }

        // Reject elements inside the Jules left sidebar (identified by "Recent sessions" heading).
        const sidebar = this.findSidebarContainer();
        if (sidebar?.contains(el)) {
            return false;
        }

        const composerRect = this.getComposerRect();
        if (!composerRect) {
            // Composer not yet found – fall back to containment within <main>.
            const mainEl = document.querySelector('main, [role="main"]');
            return !mainEl || mainEl.contains(el);
        }

        const rect = el.getBoundingClientRect();
        const horizontalPadding = Math.max(120, composerRect.width * 0.18);
        const laneLeft = composerRect.left - horizontalPadding;
        const laneRight = composerRect.right + horizontalPadding;
        const centerX = rect.left + (rect.width / 2);

        if (centerX < laneLeft || centerX > laneRight) {
            return false;
        }

        if (rect.top > composerRect.bottom + 80) {
            return false;
        }

        if (rect.width > window.innerWidth * 0.78) {
            return false;
        }

        return true;
    }

    private isRightLaneElement(el: Element): boolean {
        const composerRect = this.getComposerRect();
        if (!composerRect) {
            return false;
        }

        const rect = el.getBoundingClientRect();
        return rect.left >= composerRect.right + 24
            && rect.width >= 160
            && rect.top <= composerRect.bottom + 160;
    }

    private findConversationContainer(): Element | null {
        const composer = this.getComposer();
        if (!composer) {
            return queryWithFallbacks(document, 'main, [role="main"], body');
        }

        return composer.closest('main, [role="main"], section, article')
            ?? queryWithFallbacks(document, 'main, [role="main"], body');
    }

    private getMessageCandidateSelectors(): string {
        return '.task-container, [data-user], [data-task], .task-description';
    }

    private isLikelyMessageElement(el: Element): boolean {
        if (!this.isVisibleElement(el)) {
            return false;
        }

        if (!this.isCenterLaneElement(el)) {
            return false;
        }

        if (el.contains(this.getComposer())) {
            return false;
        }

        if (el.closest('aside, nav, header')) {
            return false;
        }

        const className = this.getClassName(el);
        if (/search|sidebar|session-list|recent-session/.test(className)) {
            return false;
        }

        const text = this.cleanArtifactText(this.getTextContentPreservingLines(el).replace(/\n{3,}/g, '\n\n').trim());
        if (text.length < 20) {
            return false;
        }

        if (/search for repo or sessions|recent sessions|daily session limit/i.test(text)) {
            return false;
        }

        return true;
    }

    /**
     * Walk the scroll container that holds the composer and collect
     * shallow block elements that look like task-event messages.
     * Used as a fallback when CSS-class-based selectors return nothing.
     */
    private listMessagesByStructure(): Element[] {
        const composer = this.getComposer();
        if (!composer) return [];

        // Walk up from composer to find its scrollable container.
        let scrollContainer: Element | null = null;
        let el: Element | null = composer.parentElement;

        while (el && el !== document.documentElement) {
            if (el instanceof HTMLElement) {
                const style = window.getComputedStyle(el);
                const oy = style.overflowY;
                if (
                    (oy === 'auto' || oy === 'scroll') &&
                    el.scrollHeight > el.clientHeight + 100
                ) {
                    scrollContainer = el;
                    break;
                }
            }
            el = el.parentElement;
        }

        if (!scrollContainer) {
            scrollContainer = composer.closest('main, [role="main"]');
        }
        if (!scrollContainer) return [];

        const results: Element[] = [];

        const collect = (parent: Element, depth: number) => {
            if (depth > 4) return;

            for (const child of Array.from(parent.children)) {
                // Descend into the branch that contains the composer, but don't collect it.
                if (child.contains(composer)) {
                    collect(child, depth + 1);
                    continue;
                }

                if (!this.isLikelyMessageElement(child)) {
                    // If this container has substantial text, try going one level deeper.
                    if (depth < 3 && (child.textContent?.trim().length ?? 0) > 100) {
                        collect(child, depth + 1);
                    }
                    continue;
                }

                results.push(child);
            }
        };

        collect(scrollContainer, 0);

        return results.sort((a, b) => {
            const ra = (a as HTMLElement).getBoundingClientRect();
            const rb = (b as HTMLElement).getBoundingClientRect();
            return ra.top - rb.top;
        });
    }

    private listMessageElements(root: Element): Element[] {
        const candidates = Array.from(root.querySelectorAll(this.getMessageCandidateSelectors()))
            .filter((candidate): candidate is Element => candidate instanceof Element)
            .map((candidate) => {
                const scopedAncestor = candidate.closest('.task-container, [data-user], [data-task]');
                return scopedAncestor instanceof Element ? scopedAncestor : candidate;
            })
            .filter((candidate, index, all) => all.indexOf(candidate) === index)
            .filter((candidate) => this.isLikelyMessageElement(candidate))
            .filter((candidate, _index, all) => !all.some((other) => {
                if (other === candidate || !candidate.contains(other)) {
                    return false;
                }

                return this.cleanArtifactText(other.textContent ?? '').length > 30;
            }))
            .sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                if (leftRect.top !== rightRect.top) {
                    return leftRect.top - rightRect.top;
                }

                return leftRect.left - rightRect.left;
            });

        if (candidates.length > 0) {
            return candidates;
        }

        // CSS selectors didn't match – fall back to structural scan.
        return this.listMessagesByStructure();
    }

    detectConversation(): ParsedConversation | null {
        const container = this.findConversationContainer();
        if (!container) {
            return null;
        }

        const messages = this.listMessageElements(container);
        const composer = this.getComposer();
        if (messages.length === 0 && !composer) {
            return null;
        }

        return {
            url: window.location.href,
            container,
            title: this.getConversationTitle(),
        };
    }

    listMessages(): Element[] {
        const container = this.findConversationContainer();
        if (!container) {
            return [];
        }

        return this.listMessageElements(container);
    }

    private buildStructuredText(root: Element): string {
        const clone = root.cloneNode(true) as Element;
        clone.querySelectorAll(
            '.bonsai-action-container, .bonsai-fallback-container, .bonsai-insert-btn, button, [role="button"]'
        ).forEach((node) => node.remove());

        const extractedCodeFences: string[] = [];
        clone.querySelectorAll('pre').forEach((pre) => {
            const codeEl = pre.querySelector('code');
            const language = this.detectCodeLanguage(codeEl ?? pre);
            const codeText = (codeEl ?? pre).textContent?.trim() ?? '';
            const fenceIndex = extractedCodeFences.length;
            extractedCodeFences.push(`\`\`\`${language}\n${codeText}\n\`\`\``);
            pre.replaceWith(document.createTextNode(`\n\n<<<BONSAI_CODE_${fenceIndex}>>>\n\n`));
        });

        let text = this.getTextContentPreservingLines(clone)
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        text = text.replace(/<<<BONSAI_CODE_(\d+)>>>/g, (_, index) => extractedCodeFences[Number(index)] ?? '');
        return this.cleanArtifactText(text);
    }

    private detectRole(el: Element): 'user' | 'assistant' {
        const className = this.getClassName(el);
        if (/user-task|user-prompt/.test(className) || el.matches('[data-user]')) {
            return 'user';
        }

        if (/jules-task|task-icon|status-awaiting-feedback/.test(className) || el.matches('[data-task]')) {
            return 'assistant';
        }

        const messages = this.listMessages();
        return messages.indexOf(el) % 2 === 0 ? 'user' : 'assistant';
    }

    parseMessage(el: Element, sequence: number): MessageNode {
        const role = this.detectRole(el);
        const contentBlocks: ContentBlock[] = [];
        const text = this.buildStructuredText(el);

        if (text) {
            contentBlocks.push(createMarkdownBlock(text));
        }

        const message = createMessageNode(
            role,
            sequence,
            contentBlocks.length > 0 ? contentBlocks : [createMarkdownBlock('')],
            this.getDeepLink(el),
            role === 'assistant' ? this.getProvenance() : undefined,
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

    parseArtifacts(_el: Element): ArtifactNode[] {
        return [];
    }

    private looksLikeFileArtifactTitle(title: string): boolean {
        return /(^|\/)[\w.-]+\.[a-z0-9]{1,8}$/i.test(title);
    }

    private extractJulesArtifactTitle(el: Element, text: string): string {
        const heading = this.cleanArtifactText(
            el.querySelector('h1, h2, h3, h4, strong, code, [role="heading"]')?.textContent?.trim()
            ?? ''
        );
        if (this.looksLikeFileArtifactTitle(heading)) {
            return heading;
        }

        const fileMatch = text.match(/([\w./-]+\.[a-z0-9]{1,8})/i);
        return this.cleanArtifactText(fileMatch?.[1] ?? heading ?? '');
    }

    private isJulesArtifactCandidate(el: Element): boolean {
        if (!this.isVisibleElement(el) || !this.isRightLaneElement(el)) {
            return false;
        }

        if (el.closest('.bonsai-action-container, .bonsai-fallback-container')) {
            return false;
        }

        const text = this.getTextContentPreservingLines(el).replace(/\n{3,}/g, '\n\n').trim();
        if (text.length < 20) {
            return false;
        }

        const title = this.extractJulesArtifactTitle(el, text);
        const normalized = this.normalizeWhitespace(text).toLowerCase();
        return this.looksLikeFileArtifactTitle(title)
            || /load file|large files are not shown|download zip/.test(normalized)
            || /(^|\n)\s*[+-]/m.test(text);
    }

    private getVisibleArtifactCards(): Element[] {
        const rawCandidates = Array.from(document.querySelectorAll('main article, main section, main li, main div, main button, main [role="button"]'))
            .filter((candidate): candidate is Element => candidate instanceof Element)
            .filter((candidate) => this.isJulesArtifactCandidate(candidate));

        return rawCandidates
            .filter((candidate, index, all) => all.indexOf(candidate) === index)
            .filter((candidate, _index, all) => !all.some((other) => {
                if (other === candidate || !other.contains(candidate)) {
                    return false;
                }

                const otherTitle = this.extractJulesArtifactTitle(other, this.getTextContentPreservingLines(other));
                const candidateTitle = this.extractJulesArtifactTitle(candidate, this.getTextContentPreservingLines(candidate));
                return candidateTitle !== '' && otherTitle === candidateTitle;
            }))
            .sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                if (leftRect.top !== rightRect.top) {
                    return leftRect.top - rightRect.top;
                }

                return leftRect.left - rightRect.left;
            });
    }

    getArtifactCount(): number {
        return this.getVisibleArtifactCards().length;
    }

    protected async parseVisibleArtifacts(): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];
        const seenKeys = new Set<string>();

        for (const card of this.getVisibleArtifactCards()) {
            const rawText = this.getTextContentPreservingLines(card)
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            const cleanedContent = this.cleanArtifactText(rawText);
            const title = this.extractJulesArtifactTitle(card, rawText) || 'Jules artifact';
            const descriptor = `${this.getClassName(card)} ${cleanedContent}`;
            const diffLike = /(^|\n)\s*[+-]/m.test(rawText);
            const fileLike = this.looksLikeFileArtifactTitle(title) || /load file|download zip/.test(descriptor);
            const structuredHtml = !fileLike
                ? this.sanitizeRichHtml(card, {
                    removeSelectors: ['.bonsai-insert-btn', '.bonsai-action-container', 'button[aria-label*="Insert"]'],
                })
                : '';
            const { viewUrl, sourceUrl } = this.extractArtifactLinks(card);
            const artifactType: ArtifactNode['type'] = fileLike ? 'code_artifact' : 'artifact_doc';
            const artifactContent = artifactType === 'code_artifact'
                ? (rawText || title)
                : (structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? structuredHtml
                    : (cleanedContent || title));
            const dedupeKey = [artifactType, title, artifactContent.slice(0, 400)].join('|');

            if (seenKeys.has(dedupeKey)) {
                continue;
            }

            seenKeys.add(dedupeKey);

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: artifactType,
                title,
                content: artifactContent,
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl ?? window.location.href,
                exportable: true,
                mime_type: artifactType === 'code_artifact'
                    ? (diffLike ? 'text/x-diff' : 'text/plain')
                    : (structuredHtml ? 'text/html' : 'text/plain'),
            });
        }

        return artifacts;
    }

    getDeepLink(el: Element): DeepLink {
        return {
            url: window.location.href,
            selector_hint: el.getAttribute('id') ? `#${el.getAttribute('id')}` : this.getMessageCandidateSelectors(),
        };
    }

    getProvenance(): Provenance {
        return {
            provider: 'google',
            model: 'jules',
            confidence: 'inferred',
        };
    }

    sendToAI(text: string): boolean {
        const input = this.getComposer();
        if (!input) {
            return false;
        }

        if (input instanceof HTMLTextAreaElement) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }

        if (input.getAttribute('contenteditable')) {
            input.textContent = text;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            return true;
        }

        return false;
    }
}

if (typeof window !== 'undefined') {
    const adapter = new JulesAdapter();
    ProviderRegistry.registerManual('jules.google.com', adapter);
    (window as any).__bonsaiAdapter = adapter;
    console.log('[Bonsai Capture] Jules adapter registered');

    Promise.all([
        import('../message-handler'),
        import('../dom-injector')
    ]).then(([_, { domInjector }]) => {
        console.log('[Bonsai Capture] Jules message handler initialized');
        domInjector.start();
        console.log('[Bonsai Capture] Jules DOM injector started');
    }).catch(err => {
        console.error('[Bonsai Capture] Failed to initialize Jules adapter:', err);
    });
}

export default JulesAdapter;

