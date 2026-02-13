/**
 * Provider Adapter Interface
 * 
 * Common interface that all provider-specific adapters must implement.
 * This enables consistent capture behavior across ChatGPT, Claude, Gemini, Grok.
 */

import type {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ConversationGraph
} from '../../shared/schema';

export interface SidebarItem {
    id: string;
    title: string;
    url: string;
}

export interface ParsedConversation {
    url: string;
    container: Element;
    title?: string;
}

export interface ProviderAdapter {
    /** Name of the provider for logging/diagnostics */
    readonly providerName: string;

    /** The site this adapter handles */
    readonly providerSite: string;

    /**
     * Detect if this adapter can handle the current page.
     * Returns conversation metadata if found, null otherwise.
     */
    detectConversation(): ParsedConversation | null;

    /**
     * List all message elements in the conversation, in order.
     */
    listMessages(): Element[];

    /**
     * Parse a message element into a MessageNode.
     */
    parseMessage(el: Element, sequence: number): Promise<MessageNode> | MessageNode;

    /**
     * Parse artifacts from a message element.
     */
    parseArtifacts(el: Element): Promise<ArtifactNode[]> | ArtifactNode[];

    /**
     * Get a deep link that can navigate back to this message.
     */
    getDeepLink(el: Element): DeepLink;

    /**
     * Subscribe to new messages being added (for live capture).
     * Returns an unsubscribe function.
     */
    subscribeNewMessages(callback: (el: Element) => void): () => void;

    /**
     * Get provenance information (model, provider) from the page.
     */
    getProvenance(): Provenance;

    /**
     * Send text to the AI input field.
     */
    sendToAI(text: string): Promise<boolean> | boolean;

    /**
     * Capture the entire conversation.
     */
    captureConversation(): Promise<ConversationGraph | null> | ConversationGraph | null;

    /**
     * Scan the sidebar for available conversations.
     */
    scanSidebar(): Promise<SidebarItem[]> | SidebarItem[];

    /**
     * Load a conversation by ID/URL.
     */
    loadConversation(id: string): Promise<boolean>;
}

/**
 * Base class with shared utility methods.
 */
export abstract class BaseAdapter implements ProviderAdapter {
    abstract readonly providerName: string;
    abstract readonly providerSite: string;

    abstract detectConversation(): ParsedConversation | null;
    abstract listMessages(): Element[];
    abstract parseMessage(el: Element, sequence: number): Promise<MessageNode> | MessageNode;
    abstract parseArtifacts(el: Element): Promise<ArtifactNode[]> | ArtifactNode[];
    abstract getDeepLink(el: Element): DeepLink;
    abstract getProvenance(): Provenance;
    abstract sendToAI(text: string): Promise<boolean> | boolean;

    async scanSidebar(): Promise<SidebarItem[]> {
        return [];
    }

    async loadConversation(id: string): Promise<boolean> {
        return false;
    }

    subscribeNewMessages(callback: (el: Element) => void): () => void {
        const conversation = this.detectConversation();
        if (!conversation) return () => { };

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node instanceof Element) {
                        // Check if this is a message element
                        const messages = this.listMessages();
                        if (messages.includes(node)) {
                            callback(node);
                        }
                        // Also check children
                        const childMessages = Array.from(node.querySelectorAll('*'))
                            .filter(el => messages.includes(el));
                        childMessages.forEach(callback);
                    }
                }
            }
        });

        observer.observe(conversation.container, {
            childList: true,
            subtree: true
        });

        return () => observer.disconnect();
    }

    async captureConversation(): Promise<ConversationGraph | null> {
        const conversation = this.detectConversation();
        if (!conversation) return null;

        const provenance = this.getProvenance();
        const messages = this.listMessages();

        const graph: ConversationGraph = {
            conversation_id: crypto.randomUUID(),
            title: conversation.title,
            source: {
                provider_site: this.providerSite as any,
                url: conversation.url,
                captured_at: new Date().toISOString(),
                capture_version: '0.1.0'
            },
            provenance,
            messages: [],
            artifacts: []
        };

        for (const [index, el] of messages.entries()) {
            const message = await this.parseMessage(el, index);
            const artifacts = await this.parseArtifacts(el);

            // Link artifacts to message
            artifacts.forEach(artifact => {
                artifact.source_message_id = message.message_id;
                message.artifact_ids.push(artifact.artifact_id);
                graph.artifacts.push(artifact);
            });

            graph.messages.push(message);
        }

        return graph;
    }

    /**
     * Extract text content from an element, handling common formatting.
     */
    protected extractTextContent(el: Element): string {
        // Clone to avoid modifying original
        const clone = el.cloneNode(true) as Element;

        // Remove code blocks (handled separately)
        clone.querySelectorAll('pre, code').forEach(code => code.remove());

        return clone.textContent?.trim() ?? '';
    }

    /**
     * Extract code blocks from an element.
     */
    protected extractCodeBlocks(el: Element): Array<{ language: string; code: string }> {
        const blocks: Array<{ language: string; code: string }> = [];

        el.querySelectorAll('pre code, .code-block code').forEach(codeEl => {
            const language = this.detectCodeLanguage(codeEl);
            const code = codeEl.textContent?.trim() ?? '';
            if (code) {
                blocks.push({ language, code });
            }
        });

        return blocks;
    }

    /**
     * Detect the programming language of a code block.
     */
    protected detectCodeLanguage(codeEl: Element): string {
        // Check class names for language hints
        const classes = Array.from(codeEl.classList);
        for (const cls of classes) {
            if (cls.startsWith('language-')) return cls.replace('language-', '');
            if (cls.startsWith('lang-')) return cls.replace('lang-', '');
        }

        // Check parent pre element
        const pre = codeEl.closest('pre');
        if (pre) {
            for (const cls of Array.from(pre.classList)) {
                if (cls.startsWith('language-')) return cls.replace('language-', '');
            }
        }

        // Check for language header
        const header = codeEl.closest('.code-container, .code-block')
            ?.querySelector('.code-header, [data-language]');
        if (header) {
            return header.textContent?.trim().toLowerCase() ?? '';
        }

        return '';
    }
}
