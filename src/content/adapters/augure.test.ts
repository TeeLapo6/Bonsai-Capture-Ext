/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../message-handler', () => ({}));
vi.mock('../dom-injector', () => ({
    domInjector: {
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

let AugureAdapterClass: typeof import('./augure').AugureAdapter;

describe('AugureAdapter conversation detection', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        document.body.innerHTML = '';
        document.title = 'Augure - Canadian AI Workspace';

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

        ({ AugureAdapter: AugureAdapterClass } = await import('./augure'));
    });

    it('detects Augure conversations with user and assistant bubbles', () => {
        document.body.innerHTML = `
            <aside>
                <div class="group w-full text-left border-b border-border py-4 transition-colors cursor-pointer bg-surface">
                    <span class="text-[15px] font-bold text-text truncate tracking-tight">Hello there</span>
                </div>
            </aside>
            <main>
                <div class="flex flex-col min-w-0 flex-1">
                    <div class="flex-1 overflow-y-auto">
                        <div class="mx-auto max-w-3xl px-4 py-4 sm:px-6 sm:py-8">
                            <div class="flex justify-end group mb-4 sm:mb-6">
                                <div class="relative max-w-[90%] sm:max-w-[85%] bg-user-bubble text-user-bubble-text rounded-2xl px-4 py-3 sm:px-5 sm:py-4">
                                    Say hello in one short sentence.
                                </div>
                            </div>
                            <div class="flex justify-start group mb-4 sm:mb-6">
                                <div class="relative max-w-[90%] sm:max-w-[85%] bg-surface text-text rounded-2xl px-4 py-3 sm:px-5 sm:py-4">
                                    <div class="chat-container">
                                        <p>Hello!</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <textarea aria-label="Message input" placeholder="Ask anything..."></textarea>
            </main>
        `;

        const adapter = new AugureAdapterClass();
        const conversation = adapter.detectConversation();
        const messages = adapter.listMessages();
        const userMessage = adapter.parseMessage(messages[0], 0);
        const assistantMessage = adapter.parseMessage(messages[1], 1);

        expect(conversation).not.toBeNull();
        expect(conversation?.title).toBe('Hello there');
        expect(messages).toHaveLength(2);
        expect(userMessage.role).toBe('user');
        expect(assistantMessage.role).toBe('assistant');
        expect((assistantMessage.content_blocks[0] as { value?: string }).value).toContain('Hello!');
    });

    it('preserves rich markdown structure for assistant messages', () => {
        document.body.innerHTML = `
            <main>
                <div class="flex flex-col min-w-0 flex-1">
                    <div class="flex justify-start group mb-4 sm:mb-6">
                        <div class="relative max-w-[90%] sm:max-w-[85%] bg-surface text-text rounded-2xl px-4 py-3 sm:px-5 sm:py-4">
                            <div class="chat-container">
                                <p>It is highly likely we are moving toward <strong>AI bundles</strong>.</p>
                                <ol>
                                    <li>The <strong>Bundle</strong> Tradition</li>
                                    <li><em>Value Addition</em> through partnerships</li>
                                </ol>
                                <p>See <a href="https://example.com/report">this report</a>.</p>
                                <pre><code class="language-ts">const answer = 42;</code></pre>
                            </div>
                        </div>
                    </div>
                    <textarea aria-label="Message input" placeholder="Ask anything..."></textarea>
                </div>
            </main>
        `;

        const adapter = new AugureAdapterClass();
        const message = adapter.parseMessage(adapter.listMessages()[0], 0);
        const markdown = (message.content_blocks[0] as { value?: string }).value ?? '';

        expect(markdown).toContain('**AI bundles**');
        expect(markdown).toContain('1. The **Bundle** Tradition');
        expect(markdown).toContain('2. *Value Addition* through partnerships');
        expect(markdown).toContain('[this report](https://example.com/report)');
        expect(markdown).toContain('```ts\nconst answer = 42;\n```');
    });

    it('treats composer-only Augure pages as available conversations', () => {
        document.body.innerHTML = `
            <main>
                <div class="flex flex-col min-w-0 flex-1">
                    <textarea aria-label="Message input" placeholder="Ask anything..."></textarea>
                </div>
            </main>
        `;

        const adapter = new AugureAdapterClass();
        const conversation = adapter.detectConversation();

        expect(conversation).not.toBeNull();
        expect(adapter.listMessages()).toHaveLength(0);
    });
});