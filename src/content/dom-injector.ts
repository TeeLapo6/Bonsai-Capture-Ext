/**
 * DOM Injector
 * 
 * Injects "Insert to Editor" buttons into the chat page DOM after each message.
 * Uses MutationObserver to handle dynamically loaded messages.
 */

import { getSelectorsForSite, queryAllWithFallbacks } from '../config/selectors';

// Button styles injected as a style element
const BUTTON_STYLES = `
.bonsai-insert-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    margin-left: 8px;
    font-size: 12px;
    font-weight: 500;
    color: #10b981;
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.3);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    z-index: 10;
}

.bonsai-insert-btn:hover {
    background: rgba(16, 185, 129, 0.2);
    border-color: rgba(16, 185, 129, 0.5);
    transform: translateY(-1px);
}

.bonsai-insert-btn:active {
    transform: translateY(0);
}

.bonsai-insert-btn svg {
    width: 14px;
    height: 14px;
}
`;

// SVG icon for the button
const INSERT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
  <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
</svg>`;

export class DOMInjector {
    private observer: MutationObserver | null = null;
    private styleEl: HTMLStyleElement | null = null;
    private hostname: string;
    private injectedMessages = new WeakSet<Element>();

    constructor() {
        this.hostname = window.location.hostname.replace(/^www\./, '');
    }

    /**
     * Start injecting buttons and observing for new messages.
     */
    start(): void {
        // Inject styles
        this.injectStyles();

        // Initial injection
        this.injectButtons();

        // Observe for new messages
        this.startObserver();

        console.log('[Bonsai Capture] DOM Injector started');
    }

    /**
     * Stop observing and clean up.
     */
    stop(): void {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        if (this.styleEl) {
            this.styleEl.remove();
            this.styleEl = null;
        }

        // Remove all injected buttons
        document.querySelectorAll('.bonsai-insert-btn').forEach(btn => btn.remove());
        document.querySelectorAll('.bonsai-action-container').forEach(c => c.remove());

        console.log('[Bonsai Capture] DOM Injector stopped');
    }

    /**
     * Inject styles into the page.
     */
    private injectStyles(): void {
        if (this.styleEl) return;

        this.styleEl = document.createElement('style');
        this.styleEl.id = 'bonsai-capture-styles';
        this.styleEl.textContent = BUTTON_STYLES;
        document.head.appendChild(this.styleEl);
    }

    /**
     * Inject buttons into all messages.
     */
    private injectButtons(): void {
        const selectors = getSelectorsForSite(this.hostname);
        if (!selectors) return;

        const messages = queryAllWithFallbacks(document, selectors.messageBlock);

        messages.forEach((messageEl, index) => {
            if (this.injectedMessages.has(messageEl)) return;

            this.injectButtonIntoMessage(messageEl, index);
            this.injectedMessages.add(messageEl);
        });
    }

    /**
     * Inject a button into a specific message element.
     */
    private injectButtonIntoMessage(messageEl: Element, index: number): void {

        // Skip artifact containers directly if identified as message blocks (unlikely but safe)
        if (messageEl.closest('.artifact-card, .code-block, pre, [data-is-artifact="true"], [data-artifact]')) return;
        // Also check down: Does this message element look like it's ONLY an artifact wrapper?
        if (messageEl.querySelector('.artifact-content') && !messageEl.querySelector('.font-user-message') && !messageEl.querySelector('.font-claude-response')) {
            // It might be a detached artifact container
            if (messageEl.classList.contains('artifact') || messageEl.getAttribute('data-testid') === 'artifact') return;
        }

        // Find the action bar or create insertion point
        const actionBar = this.findActionBar(messageEl);

        // Check if already has our button
        if (actionBar.querySelector('.bonsai-insert-btn')) return;

        // Create button
        const button = document.createElement('button');
        button.className = 'bonsai-insert-btn';
        button.innerHTML = `${INSERT_ICON}<span>Insert</span>`;
        button.title = 'Insert to Bonsai Editor';
        button.dataset.messageIndex = String(index);
        button.dataset.messageId = this.getMessageId(messageEl) ?? String(index);

        // Click handler
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleInsertClick(messageEl, index);
        });

        // Insert button
        actionBar.appendChild(button);
    }

    /**
     * Find the action bar within a message element.
     */
    private findActionBar(messageEl: Element): Element {
        // FORCE BOTTOM PLACEMENT FOR CLAUDE
        if (this.hostname.includes('claude.ai')) {
            return this.createFallbackContainer(messageEl);
        }

        // Provider-specific action bar selectors
        const actionSelectors = [
            // Claude Main Action Bar (Skipped due to force-bottom policy above)
            '.font-claude-message-actions',
            '.message-actions-container',

            // ChatGPT
            '[data-testid="message-actions"]',
            '.message-actions',
            '.flex.gap-1',
            '.text-gray-400.flex',
            '.flex.items-center.gap-1',

            // Gemini
            '.response-actions',
            '.action-buttons',
        ];

        for (const selector of actionSelectors) {
            const bars = messageEl.querySelectorAll(selector);
            for (let i = 0; i < bars.length; i++) {
                const bar = bars[i];
                // CRITICAL: Skip bars inside artifacts, code blocks, or nested components.
                if (bar.closest('.artifact-card, .code-block, pre, [data-is-artifact="true"], [data-artifact]')) continue;
                return bar;
            }
        }

        // Fallback: Look for the Copy/Edit/Reply button row
        const buttons = messageEl.querySelectorAll('button');
        for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
            if (label.includes('copy') || label.includes('edit') || label.includes('reply')) {
                const row = btn.closest('.flex, .row, [role="group"]');
                if (row) {
                    if (row.closest('.artifact-card, .code-block, pre, [data-is-artifact="true"], [data-artifact]')) continue;
                    if (row.parentElement?.closest('.grid')) return row;
                    return row;
                }
            }
        }

        // FALLBACK: Create a simple container if no action bar found
        return this.createFallbackContainer(messageEl);
    }

    private createFallbackContainer(messageEl: Element): Element {
        // SPECIAL HANDLING: Claude User Messages
        // GROUP WRAPPER ESCAPE STRATEGY
        const isClaudeUser = this.hostname.includes('claude.ai') &&
            (messageEl.getAttribute('data-is-author-user') === 'true' ||
                messageEl.querySelector('.font-user-message') ||
                messageEl.matches('[data-testid="user-message"]'));

        if (isClaudeUser) {
            let referenceNode = messageEl;

            // Traverse up to find the '.group' wrapper or closest semantic Row
            // Typical hierarchy: div > div.group > div > div.grid

            let foundGroup = false;
            let currentNode = messageEl;
            for (let i = 0; i < 6; i++) {
                if (currentNode.classList.contains('group')) {
                    referenceNode = currentNode;
                    foundGroup = true;
                    break;
                }
                if (currentNode.parentElement) {
                    currentNode = currentNode.parentElement;
                } else break;
            }

            // If we didn't find .group, try to find just valid parent that isn't the grid or bubble
            if (!foundGroup) {
                // Fallback traversal: go up 3 levels blindly from messageEl
                // If messageEl is inner text div
                if (!messageEl.classList.contains('font-user-message')) {
                    const bubble = messageEl.closest('.font-user-message');
                    if (bubble && bubble.parentElement && bubble.parentElement.parentElement) {
                        referenceNode = bubble.parentElement.parentElement;
                    }
                } else {
                    // messageEl IS the bubble
                    if (messageEl.parentElement && messageEl.parentElement.parentElement) {
                        referenceNode = messageEl.parentElement.parentElement;
                    }
                }
            }


            // Check if we already injected a sibling at this level
            const next = referenceNode.nextElementSibling;
            if (next && next.classList.contains('bonsai-fallback-container')) {
                return next;
            }

            // Create container
            const container = document.createElement('div');
            container.className = 'bonsai-action-container bonsai-fallback-container';
            // Style: Full width, right aligned.
            container.style.cssText = 'display: flex; justify-content: flex-end; padding: 0 4px; margin-top: -6px; margin-bottom: 24px; width: 100%; box-sizing: border-box;';

            // Insert AFTER the referenceNode (The Group Wrapper)
            if (referenceNode.parentNode) {
                referenceNode.parentNode.insertBefore(container, referenceNode.nextSibling);
            } else {
                // Fallback
                messageEl.appendChild(container);
            }
            return container;
        }

        // Default handling for Assistant / Others (Inside Bottom)
        const existing = messageEl.querySelector('.bonsai-fallback-container');
        if (existing) return existing;

        const container = document.createElement('div');
        container.className = 'bonsai-action-container bonsai-fallback-container';
        container.style.cssText = 'display: flex; justify-content: flex-end; padding: 6px; margin-top: auto; border-top: 1px solid rgba(128,128,128,0.1); width: 100%; box-sizing: border-box;';

        messageEl.appendChild(container);
        return container;
    }

    /**
     * Get message ID from element.
     */
    private getMessageId(messageEl: Element): string | null {
        return messageEl.getAttribute('data-message-id')
            ?? messageEl.closest('[data-message-id]')?.getAttribute('data-message-id')
            ?? null;
    }

    /**
     * Handle click on insert button.
     */
    private handleInsertClick(messageEl: Element, index: number): void {
        const messageId = this.getMessageId(messageEl) ?? String(index);

        // Send message to side panel via background
        chrome.runtime.sendMessage({
            type: 'INSERT_FROM_DOM',
            messageId,
            messageIndex: index
        });

        // Visual feedback
        let button = messageEl.querySelector('.bonsai-insert-btn');

        // Deep search for Sibling button
        if (!button) {
            let ref = messageEl;
            // Search up to 6 levels up for a sibling
            for (let i = 0; i < 6; i++) {
                if (ref.nextElementSibling?.classList.contains('bonsai-fallback-container')) {
                    button = ref.nextElementSibling.querySelector('.bonsai-insert-btn');
                    if (button) break;
                }
                if (ref.parentElement && ref.parentElement.tagName !== 'BODY') {
                    ref = ref.parentElement;
                } else break;
            }
        }


        if (button) {
            button.textContent = '✓ Inserted';
            setTimeout(() => {
                button.innerHTML = `${INSERT_ICON}<span>Insert</span>`;
            }, 1500);
        }

        console.log('[Bonsai Capture] Insert clicked for message:', messageId);
    }

    /**
     * Start MutationObserver to watch for new messages.
     */
    private startObserver(): void {
        const selectors = getSelectorsForSite(this.hostname);
        if (!selectors) return;

        this.observer = new MutationObserver((mutations) => {
            let shouldInject = false;

            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    shouldInject = true;
                    break;
                }
            }

            if (shouldInject) {
                // Debounce injection
                requestAnimationFrame(() => this.injectButtons());
            }
        });

        // Observe the body for changes
        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }
}

// Singleton instance
export const domInjector = new DOMInjector();
