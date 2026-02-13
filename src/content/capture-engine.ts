/**
 * Capture Engine
 * 
 * Orchestrates conversation capture using the appropriate provider adapter.
 */

import type { ProviderAdapter } from './adapters/interface';
import type { ConversationGraph, CaptureScope, MessageNode } from '../shared/schema';

export class CaptureEngine {
    private _adapter: ProviderAdapter | null = null;
    private _initialized = false;

    /**
     * Get the adapter, initializing lazily if needed.
     */
    private get adapter(): ProviderAdapter | null {
        if (!this._initialized) {
            this._adapter = (window as any).__bonsaiAdapter ?? null;
            this._initialized = true;
        }
        return this._adapter;
    }

    /**
     * Initialize with the current page's adapter.
     * @deprecated Use lazy initialization via adapter getter
     */
    init(): boolean {
        this._adapter = (window as any).__bonsaiAdapter ?? null;
        this._initialized = true;
        return this._adapter !== null;
    }

    /**
     * Force re-initialization (useful if adapter loaded late).
     */
    reinit(): boolean {
        this._initialized = false;
        return this.adapter !== null;
    }

    /**
     * Get the current adapter.
     */
    getAdapter(): ProviderAdapter | null {
        return this.adapter;
    }

    /**
     * Explicitly set the adapter (fixes import race conditions).
     */
    setAdapter(adapter: ProviderAdapter) {
        this._adapter = adapter;
        this._initialized = true;
    }

    /**
     * Check if capture is available on this page.
     */
    isAvailable(): boolean {
        return this.adapter?.detectConversation() !== null;
    }

    /**
     * Capture based on the specified scope.
     */
    async capture(scope: CaptureScope): Promise<ConversationGraph | null> {
        if (!this.adapter) return null;

        switch (scope.type) {
            case 'entire_conversation':
                return this.captureEntireConversation();
            case 'single_message':
                return this.captureSingleMessage(scope.message_id);
            case 'up_to_message':
                return this.captureUpToMessage(scope.message_id);
            case 'artifacts_only':
                return this.captureArtifactsOnly(scope.artifact_ids);
            default:
                return null;
        }
    }

    /**
     * Capture the entire conversation.
     */
    async captureEntireConversation(): Promise<ConversationGraph | null> {
        return (await this.adapter?.captureConversation()) ?? null;
    }

    /**
     * Capture a single message.
     */
    async captureSingleMessage(messageId: string): Promise<ConversationGraph | null> {
        const full = await this.adapter?.captureConversation();
        if (!full) return null;

        const message = full.messages.find(m => m.message_id === messageId);
        if (!message) return null;

        return {
            ...full,
            messages: [message],
            artifacts: full.artifacts.filter(a => message.artifact_ids.includes(a.artifact_id))
        };
    }

    /**
     * Capture all messages up to and including the specified message.
     */
    async captureUpToMessage(messageId: string): Promise<ConversationGraph | null> {
        const full = await this.adapter?.captureConversation();
        if (!full) return null;

        const index = full.messages.findIndex(m => m.message_id === messageId);
        if (index === -1) return null;

        const messages = full.messages.slice(0, index + 1);
        const artifactIds = new Set(messages.flatMap(m => m.artifact_ids));

        return {
            ...full,
            messages,
            artifacts: full.artifacts.filter(a => artifactIds.has(a.artifact_id))
        };
    }

    /**
     * Capture only specific artifacts.
     */
    async captureArtifactsOnly(artifactIds: string[]): Promise<ConversationGraph | null> {
        const full = await this.adapter?.captureConversation();
        if (!full) return null;

        const artifactSet = new Set(artifactIds);

        return {
            ...full,
            messages: [],
            artifacts: full.artifacts.filter(a => artifactSet.has(a.artifact_id))
        };
    }

    /**
     * Subscribe to new messages and automatically capture them.
     */
    subscribeToNewMessages(callback: (message: MessageNode) => void): () => void {
        if (!this.adapter) return () => { };

        let sequence = this.adapter.listMessages().length;

        return this.adapter.subscribeNewMessages(async (el) => {
            const message = await this.adapter!.parseMessage(el, sequence++);
            callback(message);
        });
    }

    /**
     * Get diagnostics about the current page.
     */
    getDiagnostics(): {
        provider: string | null;
        site: string | null;
        hasConversation: boolean;
        messageCount: number;
        provenance: { provider?: string; model?: string; confidence: string } | null;
    } {
        if (!this.adapter) {
            return {
                provider: null,
                site: null,
                hasConversation: false,
                messageCount: 0,
                provenance: null
            };
        }

        const conversation = this.adapter.detectConversation();

        return {
            provider: this.adapter.providerName,
            site: this.adapter.providerSite,
            hasConversation: conversation !== null,
            messageCount: this.adapter.listMessages().length,
            provenance: this.adapter.getProvenance()
        };
    }
}

// Singleton for easy access
export const captureEngine = new CaptureEngine();
