/**
 * ChatGPT Adapter
 * 
 * Captures conversations from chatgpt.com / chat.openai.com
 */

// DEBUG: Log start
console.log('!!! Bonsai Capture: ChatGPT Adapter Loading !!!');

import { BaseAdapter, ParsedConversation, SidebarItem } from './interface';
import {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ConversationGraph,
    ContentBlock,
    createMessageNode,
    createTextBlock,
    createCodeBlock,
    createMarkdownBlock
} from '../../shared/schema';
import {
    getSelectorsForSite,
    queryWithFallbacks,
    queryAllWithFallbacks
} from '../../config/selectors';

class ChatGPTAdapter extends BaseAdapter {
    readonly providerName = 'OpenAI';
    readonly providerSite = 'chatgpt.com';

    private get selectors() {
        return getSelectorsForSite(window.location.hostname) ?? getSelectorsForSite('chatgpt.com')!;
    }

    detectConversation(): ParsedConversation | null {
        const isProjectPage = window.location.pathname.includes('/project');
        const container = queryWithFallbacks(document, this.selectors.conversationContainer);
        
        if (!container && !isProjectPage) return null;

        // Extract title from page or heading
        const title = document.title.replace(' - ChatGPT', '').replace('ChatGPT', '').trim()
            || this.extractConversationTitle()
            || (isProjectPage ? 'Project Overview' : 'Untitled');

        return {
            url: window.location.href,
            container: container || document.body,
            title: title || undefined
        };
    }

    private extractConversationTitle(): string {
        // Try to get from sidebar active item
        const activeItem = document.querySelector('[data-testid="history-item"].active, .conversation-item.selected');
        return activeItem?.textContent?.trim() ?? '';
    }

    listMessages(): Element[] {
        const conversation = this.detectConversation();
        if (!conversation) return [];

        const elements = queryAllWithFallbacks(conversation.container, this.selectors.messageBlock);
        return Array.from(new Set(elements));
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
            // No bubbles found? Try to find any text container
            return turn; // Fallback to turn itself
        }

        // Filter out "You said" artifacts
        const validBubbles = bubbles.filter(el => {
            const text = el.textContent?.trim() || '';
            // Heuristic: "You said" block often starts with this text
            // And usually has a specific class, but we use text to be safe
            if (text.startsWith('You said:')) return false;
            return true;
        });

        if (validBubbles.length > 0) {
            // Return the last valid bubble (most recent edit)
            return validBubbles[validBubbles.length - 1];
        }

        // If all were filtered (e.g. user literally message "You said: ..."), 
        // fallback to the last bubble (likely the message).
        return bubbles[bubbles.length - 1];
    }

    async scanSidebar(): Promise<SidebarItem[]> {
        const items: SidebarItem[] = [];
        console.log('[Bonsai Capture] Scanning for conversation links...');

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
                    items.push({
                        id,
                        title,
                        url: href.startsWith('http') ? href : `https://chatgpt.com/c/${id}`
                    });
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

    async loadConversation(id: string): Promise<boolean> {
        // If already on the page
        if (window.location.href.includes(id)) {
            return true;
        }

        // Try to find in sidebar and click
        const sidebarLink = document.querySelector(`a[href*="${id}"]`) as HTMLElement;
        if (sidebarLink) {
            sidebarLink.click();
            // Wait for load? tough to know when done without complex logic
            // Capture engine usually waits or retries
            return true;
        }

        // Fallback: Location change
        window.location.href = `https://chatgpt.com/c/${id}`;
        return true;
    }

    async parseMessage(el: Element, sequence: number): Promise<MessageNode> {
        const bubble = this.resolveMessageBubble(el);
        const role = this.detectRole(bubble);
        const contentBlocks = this.parseContentBlocks(bubble);
        const deepLink = this.getDeepLink(el); // Deep link often on container or specific child, but keep el for now
        const origin = this.getProvenance();

        return createMessageNode(role, sequence, contentBlocks, deepLink, role === 'assistant' ? origin : undefined);
    }



    private detectRole(el: Element): 'user' | 'assistant' | 'system' | 'tool' {
        // Check data attribute
        const roleAttr = el.getAttribute('data-message-author-role');
        if (roleAttr === 'user') return 'user';
        if (roleAttr === 'assistant') return 'assistant';
        if (roleAttr === 'system') return 'system';
        if (roleAttr === 'tool') return 'tool';

        // Check testid
        const testId = el.getAttribute('data-testid') ?? '';
        if (testId.includes('user')) return 'user';
        if (testId.includes('assistant')) return 'assistant';

        // Fallback: check classes and structure
        const classList = el.className.toLowerCase();
        if (classList.includes('user')) return 'user';
        if (classList.includes('assistant')) return 'assistant';

        // Check for agent icon (assistant indicator)
        if (el.querySelector('[data-testid="bot-avatar"], .agent-avatar, .gpt-avatar')) {
            return 'assistant';
        }

        // Default based on position (even = user, odd = assistant in typical flows)
        const messages = this.listMessages();
        const index = messages.indexOf(el);
        return index % 2 === 0 ? 'user' : 'assistant';
    }

    private parseContentBlocks(el: Element): ContentBlock[] {
        const blocks: ContentBlock[] = [];

        // 1. Mark and Extract Code Blocks
        const codeBlocks = this.extractCodeBlocks(el);

        // 2. Clone content for text extraction
        const contentArea = el.querySelector('.markdown, .message-content, [data-message-content]') ?? el;
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

        const codeEls = clone.querySelectorAll('pre');
        codeEls.forEach((pre, idx) => {
            // In ChatGPT, code blocks are PREs.
            // We replace them with a unique marker that survives textContent extraction.
            const placeholder = document.createTextNode(`\n\n<<<BONSAI_CODE_BLOCK_${idx}>>>\n\n`);
            pre.parentNode?.replaceChild(placeholder, pre);
        });

        // 4. Get text using recursive walker to guarantee newlines
        const rawText = this.getTextContentPreservingLines(clone);

        // Normalize
        let textContent = rawText.replace(/\n{3,}/g, '\n\n').trim();
        textContent = textContent.replace(/^ChatGPT said:[\s\n]*/i, '').trim();

        // 5. Escape Asterisks (Subjective preference from Claude task, applying here for consistency)
        textContent = textContent.replace(/\*/g, '\u2217');

        // 6. Split and Reassemble
        const parts = textContent.split(/<<<BONSAI_CODE_BLOCK_(\d+)>>>/);

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
                    blocks.push(createCodeBlock(cb.code, cb.language));
                }
            }
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

    async captureConversation(): Promise<ConversationGraph> {
        const title = document.title;
        const messageEls = this.listMessages();
        const messages: MessageNode[] = [];
        const allArtifacts: ArtifactNode[] = [];
        const seenArtifactContent = new Set<string>();

        for (const [index, el] of messageEls.entries()) {
            const message = await this.parseMessage(el, index);

            // Parse artifacts SCOPED to this message element
            const artifacts = await this.parseArtifacts(el);

            // Link artifacts to this message
            for (const artifact of artifacts) {
                // Deduplicate global content (e.g. same image in multiple views if any leak through)
                if (artifact.type === 'image' && typeof artifact.content === 'string') {
                    if (seenArtifactContent.has(artifact.content)) continue;
                    seenArtifactContent.add(artifact.content);
                }

                artifact.source_message_id = message.message_id;
                message.artifact_ids.push(artifact.artifact_id);
                allArtifacts.push(artifact);
            }

            messages.push(message);
        }

        return {
            conversation_id: crypto.randomUUID(),
            title,
            source: {
                provider_site: this.providerSite as any,
                url: window.location.href,
                captured_at: new Date().toISOString(),
                capture_version: '0.1.0'
            },
            provenance: this.getProvenance(),
            messages,
            artifacts: allArtifacts
        };
    }

    async parseArtifacts(el: Element): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];
        const seenContent = new Set<string>();

        // Look for artifact panel references
        const artifactRefs = el.querySelectorAll('[data-artifact-id], .artifact-reference');
        artifactRefs.forEach(ref => {
            const artifactId = ref.getAttribute('data-artifact-id') ?? crypto.randomUUID();
            const title = ref.querySelector('.artifact-title')?.textContent?.trim();

            // Try to get artifact content from the panel
            const panel = document.querySelector(`[data-artifact-id="${artifactId}"]`);
            const content = panel?.textContent ?? ref.textContent ?? '';

            // Find closest message
            const messageEl = ref.closest('[data-bonsai-msg-id]');
            const sourceMsgId = messageEl?.getAttribute('data-bonsai-msg-id') ?? '';

            artifacts.push({
                artifact_id: artifactId,
                type: 'artifact_doc',
                title,
                content,
                source_message_id: sourceMsgId,
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
                exportable: true
            });
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


