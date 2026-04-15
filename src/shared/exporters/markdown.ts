/**
 * Markdown Exporter
 * 
 * Exports ConversationGraph to Markdown format.
 * Matches Bonsai's markdown export style.
 */

import type { ConversationGraph, ContentBlock, MessageNode, ArtifactNode } from '../schema';

export interface MarkdownExportOptions {
    /** 'inline' renders artifact content inside messages; 'appendix' puts a link and renders at end */
    artifactMode?: 'inline' | 'appendix';
}

const ROLE_ICONS: Record<string, string> = {
    user: '👤',
    assistant: '🤖',
    system: '🔧',
    tool: '🔨'
};

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function getArtifactAnchorId(artifact: ArtifactNode): string {
    return `artifact-${artifact.artifact_id}`;
}

/**
 * Derive the heading slug that Obsidian (and most markdown renderers) generate for a
 * heading whose text is `title`.  Algorithm matches Obsidian:
 *   lowercase → strip non-(letter/digit/space/hyphen) → spaces→hyphens
 *   → collapse consecutive hyphens ("Foo - Bar" → "foo-bar", not "foo---bar")
 *   → trim leading/trailing hyphens
 */
function slugifyMarkdownHeading(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function getSourceAnchorId(artifactId: string, sourceIndex: string): string {
    return `artifact-${artifactId}-source-${sourceIndex}`;
}

function rewriteResearchCitations(text: string, artifactId: string): string {
    const citationPattern = /[\[【](\d+)(?:†([^\]】]+))?[\]】]/g;
    return text.replace(citationPattern, (_match, sourceIndex: string, lineInfo?: string) => {
        const title = lineInfo ? `Source ${sourceIndex}, ${lineInfo}` : `Source ${sourceIndex}`;
        const href = `#${getSourceAnchorId(artifactId, sourceIndex)}`;
        return `<sup class="bonsai-citation" title="${title.replace(/"/g, '&quot;')}"><a href="${href}">${sourceIndex}</a></sup>`;
    });
}

function renderDeepResearchContentForMarkdown(artifact: ArtifactNode, content: string): string {
    const trimmed = content.trim();
    if (!trimmed) return '';

    const withSourceIds = trimmed.replace(
        /<(li|span)([^>]*)data-bonsai-source-index="(\d+)"([^>]*)>/g,
        (_match, tagName: string, before: string, sourceIndex: string, after: string) => `<${tagName}${before}data-bonsai-source-index="${sourceIndex}"${after} id="${getSourceAnchorId(artifact.artifact_id, sourceIndex)}">`
    );

    return rewriteResearchCitations(withSourceIds, artifact.artifact_id);
}

/**
 * Walk a DOM node tree and emit Markdown text.
 * Handles the common HTML produced by sanitizeRichHtml for ChatGPT messages:
 * ul/ol lists, strong/em, inline code, pre/code blocks, headings, paragraphs.
 */
function walkNodeToMarkdown(node: Node, listDepth = 0): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const children = (depth = listDepth) =>
        Array.from(el.childNodes).map(n => walkNodeToMarkdown(n, depth)).join('');

    switch (tag) {
        case 'strong': case 'b': return `**${children()}**`;
        case 'em': case 'i': return `_${children()}_`;
        case 'code': {
            // Inside a <pre> block — content will be rendered by the 'pre' case
            if (el.closest('pre')) return el.textContent ?? '';
            return `\`${el.textContent ?? ''}\``;
        }
        case 'pre': {
            const codeEl = el.querySelector('code');
            const lang = (codeEl?.className ?? '').match(/language-(\S+)/)?.[1] ?? '';
            const code = codeEl?.textContent ?? el.textContent ?? '';
            return `\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
        }
        case 'a': {
            const href = el.getAttribute('href') ?? '#';
            const text = children();
            return text.trim() ? `[${text}](${href})` : href;
        }
        case 'h1': return `\n# ${children()}\n\n`;
        case 'h2': return `\n## ${children()}\n\n`;
        case 'h3': return `\n### ${children()}\n\n`;
        case 'h4': return `\n#### ${children()}\n\n`;
        case 'p': return `${children()}\n\n`;
        case 'br': return '\n';
        case 'hr': return '\n---\n\n';
        case 'blockquote': return `> ${children()}\n\n`;
        case 'li': {
            const indent = '  '.repeat(listDepth);
            return `${indent}- ${children(listDepth + 1)}\n`;
        }
        case 'ul': case 'ol':
            return `${children(listDepth)}\n`;
        case 'table':
            // Keep tables as inline HTML — markdown tables are complex
            return `\n${(el as HTMLElement).outerHTML}\n\n`;
        default:
            return children();
    }
}

/**
 * Convert sanitised HTML (from sanitizeRichHtml) to Markdown text.
 * Used by the markdown exporter so that html-type content blocks export cleanly
 * to .md files that render properly in Obsidian and other markdown viewers.
 */
function htmlToMarkdown(html: string): string {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    return walkNodeToMarkdown(doc.body).replace(/\n{3,}/g, '\n\n').trim();
}

function formatContentBlock(block: ContentBlock): string {
    switch (block.type) {
        case 'text':
        case 'markdown':
            return block.value;

        case 'html':
            return htmlToMarkdown(block.value);

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

function formatArtifactContent(artifact: ArtifactNode): string {
    if (artifact.type === 'image' && typeof artifact.content === 'string') {
        return `![${artifact.title ?? 'image'}](${artifact.content})\n\n`;
    } else if (artifact.type === 'video' && typeof artifact.content === 'string') {
        return `<video controls src="${artifact.content}"></video>\n\n`;
    } else if (artifact.type === 'file' && typeof artifact.content === 'string' && artifact.content.startsWith('data:')) {
        return `[Captured file included in HTML export: ${artifact.title ?? 'file'}]\n\n`;
    } else if (artifact.type === 'deep_research' && typeof artifact.content === 'string') {
        return `${renderDeepResearchContentForMarkdown(artifact, artifact.content)}\n\n`;
    } else if (artifact.type === 'code_artifact' && typeof artifact.content === 'string') {
        return `\`\`\`\n${artifact.content}\n\`\`\`\n\n`;
    } else if (typeof artifact.content === 'string') {
        return `${artifact.content}\n\n`;
    }
    return '';
}

function formatArtifactLinks(artifact: ArtifactNode): string {
    const links: string[] = [];
    if (artifact.view_url) links.push(`[Open](${artifact.view_url})`);
    if (artifact.source_url && artifact.source_url !== artifact.view_url) links.push(`[Source](${artifact.source_url})`);
    return links.length > 0 ? `*Links: ${links.join(' | ')}*\n\n` : '';
}

function formatMessage(message: MessageNode, artifacts: ArtifactNode[] = [], artifactMode: 'inline' | 'appendix' = 'inline'): string {
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

    // Artifacts are rendered inline only in inline mode; appendix mode relies on
    // the message reference block plus the appendix section below.
    if (artifactMode === 'inline' && artifacts.length > 0) {
        const renderedArtifacts = new Set<string>();
        for (const artifact of artifacts) {
            if (renderedArtifacts.has(artifact.artifact_id)) continue;
            renderedArtifacts.add(artifact.artifact_id);

            const title = artifact.title || artifact.type;
            md += `### ${title}\n\n`;
            md += `**Type:** ${artifact.type}\n\n`;
            md += formatArtifactLinks(artifact);
            md += formatArtifactContent(artifact);
        }
    }

    // Add timestamp if present
    if (message.created_at) {
        md += `*Timestamp: ${message.created_at}*\n\n`;
    }

    md += '---\n\n';

    return md;
}

export function exportToMarkdown(graph: ConversationGraph, options?: MarkdownExportOptions): string {
    const artifactMode = options?.artifactMode ?? 'inline';
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

    if (graph.artifacts.length > 0) {
        md += `## Artifacts\n\n`;
        graph.artifacts.forEach((artifact, index) => {
            const title = artifact.title ?? artifact.type;
            md += `${index + 1}. <a href="#${getArtifactAnchorId(artifact)}">${title}</a>\n`;
        });
        md += `\n`;
    }

    md += '---\n\n';
    md += '## Conversation\n\n';

    // Messages
    const allRenderedArtifacts: ArtifactNode[] = [];

    for (const message of graph.messages) {
        const messageArtifacts = graph.artifacts.filter(a => a.source_message_id === message.message_id);
        messageArtifacts.forEach(a => allRenderedArtifacts.push(a));

        // Skip messages with no content and no artifacts
        if (message.content_blocks.length === 0 && messageArtifacts.length === 0) continue;

        md += formatMessage(message, messageArtifacts, artifactMode);
    }

    // Collect artifacts that need an appendix entry:
    // In appendix mode: ALL message-linked artifacts + any remaining unlinked artifacts
    // In inline mode: only remaining unlinked artifacts (message-linked ones were rendered inline)
    const renderedArtifactIds = new Set(allRenderedArtifacts.map(a => a.artifact_id));
    const remainingArtifacts = graph.artifacts.filter(a => !renderedArtifactIds.has(a.artifact_id));

    const appendixArtifacts = artifactMode === 'appendix'
        ? graph.artifacts
        : remainingArtifacts;

    // De-duplicate
    const seenIds = new Set<string>();
    const uniqueAppendixArtifacts = appendixArtifacts.filter(a => {
        if (seenIds.has(a.artifact_id)) return false;
        seenIds.add(a.artifact_id);
        return true;
    });

    if (uniqueAppendixArtifacts.length > 0) {
        md += `## ${artifactMode === 'appendix' ? 'Appendix' : 'Artifacts'}\n\n`;

        for (const artifact of uniqueAppendixArtifacts) {
            const title = artifact.title ?? artifact.type;

            // Explicit HTML id keeps same-page links stable across Obsidian and other readers.
            md += `### <a id="${getArtifactAnchorId(artifact)}"></a>${title}\n\n`;
            md += `**Type:** ${artifact.type}\n\n`;

            md += formatArtifactLinks(artifact);
            md += formatArtifactContent(artifact);

            md += '---\n\n';
        }
    }

    // Footer
    md += '\n---\n\n';
    md += '*Exported via Bonsai Capture*\n';

    return md;
}
