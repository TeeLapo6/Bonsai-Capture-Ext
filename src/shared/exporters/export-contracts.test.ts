import { describe, expect, it } from 'vitest';

import { toBonsaiImportPackage } from '../bonsai-adapter';
import type { ConversationGraph } from '../schema';
import { exportToJSON, parseFromJSON } from './json';
import { exportToMarkdown } from './markdown';
import { exportToTOON } from './toon';

const sampleGraph: ConversationGraph = {
  conversation_id: 'conv_1',
  title: 'Export Contract Fixture',
  source: {
    provider_site: 'chatgpt.com',
    url: 'https://chatgpt.com/c/conv_1',
    captured_at: '2026-03-09T12:00:00.000Z',
    capture_version: '0.1.0',
  },
  provenance: {
    provider: 'openai',
    model: 'gpt-4o',
    confidence: 'observed',
  },
  messages: [
    {
      message_id: 'msg_user',
      role: 'user',
      sequence: 0,
      created_at: '2026-03-09T12:00:01.000Z',
      origin: { confidence: 'unknown' },
      content_blocks: [{ type: 'text', value: 'Summarize the attached result.' }],
      artifact_ids: [],
      deep_link: {
        url: 'https://chatgpt.com/c/conv_1',
        selector_hint: 'article[data-testid="conversation-turn"]',
      },
    },
    {
      message_id: 'msg_assistant',
      role: 'assistant',
      sequence: 1,
      created_at: '2026-03-09T12:00:05.000Z',
      origin: {
        provider: 'openai',
        model: 'gpt-4o',
        confidence: 'observed',
      },
      content_blocks: [
        { type: 'markdown', value: 'Here is the result and the supporting image.' },
        { type: 'image_ref', artifact_id: 'artifact_image', alt: 'preview' },
        { type: 'code', language: 'json', value: '{"status":"ok"}' },
      ],
      artifact_ids: ['artifact_image', 'artifact_file'],
      deep_link: {
        url: 'https://chatgpt.com/c/conv_1',
        message_anchor: 'msg_assistant',
        selector_hint: 'article[data-testid="conversation-turn"]',
      },
    },
  ],
  artifacts: [
    {
      artifact_id: 'artifact_image',
      type: 'image',
      title: 'Preview',
      mime_type: 'image/png',
      content: 'data:image/png;base64,ZmFrZV9pbWFnZQ==',
      source_message_id: 'msg_assistant',
      source_url: 'https://chatgpt.com/c/conv_1',
      exportable: true,
    },
    {
      artifact_id: 'artifact_file',
      type: 'file',
      title: 'report.pdf',
      mime_type: 'application/pdf',
      content: 'https://example.com/report.pdf',
      source_message_id: 'msg_assistant',
      source_url: 'https://example.com/report.pdf',
      exportable: true,
    },
  ],
  tags: ['fixture', 'export'],
};

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
  });

  it('renders markdown with provider metadata and inline artifacts', () => {
    const markdown = exportToMarkdown(sampleGraph);

    expect(markdown).toContain('# Export Contract Fixture');
    expect(markdown).toContain('**Captured from:** chatgpt.com');
    expect(markdown).toContain('### 🤖 Assistant');
    expect(markdown).toContain('*Model: gpt-4o*');
    expect(markdown).toContain('![preview](artifact:artifact_image)');
    expect(markdown).toContain('```json');
    expect(markdown).toContain('*Exported via Bonsai Capture*');
  });
});