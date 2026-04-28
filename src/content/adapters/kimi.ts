/**
 * Kimi (Moonshot AI) Adapter
 *
 * Captures conversations from kimi.com / kimi.moonshot.cn.
 * Kimi uses Vue 3 + Naive UI with a Lexical editor for input.
 * Chat URLs follow the pattern: https://www.kimi.com/chat/{uuid}
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

export class KimiAdapter extends BaseAdapter {
    readonly providerName = 'Moonshot';
    readonly providerSite = 'kimi.com';

    private get selectors() {
        return getSelectorsForSite('kimi.com')!;
    }

    private getConversationTitle(): string | undefined {
        const title = document.title
            .replace(/\s*-\s*Kimi$/i, '')
            .trim();

        if (title && title !== 'Kimi AI with K2.6' && title !== 'Unnamed Chat') {
            return title;
        }

        const firstUserText = this.listUserMessages().find(m => m.textContent?.trim())?.textContent?.trim();
        return firstUserText ? firstUserText.slice(0, 120) : undefined;
    }

    private findConversationContainer(): Element | null {
        const firstMessage = queryWithFallbacks(document, this.selectors.messageBlock);
        if (firstMessage) {
            return firstMessage.closest('.message-list, .message-list-container, .chat-box')
                ?? queryWithFallbacks(document, this.selectors.conversationContainer);
        }

        const messageList = queryWithFallbacks(document, '.message-list, .message-list-container');
        if (messageList && messageList.children.length > 0) {
            return messageList;
        }

        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (input) {
            return input.closest('.chat-box, .layout-content-main')
                ?? queryWithFallbacks(document, this.selectors.conversationContainer);
        }

        return null;
    }

    private listUserMessages(): Element[] {
        const container = this.findConversationContainer();
        if (!container) return [];

        const all = queryAllWithFallbacks(container, this.selectors.messageBlock);
        return all.filter(el => this.detectRole(el) === 'user');
    }

    detectConversation(): ParsedConversation | null {
        if (document.querySelector('.home-page, .home-banner, .activity-area')) {
            return null;
        }

        const container = this.findConversationContainer();
        if (!container) return null;

        const rawMessages = queryAllWithFallbacks(container, this.selectors.messageBlock);
        const input = queryWithFallbacks(document, this.selectors.inputField);

        const messages = rawMessages.filter(candidate => {
            const text = candidate.textContent?.trim() ?? '';
            return text.length > 0;
        });

        if (messages.length === 0 && !input) return null;

        const chatIdMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/i);

        return {
            url: chatIdMatch
                ? `https://www.kimi.com/chat/${chatIdMatch[1]}`
                : window.location.href,
            container,
            title: this.getConversationTitle()
        };
    }

    listMessages(): Element[] {
        const container = this.findConversationContainer();
        if (!container) return [];

        return queryAllWithFallbacks(container, this.selectors.messageBlock).filter(candidate => {
            const text = candidate.textContent?.trim() ?? '';
            return text.length > 0;
        });
    }

    parseMessage(el: Element, sequence: number): MessageNode {
        const role = this.detectRole(el);
        const contentBlocks: ContentBlock[] = [];

        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll(
            '.bonsai-action-container, .bonsai-fallback-container, .bonsai-insert-btn, button, .send-button-container, .send-icon'
        ).forEach(node => node.remove());

        const markdownRoot = clone.querySelector('[class*="markdown"], [class*="content"], .prose')
            ?? clone;

        const extractedCodeFences: string[] = [];
        markdownRoot.querySelectorAll('pre').forEach(pre => {
            const codeEl = pre.querySelector('code');
            const langFromClass = (codeEl?.className ?? '').match(/\blanguage-(\w+)\b/)?.[1] ?? '';

            let lang = langFromClass;
            if (!lang) {
                let parent: Element | null = pre.parentElement;
                while (parent && parent !== markdownRoot) {
                    const label = parent.querySelector('[class*="language"], [class*="lang"]');
                    if (label) { lang = (label.textContent?.trim() ?? '').toLowerCase(); break; }
                    parent = parent.parentElement;
                }
            }

            const codeText = (codeEl ?? pre).textContent?.trim() ?? '';
            const idx = extractedCodeFences.length;
            extractedCodeFences.push(`\n\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`);
            pre.replaceWith(document.createTextNode(`<<<BONSAI_CODE_${idx}>>>`));
        });

        const text = this.buildStructuredMarkdown(markdownRoot, extractedCodeFences);

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
        const classLower = typeof className === 'string' ? className.toLowerCase() : '';

        if (classLower.includes('user') || classLower.includes('human') || classLower.includes('question')) {
            return 'user';
        }

        if (classLower.includes('assistant') || classLower.includes('kimi') || classLower.includes('answer')
            || classLower.includes('response') || classLower.includes('model')) {
            return 'assistant';
        }

        const messages = this.listMessages();
        if (messages.length === 0) return 'user';
        return messages.indexOf(el) % 2 === 0 ? 'user' : 'assistant';
    }

    parseArtifacts(el: Element): ArtifactNode[] {
        const artifacts: ArtifactNode[] = [];
        const messageId = el.getAttribute('data-message-id') || `kimi-msg-${Date.now()}`;
        let artifactIdx = 0;

        el.querySelectorAll('pre').forEach(pre => {
            const codeEl = pre.querySelector('code');
            const codeText = (codeEl ?? pre).textContent?.trim();
            if (!codeText) return;

            const langFromClass = (codeEl?.className ?? '').match(/\blanguage-(\w+)\b/)?.[1] ?? '';
            let lang = langFromClass;
            if (!lang) {
                let parent: Element | null = pre.parentElement;
                while (parent && parent !== el) {
                    const label = parent.querySelector('[class*="language"], [class*="lang"]');
                    if (label) { lang = (label.textContent?.trim() ?? '').toLowerCase(); break; }
                    parent = parent.parentElement;
                }
            }

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
        const chatIdMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/i);
        return {
            url: chatIdMatch
                ? `https://www.kimi.com/chat/${chatIdMatch[1]}`
                : window.location.href
        };
    }

    getProvenance(): Provenance {
        const modelLabel = queryWithFallbacks(document,
            '.current-model, .model-name, [class*="model-select"], [class*="model-picker"]'
        )?.textContent?.trim();
        return {
            provider: 'moonshot',
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

            Array.from(el.childNodes).forEach(child => {
                if (child.nodeType === Node.TEXT_NODE && !(child.textContent ?? '').trim()) {
                    return;
                }

                if (child.nodeType === Node.ELEMENT_NODE) {
                    const childEl = child as Element;
                    if (childEl.tagName === 'UL' || childEl.tagName === 'OL') {
                        const nested = renderNode(childEl).trimEnd();
                        if (nested) lines.push(`\n${nested}`);
                        return;
                    }
                }

                const chunk = renderNode(child).trim();
                if (chunk) lines.push(chunk);
            });

            const content = lines.join(' ').replace(/[ \t]+\n/g, '\n').trim();
            if (!content) return '';

            const [firstLine, ...rest] = content.split('\n');
            const nestedLines = rest.map(line => line ? `   ${line}` : '').join('\n');
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
                        ? `${content.split('\n').map(line => line ? `> ${line}` : '>').join('\n')}\n\n`
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
                    return context?.listType
                        ? renderListItem(el, context.listType, context.index ?? 0)
                        : `${inner.trim()}\n`;
                case 'DIV':
                case 'SECTION':
                case 'ARTICLE':
                case 'SPAN':
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
        if (!input) return false;

        if (input.getAttribute('data-lexical-editor') !== null) {
            (input as HTMLElement).click();
            (input as HTMLElement).focus();
            input.textContent = '';
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));

            setTimeout(() => {
                const sendBtn = queryWithFallbacks(document,
                    '.send-button-container button:not([disabled]), button[class*="send"], .send-icon'
                );
                if (sendBtn instanceof HTMLButtonElement && !sendBtn.disabled) {
                    sendBtn.click();
                }
            }, 100);
            return true;
        }

        if (input instanceof HTMLTextAreaElement) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }

        if (input.getAttribute('contenteditable') === 'true') {
            input.textContent = text;
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            return true;
        }

        return false;
    }
}

if (typeof window !== 'undefined') {
    const adapter = new KimiAdapter();
    (window as any).__bonsaiAdapter = adapter;
    console.log('[Bonsai Capture] Kimi adapter registered');

    Promise.all([
        import('../message-handler'),
        import('../dom-injector')
    ]).then(([_, { domInjector }]) => {
        console.log('[Bonsai Capture] Kimi message handler initialized');
        domInjector.start();
        console.log('[Bonsai Capture] Kimi DOM injector started');
    }).catch(err => {
        console.error('[Bonsai Capture] Failed to initialize Kimi adapter:', err);
    });
}

export default KimiAdapter;
