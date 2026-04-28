import type { ArtifactNode, ContentBlock, ConversationGraph, MessageNode } from './schema';
import { markdownToHtml } from './markdown-to-html';
import {
    buildResearchCitationDisplayMap,
    getResearchCitationDisplayNumber,
    rewriteResearchSourceDisplayNumbers,
    splitRawIndexes,
} from './research-citations';

export interface RenderConversationOptions {
    artifactMode?: 'inline' | 'appendix';
    interactiveHtmlMode?: 'render' | 'code' | 'fallback';
}

const ROLE_LABELS: Record<MessageNode['role'], string> = {
    user: 'User',
    assistant: 'Assistant',
    system: 'System',
    tool: 'Tool',
};

const PREVIEW_STYLES = `<style data-bonsai-preview-styles="true">
.bonsai-gemini-structured,
.bonsai-deep-research {
    line-height: 1.65;
    color: #1f2937;
}

.bonsai-gemini-structured h2,
.bonsai-deep-research h2 {
    display: inline-block;
    margin: 1.35rem 0 0.8rem;
    padding: 0.32rem 0.72rem;
    border: 1px solid #bfdbfe;
    border-radius: 999px;
    background: #eff6ff;
    color: #1d4ed8;
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.bonsai-gemini-structured h3,
.bonsai-deep-research h3 {
    margin: 1rem 0 0.55rem;
    padding-left: 0.75rem;
    border-left: 3px solid #60a5fa;
    color: #0f172a;
    font-size: 1rem;
}

.bonsai-gemini-structured section,
.bonsai-deep-research section,
.bonsai-deep-research [data-bonsai-sources="true"] {
    margin-top: 1rem;
}

.bonsai-deep-research [data-bonsai-sources="true"] {
    padding: 1rem 1.1rem;
    border: 1px solid #dbe4ee;
    border-radius: 12px;
    background: #fbfdff;
}

.bonsai-gemini-structured p,
.bonsai-deep-research p {
    margin: 0.6rem 0;
}

.bonsai-deep-research ul {
    padding-left: 1.2rem;
}

.bonsai-deep-research li {
    margin: 0.45rem 0;
}

.bonsai-deep-research li:has(img) {
    list-style: none;
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 0.8rem;
    align-items: start;
    margin: 0.55rem 0;
    padding: 0.75rem 0.9rem;
    border: 1px solid #dbe4ee;
    border-radius: 12px;
    background: #ffffff;
}

.bonsai-deep-research li:has(img) img,
.bonsai-deep-research [data-bonsai-sources="true"] img {
    width: 28px !important;
    height: 28px !important;
    max-width: 28px !important;
    max-height: 28px !important;
    object-fit: contain;
    border-radius: 6px;
    margin: 0;
}

.bonsai-deep-research li:has(img) > * {
    margin: 0;
}

.bonsai-deep-research a {
    word-break: break-word;
}

sup.bonsai-citation {
    font-size: 0.72em;
    line-height: 1;
    vertical-align: super;
    margin: 0 0.08em;
    white-space: nowrap;
}

sup.bonsai-citation a {
    color: #1d4ed8;
    text-decoration: none;
    padding: 0.05em 0.22em;
    border: 1px solid #bfdbfe;
    border-radius: 3px;
    background: #eff6ff;
}

sup.bonsai-citation a:hover {
    background: #dbeafe;
    text-decoration: none;
}

sup.bonsai-citation + sup.bonsai-citation {
    margin-left: 0.05em;
}

.bonsai-artifact-index {
    margin: 0.8rem 0;
    padding: 0.6rem 1rem;
    border: 1px solid #dbe4ee;
    border-radius: 10px;
    background: #f8fafc;
    font-size: 0.92rem;
}

.bonsai-artifact-index summary {
    cursor: pointer;
    padding: 0.15rem 0;
    list-style: none;
    user-select: none;
}

.bonsai-artifact-index summary::marker,
.bonsai-artifact-index summary::-webkit-details-marker {
    display: none;
}

.bonsai-artifact-index summary::before {
    content: '▶';
    font-size: 0.7rem;
    margin-right: 0.4rem;
    transition: transform 0.15s;
    display: inline-block;
}

.bonsai-artifact-index[open] summary::before {
    transform: rotate(90deg);
}

.bonsai-artifact-index ol {
    margin: 0.5rem 0 0.2rem;
    padding-left: 1.6rem;
}

.bonsai-artifact-index li {
    margin: 0.25rem 0;
}

.bonsai-artifact-index a {
    color: #1d4ed8;
    text-decoration: none;
}

.bonsai-artifact-index a:hover {
    text-decoration: underline;
}
</style>`;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function renderPlainText(value: string): string {
    if (!value.trim()) return '';

    return value
        .trim()
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

function wrapGeminiStructuredHtml(html: string): string {
    return `<div class="bonsai-gemini-structured">${html}</div>`;
}

function wrapDeepResearchHtml(html: string): string {
    return `<div class="bonsai-deep-research">${html}</div>`;
}

function shouldRenderArtifactAsMarkdown(artifact: ArtifactNode): boolean {
    const mimeType = (artifact.mime_type ?? '').split(';')[0].trim().toLowerCase();

    return mimeType === 'text/markdown'
        || mimeType === 'text/x-markdown'
        || (artifact.type === 'deep_research' && typeof artifact.content === 'string' && mimeType !== 'text/html');
}

function looksLikeInteractiveHtmlArtifact(artifact: ArtifactNode): boolean {
    if (typeof artifact.content !== 'string') {
        return false;
    }

    const mimeType = (artifact.mime_type ?? '').split(';')[0].trim().toLowerCase();
    const content = artifact.content.toLowerCase();

    if (!(mimeType === 'text/html' || /<(?:!doctype|html|body|main|section|div)\b/i.test(artifact.content))) {
        return false;
    }

    if (!content.includes('<script')) {
        return false;
    }

    return content.includes('<canvas')
        || content.includes('chart.js')
        || content.includes('plotly')
        || content.includes('d3')
        || content.includes('type="range"')
        || content.includes("type='range'")
        || content.includes('oninput=')
        || content.includes('onclick=')
        || content.includes('addeventlistener(');
}

function extractFirstInlineImageFromHtml(html: string): string | null {
    const match = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
    if (!match || !match[1]) {
        return null;
    }
    return match[1];
}

function rewriteResearchCitations(
    html: string,
    artifactId: string,
    sourceIndexes: Set<number>,
    displayMap: Map<number, number>
): string {
    const protectedSegments = html.split(/(<pre[\s\S]*?<\/pre>)/gi);

    return protectedSegments
        .map((segment, index) => {
            if (index % 2 === 1) {
                return segment;
            }

            // Pass 1: bracket markers 【N†source】 and [N†source]
            let result = segment.replace(/[\[【](\d+(?:[,、 ]\d+)*)(?:†([^\]】]+))?[\]】]/g, (_, rawIndexes: string, lineInfo?: string) => {
                const indexes = splitRawIndexes(rawIndexes);

                return indexes.map((sourceIndex) => {
                    const displayIndex = getResearchCitationDisplayNumber(sourceIndex, displayMap);
                    const title = lineInfo
                        ? `Source ${displayIndex}, ${lineInfo}`
                        : `Source ${displayIndex}`;

                    if (sourceIndexes.has(sourceIndex)) {
                        return `<sup class="bonsai-citation" title="${escapeAttribute(title)}"><a href="#artifact-${escapeAttribute(artifactId)}-source-${sourceIndex}">${escapeHtml(String(displayIndex))}</a></sup>`;
                    }

                    return `<sup class="bonsai-citation" title="${escapeAttribute(title)}">${escapeHtml(String(displayIndex))}</sup>`;
                }).join(', ');
            });

            // Pass 2: bare HTML citations <sup><a href="#...">N</a></sup> or <sup>N</sup>
            // that survived without being converted to bracket markers (e.g. from probe data).
            // Skip elements already rewritten (class="bonsai-citation") and skip <sup>
            // elements inside source list <li data-bonsai-source-index> entries (those are
            // source labels, not inline citations).
            const sourcesSections = result.split(/(<section\s[^>]*data-bonsai-(?:observed-)?sources[^>]*>[\s\S]*?<\/section>)/gi);
            result = sourcesSections.map((part, partIndex) => {
                // Odd segments are the captured source sections — leave untouched
                if (partIndex % 2 === 1) return part;

                const withIndexedSupCitations = part.replace(
                    /<sup\b(?![^>]*class="bonsai-citation")[^>]*\bdata-citation-index="(\d+)"[^>]*>[\s\S]*?<\/sup>/gi,
                    (match, rawIndex: string) => {
                        const sourceIndex = Number.parseInt(rawIndex, 10);
                        if (!Number.isFinite(sourceIndex) || sourceIndex <= 0) return match;

                        const displayIndex = getResearchCitationDisplayNumber(sourceIndex, displayMap);
                        const title = `Source ${displayIndex}`;
                        if (sourceIndexes.has(sourceIndex)) {
                            return `<sup class="bonsai-citation" title="${escapeAttribute(title)}"><a href="#artifact-${escapeAttribute(artifactId)}-source-${sourceIndex}">${escapeHtml(String(displayIndex))}</a></sup>`;
                        }

                        return `<sup class="bonsai-citation" title="${escapeAttribute(title)}">${escapeHtml(String(displayIndex))}</sup>`;
                    }
                );

                return withIndexedSupCitations.replace(
                    /<sup(?![^>]*class="bonsai-citation")[^>]*>(?:<a\s[^>]*>)?(\d+(?:[,、 ]\d+)*)(?:<\/a>)?<\/sup>/gi,
                    (match, rawIndexes: string) => {
                        const numericIndexes = splitRawIndexes(rawIndexes);
                        if (numericIndexes.length === 0) return match;

                        return numericIndexes.map((sourceIndex) => {
                            const displayIndex = getResearchCitationDisplayNumber(sourceIndex, displayMap);
                            const title = `Source ${displayIndex}`;
                            if (sourceIndexes.has(sourceIndex)) {
                                return `<sup class="bonsai-citation" title="${escapeAttribute(title)}"><a href="#artifact-${escapeAttribute(artifactId)}-source-${sourceIndex}">${escapeHtml(String(displayIndex))}</a></sup>`;
                            }
                            return `<sup class="bonsai-citation" title="${escapeAttribute(title)}">${escapeHtml(String(displayIndex))}</sup>`;
                        }).join(', ');
                    }
                );
            }).join('');

            // Add comma separators between adjacent citation pills
            return result.replace(/<\/sup>\s*(?=<sup class="bonsai-citation")/gi, '</sup>, ');
        })
        .join('');
}

function decorateRenderedResearchHtml(artifactId: string, html: string, sourceIndexes: Set<number>): string {
    const displayMap = buildResearchCitationDisplayMap(html);

    html = html.replace(
        /<(li|span)([^>]*)data-bonsai-source-index="(\d+)"([^>]*)>/g,
        (_, tagName: string, before: string, sourceIndex: string, after: string) => `<${tagName}${before}data-bonsai-source-index="${sourceIndex}"${after} id="artifact-${escapeAttribute(artifactId)}-source-${sourceIndex}">`
    );

    html = rewriteResearchSourceDisplayNumbers(html, displayMap);

    return rewriteResearchCitations(html, artifactId, sourceIndexes, displayMap);
}

function renderResearchMarkdown(artifact: ArtifactNode, markdown: string): string {
    const sourceIndexes = new Set(
        Array.from(markdown.matchAll(/data-bonsai-source-index="(\d+)"/g), (match) => Number(match[1]))
    );

    const rawInlineIndexes = Array.from(markdown.matchAll(/[\[【](\d+(?:[,、 ]\d+)*)(?:†[^\]】]+)?[\]】]/g))
        .flatMap((match) => splitRawIndexes(match[1]));

    const rendered = decorateRenderedResearchHtml(
        artifact.artifact_id,
        markdownToHtml(markdown.trim()),
        sourceIndexes
    );

    const renderedInline = Array.from(rendered.matchAll(/class="bonsai-citation"[^>]*><a href="#artifact-[^"]+-source-(\d+)">(\d+)<\/a>/g))
        .slice(0, 16)
        .map((match) => ({
            sourceIndex: Number(match[1]),
            displayIndex: Number(match[2]),
        }));

    if (rawInlineIndexes.length > 0 && sourceIndexes.size > 0) {
        console.log('[Bonsai Citation Debug] Render markdown artifact', {
            artifactId: artifact.artifact_id,
            rawInlineIndexes: rawInlineIndexes.slice(0, 16),
            sourceIndexes: Array.from(sourceIndexes).slice(0, 16),
            renderedInline,
        });
    }

    return wrapDeepResearchHtml(
        rendered
    );
}

function renderResearchHtml(artifact: ArtifactNode, html: string): string {
    const sourceIndexes = new Set(
        Array.from(html.matchAll(/data-bonsai-source-index="(\d+)"/g), (match) => Number(match[1]))
    );

    return wrapDeepResearchHtml(decorateRenderedResearchHtml(artifact.artifact_id, html, sourceIndexes));
}

function getArtifactDownloadName(artifact: ArtifactNode): string {
    const baseName = (artifact.title ?? artifact.type)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'captured-artifact';

    const extension = (() => {
        switch ((artifact.mime_type ?? '').split(';')[0].trim().toLowerCase()) {
            case 'application/pdf':
                return 'pdf';
            case 'text/html':
                return 'html';
            case 'text/plain':
                return 'txt';
            case 'application/json':
                return 'json';
            case 'image/svg+xml':
                return 'svg';
            case 'video/mp4':
                return 'mp4';
            case 'video/webm':
                return 'webm';
            case 'video/quicktime':
                return 'mov';
            default:
                return 'bin';
        }
    })();

    if (/\.[a-z0-9]{2,8}$/i.test(baseName)) {
        return baseName;
    }

    return `${baseName}.${extension}`;
}

function shouldRenderArtifactInAppendix(artifact: ArtifactNode, artifactMode: 'inline' | 'appendix' = 'appendix'): boolean {
    if (artifactMode === 'inline') {
        return false;
    }

    if (artifact.type === 'code_artifact') {
        return typeof artifact.content === 'string' && artifact.content.trim().length > 0;
    }

    if (artifact.type === 'deep_research' || artifact.type === 'file') {
        return true;
    }

    if (artifact.mime_type === 'text/html' && typeof artifact.content === 'string' && artifact.content.length > 1200) {
        return true;
    }

    if (artifact.type === 'artifact_doc' && (artifact.view_url || artifact.source_url)) {
        return true;
    }

    if (artifact.type === 'artifact_doc' && typeof artifact.content === 'string' && artifact.content.length > 1800) {
        return true;
    }

    return false;
}

function renderLinks(artifact: ArtifactNode): string {
    const links: string[] = [];

    const hasInlineDeepResearchContent = artifact.type === 'deep_research'
        && typeof artifact.content === 'string'
        && artifact.content.trim().length > 0;

    const isIrrelevantResearchUrl = (url: string | undefined): boolean => {
        if (!url) return true;
        return /web-sandbox\.oaiusercontent\.com|chatgpt\.com\/(g|c)\//i.test(url);
    };

    if (hasInlineDeepResearchContent) {
        return '';
    }

    if (artifact.view_url && !(artifact.type === 'deep_research' && isIrrelevantResearchUrl(artifact.view_url))) {
        links.push(`<a href="${escapeAttribute(artifact.view_url)}" target="_blank" rel="noreferrer">Open</a>`);
    }

    if (artifact.source_url
        && artifact.source_url !== artifact.view_url
        && !(artifact.type === 'deep_research' && isIrrelevantResearchUrl(artifact.source_url))) {
        // For deep-research and research-type artifacts, the source URL is the actual report URL
        const isResearch = artifact.type === 'deep_research' || /research|report/i.test(artifact.title ?? '');
        const sourceLabel = artifact.type === 'image'
            ? 'Source'
            : isResearch
                ? 'View Report'
                : 'Download';
        links.push(`<a href="${escapeAttribute(artifact.source_url)}" target="_blank" rel="noreferrer">${sourceLabel}</a>`);
    }

    return links.length > 0 ? `<p><em>Links: ${links.join(' | ')}</em></p>` : '';
}

function renderArtifact(artifact: ArtifactNode, interactiveHtmlMode: 'render' | 'code' | 'fallback' = 'code'): string {
    let html = `<section data-artifact-id="${escapeAttribute(artifact.artifact_id)}">`;
    html += `<h3 id="artifact-${escapeAttribute(artifact.artifact_id)}" data-artifact-id="${escapeAttribute(artifact.artifact_id)}">${escapeHtml(artifact.title ?? artifact.type)}</h3>`;
    html += renderLinks(artifact);

    if (artifact.type === 'image' && typeof artifact.content === 'string') {
        html += `<p><img src="${escapeAttribute(artifact.content)}" alt="${escapeAttribute(artifact.title ?? 'image')}" /></p>`;
        html += '</section>';
        return html;
    }

    if (artifact.type === 'video' && typeof artifact.content === 'string') {
        const title = artifact.title ?? 'video';
        html += `<video controls preload="metadata" playsinline src="${escapeAttribute(artifact.content)}" title="${escapeAttribute(title)}" style="display:block; width:100%; max-height:540px; border-radius:8px; background:#000;"></video>`;

        if (artifact.content.startsWith('data:')) {
            const downloadName = getArtifactDownloadName(artifact);
            html += `<p><a href="${escapeAttribute(artifact.content)}" download="${escapeAttribute(downloadName)}">Download captured video</a></p>`;
        }

        html += '</section>';
        return html;
    }

    if (artifact.type === 'file' && typeof artifact.content === 'string' && artifact.content.startsWith('data:')) {
        const downloadName = getArtifactDownloadName(artifact);
        html += `<p><a href="${escapeAttribute(artifact.content)}" download="${escapeAttribute(downloadName)}">Download captured file</a></p>`;

        if ((artifact.mime_type ?? '').startsWith('application/pdf')) {
            html += `<p><iframe src="${escapeAttribute(artifact.content)}" title="${escapeAttribute(artifact.title ?? downloadName)}" style="width:100%; min-height:640px; border:1px solid #d0d7de; border-radius:8px;"></iframe></p>`;
        }

        html += '</section>';
        return html;
    }

    if (artifact.type === 'code_artifact' && typeof artifact.content === 'string') {
        html += `<pre><code>${escapeHtml(artifact.content)}</code></pre>`;
        html += '</section>';
        return html;
    }

    if (shouldRenderArtifactAsMarkdown(artifact) && typeof artifact.content === 'string') {
        html += renderResearchMarkdown(artifact, artifact.content);
        html += '</section>';
        return html;
    }

    if (artifact.type === 'deep_research' && artifact.mime_type === 'text/html' && typeof artifact.content === 'string') {
        html += renderResearchHtml(artifact, artifact.content);
        html += '</section>';
        return html;
    }

    if (looksLikeInteractiveHtmlArtifact(artifact)) {
        if (interactiveHtmlMode === 'render') {
            html += artifact.content as string;
            html += '</section>';
            return html;
        }

        if (interactiveHtmlMode === 'code') {
            html += '<p><em>Interactive HTML artifact captured. Showing source for fidelity in sidepanel preview.</em></p>';
            html += `<pre><code class="language-html">${escapeHtml((artifact.content as string).trim())}</code></pre>`;
            html += '</section>';
            return html;
        }

        const inlineImage = extractFirstInlineImageFromHtml(artifact.content as string);

        html += '<p><em>Interactive HTML artifact captured. Live execution is disabled in the sidepanel preview, so a static fallback is shown.</em></p>';
        if (inlineImage) {
            html += `<p><img src="${escapeAttribute(inlineImage)}" alt="${escapeAttribute(artifact.title ?? 'interactive artifact snapshot')}" /></p>`;
        }

        html += '<p><em>Tip: Use Open/View link above to inspect the full interactive document.</em></p>';
        html += '</section>';
        return html;
    }

    if (artifact.mime_type === 'text/html' && typeof artifact.content === 'string') {
        html += artifact.content;
        html += '</section>';
        return html;
    }

    if (typeof artifact.content === 'string' && artifact.content.trim()) {
        html += renderPlainText(artifact.content);
        html += '</section>';
        return html;
    }

    if (artifact.content && typeof artifact.content === 'object') {
        html += `<pre><code>${escapeHtml(JSON.stringify(artifact.content, null, 2))}</code></pre>`;
        html += '</section>';
        return html;
    }

    // No renderable content — show a note pointing to the view link if one exists
    if (artifact.view_url || artifact.source_url) {
        const linkUrl = artifact.view_url ?? artifact.source_url!;
        html += `<p><em>Content not captured inline. <a href="${escapeAttribute(linkUrl)}" target="_blank" rel="noreferrer">Open the full report</a> to view it.</em></p>`;
    } else {
        html += `<p><em>No content captured for this artifact.</em></p>`;
    }

    html += '</section>';
    return html;
}

function renderBlock(
    block: ContentBlock,
    artifactsById: Map<string, ArtifactNode>,
    renderedArtifactIds: Set<string>,
    providerSite: ConversationGraph['source']['provider_site']
): string {
    switch (block.type) {
        case 'text':
            return renderPlainText(block.value);

        case 'markdown':
            return markdownToHtml(block.value);

        case 'html':
            return providerSite === 'gemini.google.com'
                ? wrapGeminiStructuredHtml(block.value)
                : block.value;

        case 'code': {
            const languageClass = block.language ? ` class="language-${escapeAttribute(block.language)}"` : '';
            return `<pre><code${languageClass}>${escapeHtml(block.value)}</code></pre>`;
        }

        case 'image_ref': {
            renderedArtifactIds.add(block.artifact_id);
            const artifact = artifactsById.get(block.artifact_id);

            if (!artifact || typeof artifact.content !== 'string') {
                return '';
            }

            return `<p><img src="${escapeAttribute(artifact.content)}" alt="${escapeAttribute(block.alt ?? artifact.title ?? 'image')}" /></p>`;
        }

        case 'table': {
            if (block.rows.length === 0) return '';

            const [header, ...rows] = block.rows;
            const headerHtml = header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('');
            const bodyHtml = rows
                .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
                .join('');

            return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
        }

        case 'list': {
            const tag = block.ordered ? 'ol' : 'ul';
            return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
        }

        default:
            return '';
    }
}

function renderMessage(
    message: MessageNode,
    artifacts: ArtifactNode[],
    providerSite: ConversationGraph['source']['provider_site'],
    artifactMode: 'inline' | 'appendix' = 'appendix',
    interactiveHtmlMode: 'render' | 'code' | 'fallback' = 'code'
): string {
    // Skip messages with no content and no artifacts to avoid empty role headers.
    if (message.content_blocks.length === 0 && artifacts.length === 0) {
        return '';
    }

    const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
    const renderedArtifactIds = new Set<string>();
    let html = `<h3>${ROLE_LABELS[message.role]}</h3>`;

    if (message.origin.model) {
        html += `<p><em>Model: ${escapeHtml(message.origin.model)}</em></p>`;
    }

    html += message.content_blocks
        .map((block) => renderBlock(block, artifactsById, renderedArtifactIds, providerSite))
        .filter(Boolean)
        .join('');

    artifacts
        .filter((artifact) => !renderedArtifactIds.has(artifact.artifact_id))
        .forEach((artifact) => {
            html += renderArtifact(artifact, interactiveHtmlMode);
        });

    if (message.created_at) {
        html += `<p><em>Timestamp: ${escapeHtml(message.created_at)}</em></p>`;
    }

    html += '<hr>';
    return html;
}

export function renderConversationGraphToHtml(graph: ConversationGraph, options?: RenderConversationOptions): string {
    const artifactMode = options?.artifactMode ?? 'appendix';
    const interactiveHtmlMode = options?.interactiveHtmlMode ?? 'code';
    const remainingArtifactIds = new Set(graph.artifacts.map((artifact) => artifact.artifact_id));
    let html = `${PREVIEW_STYLES}<h1>${escapeHtml(graph.title ?? 'Conversation')}</h1>`;

    html += `<p><strong>Captured from:</strong> ${escapeHtml(graph.source.provider_site)}</p>`;
    html += `<p><strong>Source URL:</strong> <a href="${escapeAttribute(graph.source.url)}" target="_blank" rel="noreferrer">${escapeHtml(graph.source.url)}</a></p>`;
    html += `<p><strong>Captured at:</strong> ${escapeHtml(graph.source.captured_at)}</p>`;

    if (graph.provenance.provider || graph.provenance.model) {
        const provider = graph.provenance.provider ?? 'unknown';
        const model = graph.provenance.model ? ` (${escapeHtml(graph.provenance.model)})` : '';
        html += `<p><strong>Provider:</strong> ${escapeHtml(provider)}${model} [${escapeHtml(graph.provenance.confidence)}]</p>`;
    }

    if (graph.artifacts.length > 0) {
        html += '<details class="bonsai-artifact-index"><summary><strong>Artifacts</strong></summary><ol>';
        graph.artifacts.forEach((artifact) => {
            html += `<li><a href="#artifact-${escapeAttribute(artifact.artifact_id)}">${escapeHtml(artifact.title ?? artifact.type)}</a></li>`;
        });
        html += '</ol></details>';
    }

    html += '<hr>';
    html += '<h2>Conversation</h2>';

    graph.messages.forEach((message) => {
        const messageArtifacts = graph.artifacts.filter((artifact) => artifact.source_message_id === message.message_id);
        const inlineArtifacts = artifactMode === 'inline'
            ? messageArtifacts
            : messageArtifacts.filter((artifact) => !shouldRenderArtifactInAppendix(artifact, artifactMode));
        inlineArtifacts.forEach((artifact) => remainingArtifactIds.delete(artifact.artifact_id));
        html += renderMessage(message, inlineArtifacts, graph.source.provider_site, artifactMode, interactiveHtmlMode);
    });

    const remainingArtifacts = graph.artifacts.filter((artifact) => remainingArtifactIds.has(artifact.artifact_id));
    if (remainingArtifacts.length > 0) {
        html += '<h2>Appendix</h2>';
        remainingArtifacts.forEach((artifact) => {
            html += renderArtifact(artifact, interactiveHtmlMode);
            html += '<hr>';
        });
    }

    return html;
}