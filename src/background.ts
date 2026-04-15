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

    if (message.type === 'INSTALL_CLAUDE_CLIPBOARD_INTERCEPTOR') {
        (async () => {
            if (!sender.tab?.id) {
                sendResponse({ success: false, error: 'Missing sender tab id' });
                return;
            }

            try {
                const results = await chrome.scripting.executeScript({
                    target: {
                        tabId: sender.tab.id,
                        frameIds: typeof sender.frameId === 'number' ? [sender.frameId] : undefined,
                    },
                    world: 'MAIN',
                    func: (eventName: string) => {
                        const globalObject = window as Window & {
                            __bonsaiClaudeClipboardInterceptorInstalled?: boolean;
                        };

                        if (globalObject.__bonsaiClaudeClipboardInterceptorInstalled) {
                            return true;
                        }

                        const clipboard = navigator.clipboard;
                        if (!clipboard || typeof clipboard.writeText !== 'function') {
                            return false;
                        }

                        const originalWriteText = clipboard.writeText.bind(clipboard);
                        const clipboardRecord = clipboard as unknown as {
                            writeText: (text: string) => Promise<void>;
                        };
                        const wrappedWriteText = async (text: string) => {
                            try {
                                window.dispatchEvent(new CustomEvent(eventName, {
                                    detail: typeof text === 'string' ? text : String(text ?? ''),
                                }));
                            } catch {
                                // Ignore event-bridge failures and still preserve the original copy behavior.
                            }

                            return originalWriteText(text);
                        };

                        try {
                            clipboardRecord.writeText = wrappedWriteText;
                        } catch {
                            try {
                                Object.defineProperty(clipboard, 'writeText', {
                                    configurable: true,
                                    value: wrappedWriteText,
                                });
                            } catch {
                                return false;
                            }
                        }

                        globalObject.__bonsaiClaudeClipboardInterceptorInstalled = true;
                        return true;
                    },
                    args: [typeof message.eventName === 'string' ? message.eventName : 'bonsai:claude-artifact-copy'],
                });

                sendResponse({
                    success: Boolean(results[0]?.result),
                });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: String(error),
                });
            }
        })();
        return true;
    }

    if (message.type === 'FETCH_BLOB_AS_DATA_URL') {
        // Fetch a page-owned blob: URL by running fetch() in the MAIN world of the
        // originating tab. This bypasses the page's CSP (which blocks <script> injection)
        // and the content-script isolation boundary (which prevents content scripts from
        // accessing blobs created by page JS).
        (async () => {
            if (!sender.tab?.id) {
                sendResponse({ dataUrl: null, error: 'Missing sender tab id' });
                return;
            }

            try {
                const results = await chrome.scripting.executeScript({
                    target: {
                        tabId: sender.tab.id,
                        frameIds: typeof sender.frameId === 'number' ? [sender.frameId] : undefined,
                    },
                    world: 'MAIN',
                    args: [message.url as string],
                    func: async (blobUrl: string): Promise<string | null> => {
                        try {
                            const resp = await fetch(blobUrl);
                            if (!resp.ok) return null;
                            const blob = await resp.blob();
                            return await new Promise<string | null>((resolve) => {
                                const reader = new FileReader();
                                reader.onloadend = () => {
                                    const result = reader.result;
                                    resolve(typeof result === 'string' ? result : null);
                                };
                                reader.onerror = () => resolve(null);
                                reader.readAsDataURL(blob);
                            });
                        } catch {
                            return null;
                        }
                    },
                });

                sendResponse({ dataUrl: results[0]?.result ?? null });
            } catch (error) {
                sendResponse({ dataUrl: null, error: String(error) });
            }
        })();
        return true;
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

    if (message.type === 'FETCH_REMOTE_RESOURCE') {
        (async () => {
            const logs: string[] = [];

            try {
                logs.push(`Background resource fetch: ${String(message.url).slice(0, 80)}...`);

                const response = await fetch(message.url, {
                    credentials: 'include',
                    redirect: 'follow',
                    headers: {
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5'
                    }
                });

                if (!response.ok) {
                    throw new Error(`Background fetch failed: ${response.status} ${response.statusText}`);
                }

                const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
                const contentDisposition = response.headers.get('content-disposition') ?? undefined;
                const normalizedType = contentType.split(';')[0].trim().toLowerCase();

                if (
                    normalizedType.startsWith('text/')
                    || normalizedType.includes('json')
                    || normalizedType.includes('xml')
                    || normalizedType.includes('javascript')
                    || normalizedType.includes('svg')
                ) {
                    const text = await response.text();
                    sendResponse({
                        ok: true,
                        text,
                        contentType,
                        contentDisposition,
                        finalUrl: response.url,
                        logs,
                    });
                    return;
                }

                const blob = await response.blob();
                const reader = new FileReader();
                reader.onloadend = () => {
                    sendResponse({
                        ok: true,
                        dataUrl: reader.result as string,
                        contentType,
                        contentDisposition,
                        finalUrl: response.url,
                        logs,
                    });
                };
                reader.onerror = () => {
                    sendResponse({
                        ok: false,
                        error: String(reader.error ?? 'FileReader failed'),
                        logs,
                    });
                };
                reader.readAsDataURL(blob);
            } catch (error) {
                logs.push(`Background error: ${error}`);
                sendResponse({
                    ok: false,
                    error: String(error),
                    logs,
                });
            }
        })();
        return true;
    }

    if (message.type === 'EXTRACT_ALL_FRAMES') {
        (async () => {
            if (!sender.tab?.id) {
                sendResponse({ frames: [], error: 'Missing sender tab id' });
                return;
            }

            try {
                const results = await chrome.scripting.executeScript({
                    target: {
                        tabId: sender.tab.id,
                        allFrames: true,
                    },
                    func: () => {
                        const body = document.body;

                        return {
                            url: window.location.href,
                            title: document.title ?? '',
                            text: body?.innerText ?? body?.textContent ?? '',
                            html: body?.innerHTML ?? '',
                            isTop: window.top === window,
                        };
                    },
                });

                sendResponse({
                    frames: results
                        .map((result) => ({
                            frameId: result.frameId,
                            ...(result.result ?? {
                                url: '',
                                title: '',
                                text: '',
                                html: '',
                                isTop: false,
                            }),
                        }))
                        .filter((frame) => typeof frame.url === 'string' && (frame.text || frame.html)),
                });
            } catch (error) {
                sendResponse({
                    frames: [],
                    error: String(error),
                });
            }
        })();
        return true;
    }

    if (message.type === 'INSTALL_OPENAI_RESEARCH_PROBE') {
        (async () => {
            if (!sender.tab?.id) {
                sendResponse({ success: false, error: 'Missing sender tab id' });
                return;
            }

            try {
                await chrome.scripting.executeScript({
                    target: {
                        tabId: sender.tab.id,
                        frameIds: typeof sender.frameId === 'number' ? [sender.frameId] : undefined,
                    },
                    world: 'MAIN',
                    func: () => {
                        const globalObject = window as Window & {
                            __bonsaiOpenAIResearchProbeInstalled?: boolean;
                            __bonsaiOpenAIResearchProbe?: {
                                entries: Array<{
                                    kind: string;
                                    url: string;
                                    contentType?: string;
                                    body: string;
                                    timestamp: number;
                                    status?: number;
                                }>;
                            };
                            __bonsaiOpenAIResearchProbeFetch?: typeof fetch;
                            __bonsaiOpenAIResearchProbeWindowPostMessage?: typeof window.postMessage;
                            __bonsaiOpenAIResearchProbePortPostMessage?: typeof MessagePort.prototype.postMessage;
                            __bonsaiOpenAIResearchProbeXHROpen?: typeof XMLHttpRequest.prototype.open;
                            __bonsaiOpenAIResearchProbeXHRSend?: typeof XMLHttpRequest.prototype.send;
                        };

                        if (globalObject.__bonsaiOpenAIResearchProbeInstalled) {
                            return;
                        }
                        globalObject.__bonsaiOpenAIResearchProbeInstalled = true;

                        const MAX_ENTRIES = 40;
                        const MAX_BODY_LENGTH = 250000;
                        const bodyPattern = /deep[_-]?research|connector_openai_deep_research|ecosystem\/widget|executive summary|citations|searches|sources|report|analysis|markdown/i;
                        const cache = globalObject.__bonsaiOpenAIResearchProbe ?? { entries: [] };
                        globalObject.__bonsaiOpenAIResearchProbe = cache;

                        const normalizeBody = (body: string): string => body.slice(0, MAX_BODY_LENGTH);
                        const shouldTrack = (url: string, body: string, contentType: string): boolean => {
                            const bodyPreview = body.slice(0, 4000);
                            return bodyPattern.test(`${url}\n${contentType}\n${bodyPreview}`);
                        };

                        const pushEntry = (entry: {
                            kind: string;
                            url: string;
                            contentType?: string;
                            body: string;
                            timestamp: number;
                            status?: number;
                        }) => {
                            const normalizedBody = normalizeBody(entry.body || '');
                            if (!normalizedBody) {
                                return;
                            }

                            const dedupeKey = `${entry.kind}|${entry.url}|${normalizedBody.slice(0, 1200)}`;
                            if (cache.entries.some((existing) => `${existing.kind}|${existing.url}|${existing.body.slice(0, 1200)}` === dedupeKey)) {
                                return;
                            }

                            cache.entries.unshift({
                                ...entry,
                                body: normalizedBody,
                            });
                            cache.entries = cache.entries.slice(0, MAX_ENTRIES);
                        };

                        const safeSerialize = (value: unknown): string => {
                            const seen = new WeakSet<object>();

                            try {
                                return JSON.stringify(value, (_key, nestedValue) => {
                                    if (nestedValue instanceof MessagePort) {
                                        return '[MessagePort]';
                                    }

                                    if (typeof nestedValue === 'function') {
                                        return `[Function ${nestedValue.name || 'anonymous'}]`;
                                    }

                                    if (nestedValue && typeof nestedValue === 'object') {
                                        if (seen.has(nestedValue)) {
                                            return '[Circular]';
                                        }

                                        seen.add(nestedValue);
                                    }

                                    return nestedValue;
                                }) ?? '';
                            } catch {
                                return '';
                            }
                        };

                        const captureDomSnapshot = (kind: 'dom' | 'dom-html') => {
                            const body = document.body;
                            if (!body) {
                                return;
                            }

                            const contentType = kind === 'dom-html' ? 'text/html' : 'text/plain';
                            const bodyContent = kind === 'dom-html'
                                ? body.innerHTML
                                : (body.innerText || body.textContent || '');

                            if (!bodyContent || !shouldTrack(location.href, bodyContent, contentType)) {
                                return;
                            }

                            pushEntry({
                                kind,
                                url: location.href,
                                contentType,
                                body: bodyContent,
                                status: 200,
                                timestamp: Date.now(),
                            });
                        };

                        const isTextLike = (contentType: string): boolean => {
                            const normalized = contentType.split(';')[0].trim().toLowerCase();
                            return normalized.startsWith('text/')
                                || normalized.includes('json')
                                || normalized.includes('xml')
                                || normalized.includes('javascript')
                                || normalized.includes('svg');
                        };

                        const originalFetch = globalObject.__bonsaiOpenAIResearchProbeFetch ?? window.fetch.bind(window);
                        globalObject.__bonsaiOpenAIResearchProbeFetch = originalFetch;

                        window.fetch = async (...args) => {
                            const response = await originalFetch(...args);

                            try {
                                const requestUrl = (() => {
                                    const [input] = args;
                                    if (typeof input === 'string') return input;
                                    if (input instanceof URL) return input.href;
                                    if (input instanceof Request) return input.url;
                                    return '';
                                })();
                                const resolvedUrl = response.url || requestUrl || location.href;
                                const contentType = response.headers.get('content-type') ?? '';

                                if (shouldTrack(resolvedUrl, '', contentType) || /connector_openai_deep_research|ecosystem\/widget/i.test(resolvedUrl)) {
                                    const clone = response.clone();
                                    const body = isTextLike(contentType) ? await clone.text() : '';
                                    if (body && shouldTrack(resolvedUrl, body, contentType)) {
                                        pushEntry({
                                            kind: 'fetch',
                                            url: resolvedUrl,
                                            contentType,
                                            body,
                                            status: response.status,
                                            timestamp: Date.now(),
                                        });
                                    }
                                }
                            } catch {
                                // Ignore probe failures.
                            }

                            return response;
                        };

                        const originalWindowPostMessage = globalObject.__bonsaiOpenAIResearchProbeWindowPostMessage ?? window.postMessage.bind(window);
                        globalObject.__bonsaiOpenAIResearchProbeWindowPostMessage = originalWindowPostMessage;

                        window.postMessage = ((message: unknown, targetOrigin: string, transfer?: Transferable[] | StructuredSerializeOptions) => {
                            try {
                                const body = typeof message === 'string' ? message : safeSerialize(message);
                                if (body && shouldTrack(targetOrigin || location.href, body, 'window-post-message')) {
                                    pushEntry({
                                        kind: 'window-post-message',
                                        url: targetOrigin || location.href,
                                        contentType: 'application/json',
                                        body,
                                        status: 200,
                                        timestamp: Date.now(),
                                    });
                                }
                            } catch {
                                // Ignore probe failures.
                            }

                            return (originalWindowPostMessage as typeof window.postMessage)(message as never, targetOrigin, transfer as never);
                        }) as typeof window.postMessage;

                        const originalPortPostMessage = globalObject.__bonsaiOpenAIResearchProbePortPostMessage ?? MessagePort.prototype.postMessage;
                        globalObject.__bonsaiOpenAIResearchProbePortPostMessage = originalPortPostMessage;

                        const wrappedPortPostMessage = function(
                            this: MessagePort,
                            message: unknown,
                            transferOrOptions?: Transferable[] | StructuredSerializeOptions
                        ) {
                            try {
                                const body = typeof message === 'string' ? message : safeSerialize(message);
                                if (body && shouldTrack(location.href, body, 'message-port')) {
                                    pushEntry({
                                        kind: 'message-port',
                                        url: location.href,
                                        contentType: 'application/json',
                                        body,
                                        status: 200,
                                        timestamp: Date.now(),
                                    });
                                }
                            } catch {
                                // Ignore probe failures.
                            }

                            return (originalPortPostMessage as typeof MessagePort.prototype.postMessage).call(this, message as never, transferOrOptions as never);
                        } as typeof MessagePort.prototype.postMessage;

                        MessagePort.prototype.postMessage = wrappedPortPostMessage;

                        const originalOpen = globalObject.__bonsaiOpenAIResearchProbeXHROpen ?? XMLHttpRequest.prototype.open;
                        const originalSend = globalObject.__bonsaiOpenAIResearchProbeXHRSend ?? XMLHttpRequest.prototype.send;
                        globalObject.__bonsaiOpenAIResearchProbeXHROpen = originalOpen;
                        globalObject.__bonsaiOpenAIResearchProbeXHRSend = originalSend;

                        XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...rest: unknown[]) {
                            (this as XMLHttpRequest & { __bonsaiProbeUrl?: string }).__bonsaiProbeUrl = String(url);
                            return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
                        };

                        XMLHttpRequest.prototype.send = function(...args: unknown[]) {
                            this.addEventListener('loadend', () => {
                                try {
                                    const probeUrl = (this as XMLHttpRequest & { __bonsaiProbeUrl?: string }).__bonsaiProbeUrl || this.responseURL || '';
                                    const contentType = this.getResponseHeader('content-type') || '';
                                    const body = typeof this.responseText === 'string' ? this.responseText : '';
                                    if (probeUrl && body && shouldTrack(probeUrl, body, contentType)) {
                                        pushEntry({
                                            kind: 'xhr',
                                            url: probeUrl,
                                            contentType,
                                            body,
                                            status: this.status,
                                            timestamp: Date.now(),
                                        });
                                    }
                                } catch {
                                    // Ignore probe failures.
                                }
                            }, { once: true });

                            return originalSend.call(this, ...(args as []));
                        };

                        window.addEventListener('message', (event) => {
                            try {
                                const body = typeof event.data === 'string'
                                    ? event.data
                                    : JSON.stringify(event.data);
                                if (!body || !shouldTrack(event.origin || location.href, body, 'message')) {
                                    return;
                                }

                                pushEntry({
                                    kind: 'message',
                                    url: event.origin || location.href,
                                    contentType: 'application/json',
                                    body,
                                    status: 200,
                                    timestamp: Date.now(),
                                });
                            } catch {
                                // Ignore unserializable payloads.
                            }
                        }, true);

                        if (document.readyState === 'loading') {
                            document.addEventListener('DOMContentLoaded', () => {
                                captureDomSnapshot('dom');
                                captureDomSnapshot('dom-html');
                            }, { once: true });
                        } else {
                            captureDomSnapshot('dom');
                            captureDomSnapshot('dom-html');
                        }

                        window.setTimeout(() => {
                            captureDomSnapshot('dom');
                            captureDomSnapshot('dom-html');
                        }, 2000);
                    },
                });

                sendResponse({ success: true });
            } catch (error) {
                sendResponse({ success: false, error: String(error) });
            }
        })();
        return true;
    }

    if (message.type === 'GET_OPENAI_RESEARCH_PROBE_DATA') {
        (async () => {
            if (!sender.tab?.id) {
                sendResponse({ snapshots: [], error: 'Missing sender tab id' });
                return;
            }

            try {
                const results = await chrome.scripting.executeScript({
                    target: {
                        tabId: sender.tab.id,
                        allFrames: true,
                    },
                    world: 'MAIN',
                    func: () => {
                        const globalObject = window as Window & {
                            __bonsaiOpenAIResearchProbe?: {
                                entries: Array<{
                                    kind: string;
                                    url: string;
                                    contentType?: string;
                                    body: string;
                                    timestamp: number;
                                    status?: number;
                                }>;
                            };
                        };

                        return {
                            url: location.href,
                            title: document.title ?? '',
                            isTop: window.top === window,
                            bodyText: document.body?.innerText ?? document.body?.textContent ?? '',
                            bodyHtml: document.body?.innerHTML ?? '',
                            entries: globalObject.__bonsaiOpenAIResearchProbe?.entries ?? [],
                        };
                    },
                });

                sendResponse({
                    snapshots: results
                        .map((result) => ({
                            frameId: result.frameId,
                            ...(result.result ?? {
                                url: '',
                                title: '',
                                isTop: false,
                                bodyText: '',
                                bodyHtml: '',
                                entries: [],
                            }),
                        }))
                        .filter((snapshot) => typeof snapshot.url === 'string'),
                });
            } catch (error) {
                sendResponse({ snapshots: [], error: String(error) });
            }
        })();
        return true;
    }

    if (message.type === 'REINJECT_CONTENT_SCRIPT') {
        (async () => {
            const tabId = message.tabId as number | undefined;
            const url = message.url as string | undefined;
            if (!tabId || !url) {
                sendResponse({ success: false, error: 'Missing tabId or url' });
                return;
            }

            // Determine which content script to inject based on URL
            const scriptMap: Array<{ pattern: RegExp; files: string[] }> = [
                { pattern: /chatgpt\.com|chat\.openai\.com/, files: ['content/chatgpt.js'] },
                { pattern: /claude\.ai/, files: ['content/claude.js'] },
                { pattern: /gemini\.google\.com/, files: ['content/gemini.js'] },
                { pattern: /grok\.com/, files: ['content/grok.js'] },
                { pattern: /jules\.google\.com/, files: ['content/jules.js'] },
            ];

            const match = scriptMap.find(s => s.pattern.test(url));
            if (!match) {
                sendResponse({ success: false, error: 'No content script for this URL' });
                return;
            }

            try {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: match.files,
                });
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({ success: false, error: String(error) });
            }
        })();
        return true;
    }

    return false;
});

// Initialize
console.log('Bonsai Capture background service initialized');
