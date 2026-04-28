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

    it('keeps distinct indexed deep research sources even when url and title match', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;

        const sources = adapter.dedupeDeepResearchSources([
            { index: 10, title: 'Repeated Source', url: 'https://example.com/source' },
            { index: 15, title: 'Repeated Source', url: 'https://example.com/source' },
        ]);

        expect(sources).toHaveLength(2);
        expect(sources.map((source: { index?: number }) => source.index)).toEqual([10, 15]);
        expect(sources.every((source: { aliases?: number[] }) => !source.aliases?.length)).toBe(true);
    });

    it('extracts indexed deep research sources from structured content_references payloads', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;

        const sources = adapter.extractSourceCandidatesFromJson(JSON.stringify({
            widgetState: {
                report_message: {
                    metadata: {
                        content_references: [
                            {
                                matched_text: '[1†L111-L116]',
                                title: 'Business Productivity Software Market Size, Report & Share Analysis 2031',
                                url: 'https://example.com/productivity#:~:text=market',
                            },
                            {
                                matched_text: '[17†L114-L122]',
                                title: 'Enterprise Collaboration Software Market - Share, Size & Trends 2031',
                                url: 'https://example.com/collaboration#:~:text=market',
                            },
                            {
                                matched_text: '[1†L139-L142]',
                                title: 'Business Productivity Software Market Size, Report & Share Analysis 2031',
                                url: 'https://example.com/productivity#:~:text=cagr',
                            },
                        ],
                    },
                },
            },
        }));

        expect(sources.map((source: { index?: number; title: string; url: string }) => ({
            index: source.index,
            title: source.title,
            url: source.url,
        }))).toEqual([
            {
                index: 1,
                title: 'Business Productivity Software Market Size, Report & Share Analysis 2031',
                url: 'https://example.com/productivity',
            },
            {
                index: 17,
                title: 'Enterprise Collaboration Software Market - Share, Size & Trends 2031',
                url: 'https://example.com/collaboration',
            },
        ]);
    });

    it('extracts indexed deep research sources from sources panel html', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;

        const sources = adapter.extractSourceCandidatesFromHtml(`
            <div>
                <div class="flex w-full min-w-0 items-start gap-[6px] overflow-hidden p-0">
                    <button type="button" aria-label="Scroll report to citation 1" data-citation-index="1">1</button>
                    <div class="flex min-w-0 flex-1 flex-col gap-1 pb-1">
                        <a href="https://example.com/productivity#:~:text=market" target="_blank">Business Productivity Software Market Size, Report & Share Analysis 2031</a>
                    </div>
                </div>
                <div class="flex w-full min-w-0 items-start gap-[6px] overflow-hidden p-0">
                    <button type="button" aria-label="Scroll report to citation 17" data-citation-index="17">17</button>
                    <div class="flex min-w-0 flex-1 flex-col gap-1 pb-1">
                        <a href="https://example.com/collaboration#:~:text=market" target="_blank">Enterprise Collaboration Software Market - Share, Size & Trends 2031</a>
                    </div>
                </div>
            </div>
        `, 'https://chatgpt.com/c/test');

        expect(sources.map((source: { index?: number; title: string; url: string }) => ({
            index: source.index,
            title: source.title,
            url: source.url,
        }))).toEqual([
            {
                index: 1,
                title: 'Business Productivity Software Market Size, Report & Share Analysis 2031',
                url: 'https://example.com/productivity',
            },
            {
                index: 17,
                title: 'Enterprise Collaboration Software Market - Share, Size & Trends 2031',
                url: 'https://example.com/collaboration',
            },
        ]);
    });

    it('replaces stale embedded source sections with computed sources', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;

        const html = adapter.appendSourcesToResearchHtml(
            [
                '<main>',
                '  <p>Executive summary<sup data-citation-index="1">1</sup><sup data-citation-index="2">2</sup></p>',
                '  <section data-bonsai-sources="true">',
                '    <h2>Sources</h2>',
                '    <ul>',
                '      <li data-bonsai-source-index="14"><sup>14</sup> <a href="https://old.example.com/a">Old Source A</a></li>',
                '      <li data-bonsai-source-index="35"><sup>35</sup> <a href="https://old.example.com/b">Old Source B</a></li>',
                '    </ul>',
                '  </section>',
                '</main>',
            ].join('\n'),
            [
                { index: 1, title: 'Fresh Source 1', url: 'https://example.com/1' },
                { index: 2, title: 'Fresh Source 2', url: 'https://example.com/2' },
            ]
        );

        expect(html).toContain('Fresh Source 1');
        expect(html).toContain('Fresh Source 2');
        expect(html).not.toContain('Old Source A');
        expect(html).not.toContain('Old Source B');
        expect(Array.from(html.matchAll(/data-bonsai-sources="true"/g))).toHaveLength(1);
        expect(html).toContain('<li data-bonsai-source-index="1"><sup>1</sup> <a href="https://example.com/1"');
        expect(html).toContain('<li data-bonsai-source-index="2"><sup>2</sup> <a href="https://example.com/2"');
    });

    it('rewrites probe markdown citations to canonical source indexes before appending sources', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;
        const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;

        // Build a sparse citations array matching the real metadata.citations wire format.
        // Each entry is { metadata: { url, title } }. The raw citation marker 【N†…】 maps
        // to citations[N-1] (0-based). Entries at irrelevant positions are null.
        const citations: unknown[] = new Array(50).fill(null);
        citations[0]  = { metadata: { url: 'https://example.com/productivity', title: 'Business Productivity Software Market Size, Report & Share Analysis 2031' } }; // raw 1  → canonical 1
        citations[7]  = { metadata: { url: 'https://example.com/knowledge',    title: 'Knowledge Management Market Size, Share & Forecast 2026-2034' } };            // raw 8  → canonical 3
        citations[16] = { metadata: { url: 'https://example.com/collaboration', title: 'Enterprise Collaboration Software Market - Share, Size & Trends 2031' } };    // raw 17 → canonical 2
        citations[49] = { metadata: { url: 'https://example.com/smb',           title: 'SMB Productivity Benchmark' } };                                             // raw 50 → canonical 4

        sendMessage.mockImplementation(({ type }: { type: string }) => {
            if (type === 'GET_OPENAI_RESEARCH_PROBE_DATA') {
                return Promise.resolve({
                    snapshots: [{
                        url: 'https://chatgpt.com/c/test',
                        title: 'Deep research test',
                        isTop: true,
                        bodyText: '',
                        bodyHtml: '',
                        entries: [{
                            kind: 'message-port',
                            url: 'https://chatgpt.com/backend-api/widget',
                            body: JSON.stringify([
                                'CALL',
                                {
                                    widgetState: {
                                        report_message: {
                                            metadata: { citations },
                                        },
                                    },
                                },
                            ]),
                            timestamp: Date.now(),
                        }],
                    }],
                });
            }

            return Promise.resolve({});
        });

        const rewritten = await adapter.rewriteProbeMarkdownCitationIndexes(
            [
                'Market size remains elevated [1†L111-L116] while collaboration spend grows [17†L114-L122].',
                'Knowledge market expansion [8†L63-L71] and SMB growth [50†L293-L302] continue.',
            ].join(' '),
            [
                { index: 1, title: 'Business Productivity Software Market Size, Report & Share Analysis 2031', url: 'https://example.com/productivity' },
                { index: 2, title: 'Enterprise Collaboration Software Market - Share, Size & Trends 2031', url: 'https://example.com/collaboration' },
                { index: 3, title: 'Knowledge Management Market Size, Share & Forecast 2026-2034', url: 'https://example.com/knowledge' },
                { index: 4, title: 'SMB Productivity Benchmark', url: 'https://example.com/smb' },
            ]
        );

        expect(rewritten).toContain('[1†L111-L116]');
        expect(rewritten).toContain('[2†L114-L122]');
        expect(rewritten).toContain('[3†L63-L71]');
        expect(rewritten).toContain('[4†L293-L302]');
        expect(rewritten).not.toContain('[17†L114-L122]');
        expect(rewritten).not.toContain('[8†L63-L71]');
        expect(rewritten).not.toContain('[50†L293-L302]');
    });

    it('ignores an earlier partial-coverage citations entry and uses the full-coverage one', async () => {
        // This is the root-cause regression: buildCanonicalCitationIndexMap must NOT
        // return early from the first entry with any matches. It must find the entry
        // whose citations array is large enough to cover ALL canonical sources.
        const adapter = (window as any).__bonsaiAdapter as any;
        const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;

        // Entry A (earlier): only 2 citations — partial coverage.
        // Entry B (later):   full 4-entry sparse array — full coverage.
        const fullCitations: unknown[] = new Array(50).fill(null);
        fullCitations[0]  = { metadata: { url: 'https://example.com/productivity', title: 'Productivity' } }; // raw 1  → canonical 1
        fullCitations[7]  = { metadata: { url: 'https://example.com/knowledge',    title: 'Knowledge' } };    // raw 8  → canonical 3
        fullCitations[14] = { metadata: { url: 'https://example.com/collaboration', title: 'Collab' } };      // raw 15 → canonical 2
        fullCitations[49] = { metadata: { url: 'https://example.com/smb',           title: 'SMB' } };         // raw 50 → canonical 4

        sendMessage.mockImplementation(({ type }: { type: string }) => {
            if (type === 'GET_OPENAI_RESEARCH_PROBE_DATA') {
                return Promise.resolve({
                    snapshots: [{
                        url: 'https://chatgpt.com/c/test',
                        title: 'Deep research test',
                        isTop: true,
                        bodyText: '',
                        bodyHtml: '',
                        entries: [
                            // Entry A: only 2 citations, partial overlap with canonical sources.
                            // This entry MUST be skipped because its coverage < canonicalSources.length.
                            {
                                kind: 'message-port',
                                url: 'https://chatgpt.com/backend-api/widget',
                                body: JSON.stringify(['CALL', {
                                    widgetState: {
                                        report_message: {
                                            metadata: {
                                                citations: [
                                                    { metadata: { url: 'https://example.com/productivity', title: 'Productivity' } },
                                                    { metadata: { url: 'https://example.com/smb', title: 'SMB' } },
                                                ],
                                            },
                                        },
                                    },
                                }]),
                                timestamp: Date.now() - 1000,
                            },
                            // Entry B: full sparse array matching all 4 canonical sources.
                            {
                                kind: 'message-port',
                                url: 'https://chatgpt.com/backend-api/widget',
                                body: JSON.stringify(['CALL', {
                                    widgetState: {
                                        report_message: {
                                            metadata: { citations: fullCitations },
                                        },
                                    },
                                }]),
                                timestamp: Date.now(),
                            },
                        ],
                    }],
                });
            }

            return Promise.resolve({});
        });

        const rewritten = await adapter.rewriteProbeMarkdownCitationIndexes(
            'Market [1†L111-L116] while collaboration [15†L114-L122]. Knowledge [8†L63-L71] and SMB [50†L293-L302].',
            [
                { index: 1, title: 'Productivity', url: 'https://example.com/productivity' },
                { index: 2, title: 'Collab', url: 'https://example.com/collaboration' },
                { index: 3, title: 'Knowledge', url: 'https://example.com/knowledge' },
                { index: 4, title: 'SMB', url: 'https://example.com/smb' },
            ]
        );

        // Entry B has: raw 1→1, raw 8→3, raw 15→2, raw 50→4.
        expect(rewritten).toContain('[1†L111-L116]');
        expect(rewritten).toContain('[2†L114-L122]');
        expect(rewritten).toContain('[3†L63-L71]');
        expect(rewritten).toContain('[4†L293-L302]');
        expect(rewritten).not.toContain('[15†L114-L122]');
        expect(rewritten).not.toContain('[8†L63-L71]');
        expect(rewritten).not.toContain('[50†L293-L302]');
    });

    it('prefers the winning message-port entry when multiple full-coverage citation arrays exist', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;
        const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;

        const entryA: unknown[] = new Array(50).fill(null);
        entryA[0] = { metadata: { url: 'https://example.com/productivity', title: 'Productivity' } }; // raw 1 -> canonical 1
        entryA[7] = { metadata: { url: 'https://example.com/smb', title: 'SMB' } };                   // raw 8 -> canonical 4
        entryA[14] = { metadata: { url: 'https://example.com/knowledge', title: 'Knowledge' } };      // raw 15 -> canonical 3
        entryA[49] = { metadata: { url: 'https://example.com/collaboration', title: 'Collab' } };     // raw 50 -> canonical 2

        const entryB: unknown[] = new Array(50).fill(null);
        entryB[0] = { metadata: { url: 'https://example.com/productivity', title: 'Productivity' } }; // raw 1 -> canonical 1
        entryB[7] = { metadata: { url: 'https://example.com/knowledge', title: 'Knowledge' } };       // raw 8 -> canonical 3
        entryB[14] = { metadata: { url: 'https://example.com/collaboration', title: 'Collab' } };     // raw 15 -> canonical 2
        entryB[49] = { metadata: { url: 'https://example.com/smb', title: 'SMB' } };                  // raw 50 -> canonical 4

        sendMessage.mockImplementation(({ type }: { type: string }) => {
            if (type === 'GET_OPENAI_RESEARCH_PROBE_DATA') {
                return Promise.resolve({
                    snapshots: [{
                        url: 'https://chatgpt.com/c/test',
                        title: 'Deep research test',
                        isTop: true,
                        bodyText: '',
                        bodyHtml: '',
                        entries: [
                            {
                                kind: 'message-port',
                                url: 'https://chatgpt.com/backend-api/widget',
                                body: JSON.stringify(['CALL', { widgetState: { report_message: { metadata: { citations: entryA } } } }]),
                                timestamp: Date.now() - 1000,
                            },
                            {
                                kind: 'message-port',
                                url: 'https://chatgpt.com/backend-api/widget',
                                body: JSON.stringify(['CALL', { widgetState: { report_message: { metadata: { citations: entryB } } } }]),
                                timestamp: Date.now(),
                            },
                        ],
                    }],
                });
            }

            return Promise.resolve({});
        });

        const rewritten = await adapter.rewriteProbeMarkdownCitationIndexes(
            'Market [1†L111-L116] while collaboration [15†L114-L122]. Knowledge [8†L63-L71] and SMB [50†L293-L302].',
            [
                { index: 1, title: 'Productivity', url: 'https://example.com/productivity' },
                { index: 2, title: 'Collab', url: 'https://example.com/collaboration' },
                { index: 3, title: 'Knowledge', url: 'https://example.com/knowledge' },
                { index: 4, title: 'SMB', url: 'https://example.com/smb' },
            ],
            {
                label: 'Probe message-port',
                score: 123,
                text: 'Market [1†L111-L116] while collaboration [15†L114-L122]. Knowledge [8†L63-L71] and SMB [50†L293-L302].',
                debugRef: 'snapshot:0:entry:1:message-port:https://chatgpt.com/backend-api/widget',
            }
        );

        expect(rewritten).toContain('[1†L111-L116]');
        expect(rewritten).toContain('[2†L114-L122]');
        expect(rewritten).toContain('[3†L63-L71]');
        expect(rewritten).toContain('[4†L293-L302]');
        expect(rewritten).not.toContain('[15†L114-L122]');
        expect(rewritten).not.toContain('[8†L63-L71]');
        expect(rewritten).not.toContain('[50†L293-L302]');
    });

    it('overrides the flat citations-position map with content_references when those raw markers map to canonical sources', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;
        const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;

        // Position-based mapping would be wrong here:
        // raw 15 -> canonical 4, raw 8 -> canonical 2, raw 24 -> canonical 3.
        // content_references should override to raw 15 -> 2, raw 8 -> 3, raw 24 -> 4.
        const citations: unknown[] = new Array(24).fill(null);
        citations[0] = { metadata: { url: 'https://example.com/productivity', title: 'Productivity' } }; // raw 1  -> canonical 1
        citations[7] = { metadata: { url: 'https://example.com/enterprise', title: 'Enterprise Productivity' } }; // raw 8 -> canonical 2 (wrong for knowledge)
        citations[14] = { metadata: { url: 'https://example.com/smb', title: 'SMB' } }; // raw 15 -> canonical 4 (wrong for collaboration)
        citations[23] = { metadata: { url: 'https://example.com/knowledge', title: 'Knowledge' } }; // raw 24 -> canonical 3 (wrong for SMB)

        sendMessage.mockImplementation(({ type }: { type: string }) => {
            if (type === 'GET_OPENAI_RESEARCH_PROBE_DATA') {
                return Promise.resolve({
                    snapshots: [{
                        url: 'https://chatgpt.com/c/test',
                        title: 'Deep research test',
                        isTop: true,
                        bodyText: '',
                        bodyHtml: '',
                        entries: [{
                            kind: 'message-port',
                            url: 'https://chatgpt.com/c/test',
                            body: JSON.stringify(['CALL', {
                                widgetState: {
                                    report_message: {
                                        metadata: {
                                            citations,
                                            content_references: [
                                                { matched_text: '[1†L111-L116]', title: 'Productivity', url: 'https://example.com/productivity' },
                                                { matched_text: '[15†L114-L122]', title: 'Collab', url: 'https://example.com/collaboration' },
                                                { matched_text: '[8†L63-L71]', title: 'Knowledge', url: 'https://example.com/knowledge' },
                                                { matched_text: '[24†L293-L302]', title: 'SMB', url: 'https://example.com/smb' },
                                            ],
                                        },
                                    },
                                },
                            }]),
                            timestamp: Date.now(),
                        }],
                    }],
                });
            }

            return Promise.resolve({});
        });

        const rewritten = await adapter.rewriteProbeMarkdownCitationIndexes(
            'Market [1†L111-L116] while collaboration [15†L114-L122]. Knowledge [8†L63-L71] and SMB [24†L293-L302].',
            [
                { index: 1, title: 'Productivity', url: 'https://example.com/productivity' },
                { index: 2, title: 'Collab', url: 'https://example.com/collaboration' },
                { index: 3, title: 'Knowledge', url: 'https://example.com/knowledge' },
                { index: 4, title: 'SMB', url: 'https://example.com/smb' },
            ],
            {
                label: 'Probe message-port',
                score: 123,
                text: 'Market [1†L111-L116] while collaboration [15†L114-L122]. Knowledge [8†L63-L71] and SMB [24†L293-L302].',
                debugRef: 'snapshot:0:entry:0:message-port:https://chatgpt.com/c/test',
            }
        );

        expect(rewritten).toContain('[1†L111-L116]');
        expect(rewritten).toContain('[2†L114-L122]');
        expect(rewritten).toContain('[3†L63-L71]');
        expect(rewritten).toContain('[4†L293-L302]');
        expect(rewritten).not.toContain('[15†L114-L122]');
        expect(rewritten).not.toContain('[8†L63-L71]');
        expect(rewritten).not.toContain('[24†L293-L302]');
    });

    it('does not collapse fragment-distinct reference URLs onto the last canonical source', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;
        const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;

        const citations: unknown[] = new Array(3).fill(null);
        citations[0] = { metadata: { url: 'https://example.com/report#:~:text=segment-a', title: 'Shared Report Title' } };
        citations[1] = { metadata: { url: 'https://example.com/report#:~:text=segment-b', title: 'Shared Report Title' } };
        citations[2] = { metadata: { url: 'https://example.com/report#:~:text=segment-c', title: 'Shared Report Title' } };

        sendMessage.mockImplementation(({ type }: { type: string }) => {
            if (type === 'GET_OPENAI_RESEARCH_PROBE_DATA') {
                return Promise.resolve({
                    snapshots: [{
                        url: 'https://chatgpt.com/c/test',
                        title: 'Deep research test',
                        isTop: true,
                        bodyText: '',
                        bodyHtml: '',
                        entries: [{
                            kind: 'message-port',
                            url: 'https://chatgpt.com/c/test',
                            body: JSON.stringify(['CALL', {
                                widgetState: {
                                    report_message: {
                                        metadata: {
                                            citations,
                                            content_references: [
                                                { matched_text: '[1†L1-L2]', title: 'Shared Report Title', url: 'https://example.com/report#:~:text=segment-a' },
                                                { matched_text: '[2†L3-L4]', title: 'Shared Report Title', url: 'https://example.com/report#:~:text=segment-b' },
                                                { matched_text: '[3†L5-L6]', title: 'Shared Report Title', url: 'https://example.com/report#:~:text=segment-c' },
                                            ],
                                        },
                                    },
                                },
                            }]),
                            timestamp: Date.now(),
                        }],
                    }],
                });
            }

            return Promise.resolve({});
        });

        const rewritten = await adapter.rewriteProbeMarkdownCitationIndexes(
            'Alpha [1†L1-L2], beta [2†L3-L4], gamma [3†L5-L6].',
            [
                { index: 1, title: 'Shared Report Title', url: 'https://example.com/report#:~:text=segment-a' },
                { index: 2, title: 'Shared Report Title', url: 'https://example.com/report#:~:text=segment-b' },
                { index: 3, title: 'Shared Report Title', url: 'https://example.com/report#:~:text=segment-c' },
            ],
            {
                label: 'Probe message-port',
                score: 123,
                text: 'Alpha [1†L1-L2], beta [2†L3-L4], gamma [3†L5-L6].',
                debugRef: 'snapshot:0:entry:0:message-port:https://chatgpt.com/c/test',
            }
        );

        expect(rewritten).toContain('[1†L1-L2]');
        expect(rewritten).toContain('[2†L3-L4]');
        expect(rewritten).toContain('[3†L5-L6]');
        expect(rewritten.match(/\[(\d+)†/g)).toEqual(['[1†', '[2†', '[3†']);
    });

    it('captures grouped turn wrappers and a trailing assistant bubble so Capture All ends on assistant', async () => {
        const adapter = (window as any).__bonsaiAdapter as {
            listMessages(): Element[];
            captureConversation(): Promise<{ messages: Array<{ role: string; message_id?: string }> }>;
        };

        document.title = 'Launch Review - ChatGPT';
        document.body.innerHTML = `
            <main>
                <div data-testid="conversation-turn-list">
                    <section data-testid="conversation-turn-1">
                        <article data-message-author-role="user" data-message-id="user-1">
                            <div data-testid="message-content">Outline a launch review</div>
                        </article>
                        <article data-message-author-role="assistant" data-message-id="assistant-1">
                            <div class="markdown">Here is the first draft.</div>
                        </article>
                    </section>
                    <section data-testid="conversation-turn-2">
                        <article data-message-author-role="user" data-message-id="user-2">
                            <div data-testid="message-content">Proceed with both</div>
                        </article>
                    </section>
                    <article data-message-author-role="assistant" data-message-id="assistant-2">
                        <div class="markdown">
                            <p>Homepage layout</p>
                            <p>System diagram</p>
                        </div>
                    </article>
                </div>
            </main>
        `;

        expect(adapter.listMessages().map((el) => el.getAttribute('data-message-id'))).toEqual([
            'user-1',
            'assistant-1',
            'user-2',
            'assistant-2',
        ]);

        const graph = await adapter.captureConversation();

        expect(graph.messages.map((message) => ({ id: message.message_id, role: message.role }))).toEqual([
            { id: 'user-1', role: 'user' },
            { id: 'assistant-1', role: 'assistant' },
            { id: 'user-2', role: 'user' },
            { id: 'assistant-2', role: 'assistant' },
        ]);
    });

    it('ignores generic group wrappers used for hover controls and auxiliary buttons', async () => {
        const adapter = (window as any).__bonsaiAdapter as {
            listMessages(): Element[];
        };

        document.title = 'Controls regression - ChatGPT';
        document.body.innerHTML = `
            <main>
                <div data-testid="conversation-turn-list">
                    <article data-message-author-role="user" data-message-id="user-1">
                        <div data-testid="message-content">Real message</div>
                    </article>
                    <div class="group" id="hover-controls">
                        <button aria-label="Copy">Copy</button>
                        <button aria-label="More">More</button>
                        <span>Scroll to bottom</span>
                    </div>
                    <article data-message-author-role="assistant" data-message-id="assistant-1">
                        <div class="markdown"><p>Real reply</p></div>
                    </article>
                </div>
            </main>
        `;

        expect(adapter.listMessages().map((el) => el.getAttribute('data-message-id'))).toEqual([
            'user-1',
            'assistant-1',
        ]);
    });

    it('does not treat control rows with accessible button labels as message turns', async () => {
        const adapter = (window as any).__bonsaiAdapter as {
            listMessages(): Element[];
        };

        document.title = 'Control row regression - ChatGPT';
        document.body.innerHTML = `
            <main>
                <div data-testid="conversation-turn-list">
                    <article data-message-author-role="user" data-message-id="user-1">
                        <div data-testid="message-content">Real message</div>
                    </article>
                    <div role="listitem" id="hover-controls">
                        <button aria-label="Copy">Copy</button>
                        <button aria-label="Thumbs up">Thumbs up</button>
                        <button aria-label="Thumbs down">Thumbs down</button>
                        <button aria-label="Edit message">Edit message</button>
                    </div>
                    <article data-message-author-role="assistant" data-message-id="assistant-1">
                        <div class="markdown"><p>Real reply</p></div>
                    </article>
                </div>
            </main>
        `;

        expect(adapter.listMessages().map((el) => el.getAttribute('data-message-id'))).toEqual([
            'user-1',
            'assistant-1',
        ]);
    });

    it('does not treat fallback control rows as messages when explicit role markers are absent', async () => {
        const adapter = (window as any).__bonsaiAdapter as {
            listMessages(): Element[];
        };

        document.title = 'Fallback control row regression - ChatGPT';
        document.body.innerHTML = `
            <main>
                <div data-testid="conversation-turn-list">
                    <article data-testid="conversation-turn-user" id="user-turn">
                        <div data-testid="message-content">Real message</div>
                    </article>
                    <div role="listitem" id="hover-controls">
                        <button aria-label="Copy">Copy</button>
                        <button aria-label="Thumbs up">Thumbs up</button>
                        <button aria-label="Thumbs down">Thumbs down</button>
                        <button aria-label="Edit message">Edit message</button>
                    </div>
                    <article data-testid="conversation-turn-assistant" id="assistant-turn">
                        <div class="markdown"><p>Real reply</p></div>
                    </article>
                </div>
            </main>
        `;

        expect(adapter.listMessages().map((el) => el.getAttribute('id'))).toEqual([
            'user-turn',
            'assistant-turn',
        ]);
    });

    it('captures a deep research creation turn without explicit role markers as its own message with an inline anchor', async () => {
        const adapter = (window as any).__bonsaiAdapter as {
            listMessages(): Element[];
            captureConversation(): Promise<{
                messages: Array<{
                    message_id: string;
                    artifact_ids: string[];
                    content_blocks: Array<{ type: string; value?: string }>;
                }>;
                artifacts: Array<{
                    artifact_id: string;
                    type: string;
                    source_message_id: string;
                    title: string;
                }>;
            }>;
        };

        document.title = 'Deep research regression - ChatGPT';
        document.body.innerHTML = `
            <main>
                <div data-testid="conversation-turn-list">
                    <article data-message-author-role="user" data-message-id="user-1">
                        <div data-testid="message-content">Run deep research on this topic.</div>
                    </article>
                    <section id="research-turn">
                        <strong>Deep research report</strong>
                        <iframe
                            title="internal://deep-research"
                            srcdoc="<main><h1>Deep research report</h1><p>Detailed findings from the research run.</p></main>"
                        ></iframe>
                    </section>
                    <article data-message-author-role="assistant" data-message-id="assistant-1">
                        <div class="markdown"><p>Follow-up reply</p></div>
                    </article>
                </div>
            </main>
        `;

        expect(adapter.listMessages().map((el) => el.getAttribute('data-message-id') ?? el.getAttribute('id'))).toEqual([
            'user-1',
            'research-turn',
            'assistant-1',
        ]);

        const graph = await adapter.captureConversation();
        const researchMessage = graph.messages.find((message) => message.message_id === 'research-turn');

        expect(researchMessage).toBeDefined();
        expect(researchMessage?.artifact_ids.length).toBe(1);
        expect(
            researchMessage?.content_blocks.some((block) =>
                block.type === 'markdown'
                && typeof block.value === 'string'
                && block.value.includes('](#artifact-')
                && block.value.includes('Deep research report')
            )
        ).toBe(true);

        expect(graph.artifacts.some((artifact) => (
            artifact.type === 'deep_research'
            && artifact.source_message_id === 'research-turn'
            && artifact.title === 'Deep research report'
        ))).toBe(true);
    });

    it('rejects fetched ChatGPT shell html when hydrating a deep research artifact', async () => {
        const adapter = (window as any).__bonsaiAdapter as {
            captureConversation(): Promise<{
                messages: Array<{
                    message_id: string;
                    content_blocks: Array<{ type: string; value?: string }>;
                }>;
                artifacts: Array<{
                    artifact_id: string;
                    type: string;
                    title: string;
                    content: string;
                    source_url?: string;
                    view_url?: string;
                }>;
            }>;
        };

        const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
        sendMessage.mockImplementation(({ type }: { type: string }) => {
            if (type === 'GET_OPENAI_RESEARCH_PROBE_DATA') {
                return Promise.resolve({ snapshots: [] });
            }

            if (type === 'EXTRACT_ALL_FRAMES') {
                return Promise.resolve({ frames: [] });
            }

            if (type === 'FETCH_REMOTE_RESOURCE') {
                return Promise.resolve({
                    ok: true,
                    contentType: 'text/html',
                    finalUrl: 'https://chatgpt.com/c/test-shell',
                    text: `
                        <!doctype html>
                        <html>
                            <head>
                                <title>Bonsai - Bonsai App Research Report</title>
                            </head>
                            <body>
                                <a href="#main">Skip to content</a>
                                <nav>
                                    <span>Chat history</span>
                                    <span>New chat</span>
                                    <span>Search chats</span>
                                    <span>Codex</span>
                                </nav>
                                <main>
                                    <section>ChatGPT said: wrapper page only</section>
                                </main>
                            </body>
                        </html>
                    `,
                });
            }

            return Promise.resolve({});
        });

        document.title = 'Deep research shell regression - ChatGPT';
        document.body.innerHTML = `
            <main>
                <div data-testid="conversation-turn-list">
                    <article data-message-author-role="user" data-message-id="user-1">
                        <div data-testid="message-content">Run deep research on this topic.</div>
                    </article>
                    <section id="research-turn">
                        <strong>Deep research report</strong>
                        <iframe
                            title="internal://deep-research"
                            src="https://connector_openai_deep_research.web-sandbox.oaiusercontent.com?app=chatgpt"
                        ></iframe>
                    </section>
                </div>
            </main>
        `;

        const graph = await adapter.captureConversation();
        const researchArtifact = graph.artifacts.find((artifact) => artifact.type === 'deep_research');
        const researchMessage = graph.messages.find((message) => message.message_id === 'research-turn');

        expect(researchArtifact).toBeDefined();
        expect(researchArtifact?.content).not.toContain('Skip to content');
        expect(researchArtifact?.content).not.toContain('Chat history');
        expect(researchArtifact?.title).toBe('Deep research report');
        expect(
            researchMessage?.content_blocks.some((block) =>
                block.type === 'markdown'
                && typeof block.value === 'string'
                && block.value.includes('](#artifact-')
                && block.value.includes('Deep research report')
            )
        ).toBe(true);
    });

    it('merges Mermaid code from alternate deep research candidates when the selected HTML only contains a rendered diagram shell', async () => {
        const adapter = (window as any).__bonsaiAdapter as any;

        vi.spyOn(adapter, 'collectProbeCandidatesForEmbed').mockResolvedValue([
            {
                label: 'Probe markdown',
                score: 120,
                text: [
                    'Executive Summary',
                    '',
                    'mermaid',
                    '',
                    'gantt',
                    'dateFormat YYYY-MM',
                    'title Rollout Timeline',
                    'section Product Development',
                    'MVP and Core Platform :a1, 2026-01, 6M',
                ].join('\n'),
                title: 'Deep research report',
                url: 'https://example.com/report',
            },
        ]);
        vi.spyOn(adapter, 'findFrameContentForEmbed').mockResolvedValue(null);
        vi.spyOn(adapter, 'collectSourcesForEmbed').mockResolvedValue([]);

        const artifact = await adapter.createDeepResearchArtifact({
            title: 'Deep research report',
            summary: [
                '<main>',
                '<h1>Deep research report</h1>',
                '<p>Executive Summary</p>',
                '<div class="chart-shell"></div>',
                '<p>Primary sources: collected from research.</p>',
                '</main>',
            ].join(''),
            sourceUrl: 'https://example.com/report',
            viewUrl: 'https://example.com/report',
        });

        expect(artifact).toBeDefined();
        expect(artifact?.mime_type).toBe('text/html');
        expect(String(artifact?.content)).toContain('language-mermaid');
        expect(String(artifact?.content)).toContain('gantt');
        expect(String(artifact?.content)).not.toContain('<svg');
    });

    it('skips empty assistant placeholders when capturing a conversation', async () => {
        const adapter = (window as any).__bonsaiAdapter as {
            captureConversation(): Promise<{ messages: Array<{ role: string; message_id?: string }> }>;
        };

        document.title = 'Empty placeholder regression - ChatGPT';
        document.body.innerHTML = `
            <main>
                <div data-testid="conversation-turn-list">
                    <article data-message-author-role="user" data-message-id="user-1">
                        <div data-testid="message-content">Keep only meaningful turns</div>
                    </article>
                    <article data-message-author-role="assistant" data-message-id="assistant-empty">
                        <div class="markdown">
                            <p> </p>
                        </div>
                    </article>
                    <article data-message-author-role="assistant" data-message-id="assistant-1">
                        <div class="markdown">
                            <p>Meaningful assistant reply</p>
                        </div>
                    </article>
                </div>
            </main>
        `;

        const graph = await adapter.captureConversation();

        expect(graph.messages.map((message) => ({ id: message.message_id, role: message.role }))).toEqual([
            { id: 'user-1', role: 'user' },
            { id: 'assistant-1', role: 'assistant' },
        ]);
    });
});