/**
 * Bonsai Import Adapter
 * 
 * Transforms the internal ConversationGraph into the format expected by
 * the Bonsai Import API.
 */

import { ConversationGraph, MessageNode, ArtifactNode, ContentBlock } from './schema';
import {
    buildResearchCitationDisplayMap,
    getResearchCitationDisplayNumber,
    rewriteResearchSourceDisplayNumbers,
    splitRawIndexes,
} from './research-citations';

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
    attachment_type: 'image' | 'video' | 'pdf' | 'document' | 'text' | 'code_artifact' | 'deep_research' | 'canvas' | 'rich_document';
    mime_type: string;
    base64?: string;
    url?: string;
    filename?: string;
    metadata?: Record<string, any>;
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
    metadata?: Record<string, any>;
}

interface DeepResearchSource {
    index?: number;
    display_index?: number;
    url?: string;
    title?: string;
    domain?: string;
    snippet?: string;
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
    const customMetadata: Record<string, any> = {
        capture_version: graph.source.capture_version,
    };

    if (graph.source_folder) {
        customMetadata.source_folder = graph.source_folder;
    }

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
            custom: customMetadata,
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
                const attachmentType = mapArtifactType(artifact);
                const metadata = buildArtifactMetadata(artifact);
                const shouldIncludeContentInPayload = isBinaryArtifact(artifact);
                attachments.push({
                    attachment_type: attachmentType,
                    mime_type: artifact.mime_type || 'application/octet-stream',
                    base64: typeof artifact.content === 'string' && shouldIncludeContentInPayload && artifact.content.startsWith('data:')
                        ? artifact.content.split(',')[1]
                        : undefined,
                    url: typeof artifact.content === 'string' && shouldIncludeContentInPayload && !artifact.content.startsWith('data:')
                        ? artifact.content
                        : undefined,
                    filename: artifact.title,
                    ...(metadata ? { metadata } : {}),
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
    const metadata = buildArtifactMetadata(artifact);

    return {
        external_id: artifact.artifact_id,
        type: artifact.type,
        title: artifact.title,
        mime_type: artifact.mime_type,
        content: contentStr,
        source_message_id: artifact.source_message_id,
        source_url: artifact.source_url,
        view_url: artifact.view_url,
        ...(metadata ? { metadata } : {}),
    };
}

// Rewrite raw citation markers ([n†Lxxx], [n,m†Lxxx] and 【n†Lxxx】) to <sup>N</sup>
// for inline message text. Multi-index brackets expand to adjacent <sup> elements.
function rewriteInlineCitations(text: string): string {
    return text.replace(
        /[\[【](\d+(?:[,、 ]\d+)*)(?:†[^\]】]+)?[\]】]/g,
        (_match, rawIndexes: string) =>
            splitRawIndexes(rawIndexes)
                .map((idx) => `<sup>${idx}</sup>`)
                .join('')
    );
}

function blockToString(block: ContentBlock): string {
    switch (block.type) {
        case 'text':
        case 'markdown':
            // Strip artifact reference anchors (e.g. <a href="#artifact-...">Title</a>)
            // The artifacts are already in the top-level attachments array and will
            // render as inline cards in the WebUI.
            // Also convert raw citation markers to superscripts so they render correctly.
            return rewriteInlineCitations(
                block.value.replace(
                    /<a\s+href="#artifact-[^"]*"[^>]*>(.*?)<\/a>/gi,
                    (_match, title) => `📄 ${title}`
                )
            );
        case 'html':
            return rewriteInlineCitations(
                block.value.replace(
                    /<a\s+href="#artifact-[^"]*"[^>]*>(.*?)<\/a>/gi,
                    (_match, title) => `📄 ${title}`
                )
            );
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

function buildArtifactMetadata(artifact: ArtifactNode): Record<string, any> | undefined {
    const meta: Record<string, any> = {};

    // For code artifacts, extract language from content or mime_type
    if (artifact.type === 'code_artifact') {
        if (typeof artifact.content === 'object' && artifact.content !== null) {
            const obj = artifact.content as Record<string, any>;
            if (obj.language) meta.language = obj.language;
        }
        if (!meta.language && artifact.mime_type) {
            // e.g. text/javascript → javascript
            const langFromMime = artifact.mime_type.replace(/^text\//, '').replace(/^application\//, '');
            if (langFromMime && langFromMime !== 'plain') meta.language = langFromMime;
        }
    }

    if (artifact.type === 'deep_research') {
        const prepared = prepareDeepResearchMetadata(artifact);

        if (prepared.content) meta.content = prepared.content;
        if (prepared.sources.length > 0) meta.sources = prepared.sources;
        if (prepared.citations) meta.citations = prepared.citations;
        if (artifact.source_url) meta.source_url = artifact.source_url;
        if (artifact.view_url) meta.view_url = artifact.view_url;
    }

    if ((artifact.type === 'artifact_doc' || artifact.type === 'embedded_doc' || artifact.type === 'file' || artifact.type === 'canvas')
        && typeof artifact.content === 'string') {
        meta.content = artifact.content;
        if (artifact.mime_type) {
            meta.mime_type = artifact.mime_type;
        }
        if (looksLikeInteractiveHtml(artifact.content, artifact.mime_type)) {
            meta.interactive_html = true;
        }
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
}

function looksLikeInteractiveHtml(content: string, mimeType?: string): boolean {
    const normalizedMime = (mimeType || '').toLowerCase();

    // Strong signal: the artifact's declared MIME type is text/html.
    // If the content is substantial enough to be a real HTML document
    // (rather than a trivial snippet), treat it as interactive so the
    // viewer renders it in a sandboxed iframe instead of as raw Markdown.
    if (normalizedMime.includes('text/html') || normalizedMime.includes('application/xhtml+xml')) {
        return true;
    }

    const normalized = content.toLowerCase();

    if (!(normalized.includes('<html') || normalized.includes('<!doctype'))) {
        return false;
    }

    if (!normalized.includes('<script')) {
        return false;
    }

    return normalized.includes('<canvas')
        || normalized.includes('chart.js')
        || normalized.includes('plotly')
        || normalized.includes('d3')
        || normalized.includes('type="range"')
        || normalized.includes("type='range'")
        || normalized.includes('oninput=')
        || normalized.includes('onclick=')
        || normalized.includes('addeventlistener(');
}

function prepareDeepResearchMetadata(artifact: ArtifactNode): {
    content?: string;
    sources: DeepResearchSource[];
    citations?: any;
} {
    const content = getDeepResearchContentString(artifact);
    const displayMap = content ? buildResearchCitationDisplayMap(content) : new Map<number, number>();
    const decoratedContent = content ? decorateDeepResearchContent(content, artifact.artifact_id, displayMap) : undefined;
    const structured = getStructuredDeepResearchData(artifact);
    const sources = structured.sources.length > 0
        ? structured.sources.map((source) => ({
            ...source,
            ...(source.index != null && displayMap.has(source.index)
                ? { display_index: getResearchCitationDisplayNumber(source.index, displayMap) }
                : {}),
        }))
        : extractDeepResearchSources(decoratedContent || content || '', displayMap);

    return {
        content: decoratedContent,
        sources,
        citations: structured.citations,
    };
}

function getDeepResearchContentString(artifact: ArtifactNode): string | undefined {
    if (typeof artifact.content === 'string') {
        return artifact.content;
    }

    if (artifact.content && typeof artifact.content === 'object') {
        const obj = artifact.content as Record<string, any>;
        if (typeof obj.content === 'string') {
            return obj.content;
        }
    }

    return undefined;
}

function getStructuredDeepResearchData(artifact: ArtifactNode): {
    sources: DeepResearchSource[];
    citations?: any;
} {
    if (!artifact.content || typeof artifact.content !== 'object') {
        return { sources: [] };
    }

    const obj = artifact.content as Record<string, any>;
    const sources = Array.isArray(obj.sources)
        ? obj.sources
            .map(source => normalizeDeepResearchSource(source))
            .filter((source): source is DeepResearchSource => !!source)
        : [];

    return {
        sources,
        citations: obj.citations,
    };
}

function normalizeDeepResearchSource(source: unknown): DeepResearchSource | undefined {
    if (!source || typeof source !== 'object') {
        return undefined;
    }

    const value = source as Record<string, any>;
    const index = toNumericIndex(value.index ?? value.source_index ?? value.number);
    const url = typeof value.url === 'string'
        ? value.url
        : typeof value.href === 'string'
            ? value.href
            : undefined;
    const title = typeof value.title === 'string'
        ? value.title
        : typeof value.name === 'string'
            ? value.name
            : undefined;
    const snippet = typeof value.snippet === 'string' ? value.snippet : undefined;
    const domain = typeof value.domain === 'string' ? value.domain : inferDomain(url);

    if (index == null && !url && !title && !snippet) {
        return undefined;
    }

    return {
        ...(index != null ? { index } : {}),
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
        ...(domain ? { domain } : {}),
        ...(snippet ? { snippet } : {}),
    };
}

function decorateDeepResearchContent(content: string, artifactId: string, displayMap: Map<number, number>): string {
    console.log(`[Bonsai Citation Debug] decorateDeepResearchContent displayMap:`, Array.from(displayMap.entries()));
    const withAnchors = content.replace(
        /<(li|span)([^>]*\bdata-bonsai-source-index="(\d+)"[^>]*)>/gi,
        (match, tagName, attrs, index) => {
            if (/\sid=/.test(attrs)) {
                return match;
            }

            return `<${tagName}${attrs} id="${getDeepResearchSourceAnchorId(artifactId, index)}">`;
        }
    );

    const withDisplayLabels = rewriteResearchSourceDisplayNumbers(withAnchors, displayMap);

    // Pass 1: bracket markers 【N†source】 and [N†source]
    let result = withDisplayLabels.replace(
        /[\[【](\d+(?:[,、 ]\d+)*)(?:†([^\]】]+))?[\]】]/g,
        (_match, rawIndexes: string, lineInfo?: string) => {
            return splitRawIndexes(rawIndexes).map((numericIndex) => {
                const displayIndex = getResearchCitationDisplayNumber(numericIndex, displayMap);
                const title = lineInfo ? `Source ${displayIndex}, ${lineInfo}` : `Source ${displayIndex}`;
                const sourceAnchor = getDeepResearchSourceAnchorId(artifactId, numericIndex);
                return `<sup class="bonsai-citation" title="${title}"><a href="#${sourceAnchor}">${displayIndex}</a></sup>`;
            }).join(', ');
        }
    );

    // Pass 2: bare HTML citations <sup><a href="#...">N</a></sup> or <sup>N</sup>
    // that survived without being converted to bracket markers.
    // Skip elements already rewritten (class="bonsai-citation") and skip <sup>
    // elements inside source list entries (those are source labels, not inline citations).
    const sourcesSections = result.split(/(<section\s[^>]*data-bonsai-(?:observed-)?sources[^>]*>[\s\S]*?<\/section>)/gi);
    result = sourcesSections.map((part, partIndex) => {
        // Odd segments are the captured source sections — leave untouched
        if (partIndex % 2 === 1) return part;

        const withIndexedSupCitations = part.replace(
            /<sup\b(?![^>]*class="bonsai-citation")[^>]*\bdata-citation-index="(\d+)"[^>]*>[\s\S]*?<\/sup>/gi,
            (match, rawIndex: string) => {
                const numericIndex = Number.parseInt(rawIndex, 10);
                if (!Number.isFinite(numericIndex) || numericIndex <= 0) return match;

                const displayIndex = getResearchCitationDisplayNumber(numericIndex, displayMap);
                const title = `Source ${displayIndex}`;
                const sourceAnchor = getDeepResearchSourceAnchorId(artifactId, numericIndex);
                return `<sup class="bonsai-citation" title="${title}"><a href="#${sourceAnchor}">${displayIndex}</a></sup>`;
            }
        );

        return withIndexedSupCitations.replace(
            /<sup(?![^>]*class="bonsai-citation")[^>]*>(?:<a\s[^>]*>)?(\d+(?:[,、 ]\d+)*)(?:<\/a>)?<\/sup>/gi,
            (match, rawIndexes: string) => {
                const indexes = splitRawIndexes(rawIndexes);
                if (indexes.length === 0) return match;

                return indexes.map((numericIndex) => {
                    const displayIndex = getResearchCitationDisplayNumber(numericIndex, displayMap);
                    const title = `Source ${displayIndex}`;
                    const sourceAnchor = getDeepResearchSourceAnchorId(artifactId, numericIndex);
                    return `<sup class="bonsai-citation" title="${title}"><a href="#${sourceAnchor}">${displayIndex}</a></sup>`;
                }).join(', ');
            }
        );
    }).join('');

    // Add comma separators between adjacent citation pills
    return result.replace(/<\/sup>\s*(?=<sup class="bonsai-citation")/gi, '</sup>, ');
}

function extractDeepResearchSources(content: string, displayMap: Map<number, number>): DeepResearchSource[] {
    const matches = content.match(/<li\b[\s\S]*?<\/li>/gi) || [];
    const seen = new Set<string>();
    const sources: DeepResearchSource[] = [];

    for (const item of matches) {
        const indexMatch = item.match(/data-bonsai-source-index="(\d+)"/i);
        if (!indexMatch) {
            continue;
        }

        const index = Number.parseInt(indexMatch[1], 10);
        const linkMatch = item.match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const url = linkMatch?.[1];
        const title = decodeHtmlEntities(stripHtml(linkMatch?.[2] || item)) || undefined;
        const source: DeepResearchSource = {
            index,
            ...(displayMap.has(index) ? { display_index: getResearchCitationDisplayNumber(index, displayMap) } : {}),
            ...(url ? { url } : {}),
            ...(title ? { title } : {}),
            ...(inferDomain(url) ? { domain: inferDomain(url) } : {}),
        };
        const dedupeKey = `${source.index ?? 'na'}:${source.url ?? source.title ?? ''}`;
        if (seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);
        sources.push(source);
    }

    return sources;
}

function getDeepResearchSourceAnchorId(artifactId: string, sourceIndex: string | number): string {
    return `artifact-${artifactId}-source-${sourceIndex}`;
}

function stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .trim();
}

function inferDomain(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }

    try {
        return new URL(value).hostname.replace(/^www\./, '');
    } catch {
        return undefined;
    }
}

function toNumericIndex(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string' && value.trim()) {
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    return undefined;
}

function mapArtifactType(artifact: ArtifactNode): ImportAttachmentRef['attachment_type'] {
    const type = artifact.type;
    const mimeType = (artifact.mime_type || '').toLowerCase();

    switch (type) {
        case 'image': return 'image';
        case 'video': return 'video';
        case 'embedded_doc': return 'rich_document';
        case 'artifact_doc': return 'rich_document';
        case 'file': return mimeType.includes('text/html') || mimeType.includes('application/xhtml+xml')
            ? 'rich_document'
            : 'document';
        case 'code_artifact': return 'code_artifact';
        case 'deep_research': return 'deep_research';
        case 'canvas': return 'canvas';
        default: return 'text';
    }
}

/**
 * Binary artifacts (image, video) use the url/base64 fields on the attachment
 * ref for inline rendering. Document artifacts (artifact_doc, code_artifact, etc.)
 * carry their content via metadata.content — we should NOT stuff raw text/HTML
 * into the url field because the backend may interpret it as a redirectable URL,
 * truncate it, or reject it outright.
 */
function isBinaryArtifact(artifact: ArtifactNode): boolean {
    return artifact.type === 'image' || artifact.type === 'video';
}
