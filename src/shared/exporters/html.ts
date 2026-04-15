/**
 * HTML Exporter
 *
 * Exports ConversationGraph to a standalone HTML document.
 */

import type { ConversationGraph } from '../schema';
import { renderConversationGraphToHtml, type RenderConversationOptions } from '../render-preview-html';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function exportToHtml(graph: ConversationGraph, options?: RenderConversationOptions): string {
    const title = escapeHtml(graph.title ?? 'Conversation');
    const body = renderConversationGraphToHtml(graph, options);

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
</head>
<body>
${body}
</body>
</html>`;
}