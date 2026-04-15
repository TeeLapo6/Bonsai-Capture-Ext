/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../message-handler', () => ({}));
vi.mock('../dom-injector', () => ({
    domInjector: {
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

const rect = {
    width: 100,
    height: 24,
    top: 0,
    left: 0,
    right: 100,
    bottom: 24,
    x: 0,
    y: 0,
    toJSON: () => ({}),
};

describe('ChatGPTAdapter bulk conversation loading', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        document.body.innerHTML = '';
        document.title = 'Old conversation - ChatGPT';

        Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: () => rect,
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

        await import('./chatgpt');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('waits for the target conversation DOM to render before resolving loadConversation', async () => {
        vi.useFakeTimers();

        const adapter = (window as any).__bonsaiAdapter as { loadConversation(id: string): Promise<boolean> };

        document.body.innerHTML = `
            <nav>
                <a href="/c/target-conversation" id="target-link">Target conversation</a>
            </nav>
            <main>
                <div data-testid="conversation-turn-list">
                    <section data-message-author-role="user" data-message-id="old-user">Old user message</section>
                    <section data-message-author-role="assistant" data-message-id="old-assistant">Old assistant response</section>
                </div>
            </main>
        `;

        const targetLink = document.querySelector<HTMLAnchorElement>('#target-link');
        expect(targetLink).not.toBeNull();

        targetLink?.addEventListener('click', (event) => {
            event.preventDefault();
            window.history.pushState({}, '', '/c/target-conversation');
            window.setTimeout(() => {
                const conversationList = document.querySelector('[data-testid="conversation-turn-list"]');
                if (!conversationList) {
                    return;
                }

                conversationList.innerHTML = `
                    <section data-message-author-role="user" data-message-id="new-user">New user message</section>
                    <section data-message-author-role="assistant" data-message-id="new-assistant">New assistant response</section>
                `;
                document.title = 'Target conversation - ChatGPT';
            }, 100);
        });

        let settled = false;
        const loadPromise = adapter.loadConversation('target-conversation').then((result) => {
            settled = result;
            return result;
        });

        await vi.advanceTimersByTimeAsync(50);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(250);
        await expect(loadPromise).resolves.toBe(true);

        expect(settled).toBe(true);
        expect(window.location.pathname).toBe('/c/target-conversation');
        expect(document.body.textContent).toContain('New assistant response');
    });
});