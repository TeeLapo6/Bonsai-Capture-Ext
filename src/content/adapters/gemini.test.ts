/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../message-handler', () => ({}));
vi.mock('../dom-injector', () => ({
    domInjector: {
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

describe('Gemini adapter video capture', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
        document.title = 'Conversation - Gemini';
        delete (window as any).__bonsaiAdapter;

        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 1280,
        });

        Object.defineProperty(window, 'innerHeight', {
            configurable: true,
            value: 900,
        });

        Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: function getBoundingClientRect() {
                const left = Number((this as HTMLElement).dataset.left ?? 0);
                const top = Number((this as HTMLElement).dataset.top ?? 0);
                const width = Number((this as HTMLElement).dataset.width ?? 0);
                const height = Number((this as HTMLElement).dataset.height ?? 0);
                return {
                    x: left,
                    y: top,
                    left,
                    top,
                    width,
                    height,
                    right: left + width,
                    bottom: top + height,
                    toJSON: () => ({}),
                } as DOMRect;
            },
        });

        Object.defineProperty(globalThis, 'chrome', {
            configurable: true,
            value: {
                runtime: {
                    lastError: null,
                    onMessage: {
                        addListener: vi.fn(),
                    },
                    sendMessage: vi.fn(),
                },
                storage: {
                    onChanged: {
                        hasListener: vi.fn(() => false),
                        addListener: vi.fn(),
                        removeListener: vi.fn(),
                    },
                    local: {
                        get: vi.fn((_keys: unknown, callback?: (result: Record<string, unknown>) => void) => callback?.({})),
                    },
                },
            },
        });
    });

    function renderGeminiConversation(markup: string): void {
        document.body.innerHTML = `
            <infinite-scroller class="chat-history" data-left="0" data-top="0" data-width="1200" data-height="840">
                <div class="conversation-container" data-left="0" data-top="0" data-width="1200" data-height="840">
                    <user-query id="user-msg" data-left="40" data-top="40" data-width="800" data-height="80">
                        <div class="query-text">Create a short ocean video.</div>
                    </user-query>
                    <model-response id="assistant-msg" data-left="40" data-top="160" data-width="980" data-height="420">
                        <message-content data-left="40" data-top="160" data-width="980" data-height="420">
                            <div class="markdown" data-left="56" data-top="176" data-width="860" data-height="96">Here are the generated videos.</div>
                            ${markup}
                        </message-content>
                    </model-response>
                </div>
            </infinite-scroller>
        `;
    }

    it('captures Gemini immersive video cards as video artifacts', async () => {
        renderGeminiConversation(`
            <div data-test-id="container" class="container clickable" data-left="56" data-top="280" data-width="320" data-height="72">
                <button aria-label="Open Ocean clip in Canvas" data-left="64" data-top="288" data-width="180" data-height="36">Open Ocean clip in Canvas</button>
                <div data-test-id="artifact-text">Ocean clip</div>
            </div>
        `);
        document.body.insertAdjacentHTML('beforeend', `
            <chat-window class="immersives-mode" data-left="760" data-top="100" data-width="420" data-height="520">
                <immersive-panel data-left="780" data-top="120" data-width="380" data-height="480">
                    <h2 data-test-id="title" data-left="804" data-top="148" data-width="160" data-height="28">Ocean clip</h2>
                    <p data-left="804" data-top="182" data-width="320" data-height="32">A short generated ocean scene with waves and light motion.</p>
                    <video controls src="blob:https://gemini.google.com/video-1" data-left="804" data-top="236" data-width="320" data-height="180"></video>
                    <a href="blob:https://gemini.google.com/video-1" aria-label="Download video" data-left="804" data-top="430" data-width="120" data-height="24">Download video</a>
                    <button aria-label="Share video" data-left="932" data-top="430" data-width="80" data-height="24">Share video</button>
                    <button aria-label="Play video" data-left="1018" data-top="430" data-width="72" data-height="24">Play video</button>
                    <button aria-label="Mute video" data-left="1096" data-top="430" data-width="72" data-height="24">Mute video</button>
                </immersive-panel>
            </chat-window>
        `);

        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected fetch'); }));

        const { default: GeminiAdapter } = await import('./gemini');
        // pageBlobUrlToDataUrl now relays through the background service worker
        // (chrome.scripting.executeScript MAIN world). Mock it directly so the test
        // doesn't depend on a real background or real network access.
        vi.spyOn(GeminiAdapter.prototype as any, 'pageBlobUrlToDataUrl').mockResolvedValue('data:video/mp4;base64,dmlkZW8tYnl0ZXM=');
        const adapter = new GeminiAdapter();
        const graph = await adapter.captureConversation();

        expect(graph).not.toBeNull();
        expect(graph?.messages).toHaveLength(2);
        expect(graph?.artifacts).toHaveLength(1);
        expect(graph?.artifacts[0]).toMatchObject({
            type: 'video',
            title: 'Ocean clip',
            mime_type: 'video/mp4',
        });
        expect(String(graph?.artifacts[0].content)).toMatch(/^(data:video\/mp4;base64,|blob:https:\/\/gemini\.google\.com\/video-1)/);
        expect(graph?.messages[1].artifact_ids).toEqual([graph!.artifacts[0].artifact_id]);
    }, 10000);

    it('captures inline Gemini video elements as video artifacts without converting stable URLs', async () => {
        renderGeminiConversation(`
            <figure data-left="56" data-top="280" data-width="420" data-height="260">
                <video controls title="Shoreline loop" src="https://video.googleusercontent.com/generated/shoreline.mp4" data-left="64" data-top="296" data-width="360" data-height="200"></video>
            </figure>
        `);

        vi.stubGlobal('fetch', vi.fn());

        const { default: GeminiAdapter } = await import('./gemini');
        const adapter = new GeminiAdapter();
        const graph = await adapter.captureConversation();

        expect(graph).not.toBeNull();
        expect(graph?.artifacts).toHaveLength(1);
        expect(graph?.artifacts[0]).toMatchObject({
            type: 'video',
            title: 'Shoreline loop',
            mime_type: 'video/mp4',
            content: 'https://video.googleusercontent.com/generated/shoreline.mp4',
            source_url: 'https://video.googleusercontent.com/generated/shoreline.mp4',
        });
    }, 10000);

    it('converts Gemini blob videos to data URLs through page-context capture', async () => {
        renderGeminiConversation(`
            <figure data-left="56" data-top="280" data-width="420" data-height="260">
                <video controls title="Wave loop" src="blob:https://gemini.google.com/video-2" data-left="64" data-top="296" data-width="360" data-height="200"></video>
            </figure>
        `);

        const fetchSpy = vi.fn(async () => {
            throw new Error('blob URLs are not readable from the extension context');
        });
        vi.stubGlobal('fetch', fetchSpy);

        const { default: GeminiAdapter } = await import('./gemini');
        vi.spyOn(GeminiAdapter.prototype as any, 'pageBlobUrlToDataUrl').mockResolvedValue('data:video/mp4;base64,dmlkZW8tYnl0ZXM=');
        const adapter = new GeminiAdapter();
        const graph = await adapter.captureConversation();

        expect(graph).not.toBeNull();
        expect(graph?.artifacts).toHaveLength(1);
        expect(graph?.artifacts[0]).toMatchObject({
            type: 'video',
            title: 'Wave loop',
            mime_type: 'video/mp4',
            content: 'data:video/mp4;base64,dmlkZW8tYnl0ZXM=',
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(graph?.artifacts[0].source_url).toBeUndefined();
        expect(graph?.artifacts[0].view_url).toBe(window.location.href);
    }, 10000);

    it('treats video-only Gemini assistant replies as meaningful messages', async () => {
        document.body.innerHTML = `
            <infinite-scroller class="chat-history" data-left="0" data-top="0" data-width="1200" data-height="840">
                <div class="conversation-container" data-left="0" data-top="0" data-width="1200" data-height="840">
                    <user-query id="user-msg" data-left="40" data-top="40" data-width="800" data-height="80">
                        <div class="query-text">Create a sunrise video.</div>
                    </user-query>
                    <model-response id="assistant-msg" data-left="40" data-top="160" data-width="980" data-height="420">
                        <message-content data-left="40" data-top="160" data-width="980" data-height="420">
                            <figure data-left="56" data-top="280" data-width="420" data-height="260">
                                <video controls title="Sunrise loop" src="https://video.googleusercontent.com/generated/sunrise.mp4" data-left="64" data-top="296" data-width="360" data-height="200"></video>
                            </figure>
                        </message-content>
                    </model-response>
                </div>
            </infinite-scroller>
        `;

        vi.stubGlobal('fetch', vi.fn());

        const { default: GeminiAdapter } = await import('./gemini');
        const adapter = new GeminiAdapter();
        const messages = adapter.listMessages();
        const graph = await adapter.captureConversation();

        expect(messages.map((message) => message.tagName.toLowerCase())).toEqual(['user-query', 'model-response']);
        expect(graph).not.toBeNull();
        expect(graph?.messages).toHaveLength(2);
        expect(graph?.messages[1].artifact_ids).toHaveLength(1);
    }, 10000);

    it('strips inline Gemini media from structured prose while keeping the video artifact', async () => {
        document.body.innerHTML = `
            <infinite-scroller class="chat-history" data-left="0" data-top="0" data-width="1200" data-height="840">
                <div class="conversation-container" data-left="0" data-top="0" data-width="1200" data-height="840">
                    <user-query id="user-msg" data-left="40" data-top="40" data-width="800" data-height="80">
                        <div class="query-text">Create a short retro interface teaser.</div>
                    </user-query>
                    <model-response id="assistant-msg" data-left="40" data-top="160" data-width="980" data-height="420">
                        <message-content data-left="40" data-top="160" data-width="980" data-height="420">
                            <div class="markdown" data-left="56" data-top="176" data-width="860" data-height="220">
                                <p>Your video is ready!</p>
                                <video controls title="Agent clip" src="https://video.googleusercontent.com/generated/agent.mp4" data-left="64" data-top="220" data-width="360" data-height="200"></video>
                                <a href="https://video.googleusercontent.com/generated/agent.mp4" aria-label="Download video" data-left="64" data-top="430" data-width="120" data-height="24">Download video</a>
                            </div>
                        </message-content>
                    </model-response>
                </div>
            </infinite-scroller>
        `;

        vi.stubGlobal('fetch', vi.fn());

        const { default: GeminiAdapter } = await import('./gemini');
        const adapter = new GeminiAdapter();
        const graph = await adapter.captureConversation();

        expect(graph).not.toBeNull();
        expect(graph?.artifacts).toHaveLength(1);
        expect(graph?.artifacts[0]).toMatchObject({
            type: 'video',
            title: 'Agent clip',
            content: 'https://video.googleusercontent.com/generated/agent.mp4',
        });
        expect(graph?.messages[1].artifact_ids).toEqual([graph!.artifacts[0].artifact_id]);

        const htmlBlock = graph?.messages[1].content_blocks.find((block) => block.type === 'html');
        expect(htmlBlock && 'value' in htmlBlock ? htmlBlock.value : '').toContain('Your video is ready!');
        expect(htmlBlock && 'value' in htmlBlock ? htmlBlock.value : '').not.toContain('<video');
        expect(htmlBlock && 'value' in htmlBlock ? htmlBlock.value : '').not.toContain('Download video');
    }, 10000);
});