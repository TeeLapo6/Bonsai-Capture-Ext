/**
 * artifact-network-probe.js
 *
 * PURPOSE: Ground-truth investigation of how Claude sends artifact content to the
 *          browser, what buttons / links exist on the panel, and which capture path
 *          will actually work for both code (diagram) and document artifacts.
 *
 * HOW TO USE:
 *   1. Navigate to a Claude chat page that HAS artifacts (documents or diagrams).
 *      DO NOT click any artifact opener yet.
 *   2. Paste this entire script into the browser DevTools Console and press Enter.
 *      It installs its interceptors silently.
 *   3. Now click an artifact opener card to open the panel.
 *   4. Wait 2–3 seconds for the panel to fully render.
 *   5. Run the following in the console to see the report:
 *        window.__bonsaiProbe.report()
 *   6. Repeat for each artifact you want to test (the probe stays installed).
 *
 * WHAT IT CAPTURES:
 *   NET   — Every fetch / XHR call matching artifact-related URL patterns.
 *           This is the definitive "what data does Claude load?" answer.
 *   DOM   — Panel toolbar buttons, links, download attributes, copy button.
 *   FIBER — React fiber prop scan for 'content','source','code','markdown','document',
 *           'src','value','text','children','body','html','data','payload','artifact'.
 *   COPY  — navigator.clipboard.writeText interception (captures copy button output).
 */
(function installBonsaiProbe() {
    'use strict';

    if (window.__bonsaiProbe) {
        console.log('[BonsaiProbe] Already installed. Run window.__bonsaiProbe.report() to see results.');
        return;
    }

    // ─── State ────────────────────────────────────────────────────────────────
    const probe = {
        networkEntries: [],   // { ts, method, url, status, contentType, bodyPreview, fullBody }
        clipboardEntries: [], // { ts, text }
        panelSnapshots: [],   // { ts, toolbarHTML, downloadLinks, copyButtons, fiberHits }
    };

    const TS = () => new Date().toISOString().slice(11, 23);

    const ARTIFACT_URL_PATTERN = /artifact|download|content|file|resource|document|raw/i;

    const FIBER_PROP_KEYS = new Set([
        'content','source','code','markdown','document',
        'src','value','text','children','body','html',
        'data','payload','artifact','initialValue','initialContent',
        'defaultValue','rawContent','fileContent','documentContent',
    ]);

    // ─── Fiber extraction ─────────────────────────────────────────────────────
    const getFiber = (el) => {
        const key = Object.keys(el).find(
            k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        return key ? el[key] : null;
    };

    const isNoise = (s) =>
        /\binline-flex\b|\bitems-center\b|\bjustify-center\b/.test(s)
        || /^\s*M[\d\s-]/.test(s)   // SVG path `d`
        || /^https?:\/\//.test(s);   // plain URL string

    const extractFiber = (root) => {
        const seeds = [
            root,
            ...Array.from(root.querySelectorAll(
                '[id*="wiggle"], .standard-markdown, .progressive-markdown, ' +
                '.viewer-body, [data-artifact-content], [data-testid*="artifact-content"]'
            ))
        ].filter((el, i, a) => el instanceof Element && a.indexOf(el) === i);

        const hits = [];
        for (const seed of seeds) {
            const fiber = getFiber(seed) ?? (seed.firstElementChild ? getFiber(seed.firstElementChild) : null);
            if (!fiber) continue;

            const seen = new WeakSet();
            const stack = [fiber];
            let n = 0;
            while (stack.length && n < 10000) {
                const f = stack.pop();
                if (!f || seen.has(f)) continue;
                seen.add(f); n++;

                const props = f.memoizedProps ?? f.pendingProps ?? {};
                for (const key of Object.keys(props)) {
                    if (!FIBER_PROP_KEYS.has(key)) continue;
                    const v = props[key];
                    if (typeof v === 'string' && v.length >= 20 && !isNoise(v)) {
                        hits.push({ key, len: v.length, preview: v.slice(0, 300), value: v });
                    }
                }

                if (f.sibling) stack.push(f.sibling);
                if (f.child) stack.push(f.child);
            }
        }

        hits.sort((a, b) => b.len - a.len);
        return hits;
    };

    // ─── Panel snapshot ───────────────────────────────────────────────────────
    const snapshotPanel = () => {
        // Find the panel — try aria-label first, then Code-toggle heuristic
        let panelRoot = document.querySelector('[aria-label^="Artifact panel"]');
        if (!panelRoot) {
            const codeToggle = document.querySelector(
                '[role="radio"][aria-label="Code"], button[aria-label="Code"], ' +
                '[role="radio"][data-testid$="-raw"]'
            );
            if (codeToggle) {
                let el = codeToggle.parentElement;
                while (el && el !== document.body) {
                    const contentLen = (el.textContent ?? '').replace(/\s+/g, '').length;
                    if (contentLen > 50 &&
                        el.querySelector('[role="radio"][aria-label="Code"], button[aria-label="Code"]') &&
                        el.querySelector('svg, pre, code, [id*="wiggle"], .standard-markdown, iframe')) {
                        panelRoot = el;
                        break;
                    }
                    el = el.parentElement;
                }
            }
        }

        if (!panelRoot) {
            return { error: 'No panel found in DOM. Did you open an artifact first?' };
        }

        // ── All toolbar buttons & links ───────────────────────────────────────
        const allInteractives = Array.from(panelRoot.querySelectorAll('a, button, [role="button"]'));
        const toolbar = allInteractives.map(el => ({
            tag: el.tagName,
            ariaLabel: el.getAttribute('aria-label') ?? '',
            textContent: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
            href: el.getAttribute('href') ?? '',
            hrefFull: el instanceof HTMLAnchorElement ? el.href : '',
            hasDownloadAttr: el.hasAttribute('download'),
            dataState: el.getAttribute('data-state') ?? '',
            role: el.getAttribute('role') ?? '',
            type: el.getAttribute('type') ?? '',
            visible: (() => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none';
            })(),
        }));

        // ── Specific signals ──────────────────────────────────────────────────
        const downloadLinks = toolbar.filter(
            t => t.hasDownloadAttr || /download|export/i.test(t.ariaLabel + t.textContent)
        );
        const copyButtons = toolbar.filter(
            t => /\bcopy\b/i.test(t.ariaLabel + t.textContent) && !/close|dismiss|cancel/.test(t.ariaLabel)
        );
        const codeToggle = toolbar.find(
            t => /\bcode\b/i.test(t.ariaLabel) && t.role === 'radio'
        );
        const previewToggle = toolbar.find(
            t => /\bpreview\b/i.test(t.ariaLabel) && t.role === 'radio'
        );

        // ── Panel title ───────────────────────────────────────────────────────
        const panelTitle =
            panelRoot.getAttribute('aria-label')?.replace(/^artifact panel:\s*/i, '').trim()
            || panelRoot.querySelector('strong, h1, h2, h3')?.textContent?.trim()
            || '(no title found)';

        // ── Content structure ─────────────────────────────────────────────────
        const hasSandboxIframe = !!panelRoot.querySelector('iframe[sandbox]');
        const standardMarkdownSections = panelRoot.querySelectorAll('.standard-markdown, .progressive-markdown').length;
        const wiggleFileContent = !!panelRoot.querySelector('[id*="wiggle-file-content"]');
        const viewerBody = !!panelRoot.querySelector('.viewer-body');
        const codeNodes = panelRoot.querySelectorAll('code').length;
        const preNodes = panelRoot.querySelectorAll('pre').length;

        // ── Fiber scan ────────────────────────────────────────────────────────
        const fiberHits = extractFiber(panelRoot);

        const snapshot = {
            ts: TS(),
            panelTitle,
            panelTagName: panelRoot.tagName,
            panelAriaLabel: panelRoot.getAttribute('aria-label') ?? '',
            panelClass: panelRoot.className.slice(0, 80),
            panelTextLen: (panelRoot.textContent ?? '').replace(/\s+/g, '').length,
            hasSandboxIframe,
            standardMarkdownSections,
            wiggleFileContent,
            viewerBody,
            codeNodes,
            preNodes,
            codeToggle: codeToggle ?? null,
            previewToggle: previewToggle ?? null,
            downloadLinks,
            copyButtons,
            toolbar,
            fiberHitCount: fiberHits.length,
            fiberHits: fiberHits.slice(0, 5).map(h => ({
                key: h.key, len: h.len, preview: h.preview.replace(/\n/g, '↵').slice(0, 200)
            })),
            fiberBestValueRaw: fiberHits[0]?.value ?? null,
        };

        probe.panelSnapshots.push(snapshot);
        return snapshot;
    };

    // ─── Network interception (fetch) ─────────────────────────────────────────
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const req = args[0];
        const url = typeof req === 'string' ? req : (req instanceof Request ? req.url : String(req));
        const method = (args[1]?.method ?? (req instanceof Request ? req.method : 'GET')).toUpperCase();
        const shouldCapture = ARTIFACT_URL_PATTERN.test(url) && !url.includes('/_next/') && !url.includes('.js');

        const response = await origFetch.apply(this, args);

        if (shouldCapture) {
            const clone = response.clone();
            const contentType = response.headers.get('content-type') ?? '';
            clone.text().then(body => {
                probe.networkEntries.push({
                    ts: TS(), method, url,
                    status: response.status,
                    contentType,
                    bodyPreview: body.slice(0, 600),
                    fullBody: body,
                });
            }).catch(() => {});
        }

        return response;
    };

    // ─── Network interception (XHR) ───────────────────────────────────────────
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__bonsaiUrl = url;
        this.__bonsaiMethod = method;
        return origOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        if (ARTIFACT_URL_PATTERN.test(this.__bonsaiUrl ?? '') && !(this.__bonsaiUrl ?? '').includes('/_next/')) {
            this.addEventListener('load', () => {
                probe.networkEntries.push({
                    ts: TS(),
                    method: this.__bonsaiMethod ?? 'XHR',
                    url: this.__bonsaiUrl,
                    status: this.status,
                    contentType: this.getResponseHeader('content-type') ?? '',
                    bodyPreview: this.responseText?.slice(0, 600) ?? '',
                    fullBody: this.responseText ?? '',
                });
            });
        }
        return origSend.apply(this, args);
    };

    // ─── Clipboard interception ───────────────────────────────────────────────
    const origWriteText = navigator.clipboard.writeText?.bind(navigator.clipboard);
    if (origWriteText) {
        try {
            Object.defineProperty(navigator.clipboard, 'writeText', {
                configurable: true,
                value: async function (text) {
                    probe.clipboardEntries.push({ ts: TS(), text });
                    console.log(`[BonsaiProbe COPY] Intercepted ${text.length} chars: ${text.slice(0, 80).replace(/\n/g, '↵')}`);
                    return origWriteText(text);
                },
            });
        } catch { /* clipboard API might not be writable */ }
    }

    // ─── Test copy button with automatic snapshot ─────────────────────────────
    probe.testCopyButton = async () => {
        const snap = snapshotPanel();
        if (snap.error) { console.error(snap.error); return; }

        const panelRoot = document.querySelector('[aria-label^="Artifact panel"]')
            || (() => {
                const codeToggle = document.querySelector('[role="radio"][aria-label="Code"]');
                let el = codeToggle?.parentElement;
                while (el && el !== document.body) {
                    if ((el.textContent ?? '').replace(/\s+/g, '').length > 50) return el;
                    el = el.parentElement;
                }
                return null;
            })();

        if (!panelRoot) { console.error('No panel root found'); return; }

        const copyBtn = Array.from(panelRoot.querySelectorAll('button, [role="button"]'))
            .find(el => /\bcopy\b/i.test(`${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`));

        if (!copyBtn) { console.log('[BonsaiProbe] No Copy button found in panel.'); return; }

        console.log('[BonsaiProbe] Clicking Copy button:', copyBtn.textContent?.trim() || copyBtn.getAttribute('aria-label'));
        const clipBefore = probe.clipboardEntries.length;

        copyBtn.click();
        await new Promise(r => setTimeout(r, 800));

        if (probe.clipboardEntries.length > clipBefore) {
            console.log('[BonsaiProbe] ✅ Copy intercepted successfully!');
        } else {
            // Plain click failed — try pointer sequence
            ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
                const opts = { bubbles: true, cancelable: true };
                copyBtn.dispatchEvent(
                    type.startsWith('pointer')
                        ? new PointerEvent(type, { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true })
                        : new MouseEvent(type, opts)
                );
            });
            await new Promise(r => setTimeout(r, 800));

            if (probe.clipboardEntries.length > clipBefore) {
                console.log('[BonsaiProbe] ✅ Copy intercepted via pointer sequence!');
            } else {
                console.log('[BonsaiProbe] ❌ Copy button click did NOT trigger clipboard.writeText.');
                console.log('   This means the Copy button does not call navigator.clipboard.writeText.');
                console.log('   It may use execCommand or a different mechanism.');
            }
        }
    };

    // ─── Report ───────────────────────────────────────────────────────────────
    probe.report = () => {
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('  BONSAI ARTIFACT PROBE — REPORT');
        console.log('═══════════════════════════════════════════════════════════');

        // Network
        console.group(`📡 NETWORK (${probe.networkEntries.length} artifact-related requests)`);
        probe.networkEntries.forEach((e, i) => {
            console.group(`#${i+1}  ${e.method} ${e.status}  ${e.contentType}`);
            console.log('URL:', e.url);
            console.log('Body preview:', e.bodyPreview.replace(/\n/g, '↵'));
            console.groupEnd();
        });
        console.groupEnd();

        // Clipboard
        console.group(`📋 CLIPBOARD (${probe.clipboardEntries.length} writes intercepted)`);
        probe.clipboardEntries.forEach((e, i) => {
            console.log(`#${i+1} [${e.ts}] ${e.text.length} chars: ${e.text.slice(0, 120).replace(/\n/g,'↵')}`);
        });
        console.groupEnd();

        // Panel snapshots
        console.group(`🖼  PANEL SNAPSHOTS (${probe.panelSnapshots.length}) — auto-snapshot on report`);
        const snap = snapshotPanel();
        const snapshots = [...probe.panelSnapshots];
        snapshots.forEach((s, i) => {
            if (s.error) { console.warn(`Snapshot #${i+1}: ${s.error}`); return; }

            console.group(`#${i+1} [${s.ts}] "${s.panelTitle}"`);
            console.log(`Tag: ${s.panelTagName}  aria-label: "${s.panelAriaLabel}"`);
            console.log(`Class: ${s.panelClass}`);
            console.log(`Text length (collapsed): ${s.panelTextLen}`);
            console.log(`Contains: sandbox-iframe=${s.hasSandboxIframe}  standard-markdown sections=${s.standardMarkdownSections}  wiggle-file-content=${s.wiggleFileContent}  viewer-body=${s.viewerBody}  <code>=${s.codeNodes}  <pre>=${s.preNodes}`);
            console.log(`Code toggle: ${JSON.stringify(s.codeToggle)}  Preview toggle: ${JSON.stringify(s.previewToggle)}`);
            console.group(`Download links (${s.downloadLinks.length}):`);
            s.downloadLinks.forEach(l => console.log(l));
            console.groupEnd();
            console.group(`Copy buttons (${s.copyButtons.length}):`);
            s.copyButtons.forEach(c => console.log(c));
            console.groupEnd();
            console.group(`All interactive elements (${s.toolbar.length}):`);
            console.table(s.toolbar);
            console.groupEnd();
            console.group(`React fiber hits (${s.fiberHitCount}):`);
            s.fiberHits.forEach(h => console.log(`  key="${h.key}" len=${h.len} → "${h.preview}"`));
            if (s.fiberBestValueRaw) {
                console.log('\n--- BEST FIBER VALUE (first 1000 chars) ---');
                console.log(s.fiberBestValueRaw.slice(0, 1000));
            }
            console.groupEnd();
            console.groupEnd();
        });
        console.groupEnd();

        console.log('═══════════════════════════════════════════════════════════');
        console.log('Raw probe data: window.__bonsaiProbe');
        console.log('Test copy:      window.__bonsaiProbe.testCopyButton()');
        console.log('Snapshot now:   window.__bonsaiProbe.snapshot()');
        console.log('Full network:   window.__bonsaiProbe.networkEntries');
        console.log('Full clipboard: window.__bonsaiProbe.clipboardEntries');
        console.log('═══════════════════════════════════════════════════════════');
    };

    probe.snapshot = snapshotPanel;

    window.__bonsaiProbe = probe;

    console.log('[BonsaiProbe] ✅ Installed successfully!');
    console.log('[BonsaiProbe] Now open an artifact panel, then call: window.__bonsaiProbe.report()');
    console.log('[BonsaiProbe] To test Copy button click:            window.__bonsaiProbe.testCopyButton()');
})();
