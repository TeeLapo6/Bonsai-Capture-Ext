/**
 * Gemini Adapter
 * 
 * Captures conversations from gemini.google.com
 */

import { BaseAdapter, ParsedConversation } from './interface';
import {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ContentBlock,
    createMessageNode,
    createMarkdownBlock,
    createCodeBlock
} from '../../shared/schema';
import { getSelectorsForSite, queryWithFallbacks, queryAllWithFallbacks } from '../../config/selectors';

export class GeminiAdapter extends BaseAdapter {
    readonly providerName = 'Google';
    readonly providerSite = 'gemini.google.com';

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
        return queryAllWithFallbacks(conversation.container, this.selectors.messageBlock);
    }

    parseMessage(el: Element, sequence: number): MessageNode {
        const role = this.detectRole(el);
        const contentBlocks = this.parseContentBlocks(el);

        return createMessageNode(
            role,
            sequence,
            contentBlocks,
            this.getDeepLink(el),
            role === 'assistant' ? this.getProvenance() : undefined
        );
    }

    private parseContentBlocks(el: Element): ContentBlock[] {
        const blocks: ContentBlock[] = [];

        // 1. Mark and Extract Code Blocks
        const codeBlocks = this.extractCodeBlocks(el);

        // 2. Clone content for text extraction
        const contentArea = el.querySelector('.markdown, message-content, .query-text') ?? el;
        const clone = contentArea.cloneNode(true) as Element;

        // Cleanup noise
        clone.querySelectorAll('style, script, link, meta, noscript, .sr-only, .bonsai-insert-btn').forEach(el => el.remove());

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

        // 5. Escape Asterisks
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

        const images = el.querySelectorAll('img');

        for (const [idx, imgEl] of Array.from(images).entries()) {
            const img = imgEl as HTMLImageElement;
            const alt = img.getAttribute('alt') || '';
            const src = img.src;

            if (!src) continue;

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
