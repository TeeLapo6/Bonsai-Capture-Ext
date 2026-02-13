/**
 * Background Service Worker
 * 
 * Handles extension lifecycle and side panel management.
 */

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id) {
        await chrome.sidePanel.open({ tabId: tab.id });
    }
});

// Set up side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CAPTURE_COMPLETE') {
        // Store captured data
        chrome.storage.local.get(['captures'], (result) => {
            const captures = result.captures ?? [];
            captures.unshift({
                id: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                data: message.data,
                source: sender.tab?.url
            });

            // Keep last 50 captures
            if (captures.length > 50) captures.pop();

            chrome.storage.local.set({ captures });
        });

        sendResponse({ success: true });
    }

    if (message.type === 'GET_CAPTURES') {
        chrome.storage.local.get(['captures'], (result) => {
            sendResponse({ captures: result.captures ?? [] });
        });
        return true; // Keep channel open for async response
    }

    if (message.type === 'SEND_TO_BONSAI') {
        // In the future, this could make an API call to Bonsai
        console.log('Would send to Bonsai:', message.data);
        sendResponse({ success: true });
    }

    if (message.type === 'INSERT_FROM_DOM') {
        // Store selected message for side panel to pick up
        chrome.storage.local.set({
            selectedMessage: {
                messageId: message.messageId,
                messageIndex: message.messageIndex,
                timestamp: Date.now()
            }
        });

        // Notify any open side panels
        chrome.runtime.sendMessage({
            type: 'MESSAGE_SELECTED',
            messageId: message.messageId,
            messageIndex: message.messageIndex
        }).catch(() => {
            // Side panel might not be open, that's OK
        });

        sendResponse({ success: true });
    }

    if (message.type === 'FETCH_IMAGE_BLOB') {
        (async () => {
            const logs: string[] = [];
            const ruleId = 1;
            try {
                logs.push(`Background fetching: ${message.url.slice(0, 50)}...`);

                // Add DNR rule to spoof Origin/Referer
                // We use updateDynamicRules to insert a rule that modifies the headers
                // for the next request.
                await chrome.declarativeNetRequest.updateDynamicRules({
                    removeRuleIds: [ruleId],
                    addRules: [{
                        id: ruleId,
                        priority: 99,
                        action: {
                            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                            requestHeaders: [
                                { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://gemini.google.com' },
                                { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://gemini.google.com/' }
                            ]
                        },
                        condition: {
                            urlFilter: message.url,
                            resourceTypes: [
                                chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
                                chrome.declarativeNetRequest.ResourceType.OTHER
                            ]
                        }
                    }]
                });

                // Wait a tiny bit for rules to propagate (safeguard)
                await new Promise(r => setTimeout(r, 50));

                // Use fetch in background context
                // MUST use credentials: 'include' to send cookies
                const response = await fetch(message.url, {
                    credentials: 'include'
                });

                if (!response.ok) {
                    throw new Error(`Background fetch failed: ${response.status} ${response.statusText}`);
                }

                const blob = await response.blob();
                const reader = new FileReader();
                reader.onloadend = () => {
                    logs.push(`Background conversion success: ${blob.size} bytes`);
                    sendResponse({
                        dataUrl: reader.result as string,
                        logs
                    });
                };
                reader.onerror = () => {
                    logs.push(`Background FileReader error: ${reader.error}`);
                    sendResponse({ dataUrl: null, logs });
                };
                reader.readAsDataURL(blob);

            } catch (error) {
                logs.push(`Background error: ${error}`);
                sendResponse({ dataUrl: null, logs });
            } finally {
                // Cleanup rule
                await chrome.declarativeNetRequest.updateDynamicRules({
                    removeRuleIds: [ruleId]
                });
            }
        })();
        return true; // Async response
    }

    if (message.type === 'UPDATE_CONFIG') {
        const { host, apiKey } = message.payload;
        chrome.storage.local.set({
            bonsaiHost: host,
            bonsaiApiKey: apiKey
        }, () => {
            sendResponse({ success: true });
        });
        return true; // Async response
    }

    return false;
});

// Initialize
console.log('Bonsai Capture background service initialized');
