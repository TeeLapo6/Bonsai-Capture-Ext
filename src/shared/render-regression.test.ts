/**
 * Regression tests for render-preview-html and capture pipeline fixes.
 *
 * These tests validate fixes for:
 * - Empty messages producing empty <h3> headers
 * - Structured HTML blocks with tables and code surviving the render pipeline
 * - Table and code block content blocks rendering correctly
 */

import { describe, expect, it } from 'vitest';
import type { ConversationGraph, MessageNode, ArtifactNode } from './schema';
import { renderConversationGraphToHtml } from './render-preview-html';

function makeGraph(overrides: Partial<ConversationGraph> = {}): ConversationGraph {
    return {
        conversation_id: 'test-conv',
        title: 'Regression Test',
        source: {
            provider_site: 'chatgpt.com',
            url: 'https://chatgpt.com/c/test',
            captured_at: '2026-04-02T00:00:00.000Z',
            capture_version: '0.1.0',
        },
        provenance: { provider: 'openai', model: 'gpt-4o', confidence: 'observed' },
        messages: [],
        artifacts: [],
        ...overrides,
    };
}

function makeMessage(overrides: Partial<MessageNode> = {}): MessageNode {
    return {
        message_id: crypto.randomUUID(),
        role: 'assistant',
        sequence: 0,
        origin: { provider: 'openai', model: 'gpt-4o', confidence: 'observed' },
        content_blocks: [],
        artifact_ids: [],
        deep_link: { url: 'https://chatgpt.com/c/test' },
        ...overrides,
    };
}

describe('renderConversationGraphToHtml – regression scenarios', () => {
    it('skips messages with no content blocks and no artifacts (empty guard)', () => {
        const emptyMsg = makeMessage({ content_blocks: [], artifact_ids: [] });
        const graph = makeGraph({ messages: [emptyMsg] });

        const html = renderConversationGraphToHtml(graph);

        // The empty message should not produce a role header
        expect(html).not.toContain('<h3>Assistant</h3>');
    });

    it('renders messages with only artifacts (no content blocks)', () => {
        const artifact: ArtifactNode = {
            artifact_id: 'art-1',
            type: 'code_artifact',
            title: 'My Code',
            content: 'console.log("hello")',
            source_message_id: 'msg-1',
            exportable: true,
        };
        const msg = makeMessage({
            message_id: 'msg-1',
            content_blocks: [],
            artifact_ids: ['art-1'],
        });
        const graph = makeGraph({ messages: [msg], artifacts: [artifact] });

        const html = renderConversationGraphToHtml(graph);

        // Should still render because there's an artifact
        expect(html).toContain('<h3>Assistant</h3>');
        expect(html).toContain('My Code');
        expect(html).toContain('console.log');
    });

    it('renders table content blocks with headers and rows', () => {
        const msg = makeMessage({
            content_blocks: [
                {
                    type: 'table',
                    rows: [
                        ['Name', 'Value'],
                        ['alpha', '1'],
                        ['beta', '2'],
                    ],
                },
            ],
        });
        const graph = makeGraph({ messages: [msg] });

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<table>');
        expect(html).toContain('<th>Name</th>');
        expect(html).toContain('<td>alpha</td>');
        expect(html).toContain('<td>2</td>');
    });

    it('renders code blocks with language annotation', () => {
        const msg = makeMessage({
            content_blocks: [
                { type: 'code', language: 'python', value: 'print("hello")' },
            ],
        });
        const graph = makeGraph({ messages: [msg] });

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<pre>');
        expect(html).toContain('class="language-python"');
        expect(html).toContain('print(&quot;hello&quot;)');
    });

    it('renders HTML blocks with embedded tables and code as raw passthrough', () => {
        const rawHtml = '<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>val</td></tr></tbody></table><pre><code>x = 1</code></pre>';
        const msg = makeMessage({
            content_blocks: [{ type: 'html', value: rawHtml }],
        });
        const graph = makeGraph({ messages: [msg] });

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<table>');
        expect(html).toContain('<pre><code>x = 1</code></pre>');
    });

    it('renders list content blocks (ordered and unordered)', () => {
        const msg = makeMessage({
            content_blocks: [
                { type: 'list', ordered: false, items: ['apple', 'banana'] },
                { type: 'list', ordered: true, items: ['first', 'second'] },
            ],
        });
        const graph = makeGraph({ messages: [msg] });

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<ul>');
        expect(html).toContain('<li>apple</li>');
        expect(html).toContain('<ol>');
        expect(html).toContain('<li>first</li>');
    });
});
