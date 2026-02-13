/**
 * Grok Adapter (Stub)
 * 
 * Captures conversations from grok.com
 */

import { BaseAdapter, ParsedConversation } from './interface';
import {
    MessageNode,
    ArtifactNode,
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

    detectConversation(): ParsedConversation | null {
        const container = queryWithFallbacks(document, this.selectors.conversationContainer);
        if (!container) return null;

        return {
            url: window.location.href,
            container,
            title: document.title.replace(' - Grok', '').trim() || undefined
        };
    }

    listMessages(): Element[] {
        const conversation = this.detectConversation();
        if (!conversation) return [];
        return queryAllWithFallbacks(conversation.container, this.selectors.messageBlock);
    }

    parseMessage(el: Element, sequence: number): MessageNode {
        const role = this.detectRole(el);
        const text = el.textContent?.trim() ?? '';

        return createMessageNode(
            role,
            sequence,
            [createMarkdownBlock(text)],
            this.getDeepLink(el),
            role === 'assistant' ? this.getProvenance() : undefined
        );
    }

    private detectRole(el: Element): 'user' | 'assistant' {
        const classList = el.className.toLowerCase();
        if (classList.includes('user')) return 'user';
        if (classList.includes('assistant') || classList.includes('grok')) return 'assistant';

        const messages = this.listMessages();
        return messages.indexOf(el) % 2 === 0 ? 'user' : 'assistant';
    }

    parseArtifacts(el: Element): ArtifactNode[] {
        return []; // TODO: Implement
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
    (window as any).__bonsaiAdapter = new GrokAdapter();
}

// Initialize message handler
import '../message-handler';

export default GrokAdapter;

