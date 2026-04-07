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
                <div id="wiggle-file-content">
                    <div class="standard-markdown">
                        <h1>Competitive landscape analysis for Bonsai</h1>
                        <p>Three critical competitors threaten Bonsai in distinct ways.</p>
                        <p>This positions Bonsai as the foundational platform for AI transformation.</p>
                    </div>
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

    it('opens and captures artifacts when the clickable opener is the artifact card root', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-doc-2"
                    class="artifact-block-cell"
                    role="button"
                    aria-label="Competitive landscape analysis for Bonsai. Open artifact."
                >
                    <div class="artifact-title">Competitive landscape analysis for Bonsai</div>
                    <div class="artifact-content">
                        <div class="standard-markdown">
                            <p>Collapsed preview snippet...</p>
                        </div>
                    </div>
                </div>
            </div>
            <div aria-label="Artifact panel: Competitive landscape analysis for Bonsai">
                <button aria-label="Close">Close</button>
                <div id="wiggle-file-content">
                    <div class="standard-markdown">
                        <h1>Competitive landscape analysis for Bonsai</h1>
                        <p>Panel capture content should be returned.</p>
                    </div>
                </div>
            </div>
        `;

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);
        const artifact = artifacts.find((candidate) => candidate.type === 'artifact_doc' || candidate.type === 'embedded_doc');

        expect(artifact).toBeDefined();
        expect(String(artifact?.content)).toContain('Panel capture content should be returned.');
        expect(String(artifact?.content)).not.toContain('Collapsed preview snippet...');
    });

    it('captures conversations when artifact cards are siblings of the assistant text container', async () => {
        const adapter = new ClaudeAdapterClass();
        document.title = 'Platform Rebuild Plan - Claude';
        document.body.innerHTML = `
            <div id="main-content">
                <div class="turn-wrapper">
                    <div class="font-claude-response">
                        <div class="standard-markdown">
                            <p>Both documents together form your complete technical blueprint.</p>
                        </div>
                    </div>
                    <div class="artifact-shell">
                        <div class="artifact-block-cell">
                            <div
                                data-artifact
                                data-artifact-type="doc"
                                data-artifact-id="artifact-doc-sibling"
                                role="button"
                                aria-label="Bonsai engine llm blocks supplement. Open artifact."
                            >
                                <div class="artifact-title">Bonsai engine llm blocks supplement</div>
                                <a href="/download/supplement.md" download>Download</a>
                            </div>
                        </div>
                    </div>
                </div>
                <div data-testid="user-message">Is this what you envisioned for the configuration system?</div>
            </div>
            <div aria-label="Artifact panel: Bonsai engine llm blocks supplement">
                <button aria-label="Close">Close</button>
                <div id="wiggle-file-content">
                    <div class="standard-markdown">
                        <h1>Bonsai engine llm blocks supplement</h1>
                        <p>CLI flags integration belongs in the execution context section.</p>
                    </div>
                </div>
            </div>
        `;

        const graph = await adapter.captureConversation();
        const assistantMessage = graph?.messages.find((message) => message.role === 'assistant');
        const artifact = graph?.artifacts.find((candidate) => candidate.artifact_id === 'artifact-doc-sibling');

        expect(graph).toBeDefined();
        expect(graph?.messages).toHaveLength(2);
        expect(assistantMessage?.content_blocks.some((block) => ('value' in block) && String(block.value).includes('complete technical blueprint'))).toBe(true);
        expect(artifact).toBeDefined();
        expect(String(artifact?.content)).toContain('CLI flags integration belongs in the execution context section.');
        expect(artifact?.source_url).toContain('/download/supplement.md');
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

    it('logs Claude artifact probe attempts in v1-v4 order when capture falls back to forced toggle scraping', async () => {
        const adapter = new ClaudeAdapterClass();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        document.body.innerHTML = `
            <button aria-label="Architecture Mermaid. Open artifact.">Open artifact</button>
            <div aria-label="Artifact panel: Architecture Mermaid">
                <div class="flex items-center justify-between px-2 py-2 bg-bg-000 gap-2">
                    <div class="flex items-center gap-2 flex-1 overflow-hidden pl-3">
                        <div role="group" class="group/segmented-control relative inline-flex w-fit h-8 text-sm font-medium bg-bg-300 p-0.5 select-none rounded-[.625rem]">
                            <button type="button" data-state="on" role="radio" aria-checked="true" aria-label="Preview">Preview</button>
                            <button type="button" data-state="off" role="radio" aria-checked="false" aria-label="Code">Code</button>
                        </div>
                        <strong>Architecture Mermaid</strong>
                    </div>
                </div>
                <div class="viewer-body">
                    <div class="standard-markdown">
                        <p>Preview snippet only...</p>
                    </div>
                </div>
            </div>
        `;

        const previewToggle = document.querySelector('button[aria-label="Preview"]') as HTMLButtonElement;
        const codeToggle = document.querySelector('button[aria-label="Code"]') as HTMLButtonElement;
        const viewerBody = document.querySelector('.viewer-body') as HTMLElement;

        codeToggle.addEventListener('click', () => {
            previewToggle.setAttribute('data-state', 'off');
            previewToggle.setAttribute('aria-checked', 'false');
            codeToggle.setAttribute('data-state', 'on');
            codeToggle.setAttribute('aria-checked', 'true');
            viewerBody.innerHTML = `
                <div class="flex-1 flex items-start pl-0 pr-2 group-data-[scrollable]/overlay:pr-6 min-w-0 font-mono"><code class="font-mono text-xs break-all">flowchart TD</code></div>
                <div class="flex-1 flex items-start pl-0 pr-2 group-data-[scrollable]/overlay:pr-6 min-w-0 font-mono"><code class="font-mono text-xs break-all">    A --&gt; B</code></div>
            `;
        });

        const opener = document.querySelector('button[aria-label*="Open artifact"]') as HTMLElement;
        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener, {
            artifactId: 'artifact-probe-sequence',
            fallbackTitle: 'Architecture Mermaid',
            typeHint: 'code',
        });

        expect(artifact?.type).toBe('code_artifact');
        expect(String(artifact?.content)).toContain('flowchart TD');

        const probeLogs = logSpy.mock.calls
            .map((call) => String(call[0] ?? ''))
            .filter((message) => message.includes('Bonsai [Claude-Artifact]: Attempting'));

        expect(probeLogs.map((message) => message.match(/Attempting (v\d)/)?.[1])).toEqual(['v1', 'v2', 'v3', 'v4']);
        expect(probeLogs.every((message) => message.includes('Found: Architecture Mermaid'))).toBe(true);
        expect(probeLogs.every((message) => message.includes('Content Type: Code'))).toBe(true);

        logSpy.mockRestore();
    });

    it('captures Claude document content from the XPath-matched wiggle element for doc artifacts', async () => {
        const adapter = new ClaudeAdapterClass();

        document.body.innerHTML = `
            <button aria-label="Plan document. Open artifact.">Open artifact</button>
            <div aria-label="Artifact panel: Plan document">
                <div class="flex items-center justify-between px-3 py-2">
                    <strong>Plan document</strong>
                </div>
                <div id="wiggle-file-content">
                    <div class="standard-markdown">
                        <h1>Plan document</h1>
                        <p>Captured directly from the XPath-matched wiggle element.</p>
                        <p>No copy probe, no clipboard, no toggle needed.</p>
                    </div>
                </div>
            </div>
        `;

        const opener = document.querySelector('button[aria-label*="Open artifact"]') as HTMLElement;
        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener, {
            artifactId: 'artifact-xpath-wiggle',
            fallbackTitle: 'Plan document',
            typeHint: 'doc',
        });

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(String(artifact?.content)).toContain('Captured directly from the XPath-matched wiggle element.');
        expect(String(artifact?.content)).toContain('No copy probe, no clipboard, no toggle needed.');
    });

    it('captures full markdown content from doc artifact panels via the configured XPath', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div data-artifact data-artifact-type="doc" data-artifact-id="artifact-doc-live-layout">
                    <div class="artifact-title">Bonsai hub blocks directory</div>
                    <a href="/download/hub-directory.md" download>Download</a>
                </div>
            </div>
            <div class="flex h-full flex-col relative">
                <div class="flex items-center justify-between px-2 py-2 bg-bg-000 gap-2">
                    <strong>Bonsai hub blocks directory · MD</strong>
                </div>
                <div id="wiggle-file-content">
                    <div class="standard-markdown">
                        <h1># Bonsai Hub - Building Blocks Directory</h1>
                        <h2>## Category Overview</h2>
                        <p>This document catalogs all launch building blocks.</p>
                    </div>
                </div>
            </div>
        `;

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);
        const artifact = artifacts.find((candidate) => candidate.artifact_id === 'artifact-doc-live-layout');

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(String(artifact?.content)).toContain('Bonsai Hub - Building Blocks Directory');
        expect(String(artifact?.content)).toContain('Category Overview');
        expect(String(artifact?.content)).toContain('This document catalogs all launch building blocks.');
        expect(artifact?.source_url).toContain('/download/hub-directory.md');
    });

    it('captures delayed Claude code viewers without mistaking the raw toggle for the code content', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    data-artifact
                    data-artifact-type="code"
                    data-artifact-id="artifact-delayed-mermaid"
                    role="button"
                >
                    <div class="artifact-title">Mermaid flowchart layout organization</div>
                </div>
            </div>
        `;

        const artifactCard = document.querySelector('[data-artifact-id="artifact-delayed-mermaid"]') as HTMLElement;
        artifactCard.addEventListener('click', () => {
            window.setTimeout(() => {
                document.body.insertAdjacentHTML('beforeend', `
                    <div class="flex h-full flex-col relative" aria-label="Artifact panel: Mermaid flowchart layout organization">
                        <div class="flex items-center justify-between px-2 py-2 bg-bg-000 gap-2">
                            <div class="flex items-center gap-2 flex-1 overflow-hidden pl-3">
                                <div role="group" class="group/segmented-control relative inline-flex w-fit h-8 text-sm font-medium bg-bg-300 p-0.5 select-none rounded-[.625rem]">
                                    <button type="button" data-state="on" role="radio" aria-checked="true" aria-label="Preview">Preview</button>
                                    <button type="button" data-state="off" role="radio" aria-checked="false" aria-label="Code" data-testid="undefined-raw">
                                        <div><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M0 0h20v20H0z"></path></svg></div>
                                    </button>
                                </div>
                                <strong>Mermaid flowchart layout organization</strong>
                            </div>
                        </div>
                        <div class="viewer-body">
                            <div class="standard-markdown">
                                <p>Preview snippet only...</p>
                            </div>
                        </div>
                    </div>
                `);

                const previewToggle = document.querySelector('button[aria-label="Preview"]') as HTMLButtonElement;
                const codeToggle = document.querySelector('button[aria-label="Code"]') as HTMLButtonElement;
                const viewerBody = document.querySelector('.viewer-body') as HTMLElement;

                codeToggle.addEventListener('click', () => {
                    previewToggle.setAttribute('data-state', 'off');
                    previewToggle.setAttribute('aria-checked', 'false');
                    codeToggle.setAttribute('data-state', 'on');
                    codeToggle.setAttribute('aria-checked', 'true');
                    viewerBody.innerHTML = `
                        <div class="flex-1 flex items-start pl-0 pr-2 group-data-[scrollable]/overlay:pr-6 min-w-0 font-mono"><code class="font-mono text-xs break-all">flowchart TD</code></div>
                        <div class="flex-1 flex items-start pl-0 pr-2 group-data-[scrollable]/overlay:pr-6 min-w-0 font-mono"><code class="font-mono text-xs break-all">    A --&gt; B</code></div>
                    `;
                });
            }, 80);
        });

        const artifact = await (adapter as any).captureClaudeOpenedArtifact(artifactCard, {
            artifactId: 'artifact-delayed-mermaid',
            fallbackTitle: 'Mermaid flowchart layout organization',
            typeHint: 'code',
        });

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('code_artifact');
        expect(String(artifact?.content)).toContain('flowchart TD');
        expect(String(artifact?.content)).toContain('A --> B');
        expect(String(artifact?.content)).not.toContain('Preview');
        expect(String(artifact?.content)).not.toContain('</>');
    });

    it('captures Claude document content via XPath from wiggle element when panel is visible', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <button aria-label="Source doc. Open artifact.">Open artifact</button>
            <div aria-label="Artifact panel: Source doc">
                <div class="flex items-center justify-between px-2 py-2 bg-bg-000 gap-2">
                    <strong>Source doc</strong>
                </div>
                <div class="viewer-body">
                    <div id="wiggle-file-content">
                        <div class="standard-markdown">
                            <h1>Source Doc</h1>
                            <h2>Inputs</h2>
                            <p>This content is captured via the configured XPath.</p>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const opener = document.querySelector('button[aria-label*="Open artifact"]') as HTMLElement;
        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener, {
            artifactId: 'artifact-wiggle-source',
            fallbackTitle: 'Source doc',
            typeHint: 'doc',
        });

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(String(artifact?.content)).toContain('Source Doc');
        expect(String(artifact?.content)).toContain('This content is captured via the configured XPath.');
    });

    it('captures open Claude document viewers identified by wiggle-file-content without Code toggles', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-doc-wiggle"
                    role="button"
                    aria-label="Bonsai SaaS Website Plan. Open artifact."
                >
                    <div class="artifact-title">Bonsai SaaS Website Plan</div>
                </div>
            </div>
            <div class="flex flex-1 h-full w-full overflow-hidden">
                <div class="flex items-center justify-between">
                    <div class="artifact-panel-header">
                        <strong>Bonsai SaaS Website Plan</strong>
                    </div>
                    <button aria-label="Close">Close</button>
                </div>
                <div id="wiggle-file-content" class="mx-auto w-full max-w-3xl">
                    <div class="standard-markdown">
                        <h1>Bonsai SaaS Website Plan</h1>
                        <p>Executive Summary</p>
                        <p>This document outlines a comprehensive plan for the SaaS launch.</p>
                    </div>
                </div>
            </div>
        `;

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);
        const artifact = artifacts.find((candidate) => candidate.artifact_id === 'artifact-doc-wiggle');

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(String(artifact?.content)).toContain('This document outlines a comprehensive plan for the SaaS launch.');
        expect(artifact?.mime_type).toBe('text/html');
    });

    it('captures delayed Claude document viewers identified by wiggle-file-content without Code toggles', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-doc-delayed-wiggle"
                    role="button"
                    aria-label="Bonsai SaaS Website Plan. Open artifact."
                >
                    <div class="artifact-title">Bonsai SaaS Website Plan</div>
                    <a href="/download/saas-plan.md" download>Download</a>
                </div>
            </div>
        `;

        const opener = document.querySelector('[data-artifact-id="artifact-doc-delayed-wiggle"]') as HTMLElement;
        opener.addEventListener('click', () => {
            window.setTimeout(() => {
                document.body.insertAdjacentHTML('beforeend', `
                    <div class="flex flex-1 h-full w-full overflow-hidden">
                        <div class="flex items-center justify-between">
                            <div class="artifact-panel-header">
                                <strong>Bonsai SaaS Website Plan</strong>
                            </div>
                            <button aria-label="Close">Close</button>
                        </div>
                        <div id="wiggle-file-content" class="mx-auto w-full max-w-3xl">
                            <div class="standard-markdown">
                                <h1>Bonsai SaaS Website Plan</h1>
                                <p>Executive Summary</p>
                                <p>This document outlines a comprehensive plan for the SaaS launch.</p>
                            </div>
                        </div>
                    </div>
                `);
            }, 80);
        });

        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener, {
            artifactId: 'artifact-doc-delayed-wiggle',
            fallbackTitle: 'Bonsai SaaS Website Plan',
            sourceUrl: 'https://claude.ai/download/saas-plan.md',
            typeHint: 'doc',
        });

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(String(artifact?.content)).toContain('This document outlines a comprehensive plan for the SaaS launch.');
        expect(artifact?.mime_type).toBe('text/html');
    });

    it('prefers broad wiggle DOM capture for document panels before clipboard fallback', async () => {
        const adapter = new ClaudeAdapterClass();
        const sendMessage = globalThis.chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-doc-wiggle-copy"
                    role="button"
                    aria-label="Bonsai SaaS Website Plan. Open artifact."
                >
                    <div class="artifact-title">Bonsai SaaS Website Plan</div>
                </div>
            </div>
            <div class="flex h-full flex-col relative">
                <div class="flex items-center justify-between">
                    <div class="artifact-panel-header">
                        <strong>Bonsai SaaS Website Plan</strong>
                    </div>
                    <div>
                        <button aria-label="Copy">Copy</button>
                        <button aria-label="Close">Close</button>
                    </div>
                </div>
                <div id="wiggle-file-content" class="mx-auto w-full max-w-3xl">
                    <div class="standard-markdown">
                        <h1>Bonsai SaaS Website Plan</h1>
                        <p>Executive Summary</p>
                        <p>This document outlines a comprehensive plan for the SaaS launch.</p>
                        <p>It should be captured directly from the DOM without clipboard access.</p>
                    </div>
                </div>
            </div>
        `;

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);
        const artifact = artifacts.find((candidate) => candidate.artifact_id === 'artifact-doc-wiggle-copy');

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(String(artifact?.content)).toContain('It should be captured directly from the DOM without clipboard access.');
        expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'INSTALL_CLAUDE_CLIPBOARD_INTERCEPTOR',
        }));
    });

    it('captures both artifacts from one message when the opened panel title expands the card title', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-doc-plan"
                    role="button"
                    aria-label="Bonsai SaaS Website Plan. Open artifact."
                >
                    <div class="artifact-title">Bonsai SaaS Website Plan</div>
                </div>
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-doc-directory"
                    role="button"
                    aria-label="Bonsai hub blocks directory. Open artifact."
                >
                    <div class="artifact-title">Bonsai hub blocks directory</div>
                </div>
            </div>
        `;

        const removeActivePanel = () => {
            document.querySelector('[data-test-open-panel="true"]')?.remove();
        };

        const mountPanel = (panelTitle: string, bodyHtml: string) => {
            removeActivePanel();
            const wrapper = document.createElement('div');
            wrapper.setAttribute('data-test-open-panel', 'true');
            wrapper.className = 'flex h-full flex-col relative';
            wrapper.innerHTML = `
                <div class="flex items-center justify-between">
                    <div class="artifact-panel-header">
                        <strong>${panelTitle}</strong>
                    </div>
                    <button aria-label="Close">Close</button>
                </div>
                <div id="wiggle-file-content" class="mx-auto w-full max-w-3xl leading-[1.65rem] px-6 py-4 md:py-6">
                    <div class="standard-markdown">${bodyHtml}</div>
                </div>
            `;
            wrapper.querySelector('button[aria-label="Close"]')?.addEventListener('click', () => wrapper.remove());
            document.body.appendChild(wrapper);
        };

        const firstOpener = document.querySelector('[data-artifact-id="artifact-doc-plan"]') as HTMLElement;
        firstOpener.addEventListener('click', () => {
            mountPanel(
                'Bonsai SaaS Website Plan',
                '<h1>Bonsai SaaS Website Plan</h1><p>Executive Summary</p><p>This document outlines a comprehensive plan for the SaaS launch.</p>'
            );
        });

        const secondOpener = document.querySelector('[data-artifact-id="artifact-doc-directory"]') as HTMLElement;
        secondOpener.addEventListener('click', () => {
            mountPanel(
                'Bonsai Hub - Building Blocks Directory',
                '<h1>Bonsai Hub - Building Blocks Directory</h1><p>Usage examples with @block-name notation.</p><p>Variables and configuration options.</p><p>Tags for discoverability.</p>'
            );
        });

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);

        expect(artifacts).toHaveLength(2);
        const firstArtifact = artifacts.find((candidate) => candidate.artifact_id === 'artifact-doc-plan');
        const secondArtifact = artifacts.find((candidate) => candidate.artifact_id === 'artifact-doc-directory');

        expect(firstArtifact).toBeDefined();
        expect(String(firstArtifact?.content)).toContain('This document outlines a comprehensive plan for the SaaS launch.');
        expect(secondArtifact).toBeDefined();
        expect(String(secondArtifact?.content)).toContain('Usage examples with @block-name notation.');
        expect(String(secondArtifact?.content)).toContain('Variables and configuration options.');
    });

    it('falls back to remote document fetch when the Claude viewer panel never appears', async () => {
        const adapter = new ClaudeAdapterClass();
        const sendMessage = (globalThis.chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>);
        sendMessage.mockImplementation(async (payload: { type?: string; url?: string }) => {
            if (payload.type === 'FETCH_REMOTE_RESOURCE' && payload.url?.includes('/download/remote-supplement.md')) {
                return {
                    ok: true,
                    text: '# Remote Supplement\n\n## Inputs\nThis document was captured from the download URL.',
                    contentType: 'text/markdown',
                    finalUrl: 'https://claude.ai/download/remote-supplement.md',
                };
            }

            return undefined;
        });

        document.body.innerHTML = `
            <div class="font-claude-response">
                <div data-artifact data-artifact-type="doc" data-artifact-id="artifact-remote-doc">
                    <div class="artifact-title">Remote Supplement</div>
                    <a href="/download/remote-supplement.md" download>Download</a>
                </div>
            </div>
        `;

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);
        const artifact = artifacts.find((candidate) => candidate.artifact_id === 'artifact-remote-doc');

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(artifact?.mime_type).toBe('text/markdown');
        expect(String(artifact?.content)).toContain('# Remote Supplement');
        expect(String(artifact?.content)).toContain('## Inputs');
        expect(artifact?.source_url).toContain('/download/remote-supplement.md');
    }, 12000);

    it('rejects Claude panel captures when the opened panel title does not match the source artifact title', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-title-lock"
                    role="button"
                    aria-label="Expected title. Open artifact."
                >
                    <div class="artifact-title">Expected title</div>
                </div>
            </div>
        `;

        const opener = document.querySelector('[data-artifact-id="artifact-title-lock"]') as HTMLElement;
        opener.addEventListener('click', () => {
            window.setTimeout(() => {
                document.body.insertAdjacentHTML('beforeend', `
                    <div aria-label="Artifact panel: Different title">
                        <button aria-label="Close">Close</button>
                        <div class="standard-markdown">
                            <h1>Different title</h1>
                            <p>This content should never be captured for the expected artifact.</p>
                        </div>
                    </div>
                `);
            }, 80);
        });

        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener, {
            artifactId: 'artifact-title-lock',
            fallbackTitle: 'Expected title',
            typeHint: 'doc',
        });

        expect(artifact).toBeNull();
    }, 12000);

    it('captures wiggle-based artifact when document H1 differs from opener title but heading bar matches', async () => {
        // Claude panels without aria-label use #wiggle-file-content as the panel root
        // candidate.  The document's own H1 (inside wiggle) may differ from the opener
        // title.  The heading bar <strong> (outside wiggle) holds the real panel title.
        // getClaudeArtifactPanelTitle must find the heading bar title, not the document H1.
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    role="button"
                    aria-label="Bonsai variants parallel cli design. Open artifact."
                >
                    <div class="artifact-block-cell">
                        <div class="leading-tight text-sm line-clamp-1">Bonsai variants parallel cli design</div>
                    </div>
                </div>
            </div>
            <div class="flex h-full flex-col relative">
                <div class="flex items-center justify-between px-2 py-2">
                    <h2>Bonsai variants parallel cli design · MD</h2>
                </div>
                <div class="flex-1 min-h-0">
                    <div id="wiggle-file-content" class="mx-auto w-full max-w-3xl">
                        <div class="standard-markdown font-claude-response">
                            <h1>Bonsai Parallel Executions, Regenerations, and Edits</h1>
                            <p>This is a comprehensive specification for parallel variants in Bonsai execution trees covering all execution modes.</p>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);

        expect(artifacts).toHaveLength(1);
        expect(String(artifacts[0].content)).toContain('comprehensive specification for parallel variants');
    }, 12000);

    it('captures supplement artifact when base artifact panel is open (same message, no token-overlap false-positive)', async () => {
        // "Bonsai coss rebuild strategy" has 4 tokens, all of which appear in
        // "Bonsai coss rebuild strategy supplement" (5 tokens).  The 75% token-overlap
        // heuristic in claudeTitlesMatch would falsely conclude the strategy panel already
        // shows the supplement, skipping the supplement opener and capturing strategy
        // content twice.  verifyClaudeArtifactTitleLock must use strict matching to avoid this.
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    role="button"
                    aria-label="Bonsai coss rebuild strategy. Open artifact."
                >
                    <div class="artifact-block-cell">
                        <div class="leading-tight text-sm line-clamp-1">Bonsai coss rebuild strategy</div>
                    </div>
                </div>
                <div
                    role="button"
                    aria-label="Bonsai coss rebuild strategy supplement. Open artifact."
                >
                    <div class="artifact-block-cell">
                        <div class="leading-tight text-sm line-clamp-1">Bonsai coss rebuild strategy supplement</div>
                    </div>
                </div>
            </div>
        `;

        const removePanel = () => document.querySelector('[data-test-panel]')?.remove();
        const mountPanel = (h2Title: string, h1Text: string, bodyText: string) => {
            removePanel();
            const wrapper = document.createElement('div');
            wrapper.setAttribute('data-test-panel', 'true');
            wrapper.className = 'flex h-full flex-col relative';
            wrapper.innerHTML = `
                <div class="flex items-center justify-between px-2 py-2">
                    <h2>${h2Title}</h2>
                    <button aria-label="Close">Close</button>
                </div>
                <div class="flex-1 min-h-0">
                    <div id="wiggle-file-content" class="mx-auto w-full max-w-3xl">
                        <div class="standard-markdown font-claude-response">
                            <h1>${h1Text}</h1>
                            <p>${bodyText}</p>
                        </div>
                    </div>
                </div>
            `;
            wrapper.querySelector('button[aria-label="Close"]')?.addEventListener('click', () => wrapper.remove());
            document.body.appendChild(wrapper);
        };

        const stratOpener = document.querySelector('[aria-label="Bonsai coss rebuild strategy. Open artifact."]') as HTMLElement;
        stratOpener.addEventListener('click', () => mountPanel(
            'Bonsai coss rebuild strategy · MD',
            'Bonsai COSS Rebuild Strategy',
            'This is the full strategy document covering commercial open source software model details.'
        ));

        const suppOpener = document.querySelector('[aria-label="Bonsai coss rebuild strategy supplement. Open artifact."]') as HTMLElement;
        suppOpener.addEventListener('click', () => {
            // Simulate panel remount for new artifact (old wiggle disconnects, new mounts)
            removePanel();
            window.setTimeout(() => {
                mountPanel(
                    'Bonsai coss rebuild strategy supplement · MD',
                    'Bonsai COSS Rebuild Strategy - Supplement',
                    'This is the supplement document with extensions and additions to the rebuild strategy.'
                );
            }, 80);
        });

        const message = document.querySelector('.font-claude-response') as Element;
        const artifacts = await adapter.parseArtifacts(message);

        expect(artifacts).toHaveLength(2);
        const strat = artifacts.find((a) => String(a.content).includes('commercial open source software model details'));
        const supp = artifacts.find((a) => String(a.content).includes('extensions and additions to the rebuild strategy'));
        expect(strat).toBeDefined();
        expect(supp).toBeDefined();
    }, 20000);

    it('cross-links a re-referenced artifact to each message that has an opener for it', async () => {
        // Simulates: assistant turn 1 creates artifact, turn 2 edits it.
        // Both openers open the SAME panel (same content → same dedup key).
        // Both messages must have the artifact in artifact_ids so single-message
        // capture for the LAST message still returns the artifact.
        const adapter = new ClaudeAdapterClass();
        document.title = 'Mermaid flowchart layout organization - Claude';
        document.body.innerHTML = `
            <div id="main-content">
                <div class="turn-wrapper">
                    <div class="font-claude-response">
                        <p>Here is your initial Mermaid flowchart.</p>
                    </div>
                    <div class="artifact-shell">
                        <div
                            data-artifact
                            data-artifact-id="mermaid-chart"
                            role="button"
                            aria-label="Mermaid flowchart layout organization. Open artifact."
                        >
                            <div class="artifact-title">Mermaid flowchart layout organization</div>
                        </div>
                    </div>
                </div>
                <div data-testid="user-message">Make the colors bolder.</div>
                <div class="turn-wrapper">
                    <div class="font-claude-response">
                        <p>I've updated the styling to use bold, saturated colors.</p>
                    </div>
                    <div class="artifact-shell">
                        <div
                            data-artifact
                            data-artifact-id="mermaid-chart"
                            role="button"
                            aria-label="Mermaid flowchart layout organization. Open artifact."
                        >
                            <div class="artifact-title">Mermaid flowchart layout organization</div>
                        </div>
                    </div>
                </div>
            </div>
            <div aria-label="Artifact panel: Mermaid flowchart layout organization">
                <button aria-label="Close">Close</button>
                <div class="standard-markdown">
                    <h1>Mermaid flowchart layout organization</h1>
                    <p>flowchart TD with bold saturated colors</p>
                </div>
            </div>
        `;

        const graph = await adapter.captureConversation();

        expect(graph).toBeDefined();
        // Only one artifact in the graph (deduplicated)
        expect(graph!.artifacts).toHaveLength(1);

        const firstAssistant = graph!.messages.find(m => m.role === 'assistant' && m.content_blocks.some(b => ('value' in b) && String(b.value).includes('initial Mermaid')));
        const lastAssistant = graph!.messages.find(m => m.role === 'assistant' && m.content_blocks.some(b => ('value' in b) && String(b.value).includes('bold, saturated')));

        expect(firstAssistant).toBeDefined();
        expect(lastAssistant).toBeDefined();

        // Both messages must reference the artifact
        expect(firstAssistant!.artifact_ids).toContain(graph!.artifacts[0].artifact_id);
        expect(lastAssistant!.artifact_ids).toContain(graph!.artifacts[0].artifact_id);
    });

    it('dedupes Claude code artifacts when opener capture has download links but visible-panel capture does not', async () => {
        const adapter = new ClaudeAdapterClass();
        document.title = 'Mermaid flowchart layout organization - Claude';
        document.body.innerHTML = `
            <div id="main-content">
                <div class="turn-wrapper">
                    <div class="font-claude-response">
                        <div class="standard-markdown">
                            <p>I've updated the styling to use bold, saturated colors.</p>
                        </div>
                    </div>
                    <div class="artifact-shell">
                        <div
                            data-artifact
                            data-artifact-type="code"
                            data-artifact-id="mermaid-chart-linked"
                            role="button"
                            aria-label="Mermaid flowchart layout organization. Open artifact."
                        >
                            <div class="artifact-title">Mermaid flowchart layout organization</div>
                            <a href="/download/mermaid-chart.mmd" download>Download</a>
                        </div>
                    </div>
                </div>
                <div class="flex flex-1 h-full w-full overflow-hidden">
                    <div class="flex items-center justify-between">
                        <div class="artifact-panel-header">
                            <strong>Mermaid flowchart layout organization</strong>
                        </div>
                        <button aria-label="Close">Close</button>
                    </div>
                    <div id="wiggle-file-content" class="mx-auto w-full max-w-3xl">
                        <div class="standard-markdown">
                            <p>flowchart TD</p>
                            <p>A --&gt; B</p>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const graph = await adapter.captureConversation();

        expect(graph).toBeDefined();
        expect(graph!.artifacts).toHaveLength(1);
        expect(String(graph!.artifacts[0].content)).toContain('flowchart TD');
    });

    it('links Claude code artifacts into the appendix during conversation capture', async () => {
        const adapter = new ClaudeAdapterClass();
        document.title = 'Architecture Mermaid - Claude';
        document.body.innerHTML = `
            <div id="main-content">
                <div class="font-claude-response">
                    <div class="standard-markdown">
                        <p>Here is the updated diagram.</p>
                    </div>
                </div>
                <div class="artifact-shell">
                    <div
                        data-artifact
                        data-artifact-type="code"
                        data-artifact-id="artifact-code-appendix"
                        role="button"
                        aria-label="Architecture Mermaid. Open artifact."
                    >
                        <div class="artifact-title">Architecture Mermaid</div>
                    </div>
                </div>
            </div>
            <div aria-label="Artifact panel: Architecture Mermaid">
                <button aria-label="Close">Close</button>
                <div class="w-full h-full relative">
                    <div class="code-block__code">
                        <code class="language-mermaid">flowchart TD\n    A --&gt; B</code>
                    </div>
                </div>
            </div>
        `;

        const graph = await adapter.captureConversation();
        const assistantMessage = graph?.messages.find((message) => message.role === 'assistant');

        expect(graph).toBeDefined();
        expect(graph?.artifacts).toHaveLength(1);
        expect(graph?.artifacts[0].type).toBe('code_artifact');
        expect(assistantMessage?.content_blocks.some(
            (block) => ('value' in block) && String(block.value).includes('[Architecture Mermaid](#artifact-artifact-code-appendix)')
        )).toBe(true);
    });

    it('captures document artifacts from panels that only have .standard-markdown (no wiggle, no aria-label, no code toggle)', async () => {
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div class="font-claude-response">
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-doc-md-only"
                    role="button"
                    aria-label="Bonsai SaaS Website Plan. Open artifact."
                >
                    <div class="artifact-title">Bonsai SaaS Website Plan</div>
                </div>
            </div>
        `;

        const opener = document.querySelector('[data-artifact-id="artifact-doc-md-only"]') as HTMLElement;
        opener.addEventListener('click', () => {
            window.setTimeout(() => {
                document.body.insertAdjacentHTML('beforeend', `
                    <div class="flex flex-1 h-full w-full overflow-hidden">
                        <div class="flex items-center justify-between px-3 py-2">
                            <strong>Bonsai SaaS Website Plan</strong>
                            <button aria-label="Close">Close</button>
                        </div>
                        <div id="wiggle-file-content" class="mx-auto w-full max-w-3xl px-4">
                            <div class="standard-markdown">
                                <h1>Bonsai SaaS Website Plan</h1>
                                <p>Executive Summary: This document outlines the comprehensive launch strategy and website architecture for Bonsai SaaS product.</p>
                            </div>
                            <div class="standard-markdown">
                                <h2>Market Analysis</h2>
                                <p>The AI-assisted development tools market is projected to reach $15B by 2028.</p>
                            </div>
                        </div>
                    </div>
                `);
            }, 80);
        });

        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener, {
            artifactId: 'artifact-doc-md-only',
            fallbackTitle: 'Bonsai SaaS Website Plan',
            typeHint: 'doc',
        });

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(String(artifact?.content)).toContain('Executive Summary');
        expect(String(artifact?.content)).toContain('Market Analysis');
        expect(String(artifact?.content)).toContain('$15B by 2028');
    });

    it('does not capture message-scoped .standard-markdown as artifact panels', async () => {
        const adapter = new ClaudeAdapterClass();
        document.title = 'Test conversation - Claude';
        document.body.innerHTML = `
            <div id="main-content">
                <div data-testid="user-message">Tell me about Bonsai</div>
                <div class="font-claude-response">
                    <div class="standard-markdown">
                        <h1>About Bonsai</h1>
                        <p>Bonsai is an AI execution system that uses conversation trees as its primary data structure. It supports branching, merging, and grafting of conversation threads.</p>
                    </div>
                </div>
            </div>
        `;

        const graph = await adapter.captureConversation();

        expect(graph).toBeDefined();
        // No artifacts should be captured — the .standard-markdown is inside a message, not a panel
        expect(graph!.artifacts).toHaveLength(0);
    });

    it('captures doc artifact content from XPath-matched wiggle element (no probe sequence runs)', async () => {
        const adapter = new ClaudeAdapterClass();

        // The panel has a wiggle-file-content element. For typeHint='doc' the XPath
        // //*[contains(@id,"wiggle")] resolves immediately — no probe sequence fires.
        document.body.innerHTML = `
            <button aria-label="XPath doc artifact. Open artifact.">Open artifact</button>
            <div aria-label="Artifact panel: XPath doc artifact">
                <button aria-label="Close">Close</button>
                <div id="wiggle-file-content">
                    <div class="standard-markdown">
                        <h1>XPath Doc Artifact</h1>
                        <p>Content captured via the configured XPath — no fiber, clipboard, or toggle interaction.</p>
                    </div>
                </div>
            </div>
        `;

        const opener = document.querySelector('button[aria-label*="Open artifact"]') as HTMLElement;
        const artifact = await (adapter as any).captureClaudeOpenedArtifact(opener, {
            artifactId: 'artifact-xpath-doc',
            fallbackTitle: 'XPath doc artifact',
            typeHint: 'doc',
        });

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('artifact_doc');
        expect(String(artifact?.content)).toContain('XPath Doc Artifact');
        expect(String(artifact?.content)).toContain('Content captured via the configured XPath');
    });

    it('does not leak sibling-artifact refs from adjacent message turns into the wrong parseArtifacts call', () => {
        // Two adjacent turn-wrappers, each with a sibling artifact card.
        // getClaudeArtifactRefs(message1) must return only message1's artifact card and
        // not pick up the opener card that belongs to message2's turn-wrapper.
        // This directly validates the message-rooted selection requirement (scope isolation).
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div id="main-content">
                <div class="turn-wrapper" id="turn-1">
                    <div class="font-claude-response" id="msg-1">
                        <div class="standard-markdown"><p>First response.</p></div>
                    </div>
                    <div class="artifact-shell">
                        <div
                            data-artifact
                            data-artifact-type="doc"
                            data-artifact-id="artifact-msg1"
                            role="button"
                            aria-label="Message 1 artifact. Open artifact."
                        >
                            <div class="artifact-title">Message 1 artifact</div>
                        </div>
                    </div>
                </div>
                <div data-testid="user-message">Follow-up question</div>
                <div class="turn-wrapper" id="turn-2">
                    <div class="font-claude-response" id="msg-2">
                        <div class="standard-markdown"><p>Second response.</p></div>
                    </div>
                    <div class="artifact-shell">
                        <div
                            data-artifact
                            data-artifact-type="doc"
                            data-artifact-id="artifact-msg2"
                            role="button"
                            aria-label="Message 2 artifact. Open artifact."
                        >
                            <div class="artifact-title">Message 2 artifact</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const msg1El = document.getElementById('msg-1') as Element;
        const msg2El = document.getElementById('msg-2') as Element;

        const refs1: Element[] = (adapter as any).getClaudeArtifactRefs(msg1El);
        const ids1 = refs1.map((r: Element) => r.getAttribute('data-artifact-id'));
        expect(ids1).toContain('artifact-msg1');
        expect(ids1).not.toContain('artifact-msg2');

        const refs2: Element[] = (adapter as any).getClaudeArtifactRefs(msg2El);
        const ids2 = refs2.map((r: Element) => r.getAttribute('data-artifact-id'));
        expect(ids2).toContain('artifact-msg2');
        expect(ids2).not.toContain('artifact-msg1');
    });

    it('does not leak sibling-artifact refs from adjacent message turns in a flat DOM structure', () => {
        // Claude sometimes renders artifact cards as flat siblings of the assistant message
        // element in the shared conversation container (no turn-wrappers).
        // getClaudeArtifactRefs(msg1) must return only artifact-1, not artifact-2.
        const adapter = new ClaudeAdapterClass();
        document.body.innerHTML = `
            <div id="main-content">
                <div data-testid="user-message">First question</div>
                <div class="font-claude-response" id="msg-1">
                    <div class="standard-markdown"><p>First response.</p></div>
                </div>
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-flat-1"
                    role="button"
                    aria-label="Flat artifact 1. Open artifact."
                >
                    <div class="artifact-title">Flat artifact 1</div>
                </div>
                <div data-testid="user-message">Second question</div>
                <div class="font-claude-response" id="msg-2">
                    <div class="standard-markdown"><p>Second response.</p></div>
                </div>
                <div
                    data-artifact
                    data-artifact-type="doc"
                    data-artifact-id="artifact-flat-2"
                    role="button"
                    aria-label="Flat artifact 2. Open artifact."
                >
                    <div class="artifact-title">Flat artifact 2</div>
                </div>
            </div>
        `;

        const msg1El = document.getElementById('msg-1') as Element;
        const msg2El = document.getElementById('msg-2') as Element;

        const refs1: Element[] = (adapter as any).getClaudeArtifactRefs(msg1El);
        const ids1 = refs1.map((r: Element) => r.getAttribute('data-artifact-id'));
        expect(ids1).toContain('artifact-flat-1');
        expect(ids1).not.toContain('artifact-flat-2');

        const refs2: Element[] = (adapter as any).getClaudeArtifactRefs(msg2El);
        const ids2 = refs2.map((r: Element) => r.getAttribute('data-artifact-id'));
        expect(ids2).toContain('artifact-flat-2');
        expect(ids2).not.toContain('artifact-flat-1');
    });

    it('visible artifact panel scan does not create a duplicate when an opener already captured the same content', async () => {
        // The opener-based path (parseArtifacts) captures the panel artifact,
        // then parseVisibleArtifacts runs globally and finds the same panel.
        // The dedup map must collapse both captures into one artifact entry.
        const adapter = new ClaudeAdapterClass();
        document.title = 'Dedup visible scan - Claude';
        document.body.innerHTML = `
            <div id="main-content">
                <div class="font-claude-response">
                    <div class="standard-markdown"><p>Here is the plan.</p></div>
                </div>
                <div class="artifact-shell">
                    <div
                        data-artifact
                        data-artifact-type="doc"
                        data-artifact-id="artifact-visible-dedup"
                        role="button"
                        aria-label="Dedup plan. Open artifact."
                    >
                        <div class="artifact-title">Dedup plan</div>
                    </div>
                </div>
            </div>
            <div aria-label="Artifact panel: Dedup plan">
                <button aria-label="Close">Close</button>
                <div id="wiggle-file-content">
                    <div class="standard-markdown">
                        <h1>Dedup plan</h1>
                        <p>This is the full plan content. It is long enough to meet the content threshold requirement for panel detection, ensuring no false-positive panel matches occur during the visible artifact scan path.</p>
                    </div>
                </div>
            </div>
        `;

        const graph = await adapter.captureConversation();

        expect(graph).toBeDefined();
        // Even though the opener path AND the visible-panel scan both find the same artifact,
        // only one entry must appear in graph.artifacts.
        expect(graph!.artifacts).toHaveLength(1);
        expect(graph!.artifacts[0].artifact_id).toBe('artifact-visible-dedup');
        expect(String(graph!.artifacts[0].content)).toContain('This is the full plan content.');
    });
});