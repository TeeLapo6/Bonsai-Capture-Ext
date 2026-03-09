import type { ConversationGraph } from '../../schema';

export const canonicalConversationGraph: ConversationGraph = {
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