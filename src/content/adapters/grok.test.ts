/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../message-handler', () => ({}));
vi.mock('../dom-injector', () => ({
    domInjector: {
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

let GrokAdapterClass: typeof import('./grok').GrokAdapter;

describe('GrokAdapter conversation detection', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        document.body.innerHTML = '';
        document.title = 'Grok';

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

        ({ GrokAdapter: GrokAdapterClass } = await import('./grok'));
    });

    it('detects shared Grok conversations that render message bubbles', () => {
        document.title = "Grok's Capabilities and Strengths | Shared Grok Conversation";
        document.body.innerHTML = `
            <main>
                <div class="w-full h-full overflow-y-auto overflow-x-hidden scrollbar-gutter-stable flex flex-col items-center">
                    <div class="relative group flex flex-col justify-center w-full max-w-[var(--content-max-width)] pb-0.5 items-end">
                        <div class="message-bubble relative rounded-3xl text-primary min-h-7 prose">What can you do?</div>
                    </div>
                    <div class="relative group flex flex-col justify-center w-full max-w-[var(--content-max-width)] pb-0.5 items-start">
                        <div class="message-bubble relative rounded-3xl text-primary min-h-7 prose">Here's what I can do as Grok.</div>
                    </div>
                </div>
            </main>
        `;

        const adapter = new GrokAdapterClass();
        const conversation = adapter.detectConversation();
        const messages = adapter.listMessages();
        const userMessage = adapter.parseMessage(messages[0], 0);
        const assistantMessage = adapter.parseMessage(messages[1], 1);

        expect(conversation).not.toBeNull();
        expect(conversation?.title).toBe("Grok's Capabilities and Strengths");
        expect(messages).toHaveLength(2);
        expect(userMessage.role).toBe('user');
        expect(assistantMessage.role).toBe('assistant');
    });

    it('treats composer-only Grok pages as available conversations', () => {
        document.title = 'New Chat - Grok';
        document.body.innerHTML = `
            <main>
                <form>
                    <textarea></textarea>
                </form>
            </main>
        `;

        const adapter = new GrokAdapterClass();
        const conversation = adapter.detectConversation();

        expect(conversation).not.toBeNull();
        expect(conversation?.title).toBe('New Chat');
        expect(adapter.listMessages()).toHaveLength(0);
    });
});