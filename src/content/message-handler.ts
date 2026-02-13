/**
 * Content Script Message Handler
 * 
 * Bridges communication between the side panel and the page adapter.
 */

import { captureEngine } from './capture-engine';
import type { CaptureScope } from '../shared/schema';

// Initialize capture engine
captureEngine.init();

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

                case 'CAPTURE':
                    const messageIndex = message.messageIndex;
                    let scope: CaptureScope = { type: 'entire_conversation' };

                    // Handle legacy index-based scopes manually if needed, or map to scopes
                    // But here we basically re-implement capture logic? 
                    // Let's rely on captureEngine properly.

                    // Actually, the existing logic manually filtered messages.
                    // We must await adapter calls.
                    switch (message.scope) {
                        case 'entire':
                            scope = { type: 'entire_conversation' };
                            break;
                        case 'single':
                            if (messageIndex !== undefined) {
                                const adapter = captureEngine.getAdapter();
                                if (adapter) {
                                    const messages = adapter.listMessages();
                                    if (messages[messageIndex]) {
                                        const singleMsg = await adapter.parseMessage(messages[messageIndex], messageIndex);
                                        const graph = await adapter.captureConversation();
                                        if (graph) {
                                            graph.messages = [singleMsg];
                                            sendResponse({ data: graph });
                                            return;
                                        }
                                    }
                                }
                            }
                            break;
                        case 'upto':
                            if (messageIndex !== undefined) {
                                const adapter = captureEngine.getAdapter();
                                if (adapter) {
                                    const graph = await adapter.captureConversation();
                                    if (graph) {
                                        graph.messages = graph.messages.slice(0, messageIndex + 1);
                                        sendResponse({ data: graph });
                                        return;
                                    }
                                }
                            }
                            break;
                        case 'from':
                            if (messageIndex !== undefined) {
                                const adapter = captureEngine.getAdapter();
                                if (adapter) {
                                    const graph = await adapter.captureConversation();
                                    if (graph) {
                                        graph.messages = graph.messages.slice(messageIndex);
                                        sendResponse({ data: graph });
                                        return;
                                    }
                                }
                            }
                            break;
                    }

                    // Fallback to engine capture if custom logic didn't return
                    const data = await captureEngine.capture(scope);
                    sendResponse({ data });
                    break;

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
