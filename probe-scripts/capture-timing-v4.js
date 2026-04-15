/**
 * capture-timing-v4.js
 *
 * PURPOSE: Confirm the animation-timing failure mode and validate the hybrid
 *          MutationObserver + polling fix.
 *
 * HOW TO USE:
 *   1. Open Claude.ai with a conversation that has a document artifact card.
 *   2. Make sure NO artifact panel is open (close it first if needed).
 *   3. Paste this script into the browser console.
 *   4. The script will simulate exactly what captureClaudeOpenedArtifact does
 *      and report the timing of panel detection.
 *
 * EXPECTED OUTPUT (after fix):
 *   - "Panel detected via POLL at Nms" (poll wins because animation blocks observer)
 *   OR
 *   - "Panel detected via MUTATION at Nms" (observer wins if no animation)
 */

(async function captureTimingV4() {
    // ---- helpers matching the extension logic ----

    const isVisibleElement = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
    };

    const getClaudeArtifactCardSelectors = () => [
        '[data-artifact]', '[data-artifact-id]', '[data-testid*="artifact"]',
        '[data-testid*="attachment"]', '.artifact-card', '.artifact-preview',
        '.artifact-block-cell', '[class*="artifact-card"]',
    ].join(', ');

    const getClaudeArtifactCodeContentSelectors = () => [
        '[id*="wiggle"]', '[data-testid*="editor"]:not(button):not([role="radio"])',
        '[data-testid*="source"]:not(button):not([role="radio"])',
        '[data-testid*="code"]:not(button):not([role="radio"])',
        '.viewer-body', '[class*="overflow-y-scroll"]',
        'div[class*="font-mono"]', 'div[class*="font-code"]', 'div[class*="whitespace-pre"]',
    ].join(', ');

    const getClaudeArtifactPanelContentSelectors = () => [
        '[id*="wiggle-file-content"]', '[data-artifact-content]', '[data-testid*="artifact-content"]',
        '.standard-markdown', '.progressive-markdown', '.markdown',
        'iframe[src]', 'embed[src]', 'object[data]', 'svg', 'canvas',
        getClaudeArtifactCodeContentSelectors(),
    ].join(', ');

    const getClaudeArtifactMessageSelectors = () => [
        '[data-testid="user-message"]', '.font-claude-response', '.font-user-message',
    ].join(', ');

    const getClaudeArtifactViewerRoot = (seed) => {
        const cardSelector = getClaudeArtifactCardSelectors();
        if (seed.closest(cardSelector)) return null;

        let current = seed.parentElement;
        while (current && current !== document.body) {
            if (!isVisibleElement(current)) { current = current.parentElement; continue; }
            const hasCodeToggle = current.querySelector(
                'button[aria-label*="Code"], [role="radio"][aria-label*="Code"]'
            ) !== null;
            const contentSel = `.standard-markdown, .progressive-markdown, .markdown, [data-artifact-content], iframe[src], embed[src], object[data], svg, canvas, pre, code, ${getClaudeArtifactCodeContentSelectors()}`;
            const hasContent = current.querySelector(contentSel) !== null;
            if (hasCodeToggle && hasContent) {
                const hasSubstantialContent = (current.textContent?.replace(/\s+/g, '').length ?? 0) > 50;
                if (hasSubstantialContent) return current;
            }
            current = current.parentElement;
        }
        return null;
    };

    const getClaudeArtifactContentViewerRoot = (seed) => {
        const cardSelector = getClaudeArtifactCardSelectors();
        if (seed.closest(cardSelector)) return null;

        const isDedicatedContentRoot = seed.matches(
            '[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"], iframe[src], embed[src], object[data], svg, canvas'
        );
        if (seed.closest(getClaudeArtifactMessageSelectors()) && !isDedicatedContentRoot) return null;

        let current = seed;
        let fallback = null;
        while (current && current !== document.body) {
            if (!isVisibleElement(current)) { current = current.parentElement; continue; }
            if (current.closest(cardSelector)) return null;

            const hasContent = current.matches(getClaudeArtifactPanelContentSelectors())
                || current.querySelector(getClaudeArtifactPanelContentSelectors()) !== null;
            if (!hasContent) { current = current.parentElement; continue; }

            const textLen = (current.textContent?.replace(/\s+/g, ' ').trim().length ?? 0);
            const substantial = textLen > 80 || current.matches('[id*="wiggle-file-content"], iframe[src], embed[src], object[data], svg, canvas');
            if (!substantial) { current = current.parentElement; continue; }

            if (!fallback) fallback = current;

            const rect = current.getBoundingClientRect();
            const hasHeading = current.querySelector('[role="heading"], h1, h2, h3, h4, [data-testid*="title"], .artifact-title, [class*="artifact-title"]') !== null;
            const hasDismiss = current.querySelector('button[aria-label*="Close"], button[aria-label*="Dismiss"], button[aria-label*="Exit"]') !== null;
            if (isDedicatedContentRoot || hasHeading || hasDismiss || (rect.width >= 260 && rect.height >= 180)) {
                return current;
            }

            current = current.parentElement;
        }

        return fallback;
    };

    const getClaudeArtifactPanelSelectors = () => [
        '[aria-label^="Artifact panel"]', '[role="region"][aria-label*="Artifact"]',
        '[data-testid*="artifact-panel"]', '[data-testid*="artifact-view"]',
        '[class*="artifact-panel"]', '[class*="artifact-view"]', '[class*="artifact-editor"]',
    ];

    const cleanText = (str) => (str || '').replace(/[\u00ad\u200b\u2028\u2029]/g, '').trim();

    const findPanelRoot = () => {
        const cardSelector = getClaudeArtifactCardSelectors();

        const selectorCandidates = getClaudeArtifactPanelSelectors()
            .flatMap(sel => Array.from(document.querySelectorAll(sel)));

        const viewerCandidates = Array.from(
            document.querySelectorAll('button[aria-label*="Code"], [role="radio"][aria-label*="Code"]')
        ).flatMap(candidate => {
            if (!(candidate instanceof Element)) return [];
            if (candidate.closest(cardSelector)) return [];
            const root = getClaudeArtifactViewerRoot(candidate);
            return root ? [root] : [];
        });

        const contentCandidates = Array.from(document.querySelectorAll(getClaudeArtifactPanelContentSelectors()))
            .flatMap(candidate => {
                if (!(candidate instanceof Element)) return [];
                if (candidate.closest(cardSelector)) return [];
                const root = getClaudeArtifactContentViewerRoot(candidate);
                return root ? [root] : [];
            });

        const allCandidates = [...selectorCandidates, ...viewerCandidates, ...contentCandidates]
            .filter((c, i, all) => all.indexOf(c) === i)
            .filter(candidate => {
                if (!isVisibleElement(candidate)) return false;
                const text = cleanText(candidate.textContent?.replace(/\s+/g, ' ') ?? '');
                return text.length > 40 || Boolean(candidate.querySelector(
                    `${getClaudeArtifactPanelContentSelectors()}, pre, code, button[aria-label*="Code"], [role="radio"][aria-label*="Code"]`
                ));
            });

        return allCandidates[0] ?? null;
    };

    const findOpener = () => {
        const selector = '[aria-label*="Open artifact"], [aria-label*="open artifact"], .artifact-block-cell[role="button"], .artifact-block-cell[aria-label], .artifact-block-cell [role="button"], .artifact-block-cell button, .artifact-block-cell div[aria-label]';
        const candidates = Array.from(document.querySelectorAll(selector))
            .filter(el => el instanceof HTMLElement && isVisibleElement(el))
            .filter(el => {
                const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim();
                return /open artifact/i.test(label) && !el.closest('nav, aside, header, footer');
            });
        return candidates[0] ?? null;
    };

    // ---- main ----

    console.log('[CaptureTimingV4] Starting...');

    // Check no panel is currently open
    const preClickPanel = findPanelRoot();
    if (preClickPanel) {
        console.log('[CaptureTimingV4] Panel already open! Please close it first and re-run.');
        console.log('  Panel:', preClickPanel.className, preClickPanel.getAttribute('aria-label'));
        return;
    }
    console.log('[CaptureTimingV4] No panel open. Good.');

    const opener = findOpener();
    if (!opener) {
        console.log('[CaptureTimingV4] No opener found. Make sure a doc artifact card is visible.');
        return;
    }
    console.log('[CaptureTimingV4] Opener found:', opener.tagName, opener.getAttribute('aria-label')?.slice(0, 60));

    // Click and time everything
    const t0 = performance.now();

    opener.click();
    console.log(`[CaptureTimingV4] Click at T=0`);

    await new Promise(r => setTimeout(r, 250));
    console.log(`[CaptureTimingV4] Warm-up delay done at T=${(performance.now() - t0).toFixed(0)}ms`);

    // Immediate synchronous check (same as extension)
    const immediate = findPanelRoot();
    if (immediate) {
        console.log(`[CaptureTimingV4] ✅ Panel detected IMMEDIATELY at T=${(performance.now() - t0).toFixed(0)}ms`);
        console.log('  Panel:', immediate.className, 'text len:', immediate.textContent?.length);
        return;
    }

    console.log(`[CaptureTimingV4] Immediate check: not found. Starting hybrid observer+poll...`);

    // Now run the hybrid approach to measure timing
    let mutationCheckCount = 0;
    let pollCheckCount = 0;
    const observations = [];

    const result = await new Promise(resolve => {
        let resolved = false;
        const resolveOnce = (source, el) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeoutTimer);
                clearInterval(pollInterval);
                observer.disconnect();
                resolve({ source, el, ms: (performance.now() - t0).toFixed(0) });
            }
        };

        const timeoutTimer = setTimeout(() => resolveOnce('TIMEOUT', null), 3000);

        const observer = new MutationObserver((mutations) => {
            mutationCheckCount++;
            const found = findPanelRoot();
            const ms = (performance.now() - t0).toFixed(0);
            observations.push({ type: 'mutation', ms, found: !!found, mutations: mutations.length });
            if (found) resolveOnce('MUTATION', found);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        const pollInterval = setInterval(() => {
            pollCheckCount++;
            const found = findPanelRoot();
            const ms = (performance.now() - t0).toFixed(0);
            observations.push({ type: 'poll', ms, found: !!found });
            if (found) resolveOnce('POLL', found);
        }, 300);
    });

    console.log(`[CaptureTimingV4] MutationObserver fired ${mutationCheckCount} times`);
    console.log(`[CaptureTimingV4] Poll fired ${pollCheckCount} times`);

    if (result.source === 'TIMEOUT') {
        console.log(`[CaptureTimingV4] ❌ TIMEOUT — panel never found in 3000ms`);
        console.log('  Mutation checks:', mutationCheckCount, '| Poll checks:', pollCheckCount);
        console.log('  Observations:', observations.slice(-5));
        // Extra diagnostics about why the panel wasn't found
        const codeToggles = Array.from(document.querySelectorAll('[role="radio"][aria-label*="Code"]'));
        console.log(`  Code toggles in DOM: ${codeToggles.length}`);
        codeToggles.forEach((t, i) => {
            const inCard = t.closest(getClaudeArtifactCardSelectors());
            const rect = t.getBoundingClientRect();
            console.log(`    Toggle ${i}: inCard=${!!inCard} rect=${rect.width.toFixed(0)}x${rect.height.toFixed(0)} aria-label="${t.getAttribute('aria-label')}"`);
        });
        return;
    }

    console.log(`[CaptureTimingV4] ✅ Panel detected via ${result.source} at T=${result.ms}ms`);
    console.log('  Panel:', result.el?.className?.slice(0, 80));
    console.log('  Panel text len:', result.el?.textContent?.length);

    // Show the mutation/poll timeline for diagnostics
    const firstMutation = observations.find(o => o.type === 'mutation');
    const firstFoundMutation = observations.find(o => o.type === 'mutation' && o.found);
    const firstFoundPoll = observations.find(o => o.type === 'poll' && o.found);
    console.log(`  First mutation fire: T=${firstMutation?.ms}ms`);
    console.log(`  First mutation-found: T=${firstFoundMutation?.ms ?? 'never'}ms`);
    console.log(`  First poll-found: T=${firstFoundPoll?.ms ?? 'never'}ms`);

    if (result.source === 'POLL' && !firstFoundMutation) {
        console.log('');
        console.log('[CaptureTimingV4] 💡 DIAGNOSIS CONFIRMED: Animation caused the failure!');
        console.log('   MutationObserver fired but panel was invisible (0×0) during animation.');
        console.log('   Poll succeeded after animation completed. This confirms the fix is needed.');
    } else if (result.source === 'MUTATION') {
        console.log('[CaptureTimingV4] Observer worked fine — no animation timing issue this time.');
    }
})();
