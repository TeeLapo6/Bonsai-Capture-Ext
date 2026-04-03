/**
 * Capture Engine
 * 
 * Orchestrates conversation capture using the appropriate provider adapter.
 */

import { ProviderRegistry } from './adapters/factory';
import type { ProviderAdapter } from './adapters/interface';
import type { ConversationGraph, CaptureScope, MessageNode, ArtifactNode } from '../shared/schema';

export class CaptureEngine {
    private _adapter: ProviderAdapter | null = null;
    private _initialized = false;

    /**
     * Get the adapter, initializing lazily if needed.
     */
    private get adapter(): ProviderAdapter | null {
        if (!this._initialized) {
            this._adapter = (window as any).__bonsaiAdapter ?? ProviderRegistry.getAdapter(window.location.hostname);
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
            case 'from_message':
                return this.captureFromMessage(scope.message_id);
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

    private async captureGeminiSingleMessage(messageId: string): Promise<ConversationGraph | null> {
        if (!this.adapter) {
            return null;
        }

        const conversation = this.adapter.detectConversation();
        if (!conversation) {
            return null;
        }

        const elements = this.adapter.listMessages();
        const numericIndex = Number(messageId);
        let selectedIndex = -1;
        let selectedElement: Element | null = null;
        let selectedMessage: MessageNode | null = null;

        if (!Number.isNaN(numericIndex) && numericIndex >= 0 && numericIndex < elements.length) {
            selectedIndex = numericIndex;
            selectedElement = elements[selectedIndex];
            selectedMessage = await this.adapter.parseMessage(selectedElement, selectedIndex);
        } else {
            for (const [index, element] of elements.entries()) {
                const parsed = await this.adapter.parseMessage(element, index);
                if (parsed.message_id === messageId) {
                    selectedIndex = index;
                    selectedElement = element;
                    selectedMessage = parsed;
                    break;
                }
            }
        }

        if (!selectedElement || !selectedMessage) {
            return null;
        }

        const artifacts = await this.adapter.parseArtifacts(selectedElement);
        selectedMessage.artifact_ids = [];

        const scopedArtifacts: ArtifactNode[] = artifacts.map((artifact) => {
            selectedMessage!.artifact_ids.push(artifact.artifact_id);

            return {
                ...artifact,
                source_message_id: selectedMessage!.message_id,
            };
        });

        return {
            conversation_id: crypto.randomUUID(),
            title: conversation.title,
            source: {
                provider_site: this.adapter.providerSite as any,
                url: conversation.url,
                captured_at: new Date().toISOString(),
                capture_version: '0.1.0',
            },
            provenance: this.adapter.getProvenance(),
            messages: [selectedMessage],
            artifacts: scopedArtifacts,
        };
    }

    /**
     * Capture a single message.
     */
    async captureSingleMessage(messageId: string): Promise<ConversationGraph | null> {
        if (this.adapter?.providerSite === 'gemini.google.com') {
            const scopedGeminiCapture = await this.captureGeminiSingleMessage(messageId);
            if (scopedGeminiCapture) {
                return scopedGeminiCapture;
            }
        }

        const full = await this.adapter?.captureConversation();
        if (!full) return null;

        let message = full.messages.find(m => m.message_id === messageId);

        if (!message) {
            const index = Number(messageId);
            if (!Number.isNaN(index) && index >= 0 && index < full.messages.length) {
                message = full.messages[index];
            }
        }

        if (!message) return null;

        return {
            ...full,
            messages: [message],
            artifacts: full.artifacts.filter(a => message!.artifact_ids.includes(a.artifact_id))
        };
    }

    /**
     * Capture all messages up to and including the specified message.
     */
    async captureUpToMessage(messageId: string): Promise<ConversationGraph | null> {
        const full = await this.adapter?.captureConversation();
        if (!full) return null;

        let index = full.messages.findIndex(m => m.message_id === messageId);

        if (index === -1) {
            const numericIndex = Number(messageId);
            if (!Number.isNaN(numericIndex) && numericIndex >= 0 && numericIndex < full.messages.length) {
                index = numericIndex;
            }
        }

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
     * Capture this message and all following messages.
     */
    async captureFromMessage(messageId: string): Promise<ConversationGraph | null> {
        const full = await this.adapter?.captureConversation();
        if (!full) return null;

        let index = full.messages.findIndex(m => m.message_id === messageId);

        if (index === -1) {
            const numericIndex = Number(messageId);
            if (!Number.isNaN(numericIndex) && numericIndex >= 0 && numericIndex < full.messages.length) {
                index = numericIndex;
            }
        }

        if (index === -1) return null;

        const messages = full.messages.slice(index);
        const artifactIds = new Set(messages.flatMap(m => m.artifact_ids));

        return {
            ...full,
            messages,
            artifacts: full.artifacts.filter(a => artifactIds.has(a.artifact_id))
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
