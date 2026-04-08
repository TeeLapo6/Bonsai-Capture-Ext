/**
 * Markdown Exporter
 * 
 * Exports ConversationGraph to Markdown format.
 * Matches Bonsai's markdown export style.
 */

import type { ConversationGraph, ContentBlock, MessageNode, ArtifactNode } from '../schema';

const ROLE_ICONS: Record<string, string> = {
    user: '👤',
    assistant: '🤖',
    system: '🔧',
    tool: '🔨'
};

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatContentBlock(block: ContentBlock): string {
    switch (block.type) {
        case 'text':
        case 'markdown':
            return block.value;

        case 'html':
            return block.value;

        case 'code':
            return `\`\`\`${block.language}\n${block.value}\n\`\`\``;

        case 'image_ref':
            return `![${block.alt ?? 'image'}](artifact:${block.artifact_id})`;

        case 'table':
            if (block.rows.length === 0) return '';
            const header = block.rows[0];
            const separator = header.map(() => '---').join(' | ');
            const rows = block.rows.slice(1).map(row => row.join(' | ')).join('\n');
            return `${header.join(' | ')}\n${separator}\n${rows}`;

        case 'list':
            return block.items
                .map((item, i) => block.ordered ? `${i + 1}. ${item}` : `- ${item}`)
                .join('\n');

        default:
            return '';
    }
}

function formatMessage(message: MessageNode, artifacts: ArtifactNode[] = []): string {
    const icon = ROLE_ICONS[message.role] ?? '💬';
    const roleLabel = capitalize(message.role);

    let md = `### ${icon} ${roleLabel}\n\n`;

    // Add model info if present
    if (message.origin.model) {
        md += `*Model: ${message.origin.model}*\n\n`;
    }

    // Format content blocks
    const content = message.content_blocks
        .map(formatContentBlock)
        .filter(Boolean)
        .join('\n\n');

    if (content) {
        md += `${content}\n\n`;
    }

    // Inline Artifacts
    const renderedArtifacts = new Set<string>();
    if (artifacts.length > 0) {
        for (const artifact of artifacts) {
            if (renderedArtifacts.has(artifact.artifact_id)) continue;
            renderedArtifacts.add(artifact.artifact_id);

            md += `**${artifact.title || artifact.type}**\n\n`;
            const artifactLinks: string[] = [];
            if (artifact.view_url) {
                artifactLinks.push(`[Open](${artifact.view_url})`);
            }
            if (artifact.source_url && artifact.source_url !== artifact.view_url) {
                artifactLinks.push(`[Source](${artifact.source_url})`);
            }
            if (artifactLinks.length > 0) {
                md += `*Links: ${artifactLinks.join(' | ')}*\n\n`;
            }
            if (artifact.type === 'image' && typeof artifact.content === 'string') {
                md += `![${artifact.title ?? 'image'}](${artifact.content})\n\n`;
            } else if (artifact.type === 'video' && typeof artifact.content === 'string') {
                md += `<video controls src="${artifact.content}"></video>\n\n`;
            } else if (artifact.type === 'file' && typeof artifact.content === 'string' && artifact.content.startsWith('data:')) {
                md += `[Captured file included in HTML export: ${artifact.title ?? 'file'}]\n\n`;
            } else if (artifact.type === 'code_artifact' && typeof artifact.content === 'string') {
                md += `\`\`\`\n${artifact.content}\n\`\`\`\n\n`;
            } else {
                md += `[Artifact: ${artifact.type}]\n\n`;
            }
        }
    }

    // Add timestamp if present
    if (message.created_at) {
        md += `*Timestamp: ${message.created_at}*\n\n`;
    }

    md += '---\n\n';

    return md;
}

export function exportToMarkdown(graph: ConversationGraph): string {
    let md = '';

    // Header
    md += `# ${graph.title ?? 'Conversation'}\n\n`;
    md += `**Captured from:** ${graph.source.provider_site}\n\n`;
    if (graph.source.url) {
        md += `**Source URL:** [${graph.source.url}](${graph.source.url})\n\n`;
    }
    if (graph.source.captured_at) {
        md += `**Captured at:** ${graph.source.captured_at}\n\n`;
    }

    // Provenance
    if (graph.provenance.provider || graph.provenance.model) {
        md += `**Provider:** ${graph.provenance.provider ?? 'unknown'}`;
        if (graph.provenance.model) {
            md += ` (${graph.provenance.model})`;
            md += ` [${graph.provenance.confidence}]`;
        }
        md += `\n\n`;
    }

    md += '---\n\n';
    md += '## Conversation\n\n';

    // Messages
    const renderedArtifactIds = new Set<string>();

    for (const message of graph.messages) {
        const messageArtifacts = graph.artifacts.filter(a => a.source_message_id === message.message_id);
        messageArtifacts.forEach(a => renderedArtifactIds.add(a.artifact_id));

        md += formatMessage(message, messageArtifacts);
    }

    // Artifacts section (remaining)
    const remainingArtifacts = graph.artifacts.filter(a => !renderedArtifactIds.has(a.artifact_id));
    if (remainingArtifacts.length > 0) {
        md += '## Artifacts\n\n';

        for (const artifact of remainingArtifacts) {
            md += `### ${artifact.title ?? artifact.type}\n\n`;
            md += `**Type:** ${artifact.type}\n\n`;

            const artifactLinks: string[] = [];
            if (artifact.view_url) {
                artifactLinks.push(`[Open](${artifact.view_url})`);
            }
            if (artifact.source_url && artifact.source_url !== artifact.view_url) {
                artifactLinks.push(`[Source](${artifact.source_url})`);
            }
            if (artifactLinks.length > 0) {
                md += `**Links:** ${artifactLinks.join(' | ')}\n\n`;
            }

            if (typeof artifact.content === 'string') {
                if (artifact.type === 'image') {
                    md += `![${artifact.title ?? 'artifact'}](${artifact.content})\n\n`;
                } else if (artifact.type === 'video') {
                    md += `<video controls src="${artifact.content}"></video>\n\n`;
                } else if (artifact.type === 'file' && artifact.content.startsWith('data:')) {
                    md += `[Captured file included in HTML export: ${artifact.title ?? 'file'}]\n\n`;
                } else if (artifact.type === 'code_artifact') {
                    md += `\`\`\`\n${artifact.content}\n\`\`\`\n\n`;
                } else {
                    md += `${artifact.content}\n\n`;
                }
            }

            md += '---\n\n';
        }
    }

    // Footer
    md += '\n---\n\n';
    md += '*Exported via Bonsai Capture*\n';

    return md;
}
