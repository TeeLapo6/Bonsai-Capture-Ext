/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../message-handler', () => ({}));
vi.mock('../dom-injector', () => ({
    domInjector: {
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

let ClaudeAdapterClass: typeof import('./claude').ClaudeAdapter;

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

describe('ClaudeAdapter code artifact capture', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        document.body.innerHTML = '';
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

        ({ ClaudeAdapter: ClaudeAdapterClass } = await import('./claude'));
    });

    it('captures only inner code-tag content for inline Claude artifacts', async () => {
        const adapter = new ClaudeAdapterClass();
        const message = document.createElement('div');
        message.innerHTML = `
            <div data-artifact data-artifact-type="code" data-artifact-id="artifact-1">
                <div class="artifact-title">Bonsai System Architecture</div>
                <div class="artifact-content">
                    <div class="w-full h-full relative">
                        <div class="code-block__code">
                            <code class="language-mermaid">flowchart TD\n    A --&gt; B</code>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const artifacts = await adapter.parseArtifacts(message);
        const artifact = artifacts.find((candidate) => candidate.type === 'code_artifact');

        expect(artifact).toBeDefined();
        expect(artifact?.content).toBe('flowchart TD\n    A --> B');
        expect(artifact?.mime_type).toBe('text/plain');
    });

    it('does not leak inline artifact documents into assistant message content', () => {
        const adapter = new ClaudeAdapterClass();
        const message = document.createElement('div');
        message.className = 'font-claude-response';
        message.innerHTML = `
            <div class="standard-markdown">
                <p>Here is the short assistant summary.</p>
            </div>
            <div data-artifact data-artifact-type="doc" data-artifact-id="artifact-doc-1">
                <div class="artifact-title">Competitive landscape analysis for Bonsai</div>
                <div class="artifact-content">
                    <div class="standard-markdown">
                        <h1>Competitive landscape analysis for Bonsai</h1>
                        <p>Three critical competitors threaten Bonsai in distinct ways.</p>
                    </div>
                </div>
            </div>
        `;

        const parsed = adapter.parseMessage(message, 0);
        const htmlBlock = parsed.content_blocks.find((block) => block.type === 'html');
        const html = htmlBlock && htmlBlock.type === 'html' ? htmlBlock.value : '';

        expect(html).toContain('Here is the short assistant summary.');
        expect(html).not.toContain('Three critical competitors threaten Bonsai in distinct ways.');
        expect(html).not.toContain('Competitive landscape analysis for Bonsai');
    });

    it('captures full document artifacts from the Claude panel instead of the inline preview snippet', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div data-artifact data-artifact-type="doc" data-artifact-id="artifact-doc-1">
                    <div class="artifact-title">Competitive landscape analysis for Bonsai</div>
                    <button aria-label="Competitive landscape analysis for Bonsai. Open artifact.">Open artifact</button>
                    <div class="artifact-content">
                        <div class="standard-markdown">
                            <p>Preview snippet only...</p>
                        </div>
                    </div>
                </div>
            </div>
            <div aria-label="Artifact panel: Competitive landscape analysis for Bonsai">
                <button aria-label="Close">Close</button>
                <div class="standard-markdown">
                    <h1>Competitive landscape analysis for Bonsai</h1>
                    <p>Three critical competitors threaten Bonsai in distinct ways.</p>
                    <p>This positions Bonsai as the foundational platform for AI transformation.</p>
                </div>
            </div>
        `;

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);
        const artifact = artifacts.find((candidate) => candidate.type === 'artifact_doc' || candidate.type === 'embedded_doc');

        expect(artifact).toBeDefined();
        expect(String(artifact?.content)).toContain('Three critical competitors threaten Bonsai in distinct ways.');
        expect(String(artifact?.content)).toContain('This positions Bonsai as the foundational platform for AI transformation.');
        expect(String(artifact?.content)).not.toContain('Preview snippet only...');
        expect(artifact?.mime_type).toBe('text/html');
    });

    it('captures only code content from opened Claude artifact panels', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <button aria-label="Bonsai System Architecture. Open artifact.">Open artifact</button>
            <div aria-label="Artifact panel: Bonsai System Architecture">
                <div class="w-full h-full relative">
                    <div class="code-block__code">
                        <code class="language-mermaid">flowchart TD\n    A --&gt; B</code>
                    </div>
                </div>
            </div>
        `;

        const opener = document.querySelector('button') as HTMLElement;
        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener);

        expect(artifact).toBeDefined();
        expect(artifact.type).toBe('code_artifact');
        expect(artifact.content).toBe('flowchart TD\n    A --> B');
        expect(artifact.mime_type).toBe('text/plain');
    });

    it('captures code artifacts correctly when the Claude panel is already in code view', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <button aria-label="Bonsai System Architecture. Open artifact.">Open artifact</button>
            <div aria-label="Artifact panel: Bonsai System Architecture">
                <button aria-label="Code" data-state="on">Code</button>
                <div class="overflow-y-scroll font-mono">flowchart TD\n    A --&gt; B</div>
            </div>
        `;

        const opener = document.querySelector('button[aria-label*="Open artifact"]') as HTMLElement;
        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener);

        expect(artifact).toBeDefined();
        expect(artifact.type).toBe('code_artifact');
        expect(artifact.content).toBe('flowchart TD\n    A --> B');
        expect(artifact.mime_type).toBe('text/plain');
    });
});