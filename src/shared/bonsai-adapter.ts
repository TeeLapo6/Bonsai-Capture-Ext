/**
 * Bonsai Import Adapter
 * 
 * Transforms the internal ConversationGraph into the format expected by
 * the Bonsai Import API.
 */

import { ConversationGraph, MessageNode, ArtifactNode, ContentBlock } from './schema';

// =============================================================================
// Bonsai Import Schema (Matches Backend)
// =============================================================================

export interface BonsaiImportPackage {
    bonsai_version: 'v1';
    conversation: {
        title?: string;
        created_at?: string;
        origin_url: string;
        provider_site: string;
    };
    metadata: {
        provider?: string;
        model?: string;
        system_prompt?: string;
        tags?: string[];
        custom?: Record<string, any>;
    };
    messages: ImportMessage[];
    attachments: ImportAttachment[];
    source_deep_link: string;
    source_map?: {
        message_selectors: Record<string, string>;
        artifact_selectors: Record<string, string>;
    };
}

export interface ImportMessage {
    external_id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: ImportMessageContent;
    model?: string;
    created_at?: string;
    metadata?: Record<string, any>;
}

export type ImportMessageContent =
    | { type: 'text'; content: string }
    | { type: 'multimodal'; text?: string; attachments: ImportAttachmentRef[] };

export interface ImportAttachmentRef {
    attachment_type: 'image' | 'pdf' | 'document' | 'text';
    mime_type: string;
    base64?: string;
    url?: string;
    filename?: string;
}

export interface ImportAttachment {
    external_id: string;
    type: string;
    title?: string;
    mime_type?: string;
    content: string;
    source_message_id: string;
    source_url?: string;
    view_url?: string;
}

// =============================================================================
// Transformation Logic
// =============================================================================

export function toBonsaiImportPackage(graph: ConversationGraph): BonsaiImportPackage {
    const messages: ImportMessage[] = graph.messages.map(msg => transformMessage(msg, graph.artifacts));

    // Embed actual content of artifacts as separate list if needed by schema,
    // though the current backend extracts attachments from Multimodal content.
    // However, the requested schema has a top-level `attachments` list.
    // We will populate it with all artifacts found in the graph.
    const attachments: ImportAttachment[] = graph.artifacts.map(transformArtifact);

    return {
        bonsai_version: 'v1',
        conversation: {
            title: graph.title,
            created_at: graph.source.captured_at || undefined,
            origin_url: graph.source.url,
            provider_site: graph.source.provider_site,
        },
        metadata: {
            provider: graph.provenance.provider,
            model: graph.provenance.model,
            tags: ['import', 'chrome-extension'],
            custom: {
                capture_version: graph.source.capture_version
            }
        },
        messages,
        attachments,
        source_deep_link: graph.source.url,
        source_map: undefined // Could populate with selectors if we tracked them per message
    };
}

function transformMessage(msg: MessageNode, allArtifacts: ArtifactNode[]): ImportMessage {
    let content: ImportMessageContent;

    // Check if we have any artifact references
    const artifactRefs = msg.content_blocks
        .filter(b => b.type === 'image_ref') as any[]; // Type assertion for now

    const hasAttachments = artifactRefs.length > 0 || msg.artifact_ids.length > 0;

    if (hasAttachments) {
        // Collect text parts
        const textParts = msg.content_blocks
            .filter(b => b.type !== 'image_ref')
            .map(blockToString)
            .join('\n\n');

        // Collect attachments
        const attachments: ImportAttachmentRef[] = [];

        // From content blocks (inline images)
        msg.content_blocks.forEach(block => {
            if (block.type === 'image_ref') {
                const artifact = allArtifacts.find(a => a.artifact_id === block.artifact_id);
                if (artifact) {
                    attachments.push({
                        attachment_type: 'image',
                        mime_type: artifact.mime_type || 'image/png',
                        // If content is base64, use it. If it's a URL, use url.
                        base64: typeof artifact.content === 'string' && artifact.content.startsWith('data:')
                            ? artifact.content.split(',')[1]
                            : undefined,
                        url: typeof artifact.content === 'string' && !artifact.content.startsWith('data:')
                            ? artifact.content
                            : undefined,
                        filename: artifact.title
                    });
                }
            }
        });

        // From associated artifact_ids (attachments not inline)
        msg.artifact_ids.forEach(id => {
            // Avoid duplicates if already processed
            if (msg.content_blocks.some(b => b.type === 'image_ref' && b.artifact_id === id)) return;

            const artifact = allArtifacts.find(a => a.artifact_id === id);
            if (artifact) {
                attachments.push({
                    attachment_type: mapArtifactType(artifact.type),
                    mime_type: artifact.mime_type || 'application/octet-stream',
                    base64: typeof artifact.content === 'string' && artifact.content.startsWith('data:')
                        ? artifact.content.split(',')[1]
                        : undefined, // naive base64 check
                    url: typeof artifact.content === 'string' && !artifact.content.startsWith('data:')
                        ? artifact.content
                        : undefined,
                    filename: artifact.title
                });
            }
        });

        content = {
            type: 'multimodal',
            text: textParts || undefined,
            attachments
        };
    } else {
        // Pure text
        content = {
            type: 'text',
            content: msg.content_blocks.map(blockToString).join('\n\n')
        };
    }

    return {
        external_id: msg.message_id,
        role: msg.role,
        content,
        model: msg.origin.model,
        created_at: msg.created_at,
        metadata: {
            deep_link: msg.deep_link,
            original_sequence: msg.sequence
        }
    };
}

function transformArtifact(artifact: ArtifactNode): ImportAttachment {
    // Stringify content if it's an object
    const contentStr = typeof artifact.content === 'string'
        ? artifact.content
        : JSON.stringify(artifact.content);

    return {
        external_id: artifact.artifact_id,
        type: artifact.type,
        title: artifact.title,
        mime_type: artifact.mime_type,
        content: contentStr,
        source_message_id: artifact.source_message_id,
        source_url: artifact.source_url,
        view_url: artifact.view_url
    };
}

function blockToString(block: ContentBlock): string {
    switch (block.type) {
        case 'text':
        case 'markdown':
            return block.value;
        case 'html':
            return block.value;
        case 'code':
            return `\`\`\`${block.language || ''}\n${block.value}\n\`\`\``;
        case 'image_ref':
            return `![${block.alt || 'image'}]`; // Placeholder for text representation
        case 'list':
            return block.items.map((item, i) => block.ordered ? `${i + 1}. ${item}` : `- ${item}`).join('\n');
        case 'table':
            // Simple table rendering (could be improved)
            return block.rows.map(row => `| ${row.join(' | ')} |`).join('\n');
        default:
            return '';
    }
}

function mapArtifactType(type: string): 'image' | 'pdf' | 'document' | 'text' {
    switch (type) {
        case 'image': return 'image';
        case 'embedded_doc': return 'pdf'; // Assumption
        case 'file': return 'document';
        default: return 'text';
    }
}
