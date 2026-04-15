import { describe, expect, it } from 'vitest';

import { toBonsaiImportPackage } from '../bonsai-adapter';
import type { ConversationGraph } from '../schema';
import { exportToHtml } from './html';
import { exportToJSON, parseFromJSON } from './json';
import { exportToMarkdown } from './markdown';
import { exportToTOON } from './toon';
import { canonicalConversationGraph as sampleGraph } from './fixtures/canonicalGraph';

describe('capture export contracts', () => {
  it('round-trips canonical graphs through JSON export', () => {
    const exported = exportToJSON(sampleGraph);
    const parsed = parseFromJSON(exported);

    expect(parsed).toEqual(sampleGraph);
  });

  it('builds stable TOON mappings for messages and artifacts', () => {
    const toon = exportToTOON(sampleGraph);

    expect(toon.graph).toEqual(sampleGraph);
    expect(toon.mapping.message_to_node).toEqual({
      msg_user: 'messages[0]',
      msg_assistant: 'messages[1]',
    });
    expect(toon.mapping.artifact_to_node).toEqual({
      artifact_image: 'artifacts[0]',
      artifact_file: 'artifacts[1]',
    });
    expect(toon.metadata?.export_tool).toBe('bonsai-capture');
  });

  it('transforms graphs into Bonsai import packages with multimodal attachments', () => {
    const pkg = toBonsaiImportPackage(sampleGraph);

    expect(pkg.bonsai_version).toBe('v1');
    expect(pkg.conversation).toEqual({
      title: 'Export Contract Fixture',
      created_at: '2026-03-09T12:00:00.000Z',
      origin_url: 'https://chatgpt.com/c/conv_1',
      provider_site: 'chatgpt.com',
    });
    expect(pkg.messages).toHaveLength(2);
    expect(pkg.attachments).toHaveLength(2);

    expect(pkg.messages[0]).toMatchObject({
      external_id: 'msg_user',
      role: 'user',
      content: {
        type: 'text',
        content: 'Summarize the attached result.',
      },
    });

    expect(pkg.messages[1].content).toEqual({
      type: 'multimodal',
      text: 'Here is the result and the supporting image.\n\n```json\n{"status":"ok"}\n```',
      attachments: [
        {
          attachment_type: 'image',
          mime_type: 'image/png',
          base64: 'ZmFrZV9pbWFnZQ==',
          url: undefined,
          filename: 'Preview',
        },
        {
          attachment_type: 'document',
          mime_type: 'application/pdf',
          base64: undefined,
          url: 'https://example.com/report.pdf',
          filename: 'report.pdf',
        },
      ],
    });

    expect(pkg.attachments[0]).toMatchObject({
      external_id: 'artifact_image',
      source_message_id: 'msg_assistant',
      source_url: 'https://chatgpt.com/c/conv_1',
      view_url: 'https://chatgpt.com/c/conv_1',
    });
  });

  it('renders markdown with provider metadata and inline artifacts', () => {
    const markdown = exportToMarkdown(sampleGraph);

    expect(markdown).toContain('# Export Contract Fixture');
    expect(markdown).toContain('**Captured from:** chatgpt.com');
    expect(markdown).toContain('### 🤖 Assistant');
    expect(markdown).toContain('*Model: gpt-4o*');
    expect(markdown).not.toContain('\n> Here is the result and the supporting image.');
    expect(markdown).toContain('[Open](https://chatgpt.com/c/conv_1)');
    expect(markdown).toContain('![preview](artifact:artifact_image)');
    expect(markdown).toContain('```json');
    expect(markdown).toContain('*Exported via Bonsai Capture*');
  });

  it('preserves deep research citation anchors and artifact ids in markdown exports', () => {
    const graph: ConversationGraph = {
      conversation_id: 'conv_deep_research',
      title: 'Deep Research Export',
      source: {
        provider_site: 'chatgpt.com',
        url: 'https://chatgpt.com/c/example',
        captured_at: '2026-04-02T12:32:00.000Z',
        capture_version: '0.1.0',
      },
      provenance: {
        provider: 'openai',
        confidence: 'observed',
      },
      messages: [
        {
          message_id: 'msg_deep_research',
          role: 'assistant',
          sequence: 0,
          origin: {
            provider: 'openai',
            confidence: 'observed',
          },
          content_blocks: [
            {
              type: 'markdown',
              value: 'See appendix:\n\n- [Deep research report](#artifact-artifact_deep_research)',
            },
          ],
          artifact_ids: ['artifact_deep_research'],
          deep_link: {
            url: 'https://chatgpt.com/c/example',
          },
        },
      ],
      artifacts: [
        {
          artifact_id: 'artifact_deep_research',
          type: 'deep_research',
          title: 'Deep research report',
          mime_type: 'text/html',
          content: '<section><h3>Executive Summary</h3><p>Mid-market adoption should start first[25†L197-L203].</p><section data-bonsai-sources="true"><h2>Sources</h2><ul><li data-bonsai-source-index="25"><sup>25</sup> <a href="https://example.com/source" target="_blank" rel="noreferrer">Example Source</a></li></ul></section></section>',
          source_message_id: 'msg_deep_research',
          source_url: 'https://example.com/report',
          view_url: 'https://example.com/report',
          exportable: true,
        },
      ],
    };

    const markdown = exportToMarkdown(graph, { artifactMode: 'appendix' });

    expect(markdown).toContain('## Artifacts');
    // Index link uses a raw HTML anchor so Obsidian treats it as same-page navigation.
    expect(markdown).toContain('<a href="#artifact-artifact_deep_research">Deep research report</a>');
    // Appendix heading keeps an explicit id for the same-page anchor target.
    expect(markdown).toContain('### <a id="artifact-artifact_deep_research"></a>Deep research report');
    expect(markdown).toContain('<sup class="bonsai-citation"');
    expect(markdown).toContain('href="#artifact-artifact_deep_research-source-25"');
  });

  it('maps video artifacts into Bonsai import packages and markdown exports', () => {
    const graph = {
      ...sampleGraph,
      messages: sampleGraph.messages.map((message) => message.message_id === 'msg_assistant'
        ? {
            ...message,
            artifact_ids: [...message.artifact_ids, 'artifact_video'],
          }
        : message),
      artifacts: [
        ...sampleGraph.artifacts,
        {
          artifact_id: 'artifact_video',
          type: 'video' as const,
          title: 'Ocean clip',
          mime_type: 'video/mp4',
          content: 'https://video.googleusercontent.com/generated/ocean.mp4',
          source_message_id: 'msg_assistant',
          source_url: 'https://video.googleusercontent.com/generated/ocean.mp4',
          view_url: 'https://gemini.google.com/app/example#artifact-video',
          exportable: true,
        },
      ],
    };

    const pkg = toBonsaiImportPackage(graph);
    const markdown = exportToMarkdown(graph);

    expect(pkg.messages[1].content).toEqual({
      type: 'multimodal',
      text: 'Here is the result and the supporting image.\n\n```json\n{"status":"ok"}\n```',
      attachments: [
        {
          attachment_type: 'image',
          mime_type: 'image/png',
          base64: 'ZmFrZV9pbWFnZQ==',
          url: undefined,
          filename: 'Preview',
        },
        {
          attachment_type: 'document',
          mime_type: 'application/pdf',
          base64: undefined,
          url: 'https://example.com/report.pdf',
          filename: 'report.pdf',
        },
        {
          attachment_type: 'video',
          mime_type: 'video/mp4',
          base64: undefined,
          url: 'https://video.googleusercontent.com/generated/ocean.mp4',
          filename: 'Ocean clip',
        },
      ],
    });
    expect(markdown).toContain('<video controls src="https://video.googleusercontent.com/generated/ocean.mp4"></video>');
  });

  it('wraps the rendered capture in a standalone HTML document', () => {
    const html = exportToHtml(sampleGraph);

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Export Contract Fixture</title>');
    expect(html).toContain('Captured from:');
    expect(html).toContain('artifact-artifact_image');
    expect(html).toContain('Export Contract Fixture');
  });
});