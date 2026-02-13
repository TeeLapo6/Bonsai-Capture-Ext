/**
 * Claude.ai Adapter
 * 
 * Captures conversations from claude.ai
 */

import { BaseAdapter, ParsedConversation } from './interface';
import {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ContentBlock,
    createMessageNode,
    createCodeBlock,
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
        const contentBlocks = this.parseContentBlocks(el);
        const deepLink = this.getDeepLink(el);
        const origin = this.getProvenance();

        return createMessageNode(role, sequence, contentBlocks, deepLink, role === 'assistant' ? origin : undefined);
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

    private parseContentBlocks(el: Element): ContentBlock[] {
        const blocks: ContentBlock[] = [];

        // 1. Mark and Extract Code Blocks (Only REAL code blocks)
        const codeBlocks = this.extractCodeBlocks(el);

        // 2. Clone content for text extraction
        const contentArea = el.querySelector('.prose, .message-content, [data-message-content]') ?? el;
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

        // Also remove artifact cards from text
        clone.querySelectorAll('[data-artifact], .artifact-card').forEach(art => art.remove());

        // 4. Get text using recursive walker to guarantee newlines between blocks
        // This handles deep nesting and grid layouts where innerText fails
        const rawText = this.getTextContentPreservingLines(clone);
        // Normalize whitespace: max 2 newlines
        let textContent = rawText.replace(/\n{3,}/g, '\n\n').trim();

        // Escape asterisks (The user wants literal asterisks, not bullets/italics)
        // Using Unicode Asterisk Operator (\u2217) which looks identical but doesn't trigger markdown
        // logic and bypasses the renderer's escaping issues (showing backslashes or entity codes).
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

    parseArtifacts(el: Element): ArtifactNode[] {
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

        const artifactRefs = el.querySelectorAll('[data-artifact], .artifact-card, .artifact-preview');

        artifactRefs.forEach(ref => {
            const artifactId = ref.getAttribute('data-artifact-id') ?? crypto.randomUUID();
            const title = ref.querySelector('.artifact-title, [data-testid="artifact-title"]')?.textContent?.trim();

            let type: ArtifactNode['type'] = 'artifact_doc';
            const typeAttr = ref.getAttribute('data-artifact-type')?.toLowerCase();
            if (typeAttr?.includes('code')) type = 'code_artifact';
            if (typeAttr?.includes('doc')) type = 'embedded_doc';

            const contentEl = document.querySelector(`[data-artifact-content="${artifactId}"]`)
                ?? ref.querySelector('.artifact-content');
            const content = contentEl?.textContent ?? '';

            artifacts.push({
                artifact_id: artifactId,
                type,
                title,
                content,
                source_message_id: '',
                exportable: true,
                mime_type: 'text/plain'
            });
        });

        // Look for images
        el.querySelectorAll('img:not([role="presentation"]):not(.avatar)').forEach(img => {
            const src = img.getAttribute('src');
            if (!src) return;

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'image',
                title: img.getAttribute('alt') ?? undefined,
                mime_type: 'image/png',
                content: src,
                source_message_id: '',
                exportable: true
            });
        });

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
            const bodyText = document.body.innerText;
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
