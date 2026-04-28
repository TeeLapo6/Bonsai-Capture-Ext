/**
 * Augure Adapter
 *
 * Captures conversations from chat.augureai.ca/chat.
 */

import { BaseAdapter, ParsedConversation } from './interface';
import {
    MessageNode,
    ArtifactNode,
    ArtifactType,
    ContentBlock,
    DeepLink,
    Provenance,
    createMessageNode,
    createMarkdownBlock
} from '../../shared/schema';
import { getSelectorsForSite, queryWithFallbacks, queryAllWithFallbacks } from '../../config/selectors';

export class AugureAdapter extends BaseAdapter {
    readonly providerName = 'Augure';
    readonly providerSite = 'chat.augureai.ca';

    private get selectors() {
        return getSelectorsForSite('chat.augureai.ca')!;
    }

    private getConversationTitle(): string | undefined {
        const activeSidebarTitle = queryWithFallbacks(
            document,
            'aside .group.w-full.cursor-pointer.bg-surface span.text-\\[15px\\].font-bold'
        )?.textContent?.trim();

        if (activeSidebarTitle) {
            return activeSidebarTitle;
        }

        const firstUserBubble = queryWithFallbacks(document, '.flex.justify-end.group .bg-user-bubble');
        const fallback = firstUserBubble?.textContent?.trim();
        return fallback ? fallback.slice(0, 120) : undefined;
    }

    private findConversationContainer(): Element | null {
        const firstMessage = queryWithFallbacks(document, this.selectors.messageBlock);
        if (firstMessage) {
            return firstMessage.closest('.flex-1.overflow-y-auto, main') ?? firstMessage.parentElement;
        }

        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (input) {
            return input.closest('.flex.flex-col.min-w-0.flex-1, main, form')
                ?? queryWithFallbacks(document, this.selectors.conversationContainer);
        }

        return null;
    }

    private listMessageElements(root: Element): Element[] {
        return queryAllWithFallbacks(root, this.selectors.messageBlock).filter((candidate) => {
            const text = candidate.textContent?.trim() ?? '';
            if (!text) {
                return false;
            }

            const className = (candidate as HTMLElement).className || '';
            return /justify-(start|end)/.test(className) && className.includes('group');
        });
    }

    detectConversation(): ParsedConversation | null {
        const container = this.findConversationContainer();
        if (!container) return null;

        const messages = this.listMessageElements(container);
        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (messages.length === 0 && !input) return null;

        return {
            url: window.location.href,
            container,
            title: this.getConversationTitle()
        };
    }

    listMessages(): Element[] {
        const container = this.findConversationContainer();
        if (!container) return [];

        return this.listMessageElements(container);
    }

    parseMessage(el: Element, sequence: number): MessageNode {
        const role = this.detectRole(el);
        const contentBlocks: ContentBlock[] = [];

        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll(
            '.bonsai-action-container, .bonsai-fallback-container, .bonsai-insert-btn, button, svg'
        ).forEach(node => node.remove());

        const contentRoot = clone.querySelector('.chat-container') ?? clone;

        const extractedCodeFences: string[] = [];
        contentRoot.querySelectorAll('pre').forEach(pre => {
            const codeEl = pre.querySelector('code');
            const languageClass = (codeEl?.className ?? '').match(/\blanguage-(\w+)\b/)?.[1] ?? '';
            const codeText = (codeEl ?? pre).textContent?.trim() ?? '';
            const idx = extractedCodeFences.length;
            extractedCodeFences.push(`\n\n\`\`\`${languageClass}\n${codeText}\n\`\`\`\n\n`);
            pre.replaceWith(document.createTextNode(`<<<BONSAI_CODE_${idx}>>>`));
        });

        const text = this.buildStructuredMarkdown(contentRoot, extractedCodeFences);

        if (text) {
            contentBlocks.push(createMarkdownBlock(text.trim()));
        }

        return createMessageNode(
            role,
            sequence,
            contentBlocks.length > 0 ? contentBlocks : [createMarkdownBlock('')],
            this.getDeepLink(el),
            role === 'assistant' ? this.getProvenance() : undefined
        );
    }

    private detectRole(el: Element): 'user' | 'assistant' {
        const className = (el as HTMLElement).className || '';
        if (className.includes('justify-end') || el.querySelector('.bg-user-bubble')) {
            return 'user';
        }

        if (className.includes('justify-start') || el.querySelector('.bg-surface')) {
            return 'assistant';
        }

        const messages = this.listMessages();
        return messages.indexOf(el) % 2 === 0 ? 'user' : 'assistant';
    }

    parseArtifacts(el: Element): ArtifactNode[] {
        const artifacts: ArtifactNode[] = [];
        const messageId = el.getAttribute('data-message-id') || `augure-msg-${Date.now()}`;
        let artifactIdx = 0;

        el.querySelectorAll('pre').forEach(pre => {
            const codeEl = pre.querySelector('code');
            const codeText = (codeEl ?? pre).textContent?.trim();
            if (!codeText) return;

            const lang = (codeEl?.className ?? '').match(/\blanguage-(\w+)\b/)?.[1] ?? '';

            artifacts.push({
                artifact_id: `${messageId}-code-${artifactIdx++}`,
                type: 'code_artifact' as ArtifactType,
                title: lang ? `Code (${lang})` : 'Code snippet',
                mime_type: lang ? `text/${lang}` : 'text/plain',
                content: { code: codeText, language: lang || undefined },
                source_message_id: messageId,
                source_url: window.location.href,
                exportable: true,
            });
        });

        return artifacts;
    }

    getDeepLink(_el: Element): DeepLink {
        return { url: window.location.href };
    }

    getProvenance(): Provenance {
        const modelLabel = queryWithFallbacks(document, 'button[aria-label^="Model:"]')?.textContent?.trim();
        return {
            provider: 'unknown',
            model: modelLabel || undefined,
            confidence: modelLabel ? 'observed' : 'inferred'
        };
    }

    private buildStructuredMarkdown(root: Element, codeFences: string[]): string {
        const renderChildren = (node: Node, context?: { listType?: 'ul' | 'ol'; index?: number }): string =>
            Array.from(node.childNodes).map((child) => renderNode(child, context)).join('');

        const renderListItem = (el: Element, listType: 'ul' | 'ol', index: number): string => {
            const marker = listType === 'ol' ? `${index + 1}. ` : '- ';
            const lines: string[] = [];

            Array.from(el.childNodes).forEach((child) => {
                if (child.nodeType === Node.TEXT_NODE && !(child.textContent ?? '').trim()) {
                    return;
                }

                if (child.nodeType === Node.ELEMENT_NODE) {
                    const childEl = child as Element;
                    if (childEl.tagName === 'UL' || childEl.tagName === 'OL') {
                        const nested = renderNode(childEl).trimEnd();
                        if (nested) {
                            lines.push(`\n${nested}`);
                        }
                        return;
                    }
                }

                const chunk = renderNode(child).trim();
                if (chunk) {
                    lines.push(chunk);
                }
            });

            const content = lines.join(' ').replace(/[ \t]+\n/g, '\n').trim();
            if (!content) {
                return '';
            }

            const [firstLine, ...rest] = content.split('\n');
            const nestedLines = rest.map((line) => line ? `   ${line}` : '').join('\n');
            return `${marker}${firstLine}${nestedLines ? `\n${nestedLines}` : ''}\n`;
        };

        const renderNode = (node: Node, context?: { listType?: 'ul' | 'ol'; index?: number }): string => {
            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent ?? '';
            }

            if (node.nodeType !== Node.ELEMENT_NODE) {
                return '';
            }

            const el = node as Element;
            const tagName = el.tagName;
            const inner = renderChildren(el, context);

            switch (tagName) {
                case 'BR':
                    return '\n';
                case 'STRONG':
                case 'B':
                    return inner.trim() ? `**${inner.trim()}**` : '';
                case 'EM':
                case 'I':
                    return inner.trim() ? `*${inner.trim()}*` : '';
                case 'CODE':
                    return inner.trim() ? `\`${inner.trim()}\`` : '';
                case 'A': {
                    const href = el.getAttribute('href');
                    const label = inner.trim() || href || '';
                    return href ? `[${label}](${href})` : label;
                }
                case 'H1':
                case 'H2':
                case 'H3':
                case 'H4':
                case 'H5':
                case 'H6': {
                    const level = Number(tagName[1]);
                    const content = inner.trim();
                    return content ? `${'#'.repeat(level)} ${content}\n\n` : '';
                }
                case 'P':
                    return inner.trim() ? `${inner.trim()}\n\n` : '';
                case 'BLOCKQUOTE': {
                    const content = inner.trim();
                    return content
                        ? `${content.split('\n').map((line) => line ? `> ${line}` : '>').join('\n')}\n\n`
                        : '';
                }
                case 'UL':
                    return `${Array.from(el.children)
                        .filter((child): child is Element => child instanceof Element && child.tagName === 'LI')
                        .map((child, index) => renderNode(child, { listType: 'ul', index }))
                        .join('')
                        .trimEnd()}\n\n`;
                case 'OL':
                    return `${Array.from(el.children)
                        .filter((child): child is Element => child instanceof Element && child.tagName === 'LI')
                        .map((child, index) => renderNode(child, { listType: 'ol', index }))
                        .join('')
                        .trimEnd()}\n\n`;
                case 'LI':
                    return context?.listType ? renderListItem(el, context.listType, context.index ?? 0) : `${inner.trim()}\n`;
                case 'DIV':
                case 'SECTION':
                case 'ARTICLE':
                    return inner;
                default:
                    return inner;
            }
        };

        let text = renderNode(root)
            .replace(/<<<BONSAI_CODE_(\d+)>>>/g, (_match, i) => codeFences[parseInt(i, 10)] ?? '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return text;
    }

    sendToAI(text: string): boolean {
        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (!(input instanceof HTMLTextAreaElement)) {
            return false;
        }

        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));

        const submit = queryWithFallbacks(document, this.selectors.submitButton || 'button[aria-label="Send message"]');
        if (submit instanceof HTMLButtonElement && !submit.disabled) {
            submit.click();
        }

        return true;
    }
}

if (typeof window !== 'undefined') {
    const adapter = new AugureAdapter();
    (window as any).__bonsaiAdapter = adapter;
    console.log('[Bonsai Capture] Augure adapter registered');

    Promise.all([
        import('../message-handler'),
        import('../dom-injector')
    ]).then(([_, { domInjector }]) => {
        console.log('[Bonsai Capture] Augure message handler initialized');
        domInjector.start();
        console.log('[Bonsai Capture] Augure DOM injector started');
    }).catch(err => {
        console.error('[Bonsai Capture] Failed to initialize Augure adapter:', err);
    });
}

export default AugureAdapter;