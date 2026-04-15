import { describe, expect, it } from 'vitest';

import type { ConversationGraph } from '../schema';
import { canonicalConversationGraph } from './fixtures/canonicalGraph';
import { exportToJSON, parseFromJSON } from './json';
import { exportToMarkdown } from './markdown';

describe('capture export edge cases', () => {
  it('throws when malformed JSON is provided', () => {
    expect(() => parseFromJSON('{"conversation_id":')).toThrow();
  });

  it('preserves list and table content across JSON round-trips', () => {
    const graph: ConversationGraph = {
      ...canonicalConversationGraph,
      messages: [
        ...canonicalConversationGraph.messages,
        {
          message_id: 'msg_assistant_rich',
          role: 'assistant',
          sequence: 2,
          created_at: '2026-03-09T12:00:09.000Z',
          origin: {
            provider: 'openai',
            model: 'gpt-4o',
            confidence: 'observed',
          },
          content_blocks: [
            {
              type: 'list',
              ordered: true,
              items: ['Open the export', 'Verify the mapping', 'Save the report'],
            },
            {
              type: 'table',
              rows: [
                ['artifact', 'status'],
                ['artifact_image', 'ok'],
                ['artifact_file', 'ok'],
              ],
            },
          ],
          artifact_ids: [],
          deep_link: {
            url: canonicalConversationGraph.source.url,
            message_anchor: 'msg_assistant_rich',
          },
        },
      ],
    };

    const parsed = parseFromJSON(exportToJSON(graph));
    const markdown = exportToMarkdown(parsed);

    expect(parsed).toEqual(graph);
    expect(markdown).toContain('1. Open the export');
    expect(markdown).toContain('artifact | status');
  });
});