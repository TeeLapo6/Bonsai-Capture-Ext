/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../message-handler', () => ({}));
vi.mock('../dom-injector', () => ({
    domInjector: {
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

describe('Jules adapter bootstrap', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        document.body.innerHTML = '';
        document.title = 'Session - Jules';
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

    function renderJulesLayout(): void {
        document.body.innerHTML = `
            <aside data-left="0" data-top="0" data-width="220" data-height="900">
                <input
                    type="text"
                    aria-label="Search for repo or sessions"
                    data-left="16"
                    data-top="24"
                    data-width="180"
                    data-height="32"
                />
                <div class="tasks-container session-list" data-left="16" data-top="96" data-width="188" data-height="240">
                    <div
                        id="sidebar-session-1"
                        class="task-container user-task"
                        data-left="16"
                        data-top="104"
                        data-width="188"
                        data-height="52"
                    >Recent session one</div>
                    <div
                        id="sidebar-session-2"
                        class="task-container user-task"
                        data-left="16"
                        data-top="164"
                        data-width="188"
                        data-height="52"
                    >Recent session two</div>
                </div>
            </aside>

            <main data-left="220" data-top="0" data-width="1040" data-height="900">
                <section id="center-thread" data-left="260" data-top="40" data-width="420" data-height="760">
                    <div
                        id="center-user"
                        class="task-container user-task"
                        data-left="280"
                        data-top="120"
                        data-width="360"
                        data-height="82"
                    >Write a parser that handles markdown tables.</div>
                    <div
                        id="center-assistant"
                        class="task-container jules-task"
                        data-left="280"
                        data-top="232"
                        data-width="360"
                        data-height="118"
                    >Implemented the parser and added a formatter.</div>
                    <div
                        id="composer"
                        contenteditable="true"
                        aria-label="Message Jules"
                        data-left="280"
                        data-top="760"
                        data-width="360"
                        data-height="44"
                    ></div>
                </section>

                <aside id="right-review" data-left="760" data-top="64" data-width="360" data-height="760">
                    <section
                        id="artifact-card"
                        class="review-card"
                        data-left="780"
                        data-top="132"
                        data-width="312"
                        data-height="184"
                    >
                        <h3 data-left="792" data-top="144" data-width="220" data-height="20">dist/assets/index-Bc2DiLid.js</h3>
                        <pre data-left="792" data-top="174" data-width="280" data-height="124"><code>+ export function render() {
-   return null;
+   return "ok";
}</code></pre>
                    </section>
                </aside>
            </main>
        `;
    }

    it('registers the Jules adapter and starts the DOM injector', async () => {
        renderJulesLayout();

        await import('./jules');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const { domInjector } = await import('../dom-injector');
        const adapter = (window as any).__bonsaiAdapter;

        expect(adapter).toBeTruthy();
        expect(adapter.providerSite).toBe('jules.google.com');
        expect(adapter.detectConversation()).not.toBeNull();
        expect(adapter.listMessages()).toHaveLength(2);
        expect(adapter.listMessages().map((el: Element) => el.id)).toEqual(['center-user', 'center-assistant']);
        expect(domInjector.start).toHaveBeenCalledTimes(1);
    });

    it('ignores sidebar sessions and captures the right review lane as artifacts', async () => {
        renderJulesLayout();

        await import('./jules');
        await new Promise((resolve) => setTimeout(resolve, 0));

        const adapter = (window as any).__bonsaiAdapter;
        const graph = await adapter.captureConversation();

        expect(graph.messages).toHaveLength(2);
        expect(graph.messages.map((message: { message_id: string }) => message.message_id)).toEqual([
            'center-user',
            'center-assistant',
        ]);
        expect(graph.artifacts).toHaveLength(1);
        expect(graph.artifacts[0]).toMatchObject({
            type: 'code_artifact',
            title: 'dist/assets/index-Bc2DiLid.js',
            mime_type: 'text/x-diff',
        });
        expect(graph.messages[1].artifact_ids).toHaveLength(1);
        expect(graph.artifacts[0].content).toContain('+ export function render()');
    });

    it('falls back to the provider registry during capture engine init', async () => {
        renderJulesLayout();

        await import('./jules');
        delete (window as any).__bonsaiAdapter;

        const { ProviderRegistry } = await import('./factory');
        const { captureEngine } = await import('../capture-engine');
        const registryAdapter = ProviderRegistry.getAdapter('jules.google.com');
        const getAdapterSpy = vi.spyOn(ProviderRegistry, 'getAdapter').mockReturnValue(registryAdapter);
        const initialized = captureEngine.init();

        expect(initialized).toBe(true);
        expect(getAdapterSpy).toHaveBeenCalledWith(window.location.hostname);
        expect(captureEngine.getAdapter()?.providerSite).toBe('jules.google.com');
    });
});