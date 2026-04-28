/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';

import { DOMInjector } from './dom-injector';

describe('DOMInjector ChatGPT force-fallback placement', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        delete (window as any).__bonsaiAdapter;
    });

    it('places the insert button via fallback container, not inside hover-controls, even when .flex.gap-1 and Copy buttons exist', () => {
        document.body.innerHTML = `
            <div role="log">
                <article data-testid="conversation-turn-2" id="turn-2">
                    <div data-message-author-role="assistant" id="bubble">
                        <div class="markdown"><p>Hello world</p></div>
                    </div>
                    <div class="flex gap-1" id="hover-controls">
                        <button aria-label="Copy">Copy</button>
                        <button aria-label="Thumbs up">Thumbs up</button>
                    </div>
                </article>
            </div>
        `;

        const bubble = document.getElementById('bubble')!;
        const hoverControls = document.getElementById('hover-controls')!;
        (window as any).__bonsaiAdapter = {
            listMessages: () => [bubble],
        };

        const injector = new DOMInjector();
        (injector as any).hostname = 'chatgpt.com';
        (injector as any).injectButtons();

        // Button must NOT be inside hover controls
        expect(hoverControls.querySelector('.bonsai-insert-btn')).toBeNull();
        // Button MUST be inside the fallback container appended to bubble
        const fallback = bubble.querySelector('.bonsai-fallback-container');
        expect(fallback).not.toBeNull();
        expect(fallback?.querySelector('.bonsai-insert-btn')).not.toBeNull();
    });

    it('does not create duplicate buttons when article and inner bubble are both processed', () => {
        document.body.innerHTML = `
            <div role="log">
                <article data-testid="conversation-turn-2" id="turn-2">
                    <div data-message-author-role="assistant" id="bubble">
                        <div class="markdown"><p>Hello world</p></div>
                    </div>
                    <div class="flex gap-1" id="hover-controls">
                        <button aria-label="Copy">Copy</button>
                    </div>
                </article>
            </div>
        `;

        const bubble = document.getElementById('bubble')!;
        const article = document.getElementById('turn-2')!;
        (window as any).__bonsaiAdapter = {
            // Simulate both being returned (before dedup)
            listMessages: () => [bubble, article],
        };

        const injector = new DOMInjector();
        (injector as any).hostname = 'chatgpt.com';
        (injector as any).injectButtons();

        const allButtons = document.querySelectorAll('.bonsai-insert-btn');
        expect(allButtons.length).toBe(1);
    });

    it('places the ChatGPT deep research insert button directly after the iframe wrapper', () => {
        document.body.innerHTML = `
            <div role="log">
                <section data-testid="conversation-turn-2" id="turn-2">
                    <div class="shell-meta">Research completed in 9m</div>
                    <div class="deep-research-outer" id="research-outer">
                        <div class="deep-research-frame" id="research-frame-wrapper">
                            <iframe
                                title="internal://deep-research"
                                src="https://connector_openai_deep_research.web-sandbox.oaiusercontent.com?app=chatgpt"
                            ></iframe>
                        </div>
                    </div>
                    <div class="flex gap-1" id="hover-controls">
                        <button aria-label="Copy">Copy</button>
                    </div>
                </section>
            </div>
        `;

        const turn = document.getElementById('turn-2')!;
        const researchOuter = document.getElementById('research-outer')!;
        (window as any).__bonsaiAdapter = {
            listMessages: () => [turn],
        };

        const injector = new DOMInjector();
        (injector as any).hostname = 'chatgpt.com';
        (injector as any).injectButtons();

        const fallback = researchOuter.nextElementSibling as HTMLElement | null;
        expect(fallback).not.toBeNull();
        expect(fallback?.classList.contains('bonsai-fallback-container')).toBe(true);
        expect(fallback?.querySelector('.bonsai-insert-btn')).not.toBeNull();
        expect(turn.lastElementChild?.id).toBe('hover-controls');
    });
});

describe('DOMInjector Gemini fallback placement', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        delete (window as any).__bonsaiAdapter;
    });

    it('places Gemini fallback insert buttons after the message when no action bar exists', () => {
        document.body.innerHTML = `
            <infinite-scroller class="chat-history">
                <div class="conversation-container">
                    <user-query id="user-msg">
                        <div class="query-text">Create a neon video.</div>
                    </user-query>
                    <model-response id="assistant-msg">
                        <message-content>
                            <video controls title="Neon loop" src="https://video.googleusercontent.com/generated/neon.mp4"></video>
                        </message-content>
                    </model-response>
                </div>
            </infinite-scroller>
        `;

        const assistantMessage = document.getElementById('assistant-msg');
        (window as any).__bonsaiAdapter = {
            listMessages: () => assistantMessage ? [assistantMessage] : [],
        };

        const injector = new DOMInjector();
        (injector as any).hostname = 'gemini.google.com';
        (injector as any).injectButtons();

        const fallback = assistantMessage?.nextElementSibling as HTMLElement | null;
        expect(fallback).not.toBeNull();
        expect(fallback?.classList.contains('bonsai-fallback-container')).toBe(true);
        expect(fallback?.querySelector('.bonsai-insert-btn')).not.toBeNull();
        expect(assistantMessage?.querySelector('.bonsai-fallback-container')).toBeNull();
    });
});