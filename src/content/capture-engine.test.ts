/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

import { CaptureEngine } from './capture-engine';
import type { ProviderAdapter } from './adapters/interface';
import type { ArtifactNode, MessageNode } from '../shared/schema';

describe('CaptureEngine single-message capture', () => {
    it('uses a scoped Claude path instead of full conversation capture', async () => {
        document.body.innerHTML = `
            <div id="msg-1" class="font-claude-response">First assistant reply</div>
            <div id="msg-2" class="font-claude-response">Second assistant reply</div>
        `;

        const messageOne = document.getElementById('msg-1') as Element;
        const messageTwo = document.getElementById('msg-2') as Element;

        const parseMessage = vi.fn((el: Element, sequence: number): MessageNode => ({
            message_id: el.getAttribute('id') ?? `msg-${sequence}`,
            role: 'assistant',
            sequence,
            origin: { confidence: 'observed' },
            content_blocks: [{ type: 'markdown', value: el.textContent ?? '' }],
            artifact_ids: [],
            deep_link: { url: `https://claude.ai/chat/test#${el.getAttribute('id')}` },
        }));

        const parseArtifacts = vi.fn(async (el: Element): Promise<ArtifactNode[]> => {
            if (el !== messageOne) {
                return [];
            }

            return [{
                artifact_id: 'artifact-1',
                type: 'artifact_doc',
                title: 'Scoped artifact',
                mime_type: 'text/plain',
                content: 'Only the selected message artifact should be captured.',
                source_message_id: '',
                exportable: true,
            }];
        });

        const captureConversation = vi.fn(async () => ({
            conversation_id: 'full-conversation',
            title: 'Should not be used',
            source: {
                provider_site: 'claude.ai',
                url: 'https://claude.ai/chat/test',
                captured_at: new Date().toISOString(),
                capture_version: '0.1.0',
            },
            provenance: { confidence: 'high' },
            messages: [],
            artifacts: [],
        }));

        const adapter = {
            providerName: 'Anthropic',
            providerSite: 'claude.ai',
            detectConversation: () => ({
                url: 'https://claude.ai/chat/test',
                title: 'Scoped Claude capture',
                container: document.body,
            }),
            listMessages: () => [messageOne, messageTwo],
            parseMessage,
            parseArtifacts,
            getDeepLink: (el: Element) => ({ url: `https://claude.ai/chat/test#${el.getAttribute('id')}` }),
            subscribeNewMessages: () => () => {},
            getProvenance: () => ({ confidence: 'observed' }),
            sendToAI: async () => true,
            captureConversation,
            scanSidebar: async () => [],
            isAvailable: () => true,
            setCaptureSettings: () => {},
            parseVisibleArtifacts: async () => [],
            createArtifactReferenceBlock: vi.fn(() => ({
                type: 'markdown',
                value: '[Scoped artifact](#artifact-artifact-1)',
            })),
        } as unknown as ProviderAdapter;

        const engine = new CaptureEngine();
        engine.setAdapter(adapter);

        const graph = await engine.captureSingleMessage('msg-1');

        expect(graph).toBeDefined();
        expect(captureConversation).not.toHaveBeenCalled();
        expect(parseArtifacts).toHaveBeenCalledTimes(1);
        expect(parseArtifacts).toHaveBeenCalledWith(messageOne);
        expect(graph?.messages).toHaveLength(1);
        expect(graph?.messages[0].message_id).toBe('msg-1');
        expect(graph?.artifacts).toHaveLength(1);
        expect(graph?.artifacts[0].artifact_id).toBe('artifact-1');
        expect(graph?.messages[0].artifact_ids).toEqual(['artifact-1']);
        expect(graph?.messages[0].content_blocks.some(
            (block) => block.type === 'markdown' && 'value' in block && String(block.value).includes('artifact-1')
        )).toBe(true);
    });
});