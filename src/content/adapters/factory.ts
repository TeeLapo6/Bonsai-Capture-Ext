/**
 * Provider Adapter Factory
 * 
 * Enables declarative configuration of AI providers and automatic adapter generation.
 */

import { BaseAdapter, ParsedConversation, SidebarItem, ProviderAdapter } from './interface';
import {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    createMessageNode,
    createMarkdownBlock,
    ProviderSite,
    ProviderName
} from '../../shared/schema';
import { queryWithFallbacks, queryAllWithFallbacks } from '../../config/selectors';

/**
 * Declarative configuration for an AI provider's DOM structure.
 */
export interface ProviderConfig {
    name: ProviderName;
    displayName: string;
    domain: string;
    selectors: {
        container: string;
        message: string;
        input: string;
        submit?: string;
        title?: string;
        sidebarItem?: string;
        artifact?: string;
        model?: string;
    };
    roleDetection: {
        userClasses?: string[];
        assistantClasses?: string[];
        userAttributes?: Record<string, string>;
        assistantAttributes?: Record<string, string>;
    };
}

/**
 * A generalized adapter that uses ProviderConfig to handle DOM-based capture.
 */
export class GenericAdapter extends BaseAdapter {
    constructor(private config: ProviderConfig) {
        super();
    }

    get providerName(): string { return this.config.displayName; }
    get providerSite(): string { return this.config.domain; }

    detectConversation(): ParsedConversation | null {
        const container = queryWithFallbacks(document, this.config.selectors.container);
        if (!container) return null;

        let title = '';
        if (this.config.selectors.title) {
            title = queryWithFallbacks(document, this.config.selectors.title)?.textContent?.trim() || '';
        }

        if (!title) {
            title = document.title.split(' - ')[0].trim();
        }

        return {
            url: window.location.href,
            container,
            title: title || undefined
        };
    }

    listMessages(): Element[] {
        const conversation = this.detectConversation();
        if (!conversation) return [];
        return queryAllWithFallbacks(conversation.container, this.config.selectors.message);
    }

    async parseMessage(el: Element, sequence: number): Promise<MessageNode> {
        const role = this.detectRole(el);
        const text = this.extractTextContent(el);
        const contentBlocks = [createMarkdownBlock(text)];
        const deepLink = this.getDeepLink(el);
        const origin = this.getProvenance();

        const message = createMessageNode(role, sequence, contentBlocks, deepLink, role === 'assistant' ? origin : undefined);

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

    async parseArtifacts(el: Element): Promise<ArtifactNode[]> {
        if (!this.config.selectors.artifact) return [];

        const artifacts: ArtifactNode[] = [];
        const artifactEls = el.querySelectorAll(this.config.selectors.artifact);

        artifactEls.forEach(artEl => {
            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'artifact_doc',
                title: artEl.textContent?.trim().slice(0, 50) || 'Artifact',
                content: artEl.textContent || '',
                source_message_id: '', // Linked during capture
                view_url: this.extractArtifactViewUrl(artEl),
                exportable: true
            });
        });

        return artifacts;
    }

    getDeepLink(el: Element): DeepLink {
        return {
            url: window.location.href,
            selector_hint: this.config.selectors.message
        };
    }

    getProvenance(): Provenance {
        let model: string | undefined;
        if (this.config.selectors.model) {
            model = queryWithFallbacks(document, this.config.selectors.model)?.textContent?.trim();
        }

        return {
            provider: this.config.name,
            model,
            confidence: model ? 'observed' : 'inferred'
        };
    }

    sendToAI(text: string): boolean {
        const input = queryWithFallbacks(document, this.config.selectors.input);
        if (!input) return false;

        if (input instanceof HTMLTextAreaElement) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (input.getAttribute('contenteditable')) {
            input.textContent = text;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        }
        return true;
    }

    private detectRole(el: Element): 'user' | 'assistant' {
        const { userClasses, assistantClasses, userAttributes, assistantAttributes } = this.config.roleDetection;

        if (userClasses?.some(cls => el.classList.contains(cls))) return 'user';
        if (assistantClasses?.some(cls => el.classList.contains(cls))) return 'assistant';

        if (userAttributes) {
            for (const [attr, val] of Object.entries(userAttributes)) {
                if (el.getAttribute(attr) === val) return 'user';
            }
        }

        if (assistantAttributes) {
            for (const [attr, val] of Object.entries(assistantAttributes)) {
                if (el.getAttribute(attr) === val) return 'assistant';
            }
        }

        // Fallback: even index = user, odd = assistant
        const messages = this.listMessages();
        const index = messages.indexOf(el);
        return index % 2 === 0 ? 'user' : 'assistant';
    }
}

/**
 * Registry for all AI provider adapters.
 */
export class ProviderRegistry {
    private static adapters: Map<string, ProviderAdapter> = new Map();
    private static configs: Map<string, ProviderConfig> = new Map();

    static register(config: ProviderConfig) {
        this.configs.set(config.domain, config);
        this.adapters.set(config.domain, new GenericAdapter(config));
    }

    static registerManual(domain: string, adapter: ProviderAdapter) {
        this.adapters.set(domain, adapter);
    }

    static {
        // Register standard providers
        this.register({
            name: 'openai',
            displayName: 'ChatGPT',
            domain: 'chatgpt.com',
            selectors: {
                container: '[data-testid="conversation-turn-list"], main .flex-col',
                message: 'article[data-testid^="conversation-turn"]',
                input: '#prompt-textarea',
                title: 'title',
                model: '[data-testid="model-info"]'
            },
            roleDetection: {
                userAttributes: { 'data-message-author-role': 'user' },
                assistantAttributes: { 'data-message-author-role': 'assistant' }
            }
        });

        this.register({
            name: 'anthropic',
            displayName: 'Claude',
            domain: 'claude.ai',
            selectors: {
                container: '#main-content, main',
                message: '[data-testid="user-message"], .font-claude-response',
                input: '[contenteditable="true"]',
                title: 'h1'
            },
            roleDetection: {
                userClasses: ['font-user-message'],
                assistantClasses: ['font-claude-response']
            }
        });

        this.register({
            name: 'google',
            displayName: 'Gemini',
            domain: 'gemini.google.com',
            selectors: {
                container: 'infinite-scroller.chat-history',
                message: 'user-query, model-response',
                input: '.ql-editor.textarea'
            },
            roleDetection: {
                userClasses: ['user-query'],
                assistantClasses: ['model-response']
            }
        });

        this.register({
            name: 'google',
            displayName: 'Jules',
            domain: 'jules.google.com',
            selectors: {
                container: '.tasks-container, main',
                message: '.task-container, .task-description',
                input: '.ProseMirror'
            },
            roleDetection: {
                userClasses: ['user-task'],
                assistantClasses: ['jules-task']
            }
        });
    }

    static getAdapter(hostname: string): ProviderAdapter | null {
        const normalized = hostname.replace(/^www\./, '');
        return this.adapters.get(normalized) || null;
    }

    static listDomains(): string[] {
        return Array.from(this.adapters.keys());
    }
}
