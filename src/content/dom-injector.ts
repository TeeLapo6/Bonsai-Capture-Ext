/**
 * DOM Injector
 * 
 * Injects "Insert to Editor" buttons into the chat page DOM after each message.
 * Uses MutationObserver to handle dynamically loaded messages.
 */

import { getSelectorsForSite, queryAllWithFallbacks } from '../config/selectors';
import { ProviderRegistry } from './adapters/factory';

type InsertMode = 'single' | 'upto' | 'from';

const INSERT_MODE_LABELS: Record<InsertMode, string> = {
    single: 'This Message',
    upto: 'Up to Message',
    from: 'This + Following',
};

// Button styles injected as a style element
const BUTTON_STYLES = `
.bonsai-insert-btn {
    display: inline-flex;
    align-items: stretch;
    padding: 0;
    margin-left: 8px;
    font-size: 11px;
    font-weight: 700;
    color: #082f3f;
    background: linear-gradient(90deg, #59e0b3 0%, #5bdfb4 14%, #5fddb8 28%, #63d9bf 42%, #67d3cb 56%, #68ccd9 70%, #67c4e7 84%, #62b5f7 100%);
    border: 1px solid rgba(96, 206, 176, 0.52);
    border-radius: 999px;
    overflow: hidden;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    z-index: 10;
    box-shadow: 0 10px 22px rgba(21, 104, 90, 0.18);
}

.bonsai-insert-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 24px rgba(21, 104, 90, 0.24);
}

.bonsai-insert-btn:active {
    transform: translateY(0);
}

.bonsai-insert-label,
.bonsai-insert-mode {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
}

.bonsai-insert-label {
    padding: 6px 10px 6px 12px;
    color: #0a3a2c;
    background: linear-gradient(90deg, rgba(89, 224, 179, 0.22), rgba(98, 214, 186, 0.18));
}

.bonsai-insert-mode {
    padding: 6px 12px 6px 10px;
    color: #083652;
    background: linear-gradient(90deg, rgba(104, 204, 217, 0.16), rgba(98, 181, 247, 0.22));
    border-left: 1px solid rgba(255, 255, 255, 0.22);
}

.bonsai-insert-btn.is-inserted .bonsai-insert-label {
    color: #0d3a2d;
}
`;

export class DOMInjector {
    private observer: MutationObserver | null = null;
    private styleEl: HTMLStyleElement | null = null;
    private hostname: string;
    private injectedMessages = new WeakSet<Element>();
    private insertMode: InsertMode = 'upto';
    private readonly handleStorageChange = (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string
    ) => {
        if (areaName !== 'local' || !changes.insertMode) {
            return;
        }

        const nextMode = changes.insertMode.newValue;
        if (this.isInsertMode(nextMode)) {
            this.insertMode = nextMode;
            this.refreshButtonMarkup();
        }
    };

    constructor() {
        this.hostname = window.location.hostname.replace(/^www\./, '');
    }

    /**
     * Start injecting buttons and observing for new messages.
     */
    start(): void {
        // Inject styles
        this.injectStyles();

        if (!chrome.storage.onChanged.hasListener(this.handleStorageChange)) {
            chrome.storage.onChanged.addListener(this.handleStorageChange);
        }

        chrome.storage.local.get(['insertMode'], (result) => {
            if (this.isInsertMode(result.insertMode)) {
                this.insertMode = result.insertMode;
            }

            this.injectButtons();
            this.refreshButtonMarkup();
        });

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

        if (chrome.storage.onChanged.hasListener(this.handleStorageChange)) {
            chrome.storage.onChanged.removeListener(this.handleStorageChange);
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

    private isInsertMode(value: unknown): value is InsertMode {
        return value === 'single' || value === 'upto' || value === 'from';
    }

    private renderButtonMarkup(isInserted = false): string {
        const insertLabel = isInserted ? 'Inserted' : 'Insert';
        const modeLabel = INSERT_MODE_LABELS[this.insertMode];
        return `<span class="bonsai-insert-label">${insertLabel}</span><span class="bonsai-insert-mode">${modeLabel}</span>`;
    }

    private refreshButtonMarkup(): void {
        document.querySelectorAll<HTMLButtonElement>('.bonsai-insert-btn').forEach((button) => {
            if (!button.classList.contains('is-inserted')) {
                button.innerHTML = this.renderButtonMarkup();
            }
            button.title = `Insert ${INSERT_MODE_LABELS[this.insertMode]}`;
        });
    }

    /**
     * Inject buttons into all messages.
     */
    private injectButtons(): void {
        const selectors = getSelectorsForSite(this.hostname);
        if (!selectors) return;

        let messages: Element[] = [];

        // Prefer adapter's own listMessages() if available to keep index mapping exact.
        const adapter = (window as any).__bonsaiAdapter ?? ProviderRegistry.getAdapter(this.hostname);
        if (adapter) {
            messages = adapter.listMessages();
        }

        // Only use raw selector fallback when no custom adapter is registered.
        // For providers with an adapter (e.g. Jules), raw selectors can hit unintended
        // elements (sidebar rows, etc.) and the observer will retry on DOM mutations.
        if ((!messages || messages.length === 0) && !adapter) {
            messages = queryAllWithFallbacks(document, selectors.messageBlock);
        }

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

        const stableMessageId = this.getMessageId(messageEl) ?? crypto.randomUUID();
        if (!messageEl.hasAttribute('data-message-id') && !messageEl.hasAttribute('data-bonsai-msg-id')) {
            try {
                messageEl.setAttribute('data-bonsai-msg-id', stableMessageId);
            } catch {
                // Some provider DOM nodes may reject attribute writes; the button still works with the synthetic id.
            }
        }

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
        button.type = 'button';
        button.innerHTML = this.renderButtonMarkup();
        button.title = `Insert ${INSERT_MODE_LABELS[this.insertMode]}`;
        button.dataset.messageIndex = String(index);
        button.dataset.messageId = stableMessageId;

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

        if (this.hostname.includes('jules.google.com')) {
            return this.createFallbackContainer(messageEl);
        }

        // GROK: .action-buttons is a sibling of message-bubble, not a descendant
        if (this.hostname.includes('grok.com')) {
            const actionButtons = messageEl.parentElement?.querySelector('.action-buttons');
            if (actionButtons) return actionButtons;
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

        if (this.hostname.includes('gemini.google.com')) {
            const next = messageEl.nextElementSibling;
            if (next && next.classList.contains('bonsai-fallback-container')) {
                return next;
            }

            const container = document.createElement('div');
            container.className = 'bonsai-action-container bonsai-fallback-container';
            container.style.cssText = 'display: flex; justify-content: flex-end; padding: 6px 0 0; margin-bottom: 16px; width: 100%; box-sizing: border-box;';

            if (messageEl.parentNode) {
                messageEl.parentNode.insertBefore(container, messageEl.nextSibling);
            } else {
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
            ?? messageEl.getAttribute('data-bonsai-msg-id')
            ?? messageEl.closest('[data-message-id]')?.getAttribute('data-message-id')
            ?? messageEl.closest('[data-bonsai-msg-id]')?.getAttribute('data-bonsai-msg-id')
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
            button.classList.add('is-inserted');
            button.innerHTML = this.renderButtonMarkup(true);
            setTimeout(() => {
                button.classList.remove('is-inserted');
                button.innerHTML = this.renderButtonMarkup();
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
