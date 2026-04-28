/**
 * Bonsai Capture - IFrame Extractor
 * 
 * Injected into cross-origin iframes (e.g., claudemcpcontent.com) to extract
 * lazy-loaded interactive visualization content.
 * 
 * Runs with "all_frames": true in manifest.json.
 */

interface BonsaiRequestMessage {
    type: 'BONSAI_REQUEST_IFRAME_CONTENT';
    iframeId: string;
    requestId: string;
    timeoutMs: number;
}

interface BonsaiResponseMessage {
    type: 'BONSAI_IFRAME_CONTENT_RESPONSE';
    iframeId: string;
    requestId: string;
    html: string | null;
    success: boolean;
    error?: string;
}

const BONSAI_REQUEST_TYPE = 'BONSAI_REQUEST_IFRAME_CONTENT';
const BONSAI_RESPONSE_TYPE = 'BONSAI_IFRAME_CONTENT_RESPONSE';
const POLL_INTERVAL_MS = 250;
const GRACE_PERIOD_MS = 3000;   // Wait for React to hydrate & render
const MIN_CONTENT_CHARS = 200;  // #vis-container must have meaningful text
const MIN_CHILD_ELEMENTS = 2;   // Or at least a few child nodes

function extractInlineFrameContent(iframe: HTMLIFrameElement): string {
    try {
        const doc = iframe.contentDocument;
        if (doc && doc.documentElement) {
            return doc.documentElement.outerHTML;
        }
    } catch {
        // cross-origin / sandboxed
    }

    const srcdoc = iframe.getAttribute('srcdoc');
    if (srcdoc) return srcdoc;

    const src = iframe.getAttribute('src');
    if (src && src.startsWith('data:')) {
        const commaIndex = src.indexOf(',');
        if (commaIndex !== -1) {
            const meta = src.slice(5, commaIndex);
            const data = src.slice(commaIndex + 1);
            if (meta.includes('base64')) {
                try { return atob(data); } catch { /* ignore */ }
            } else {
                try { return decodeURIComponent(data); } catch { return data; }
            }
        }
    }

    return '';
}

/**
 * Walk the DOM looking for a container element that looks like the main
 * visualization wrapper. Claude's interactive React apps render the
 * content inside a #vis-container div, but if that hasn't mounted yet
 * we fall back to the full document body.
 *
 * When #vis-container contains iframes, we inline their actual DOM content
 * into srcdoc so the captured HTML is self-contained and renders without
 * relying on external blob URLs or parent postMessage.
 *
 * IMPORTANT: We KEEP <script> tags intact. Claude's iframe artifacts are
 * client-side React apps — the DOM is empty until scripts run. Stripping
 * scripts produces a blank capture. The Bonsai viewer uses a sandboxed
 * iframe with allow-scripts, so the React app can re-initialize and render
 * inside Bonsai. We only strip scripts as an absolute last-resort fallback
 * when the DOM already contains rendered markup.
 *
 * TWO-FRAME ARCHITECTURE NOTE:
 * Claude's mcp_apps loader pattern embeds the React visualization inside a
 * nested about:blank child iframe inside the claudemcpcontent.com frame.
 * The outer frame body contains only SCRIPT + IFRAME elements — the actual
 * #vis-container lives in the inner about:blank frame's document.
 * Since about:blank inherits the parent's origin, contentDocument is
 * accessible from the outer frame context.
 */
function getVisContainerElement(root: ParentNode = document): Element | null {
    return root.querySelector('#vis-container')
        ?? root.querySelector('body > div[id*="vis-container"]');
}

/**
 * Find the first nested child iframe in the current frame's body.
 * In the mcp_apps two-frame layout the outer claudemcpcontent.com frame
 * contains a single child iframe (about:blank) that hosts the React app.
 */
function findInnerFrame(): HTMLIFrameElement | null {
    return (
        document.querySelector('body > iframe') ??
        document.querySelector('iframe')
    ) as HTMLIFrameElement | null;
}

/**
 * Returns the Document that contains #vis-container.
 * Checks the current frame's document first; if not found, probes the
 * nested child iframe (same-origin about:blank is directly accessible).
 */
function getVisSourceDocument(): Document | null {
    if (getVisContainerElement(document)) return document;

    const inner = findInnerFrame();
    if (inner) {
        try {
            const childDoc = inner.contentDocument;
            if (childDoc && getVisContainerElement(childDoc)) return childDoc;
        } catch {
            // cross-origin child — skip
        }
    }
    return null;
}

function getBodyHtml(): string | null {
    try {
        const sourceDoc = getVisSourceDocument();
        if (!sourceDoc) return null;

        // Strategy 1: specific #vis-container div
        const vis = getVisContainerElement(sourceDoc);
        if (vis instanceof Element) {
            // Clone the full source document so we can inline nested iframes
            const doc = sourceDoc.documentElement.cloneNode(true) as HTMLElement;
            const docVis = getVisContainerElement(doc);
            if (docVis instanceof Element) {
                const origIframes = vis.querySelectorAll('iframe');
                const clonedIframes = docVis.querySelectorAll('iframe');

                origIframes.forEach((orig, i) => {
                    const cloned = clonedIframes[i];
                    if (!cloned) return;

                    const innerHtml = extractInlineFrameContent(orig as HTMLIFrameElement);
                    if (innerHtml) {
                        (cloned as HTMLIFrameElement).setAttribute('srcdoc', innerHtml);
                        cloned.removeAttribute('src');
                    }
                });
            }

            return doc.outerHTML;
        }

        // Strategy 2: XPath
        const xpathResult = sourceDoc.evaluate(
            '/html/body/div[@id="vis-container"]',
            sourceDoc,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
        );
        const node = xpathResult.singleNodeValue;
        if (node instanceof Element) {
            const doc = sourceDoc.documentElement.cloneNode(true) as HTMLElement;
            return doc.outerHTML;
        }
    } catch {
        // ignore
    }

    return null;
}

/**
 * Return best-effort content.  If the specific #vis-container element
 * hasn't mounted yet, return the full document HTML with scripts intact
 * so the React app can initialise inside the Bonsai viewer.
 * Falls back to the inner child iframe's HTML when the outer frame has
 * no meaningful content (mcp_apps two-frame layout).
 */
function getBestEffortHtml(): string | null {
    const targeted = getBodyHtml();
    if (targeted) return targeted;

    // Try inner child iframe as fallback (mcp_apps two-frame layout)
    const inner = findInnerFrame();
    if (inner) {
        try {
            const childDoc = inner.contentDocument;
            if (childDoc && childDoc.documentElement &&
                childDoc.documentElement.outerHTML.trim().length > 100) {
                return (childDoc.documentElement.cloneNode(true) as HTMLElement).outerHTML;
            }
        } catch {
            // cross-origin child — skip
        }
    }

    try {
        if (document.documentElement && document.documentElement.outerHTML.trim().length > 100) {
            const doc = document.documentElement.cloneNode(true) as HTMLElement;
            return doc.outerHTML;
        }
    } catch {
        // ignore
    }

    return null;
}

function isVisContainerRendered(vis: Element): boolean {
    const textLen = (vis.textContent || '').trim().length;
    const htmlLen = (vis.innerHTML || '').trim().length;
    const descendantCount = vis.querySelectorAll('*').length;

    return textLen >= MIN_CONTENT_CHARS
        || htmlLen >= 120
        || descendantCount >= MIN_CHILD_ELEMENTS
        || vis.querySelector('iframe, svg, canvas, img, table, [role="img"]') !== null;
}

function waitForVisContainer(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        // Defensive scroll to trigger any viewport-based lazy loading
        try {
            document.body.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        } catch {
            // ignore
        }

        // Check for the ideal target first — only resolve immediately if
        // #vis-container already has rendered content. Otherwise fall through
        // to the polling loop so React has time to hydrate.
        // getBodyHtml() handles two-frame layout via getVisSourceDocument().
        const immediate = getBodyHtml();
        if (immediate) {
            const sourceDoc = getVisSourceDocument();
            const vis = sourceDoc ? getVisContainerElement(sourceDoc) : null;
            if (vis instanceof Element && isVisContainerRendered(vis)) {
                resolve(immediate);
                return;
            }
        }

        let settled = false;
        let foundAt: number | null = null;
        let innerObserver: MutationObserver | null = null;

        const finish = (result: string | null, error?: string) => {
            if (settled) return;
            settled = true;
            clearInterval(pollInterval);
            clearTimeout(timeoutHandle);
            try {
                observer.disconnect();
            } catch {
                // ignore
            }
            try {
                innerObserver?.disconnect();
            } catch {
                // ignore
            }
            if (result) {
                resolve(result);
            } else {
                reject(new Error(error || 'Timeout waiting for #vis-container'));
            }
        };

        /**
         * Check for #vis-container.  When it first appears we do NOT resolve
         * immediately — we wait a grace period so React scripts can populate
         * its children (inner iframes, canvases, SVGs, text nodes, etc.).
         * We also require visible content so we don't capture an empty shell.
         * getVisSourceDocument() handles the two-frame layout.
         */
        const hasMeaningfulContent = (): boolean => {
            const sourceDoc = getVisSourceDocument();
            if (!sourceDoc) return false;
            const vis = getVisContainerElement(sourceDoc);
            if (!(vis instanceof Element)) return false;
            return isVisContainerRendered(vis);
        };

        const checkTarget = (): string | null => {
            const html = getBodyHtml();
            if (!html) return null;

            if (!foundAt) {
                foundAt = Date.now();
                return null; // keep waiting for grace period
            }

            const elapsedSinceFound = Date.now() - foundAt;
            if (elapsedSinceFound < GRACE_PERIOD_MS) {
                return null;
            }

            if (!hasMeaningfulContent()) {
                // Container exists but is still empty — keep waiting up to timeout
                return null;
            }

            return html;
        };

        const observer = new MutationObserver(() => {
            const html = checkTarget();
            if (html) finish(html);
        });

        try {
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
            });
        } catch {
            // If observing documentElement fails, poll alone will have to suffice
        }

        // Also observe the inner child iframe's document for mutations.
        // The outer frame's MutationObserver won't fire for changes inside
        // a nested frame — we need a separate observer on the inner document.
        try {
            const inner = findInnerFrame();
            const innerDoc = inner?.contentDocument;
            if (innerDoc && innerDoc.documentElement) {
                innerObserver = new MutationObserver(() => {
                    const html = checkTarget();
                    if (html) finish(html);
                });
                innerObserver.observe(innerDoc.documentElement, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                });
            }
        } catch {
            // inner frame not yet accessible or cross-origin — poll will cover it
        }

        const pollInterval = window.setInterval(() => {
            // If the inner iframe became accessible after initial setup,
            // attach its MutationObserver now so we respond faster.
            if (!innerObserver) {
                try {
                    const inner = findInnerFrame();
                    const innerDoc = inner?.contentDocument;
                    if (innerDoc && innerDoc.documentElement) {
                        innerObserver = new MutationObserver(() => {
                            const html = checkTarget();
                            if (html) finish(html);
                        });
                        innerObserver.observe(innerDoc.documentElement, {
                            childList: true,
                            subtree: true,
                            attributes: true,
                        });
                    }
                } catch {
                    // not yet accessible — will retry next tick
                }
            }

            const html = checkTarget();
            if (html) {
                finish(html);
                return;
            }

            const elapsed = Date.now() - startTime;

            // Periodically re-scroll to keep the element in view
            if (elapsed > timeoutMs * 0.3 && elapsed < timeoutMs * 0.7) {
                try {
                    document.body.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                } catch {
                    // ignore
                }
            }

            if (elapsed >= timeoutMs) {
                // Timeout — fall back to body HTML as last resort
                const fallback = getBestEffortHtml();
                finish(fallback, fallback ? undefined : 'Timeout waiting for #vis-container');
            }
        }, POLL_INTERVAL_MS);

        const timeoutHandle = window.setTimeout(
            () => {
                const fallback = getBestEffortHtml();
                finish(fallback, fallback ? undefined : 'Timeout waiting for #vis-container');
            },
            timeoutMs + 50
        );
    });
}

function sendResponse(response: BonsaiResponseMessage): void {
    try {
        window.parent.postMessage(response, '*');
    } catch {
        // If postMessage to parent fails, there's nothing we can do
    }
}

/**
 * Handle a request from the parent window.
 *
 * Guards:
 *  - Rejects messages not from the direct parent window (source === window.parent).
 *  - Cancels any in-flight extraction when a fresh request arrives (stale request
 *    cancellation via a monotonic generation counter).
 */
let currentExtractionGen = 0;

function handleRequest(event: MessageEvent<unknown>): void {
    const data = event.data as Partial<BonsaiRequestMessage>;

    if (
        data.type !== BONSAI_REQUEST_TYPE
        || typeof data.iframeId !== 'string'
        || typeof data.requestId !== 'string'
    ) {
        return;
    }

    // ── Origin / source verification ──
    // Only accept messages from the direct parent frame.  Without this guard a
    // sibling iframe (or the page's own JS, before the content script isolates)
    // could inject spoofed requests.  event.source comparison works cross-origin
    // — we only compare references, never read properties on the window.
    //
    // window.parent is null when this frame has no embedder (top-level window).
    if (!window.parent || event.source !== window.parent) {
        console.warn('[Bonsai IFrame Extractor] Rejected request from non-parent source', {
            hasParent: !!window.parent,
            sourceWindow: event.source !== null,
            origin: event.origin,
        });
        return;
    }

    // ── Stale request cancellation ──
    // Increment the generation counter.  The previous extraction (if any) checks
    // this counter before responding; if it no longer matches, it silently drops
    // the result.  This prevents a slow first extraction from overwriting a
    // faster retry that already resolved.
    const myGen = ++currentExtractionGen;

    // Capture iframeId in a local const so TypeScript knows it is defined
    // inside the closures below.
    const requestId = data.iframeId;
    const messageRequestId = data.requestId;

    const timeoutMs = typeof data.timeoutMs === 'number' && data.timeoutMs > 0
        ? data.timeoutMs
        : 15000;

    console.log('[Bonsai IFrame Extractor] Received request', {
        requestId,
        messageRequestId,
        timeoutMs,
        gen: myGen,
        currentUrl: window.location.href,
    });

    waitForVisContainer(timeoutMs)
        .then((html) => {
            if (currentExtractionGen !== myGen) {
                console.log('[Bonsai IFrame Extractor] Dropping stale extraction result', {
                    requestId,
                    messageRequestId,
                    gen: myGen,
                    currentGen: currentExtractionGen,
                });
                return;
            }
            console.log('[Bonsai IFrame Extractor] Responding with success', {
                requestId,
                messageRequestId,
                htmlLength: html.length,
            });
            sendResponse({
                type: BONSAI_RESPONSE_TYPE,
                iframeId: requestId,
                requestId: messageRequestId,
                html,
                success: true,
            });
        })
        .catch((error: Error) => {
            if (currentExtractionGen !== myGen) {
                return;
            }
            console.warn('[Bonsai IFrame Extractor] Responding with error', {
                requestId,
                messageRequestId,
                error: error.message,
            });
            sendResponse({
                type: BONSAI_RESPONSE_TYPE,
                iframeId: requestId,
                requestId: messageRequestId,
                html: null,
                success: false,
                error: error.message,
            });
        });
}

// Listen for requests from the parent window
window.addEventListener('message', handleRequest);

// Also handle direct invocation via a global function for testing/debugging
(window as unknown as Record<string, unknown>)['__bonsaiIframeExtract'] = async (timeoutMs = 3000): Promise<string | null> => {
    try {
        return await waitForVisContainer(timeoutMs);
    } catch {
        return null;
    }
};

console.log('[Bonsai IFrame Extractor] Loaded on', window.location.href);
