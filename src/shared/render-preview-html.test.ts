import { describe, expect, it } from 'vitest';
import type { ConversationGraph } from './schema';
import { renderConversationGraphToHtml } from './render-preview-html';

describe('renderConversationGraphToHtml', () => {
    it('preserves structured html blocks and linked artifacts', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_1',
            title: 'Structured Capture',
            source: {
                provider_site: 'claude.ai',
                url: 'https://claude.ai/chat/example',
                captured_at: '2026-04-01T12:00:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'anthropic',
                model: 'sonnet-4.5',
                confidence: 'observed',
            },
            messages: [
                {
                    message_id: 'msg_1',
                    role: 'assistant',
                    sequence: 0,
                    created_at: '2026-04-01T12:00:01.000Z',
                    origin: {
                        provider: 'anthropic',
                        model: 'sonnet-4.5',
                        confidence: 'observed',
                    },
                    content_blocks: [
                        {
                            type: 'html',
                            value: '<table><thead><tr><th>Scenario</th><th>Mode</th></tr></thead><tbody><tr><td>Simple conversation</td><td><code>lightweight</code></td></tr></tbody></table><pre><code>const answer = 42;</code></pre>',
                        },
                    ],
                    artifact_ids: ['artifact_1'],
                    deep_link: {
                        url: 'https://claude.ai/chat/example',
                    },
                },
            ],
            artifacts: [
                {
                    artifact_id: 'artifact_1',
                    type: 'deep_research',
                    title: 'Research Report',
                    content: 'Embedded report',
                    source_message_id: 'msg_1',
                    view_url: 'https://chatgpt.com/c/example',
                    exportable: true,
                },
            ],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<table>');
        expect(html).toContain('<pre><code>const answer = 42;</code></pre>');
        expect(html).toContain('Research Report');
        expect(html).toContain('artifact-artifact_1');
        expect(html).not.toContain('https://chatgpt.com/c/example');
    });

    it('renders captured file artifacts as downloadable links', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_2',
            title: 'Captured File',
            source: {
                provider_site: 'chatgpt.com',
                url: 'https://chatgpt.com/c/example',
                captured_at: '2026-04-02T12:00:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'openai',
                confidence: 'observed',
            },
            messages: [
                {
                    message_id: 'msg_1',
                    role: 'assistant',
                    sequence: 0,
                    origin: {
                        provider: 'openai',
                        confidence: 'observed',
                    },
                    content_blocks: [],
                    artifact_ids: ['artifact_file'],
                    deep_link: {
                        url: 'https://chatgpt.com/c/example',
                    },
                },
            ],
            artifacts: [
                {
                    artifact_id: 'artifact_file',
                    type: 'file',
                    title: 'research-report.pdf',
                    mime_type: 'application/pdf',
                    content: 'data:application/pdf;base64,JVBERi0xLjQK',
                    source_message_id: 'msg_1',
                    source_url: 'https://files.oaiusercontent.com/example.pdf',
                    view_url: 'https://files.oaiusercontent.com/example.pdf',
                    exportable: true,
                },
            ],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('Download captured file');
        expect(html).toContain('research-report.pdf');
        expect(html).toContain('data:application/pdf;base64,JVBERi0xLjQK');
    });

    it('renders deep research artifacts in the appendix', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_3',
            title: 'Appendix Capture',
            source: {
                provider_site: 'chatgpt.com',
                url: 'https://chatgpt.com/c/example',
                captured_at: '2026-04-02T12:30:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'openai',
                confidence: 'observed',
            },
            messages: [
                {
                    message_id: 'msg_1',
                    role: 'assistant',
                    sequence: 0,
                    origin: {
                        provider: 'openai',
                        confidence: 'observed',
                    },
                    content_blocks: [
                        {
                            type: 'markdown',
                            value: 'Artifact links\n\n- [Deep research report](#artifact-artifact_appendix)',
                        },
                    ],
                    artifact_ids: ['artifact_appendix'],
                    deep_link: {
                        url: 'https://chatgpt.com/c/example',
                    },
                },
            ],
            artifacts: [
                {
                    artifact_id: 'artifact_appendix',
                    type: 'deep_research',
                    title: 'Deep research report',
                    mime_type: 'text/html',
                    content: '<section><h3>Executive Summary</h3><p>Long-form research body.</p></section>',
                    source_message_id: 'msg_1',
                    source_url: 'https://example.com/report',
                    view_url: 'https://example.com/report',
                    exportable: true,
                },
            ],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<h2>Appendix</h2>');
        expect(html).toContain('artifact-artifact_appendix');
        expect(html).toContain('Executive Summary');
        expect(html).not.toContain('Links:');
    });

    it('renders deep research markdown tables, mermaid fences, and citation sources', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_4',
            title: 'Research Markdown Capture',
            source: {
                provider_site: 'chatgpt.com',
                url: 'https://chatgpt.com/c/example',
                captured_at: '2026-04-02T12:31:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'openai',
                confidence: 'observed',
            },
            messages: [
                {
                    message_id: 'msg_1',
                    role: 'assistant',
                    sequence: 0,
                    origin: {
                        provider: 'openai',
                        confidence: 'observed',
                    },
                    content_blocks: [],
                    artifact_ids: ['artifact_research'],
                    deep_link: { url: 'https://chatgpt.com/c/example' },
                },
            ],
            artifacts: [
                {
                    artifact_id: 'artifact_research',
                    type: 'deep_research',
                    title: 'Deep research report',
                    mime_type: 'text/markdown',
                    content: [
                        '## Revenue Projections',
                        '',
                        '| Year | Base |',
                        '| --- | --- |',
                        '| 2027 | $1.5M |',
                        '',
                        '```mermaid',
                        'flowchart TD',
                        '  A --> B',
                        '```',
                        '',
                        'Mid-market adoption should start first[25†L197-L203].',
                        '',
                        '<section data-bonsai-sources="true">',
                        '<h2>Sources</h2>',
                        '<ul>',
                        '<li data-bonsai-source-index="25"><sup>25</sup> <a href="https://example.com/source" target="_blank" rel="noreferrer">Example Source</a></li>',
                        '</ul>',
                        '</section>',
                    ].join('\n'),
                    source_message_id: 'msg_1',
                    exportable: true,
                },
            ],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<table>');
        expect(html).toContain('language-mermaid');
        expect(html).toContain('artifact-artifact_research-source-25');
        expect(html).toContain('<sup class="bonsai-citation"');
        expect(html).toContain('href="#artifact-artifact_research-source-25"');
        expect(html).toContain('class="bonsai-deep-research"');
    });

    it('renders linked Claude document artifacts in the appendix without duplicating them inline', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_6',
            title: 'Claude Artifact Appendix',
            source: {
                provider_site: 'claude.ai',
                url: 'https://claude.ai/chat/example',
                captured_at: '2026-04-03T12:00:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'anthropic',
                model: 'sonnet-4.5',
                confidence: 'observed',
            },
            messages: [
                {
                    message_id: 'msg_1',
                    role: 'assistant',
                    sequence: 0,
                    created_at: '2026-04-03T12:00:01.000Z',
                    origin: {
                        provider: 'anthropic',
                        model: 'sonnet-4.5',
                        confidence: 'observed',
                    },
                    content_blocks: [
                        {
                            type: 'html',
                            value: '<p>Here is the summary for the main response.</p>',
                        },
                        {
                            type: 'markdown',
                            value: 'See appendix:\n\n- [Bonsai engine llm blocks supplement](#artifact-artifact_doc_1)',
                        },
                    ],
                    artifact_ids: ['artifact_doc_1'],
                    deep_link: {
                        url: 'https://claude.ai/chat/example',
                    },
                },
            ],
            artifacts: [
                {
                    artifact_id: 'artifact_doc_1',
                    type: 'artifact_doc',
                    title: 'Bonsai engine llm blocks supplement',
                    mime_type: 'text/html',
                    content: '<section><p>CLI flags integration belongs in the execution context section.</p></section>',
                    source_message_id: 'msg_1',
                    source_url: 'https://claude.ai/download/supplement.md',
                    view_url: 'https://claude.ai/download/supplement.md',
                    exportable: true,
                },
            ],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<h2>Appendix</h2>');
        expect(html).toContain('Bonsai engine llm blocks supplement');
        expect(html).toContain('CLI flags integration belongs in the execution context section.');
        expect(html).toContain('See appendix:');
    });

    it('renders linked Claude code artifacts in the appendix', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_7',
            title: 'Claude Code Artifact Appendix',
            source: {
                provider_site: 'claude.ai',
                url: 'https://claude.ai/chat/example',
                captured_at: '2026-04-05T12:00:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'anthropic',
                model: 'sonnet-4.5',
                confidence: 'observed',
            },
            messages: [
                {
                    message_id: 'msg_code_1',
                    role: 'assistant',
                    sequence: 0,
                    created_at: '2026-04-05T12:00:01.000Z',
                    origin: {
                        provider: 'anthropic',
                        model: 'sonnet-4.5',
                        confidence: 'observed',
                    },
                    content_blocks: [
                        {
                            type: 'html',
                            value: '<p>Here is the updated diagram.</p>',
                        },
                        {
                            type: 'markdown',
                            value: 'See appendix:\n\n- [Architecture Mermaid](#artifact-artifact_code_1)',
                        },
                    ],
                    artifact_ids: ['artifact_code_1'],
                    deep_link: {
                        url: 'https://claude.ai/chat/example',
                    },
                },
            ],
            artifacts: [
                {
                    artifact_id: 'artifact_code_1',
                    type: 'code_artifact',
                    title: 'Architecture Mermaid',
                    mime_type: 'text/plain',
                    content: 'flowchart TD\n    A --> B',
                    source_message_id: 'msg_code_1',
                    exportable: true,
                },
            ],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<h2>Appendix</h2>');
        expect(html).toContain('Architecture Mermaid');
        expect(html).toContain('flowchart TD');
        expect(html).toContain('See appendix:');
    });

    it('suppresses deep research external links when body content exists', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_5',
            title: 'No External Link Research',
            source: {
                provider_site: 'chatgpt.com',
                url: 'https://chatgpt.com/c/example',
                captured_at: '2026-04-02T12:31:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'openai',
                confidence: 'observed',
            },
            messages: [
                {
                    message_id: 'msg_1',
                    role: 'assistant',
                    sequence: 0,
                    origin: {
                        provider: 'openai',
                        confidence: 'observed',
                    },
                    content_blocks: [],
                    artifact_ids: ['artifact_research'],
                    deep_link: { url: 'https://chatgpt.com/c/example' },
                },
            ],
            artifacts: [
                {
                    artifact_id: 'artifact_research',
                    type: 'deep_research',
                    title: 'Deep research report',
                    mime_type: 'text/markdown',
                    content: 'Executive Summary\n\nThis is the actual research body.',
                    source_message_id: 'msg_1',
                    source_url: 'https://connector_openai_deep_research.web-sandbox.oaiusercontent.com',
                    view_url: 'https://chatgpt.com/c/example',
                    exportable: true,
                },
            ],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).not.toContain('Open</a>');
    });

    it('renders short linked artifact docs in the appendix instead of inline', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_6',
            title: 'Gemini Linked Artifact Capture',
            source: {
                provider_site: 'gemini.google.com',
                url: 'https://gemini.google.com/app/example',
                captured_at: '2026-04-02T22:30:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'google',
                model: 'gemini-pro',
                confidence: 'inferred',
            },
            messages: [
                {
                    message_id: 'msg_1',
                    role: 'assistant',
                    sequence: 0,
                    origin: {
                        provider: 'google',
                        model: 'gemini-pro',
                        confidence: 'inferred',
                    },
                    content_blocks: [
                        {
                            type: 'markdown',
                            value: 'Here are the requested artifacts for your application idea.',
                        },
                    ],
                    artifact_ids: ['artifact_doc_1'],
                    deep_link: {
                        url: 'https://gemini.google.com/app/example',
                    },
                },
            ],
            artifacts: [
                {
                    artifact_id: 'artifact_doc_1',
                    type: 'artifact_doc',
                    title: 'Minimum Viable Product (MVP) Definition',
                    mime_type: 'text/plain',
                    content: 'A concise MVP definition that is intentionally shorter than the old appendix threshold.',
                    source_message_id: 'msg_1',
                    view_url: 'https://gemini.google.com/app/example#artifact',
                    exportable: true,
                },
            ],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('<h2>Appendix</h2>');
        expect(html).toContain('Minimum Viable Product (MVP) Definition');
        expect(html).not.toContain('Links: Open</em></p><pre><code>A concise MVP definition');
    });

    it('wraps Gemini html message blocks with preview styling hooks', () => {
        const graph: ConversationGraph = {
            conversation_id: 'conv_7',
            title: 'Gemini Thinking Capture',
            source: {
                provider_site: 'gemini.google.com',
                url: 'https://gemini.google.com/app/thinking-example',
                captured_at: '2026-04-02T23:00:00.000Z',
                capture_version: '0.1.0',
            },
            provenance: {
                provider: 'google',
                model: 'gemini-pro',
                confidence: 'inferred',
            },
            messages: [
                {
                    message_id: 'msg_1',
                    role: 'assistant',
                    sequence: 0,
                    origin: {
                        provider: 'google',
                        model: 'gemini-pro',
                        confidence: 'inferred',
                    },
                    content_blocks: [
                        {
                            type: 'html',
                            value: '<h2>Thoughts</h2><h3>Understanding the Competitive Landscape</h3><p>I am initiating a comprehensive analysis.</p>',
                        },
                    ],
                    artifact_ids: [],
                    deep_link: {
                        url: 'https://gemini.google.com/app/thinking-example',
                    },
                },
            ],
            artifacts: [],
        };

        const html = renderConversationGraphToHtml(graph);

        expect(html).toContain('data-bonsai-preview-styles="true"');
        expect(html).toContain('class="bonsai-gemini-structured"');
        expect(html).toContain('Thoughts');
    });
});
