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

    const pkg = toBonsaiImportPackage(graph);
    const markdown = exportToMarkdown(graph, { artifactMode: 'appendix' });

    expect(pkg.messages[0].content).toMatchObject({
      type: 'multimodal',
    });
    if (pkg.messages[0].content.type !== 'multimodal') {
      throw new Error('expected multimodal content');
    }

    expect(pkg.messages[0].content.attachments[0]?.metadata?.content).toContain('<sup class="bonsai-citation"');
    expect(pkg.messages[0].content.attachments[0]?.metadata?.content).toContain('id="artifact-artifact_deep_research-source-25"');
    expect(pkg.messages[0].content.attachments[0]?.metadata?.sources).toEqual([
      {
        display_index: 1,
        index: 25,
        url: 'https://example.com/source',
        title: 'Example Source',
        domain: 'example.com',
      },
    ]);
    expect(pkg.attachments[0]?.metadata?.content).toContain('<sup class="bonsai-citation"');
    expect(pkg.attachments[0]?.metadata?.sources).toEqual([
      {
        display_index: 1,
        index: 25,
        url: 'https://example.com/source',
        title: 'Example Source',
        domain: 'example.com',
      },
    ]);

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

  it('remaps deep research raw citation ids to sequential display numbers while preserving raw anchors', () => {
    const graph: ConversationGraph = {
      conversation_id: 'conv_deep_research_remap',
      title: 'Deep Research Citation Remap',
      source: {
        provider_site: 'chatgpt.com',
        url: 'https://chatgpt.com/c/example-remap',
        captured_at: '2026-04-02T12:33:00.000Z',
        capture_version: '0.1.0',
      },
      provenance: {
        provider: 'openai',
        confidence: 'observed',
      },
      messages: [
        {
          message_id: 'msg_deep_research_remap',
          role: 'assistant',
          sequence: 0,
          origin: {
            provider: 'openai',
            confidence: 'observed',
          },
          content_blocks: [
            {
              type: 'markdown',
              value: 'See appendix:\n\n- [Deep research report](#artifact-artifact_deep_research_remap)',
            },
          ],
          artifact_ids: ['artifact_deep_research_remap'],
          deep_link: {
            url: 'https://chatgpt.com/c/example-remap',
          },
        },
      ],
      artifacts: [
        {
          artifact_id: 'artifact_deep_research_remap',
          type: 'deep_research',
          title: 'Deep research report',
          mime_type: 'text/html',
          content: '<section><p>Prioritize segment A first[25†L197-L203], then segment B[17†L10-L12].</p><section data-bonsai-sources="true"><h2>Sources</h2><ul><li data-bonsai-source-index="17"><sup>17</sup> <a href="https://example.com/b" target="_blank" rel="noreferrer">Source B</a></li><li data-bonsai-source-index="25"><sup>25</sup> <a href="https://example.com/a" target="_blank" rel="noreferrer">Source A</a></li></ul></section></section>',
          source_message_id: 'msg_deep_research_remap',
          exportable: true,
        },
      ],
    };

    const pkg = toBonsaiImportPackage(graph);

    expect(pkg.messages[0].content).toMatchObject({
      type: 'multimodal',
    });
    if (pkg.messages[0].content.type !== 'multimodal') {
      throw new Error('expected multimodal content');
    }

    const attachment = pkg.messages[0].content.attachments[0];
    expect(attachment?.metadata?.content).toContain('title="Source 1, L197-L203"');
    expect(attachment?.metadata?.content).toContain('title="Source 2, L10-L12"');
    expect(attachment?.metadata?.content).toContain('href="#artifact-artifact_deep_research_remap-source-25">1</a>');
    expect(attachment?.metadata?.content).toContain('href="#artifact-artifact_deep_research_remap-source-17">2</a>');
    expect(attachment?.metadata?.content).toContain('artifact-artifact_deep_research_remap-source-17"><sup>2</sup>');
    expect(attachment?.metadata?.content).toContain('artifact-artifact_deep_research_remap-source-25"><sup>1</sup>');
    expect(attachment?.metadata?.sources).toEqual([
      {
        index: 17,
        display_index: 2,
        url: 'https://example.com/b',
        title: 'Source B',
        domain: 'example.com',
      },
      {
        index: 25,
        display_index: 1,
        url: 'https://example.com/a',
        title: 'Source A',
        domain: 'example.com',
      },
    ]);
  });

  it('includes source folder metadata in Bonsai import packages', () => {
    const pkg = toBonsaiImportPackage({
      ...sampleGraph,
      source_folder: {
        name: 'Alpha Project',
        url: 'https://chatgpt.com/g/g-p-alpha/project',
      },
    });

    expect(pkg.metadata.custom).toMatchObject({
      capture_version: sampleGraph.source.capture_version,
      source_folder: {
        name: 'Alpha Project',
        url: 'https://chatgpt.com/g/g-p-alpha/project',
      },
    });
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