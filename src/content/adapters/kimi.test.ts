/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../message-handler', () => ({}));
vi.mock('../dom-injector', () => ({
    domInjector: {
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

let KimiAdapterClass: typeof import('./kimi').KimiAdapter;

describe('KimiAdapter conversation detection', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        document.body.innerHTML = '';
        document.title = 'Unnamed Chat - Kimi';

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

        ({ KimiAdapter: KimiAdapterClass } = await import('./kimi'));
    });

    it('detects Kimi chat conversations with messages', () => {
        document.title = 'Quantum Computing - Kimi';
        document.body.innerHTML = `
            <div class="chat-box">
                <div class="message-list">
                    <div class="user-message px-4 py-3">
                        <div class="markdown-content">
                            <p>Explain quantum computing in simple terms.</p>
                        </div>
                    </div>
                    <div class="kimi-message px-4 py-3">
                        <div class="markdown-content">
                            <p>Quantum computing uses <strong>qubits</strong> that can exist in multiple states simultaneously.</p>
                            <pre><code class="language-python">from qiskit import QuantumCircuit
circuit = QuantumCircuit(2)
circuit.h(0)
circuit.cx(0, 1)</code></pre>
                        </div>
                    </div>
                </div>
                <div class="chat-input-editor">
                    <div data-lexical-editor="true" contenteditable="true"></div>
                </div>
            </div>
        `;

        const adapter = new KimiAdapterClass();
        const conversation = adapter.detectConversation();
        const messages = adapter.listMessages();
        const userMessage = adapter.parseMessage(messages[0], 0);
        const assistantMessage = adapter.parseMessage(messages[1], 1);

        expect(conversation).not.toBeNull();
        expect(conversation?.title).toBe('Quantum Computing');
        expect(messages).toHaveLength(2);
        expect(userMessage.role).toBe('user');
        expect(assistantMessage.role).toBe('assistant');
        expect((userMessage.content_blocks[0] as { value?: string }).value).toContain('Explain quantum computing');
        expect((assistantMessage.content_blocks[0] as { value?: string }).value).toContain('**qubits**');
        expect((assistantMessage.content_blocks[0] as { value?: string }).value).toContain('```python');
    });

    it('preserves code blocks and rich markdown in assistant messages', () => {
        document.title = 'Code Review - Kimi';
        document.body.innerHTML = `
            <div class="chat-box">
                <div class="message-list">
                    <div class="user-message">
                        <p>Review this code.</p>
                    </div>
                    <div class="kimi-message">
                        <div class="markdown-content">
                            <p>Here are my suggestions:</p>
                            <ol>
                                <li>Use <strong>async/await</strong> instead of promises</li>
                                <li>Add <em>error handling</em></li>
                            </ol>
                            <pre><code class="language-javascript">async function fetchData() {
  const res = await fetch('/api');
  return res.json();
}</code></pre>
                            <p>See <a href="https://example.com/docs">the docs</a> for more.</p>
                        </div>
                    </div>
                </div>
                <div data-lexical-editor="true" contenteditable="true"></div>
            </div>
        `;

        const adapter = new KimiAdapterClass();
        const message = adapter.parseMessage(adapter.listMessages()[1], 1);
        const markdown = (message.content_blocks[0] as { value?: string }).value ?? '';

        expect(markdown).toContain('1. Use **async/await** instead of promises');
        expect(markdown).toContain('2. Add *error handling*');
        expect(markdown).toContain('```javascript');
        expect(markdown).toContain('[the docs](https://example.com/docs)');
    });

    it('returns null for home page with activity area', () => {
        document.body.innerHTML = `
            <div class="home-page">
                <div class="activity-area">
                    <div class="activity-card">Kimi K2.6 is here</div>
                </div>
                <div data-lexical-editor="true" contenteditable="true"></div>
            </div>
        `;

        const adapter = new KimiAdapterClass();
        const conversation = adapter.detectConversation();

        expect(conversation).toBeNull();
    });

    it('treats composer-only Kimi pages as available conversations', () => {
        document.title = 'Kimi AI with K2.6 | Better Coding, Smarter Agents';
        document.body.innerHTML = `
            <div class="chat-box">
                <div class="chat-input-editor">
                    <div data-lexical-editor="true" contenteditable="true"></div>
                </div>
            </div>
        `;

        const adapter = new KimiAdapterClass();
        const conversation = adapter.detectConversation();

        expect(conversation).not.toBeNull();
        expect(adapter.listMessages()).toHaveLength(0);
    });

    it('detects roles by position when class-based detection fails', () => {
        document.body.innerHTML = `
            <div class="chat-box">
                <div class="message-list">
                    <div class="generic-item"><p>User message first</p></div>
                    <div class="generic-item"><p>Kimi response</p></div>
                </div>
                <div data-lexical-editor="true" contenteditable="true"></div>
            </div>
        `;

        const adapter = new KimiAdapterClass();
        const messages = adapter.listMessages();

        expect(messages).toHaveLength(2);
        expect(adapter.parseMessage(messages[0], 0).role).toBe('user');
        expect(adapter.parseMessage(messages[1], 1).role).toBe('assistant');
    });

    it('extracts code artifacts', () => {
        document.body.innerHTML = `
            <div class="chat-box">
                <div class="message-list">
                    <div class="kimi-message" data-message-id="msg-1">
                        <div class="markdown-content">
                            <p>Here is the code:</p>
                            <pre><code class="language-typescript">interface User {
  name: string;
  age: number;
}</code></pre>
                        </div>
                    </div>
                </div>
                <div data-lexical-editor="true" contenteditable="true"></div>
            </div>
        `;

        const adapter = new KimiAdapterClass();
        const messages = adapter.listMessages();
        const artifacts = adapter.parseArtifacts(messages[0]);

        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].type).toBe('code_artifact');
        expect(artifacts[0].title).toBe('Code (typescript)');
        expect(artifacts[0].mime_type).toBe('text/typescript');
    });
});
