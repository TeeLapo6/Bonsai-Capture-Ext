/**
 * Bonsai Capture - Canonical Schema
 * 
 * Core types for representing AI chat conversations in a provider-agnostic format.
 * Designed to map cleanly to Bonsai's Conversation/Message/Attachment models.
 */

// =============================================================================
// Provider Information
// =============================================================================

export type ProviderSite =
    | 'chatgpt.com'
    | 'claude.ai'
    | 'gemini.google.com'
    | 'grok.com'
    | 'unknown';

export type ProviderName =
    | 'openai'
    | 'anthropic'
    | 'google'
    | 'xai'
    | 'unknown';

export type ConfidenceLevel = 'observed' | 'inferred' | 'unknown';

export interface Provenance {
    provider?: ProviderName;
    model?: string;
    confidence: ConfidenceLevel;
}

// =============================================================================
// Content Blocks
// =============================================================================

export interface MarkdownBlock {
    type: 'markdown';
    value: string;
}

export interface TextBlock {
    type: 'text';
    value: string;
}

export interface CodeBlock {
    type: 'code';
    language: string;
    value: string;
}

export interface ImageRefBlock {
    type: 'image_ref';
    artifact_id: string;
    alt?: string;
}

export interface TableBlock {
    type: 'table';
    rows: string[][];
}

export interface ListBlock {
    type: 'list';
    ordered: boolean;
    items: string[];
}

export type ContentBlock =
    | MarkdownBlock
    | TextBlock
    | CodeBlock
    | ImageRefBlock
    | TableBlock
    | ListBlock;

// =============================================================================
// Deep Links
// =============================================================================

export interface DeepLink {
    url: string;
    message_anchor?: string;
    selector_hint?: string;
}

// =============================================================================
// Messages
// =============================================================================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface MessageNode {
    message_id: string;
    role: MessageRole;
    sequence: number;
    created_at?: string;
    origin: Provenance;
    content_blocks: ContentBlock[];
    artifact_ids: string[];
    deep_link: DeepLink;
}

// =============================================================================
// Artifacts
// =============================================================================

export type ArtifactType =
    | 'image'
    | 'embedded_doc'
    | 'artifact_doc'
    | 'deep_research'
    | 'file'
    | 'canvas'
    | 'code_artifact';

export interface ArtifactNode {
    artifact_id: string;
    type: ArtifactType;
    title?: string;
    mime_type?: string;
    /** Base64 for binary content, string for text content, object for structured */
    content: string | Record<string, unknown>;
    source_message_id: string;
    source_url?: string;
    exportable: boolean;
}

// =============================================================================
// Conversation Graph (Root)
// =============================================================================

export interface ConversationSource {
    provider_site: ProviderSite;
    url: string;
    captured_at: string;
    capture_version: string;
}

export interface ConversationGraph {
    conversation_id: string;
    title?: string;
    source: ConversationSource;
    provenance: Provenance;
    messages: MessageNode[];
    artifacts: ArtifactNode[];
}

// =============================================================================
// Capture Scopes
// =============================================================================

export type CaptureScope =
    | { type: 'single_message'; message_id: string }
    | { type: 'up_to_message'; message_id: string }
    | { type: 'entire_conversation' }
    | { type: 'artifacts_only'; artifact_ids: string[] };

// =============================================================================
// Factory Functions
// =============================================================================

export function createEmptyGraph(
    source: ConversationSource,
    provenance: Provenance
): ConversationGraph {
    return {
        conversation_id: crypto.randomUUID(),
        source,
        provenance,
        messages: [],
        artifacts: []
    };
}

export function createMessageNode(
    role: MessageRole,
    sequence: number,
    content: ContentBlock[],
    deepLink: DeepLink,
    origin?: Provenance
): MessageNode {
    return {
        message_id: crypto.randomUUID(),
        role,
        sequence,
        created_at: new Date().toISOString(),
        origin: origin ?? { confidence: 'unknown' },
        content_blocks: content,
        artifact_ids: [],
        deep_link: deepLink
    };
}

export function createTextBlock(value: string): TextBlock {
    return { type: 'text', value };
}

export function createCodeBlock(value: string, language: string = ''): CodeBlock {
    return { type: 'code', language, value };
}

export function createMarkdownBlock(value: string): MarkdownBlock {
    return { type: 'markdown', value };
}
