/**
 * Grok Adapter (Stub)
 * 
 * Captures conversations from grok.com
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

export class GrokAdapter extends BaseAdapter {
    readonly providerName = 'xAI';
    readonly providerSite = 'grok.com';

    private get selectors() {
        return getSelectorsForSite('grok.com')!;
    }

    private getConversationTitle(): string | undefined {
        const title = document.title
            .replace(/\s*\|\s*Shared Grok Conversation$/i, '')
            .replace(/\s*-\s*Grok$/i, '')
            .trim();

        return title || undefined;
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

    private findConversationContainer(): Element | null {
        const firstMessage = queryWithFallbacks(document, this.selectors.messageBlock);
        if (firstMessage) {
            return firstMessage.closest(
                '[class*="overflow-y-auto"][class*="scrollbar-gutter-stable"], main, [data-testid="chat"]'
            ) ?? firstMessage.parentElement;
        }

        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (input) {
            return input.closest('main, form') ?? queryWithFallbacks(document, this.selectors.conversationContainer);
        }

        return null;
    }

    private listMessageElements(root: Element): Element[] {
        return queryAllWithFallbacks(root, this.selectors.messageBlock).filter((candidate) => {
            const text = candidate.textContent?.trim() ?? '';
            if (!text) {
                return false;
            }

            return candidate.matches('div.message-bubble, .message, [data-testid="message-container"]');
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

        // Extract images before cloning (clone preserves absolute img.src)
        const searchImages = this.extractSearchImages(el);
        const generatedImages = this.extractGeneratedImages(el);

        // Clone + sanitize for text extraction
        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll(
            '.bonsai-action-container, .bonsai-fallback-container, .bonsai-insert-btn, .thinking-container, [data-testid="image-viewer"]'
        ).forEach(node => node.remove());

        // Prefer the response-content-markdown subtree to avoid stray UI text
        const markdownRoot = clone.querySelector('.response-content-markdown') ?? clone;

        // Extract code blocks: capture lang + verbatim code, replace <pre> with placeholder
        const extractedCodeFences: string[] = [];
        markdownRoot.querySelectorAll('pre').forEach(pre => {
            const codeEl = pre.querySelector('code');

            // Language from <code class="language-xxx"> first, then nearest .language-label
            const langFromClass = (codeEl?.className ?? '').match(/\blanguage-(\w+)\b/)?.[1] ?? '';
            let lang = langFromClass;
            if (!lang) {
                let parent: Element | null = pre.parentElement;
                while (parent && parent !== markdownRoot) {
                    const label = parent.querySelector('.language-label');
                    if (label) { lang = (label.textContent?.trim() ?? '').toLowerCase(); break; }
                    parent = parent.parentElement;
                }
            }

            const codeText = (codeEl ?? pre).textContent?.trim() ?? '';
            const idx = extractedCodeFences.length;
            extractedCodeFences.push(`\`\`\`${lang}\n${codeText}\n\`\`\``);
            pre.replaceWith(document.createTextNode(`\n\n<<<BONSAI_CODE_${idx}>>>\n\n`));
        });

        const text = this.buildStructuredText(markdownRoot, extractedCodeFences);

        if (text) {
            contentBlocks.push(createMarkdownBlock(text));
        }

        // Search result images as linked markdown images
        if (searchImages.length > 0) {
            const imgMarkdown = searchImages
                .map(img => img.href
                    ? `[![${img.alt}](${img.src})](${img.href})`
                    : `![${img.alt}](${img.src})`)
                .join('\n');
            contentBlocks.push(createMarkdownBlock(imgMarkdown));
        }

        // Generated (Grok Imagine) images
        if (generatedImages.length > 0) {
            const genMarkdown = generatedImages
                .map(img => `![Generated image](${img.src})`)
                .join('\n');
            contentBlocks.push(createMarkdownBlock(genMarkdown));
        }

        // Sources from the sibling action-buttons bar
        const sourceSummary = this.extractSources(el);
        if (sourceSummary) {
            contentBlocks.push(createMarkdownBlock(sourceSummary));
        }

        return createMessageNode(
            role,
            sequence,
            contentBlocks.length > 0 ? contentBlocks : [createMarkdownBlock('')],
            this.getDeepLink(el),
            role === 'assistant' ? this.getProvenance() : undefined
        );
    }

    private extractSearchImages(el: Element): Array<{ src: string; alt: string; href: string }> {
        const viewer = el.querySelector('[data-testid="image-viewer"]');
        if (!viewer) return [];

        const results: Array<{ src: string; alt: string; href: string }> = [];
        viewer.querySelectorAll('[class*="group/image"]').forEach(item => {
            // Skip presentation/favicon images
            const img = item.querySelector('img:not([role="presentation"])');
            const link = item.querySelector('a');
            if (img) {
                results.push({
                    src: (img as HTMLImageElement).src ?? '',
                    alt: img.getAttribute('alt') ?? '',
                    href: (link as HTMLAnchorElement)?.href ?? ''
                });
            }
        });
        return results;
    }

    private extractGeneratedImages(el: Element): Array<{ src: string }> {
        const results: Array<{ src: string }> = [];
        const seen = new Set<string>();

        el.querySelectorAll('[class*="grok-image"] img').forEach(img => {
            const className = typeof (img as HTMLElement).className === 'string'
                ? (img as HTMLElement).className
                : '';
            // Skip the absolute background duplicate
            if (className.includes('absolute')) return;

            const src = (img as HTMLImageElement).src;
            if (src && !seen.has(src)) {
                seen.add(src);
                results.push({ src });
            }
        });
        return results;
    }

    private extractSources(el: Element): string | null {
        // Sources button lives in the .action-buttons sibling of the message-bubble
        const sourcesEl = el.parentElement?.querySelector('[aria-label*=" source"]');
        if (!sourcesEl) return null;

        const ariaLabel = sourcesEl.getAttribute('aria-label') ?? '';

        // Extract domain names from Google favicon URLs embedded in the button
        const domains: string[] = [];
        sourcesEl.querySelectorAll('img[src*="favicons?"]').forEach(img => {
            const src = (img as HTMLImageElement).src ?? '';
            const match = src.match(/[?&]domain=([^&]+)/);
            if (match) {
                try {
                    domains.push(decodeURIComponent(match[1]));
                } catch {
                    domains.push(match[1]);
                }
            }
        });

        const label = ariaLabel.trim() || 'Sources';
        if (domains.length > 0) {
            return `**${label}:** ${domains.join(', ')}`;
        }
        return `**${label}**`;
    }

    private buildStructuredText(root: Element, codeFences: string[]): string {
        const BLOCK_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'TD', 'TH']);

        function walk(node: Node): string {
            if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            const el = node as Element;
            const inner = Array.from(el.childNodes).map(walk).join('');
            if (el.tagName === 'BR') return '\n';
            if (BLOCK_TAGS.has(el.tagName)) return '\n' + inner.trim() + '\n';
            return inner;
        }

        let text = walk(root).replace(/\n{3,}/g, '\n\n').trim();
        text = text.replace(/<<<BONSAI_CODE_(\d+)>>>/g, (_, i) => codeFences[parseInt(i, 10)] ?? '');
        return text;
    }

    private detectRole(el: Element): 'user' | 'assistant' {
        const classList = this.getClassName(el);
        if (classList.includes('user')) return 'user';
        if (classList.includes('assistant') || classList.includes('grok')) return 'assistant';

        const alignedContainer = el.closest('[class*="items-end"], [class*="items-start"]');
        const alignedClasses = this.getClassName(alignedContainer);
        if (alignedClasses.includes('items-end')) return 'user';
        if (alignedClasses.includes('items-start')) return 'assistant';

        const messages = this.listMessages();
        return messages.indexOf(el) % 2 === 0 ? 'user' : 'assistant';
    }

    parseArtifacts(el: Element): ArtifactNode[] {
        const artifacts: ArtifactNode[] = [];
        const messageId = el.getAttribute('data-message-id') || `grok-msg-${Date.now()}`;
        let artifactIdx = 0;

        // Extract code blocks as code_artifact
        el.querySelectorAll('pre').forEach(pre => {
            const codeEl = pre.querySelector('code');
            const codeText = (codeEl ?? pre).textContent?.trim();
            if (!codeText) return;

            // Detect language from <code class="language-xxx">
            const langFromClass = (codeEl?.className ?? '').match(/\blanguage-(\w+)\b/)?.[1] ?? '';
            let lang = langFromClass;
            if (!lang) {
                let parent: Element | null = pre.parentElement;
                while (parent && parent !== el) {
                    const label = parent.querySelector('.language-label');
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

        // Extract generated images (Grok Imagine) as image artifacts
        const seen = new Set<string>();
        el.querySelectorAll('[class*="grok-image"] img').forEach(img => {
            const className = typeof (img as HTMLElement).className === 'string'
                ? (img as HTMLElement).className
                : '';
            if (className.includes('absolute')) return;

            const src = (img as HTMLImageElement).src;
            if (!src || seen.has(src)) return;
            seen.add(src);

            artifacts.push({
                artifact_id: `${messageId}-img-${artifactIdx++}`,
                type: 'image' as ArtifactType,
                title: 'Generated image',
                mime_type: 'image/png',
                content: src,
                source_message_id: messageId,
                source_url: window.location.href,
                exportable: true,
            });
        });

        return artifacts;
    }

    getDeepLink(el: Element): DeepLink {
        return { url: window.location.href };
    }

    getProvenance(): Provenance {
        return {
            provider: 'xai',
            model: 'grok-2',
            confidence: 'inferred'
        };
    }

    sendToAI(text: string): boolean {
        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (!input) return false;

        if (input instanceof HTMLTextAreaElement) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (input.getAttribute('contenteditable')) {
            input.textContent = text;
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        return true;
    }
}

if (typeof window !== 'undefined') {
    const adapter = new GrokAdapter();
    (window as any).__bonsaiAdapter = adapter;
    console.log('[Bonsai Capture] Grok adapter registered');

    Promise.all([
        import('../message-handler'),
        import('../dom-injector')
    ]).then(([_, { domInjector }]) => {
        console.log('[Bonsai Capture] Grok message handler initialized');
        domInjector.start();
        console.log('[Bonsai Capture] Grok DOM injector started');
    }).catch(err => {
        console.error('[Bonsai Capture] Failed to initialize Grok adapter:', err);
    });
}

export default GrokAdapter;

