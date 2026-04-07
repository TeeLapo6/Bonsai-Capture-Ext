/**
 * Content Script Message Handler
 * 
 * Bridges communication between the side panel and the page adapter.
 */

import { captureEngine } from './capture-engine';
import type { CaptureScope } from '../shared/schema';
import type { ProviderCaptureSettings } from '../shared/capture-settings';

// Initialize capture engine
captureEngine.init();

// Track the last focused editable element so that "Paste" can insert text there
let lastFocusedInput: HTMLElement | null = null;
document.addEventListener('focusin', (e: FocusEvent) => {
    const target = e.target as HTMLElement;
    if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
    ) {
        lastFocusedInput = target;
    }
}, true);

// Listen for messages from the side panel
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
        try {
            switch (message.type) {
                case 'GET_DIAGNOSTICS':
                    sendResponse(captureEngine.getDiagnostics());
                    break;

                case 'REFRESH_DIAGNOSTICS':
                    captureEngine.init();
                    // Give it a moment to detect
                    setTimeout(() => {
                        sendResponse(captureEngine.getDiagnostics());
                    }, 500);
                    // Return true handled by wrapping logic? No, we need to be careful with async.
                    // The async IIFE wrapper handles the await, but setTimeout breaks the flow if we don't promisify it.
                    // Actually, captureEngine.init() is synchronous in detection but might trigger async side effects.
                    // Let's just return immediately for now, or use a small delay if needed.
                    // Better:
                    // sendResponse(captureEngine.getDiagnostics());
                    return true; // Keep open if we wanted to wait
                    // For now, let's just re-init and return.
                    break;

                case 'CAPTURE': {
                    captureEngine.applyProviderCaptureSettings(message.providerCaptureSettings as Partial<ProviderCaptureSettings> | null | undefined);

                    const numericMessageIndex = Number(message.messageIndex);
                    const messageIndex = Number.isFinite(numericMessageIndex) ? numericMessageIndex : undefined;
                    let messageId = typeof message.messageId === 'string' && message.messageId ? message.messageId : undefined;

                    if (!messageId && messageIndex !== undefined) {
                        messageId = String(messageIndex);
                    }

                    if (message.scope === 'entire') {
                        const data = await captureEngine.capture({ type: 'entire_conversation' });
                        sendResponse({ data });
                        return;
                    }

                    if (messageId) {
                        let scope: CaptureScope | null = null;

                        if (message.scope === 'single') {
                            scope = { type: 'single_message', message_id: messageId };
                        } else if (message.scope === 'upto') {
                            scope = { type: 'up_to_message', message_id: messageId };
                        } else if (message.scope === 'from') {
                            scope = { type: 'from_message', message_id: messageId };
                        }

                        if (scope) {
                            const data = await captureEngine.capture(scope);
                            if (data) {
                                sendResponse({ data });
                                return;
                            }
                        }
                    }

                    const adapter = captureEngine.getAdapter();

                    // Legacy index-based fallback (for existing messageIndex path and when messageId isn't present)
                    if (adapter) {
                        const graph = await adapter.captureConversation();
                        if (graph && messageIndex !== undefined && messageIndex >= 0 && messageIndex < graph.messages.length) {
                            if (message.scope === 'single') {
                                const single = graph.messages[messageIndex];
                                if (single) {
                                    graph.messages = [single];
                                    graph.artifacts = graph.artifacts.filter(a => single.artifact_ids.includes(a.artifact_id));
                                    sendResponse({ data: graph });
                                    return;
                                }
                            }
                            if (message.scope === 'upto') {
                                const messages = graph.messages.slice(0, messageIndex + 1);
                                const artifactIds = new Set(messages.flatMap(m => m.artifact_ids));
                                graph.messages = messages;
                                graph.artifacts = graph.artifacts.filter(a => artifactIds.has(a.artifact_id));
                                sendResponse({ data: graph });
                                return;
                            }
                            if (message.scope === 'from') {
                                const messages = graph.messages.slice(messageIndex);
                                const artifactIds = new Set(messages.flatMap(m => m.artifact_ids));
                                graph.messages = messages;
                                graph.artifacts = graph.artifacts.filter(a => artifactIds.has(a.artifact_id));
                                sendResponse({ data: graph });
                                return;
                            }
                        }
                    }

                    // General fallback
                    const fallbackData = await captureEngine.capture({ type: 'entire_conversation' });
                    sendResponse({ data: fallbackData });
                    return;
                }

                case 'SCAN_SIDEBAR':
                    const scanAdapter = captureEngine.getAdapter();
                    if (scanAdapter && scanAdapter.scanSidebar) {
                        const items = await scanAdapter.scanSidebar();
                        sendResponse({ items });
                    } else {
                        sendResponse({ items: [] });
                    }
                    break;

                case 'LOAD_CONVERSATION':
                    const loadAdapter = captureEngine.getAdapter();
                    if (loadAdapter && loadAdapter.loadConversation) {
                        const success = await loadAdapter.loadConversation(message.id);
                        sendResponse({ success });
                    } else {
                        sendResponse({ success: false });
                    }
                    break;

                case 'SEND_TO_AI':
                    const aiAdapter = captureEngine.getAdapter();
                    if (aiAdapter) {
                        const success = await aiAdapter.sendToAI(message.text);
                        sendResponse({ success });
                    } else {
                        sendResponse({ success: false, error: 'No adapter available' });
                    }
                    break;

                case 'PASTE_TEXT': {
                    const pasteText = message.text as string;
                    if (!pasteText) { sendResponse({ success: false }); break; }
                    // Re-focus the last tracked input, then insert text
                    const target = lastFocusedInput ?? (document.activeElement as HTMLElement | null);
                    if (
                        target &&
                        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
                    ) {
                        target.focus();
                        document.execCommand('insertText', false, pasteText);
                        sendResponse({ success: true });
                    } else {
                        sendResponse({ success: false, error: 'No focused input found' });
                    }
                    break;
                }

                default:
                    sendResponse({ error: 'Unknown message type' });
            }
        } catch (error) {
            console.error('[Bonsai Capture] Error handling message:', error);
            sendResponse({ error: String(error) });
        }
    })();

    // Keep channel open for async response
    return true;
});

// Log initialization
console.log('[Bonsai Capture] Content script initialized', captureEngine.getDiagnostics());
