/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';

import { DOMInjector } from './dom-injector';

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