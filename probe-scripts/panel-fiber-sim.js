/**
 * panel-fiber-sim.js
 *
 * PURPOSE: Run the full captureClaudePanelArtifact simulation on the currently-open
 *          artifact panel and confirm exactly which step succeeds or fails.
 *
 * HOW TO USE:
 *   1. Open a Claude.ai document artifact panel manually (click "Open artifact").
 *   2. Wait for it to fully render.
 *   3. Paste this script into the browser console.
 *
 * OUTPUT: Intermediate values for every step of captureClaudePanelArtifact.
 */
(function panelFiberSim() {

    // ── helpers ──────────────────────────────────────────────────────────────

    const isVisibleElement = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden'
            && rect.width > 0 && rect.height > 0;
    };

    const classSnippet = (el) => {
        const raw = typeof el.className === 'string'
            ? el.className
            : (el.getAttribute?.('class') ?? '');
        return raw.slice(0, 40);
    };

    const getClaudeArtifactCardSelectors = () => [
        '[data-artifact]','[data-artifact-id]','[data-testid*="artifact"]',
        '[data-testid*="attachment"]','.artifact-card','.artifact-preview',
        '.artifact-block-cell','[class*="artifact-card"]',
    ].join(', ');

    const getClaudeArtifactCodeContentSelectors = () => [
        '[id*="wiggle"]','[data-testid*="editor"]:not(button):not([role="radio"])',
        '[data-testid*="source"]:not(button):not([role="radio"])',
        '[data-testid*="code"]:not(button):not([role="radio"])',
        '.viewer-body','[class*="overflow-y-scroll"]',
        'div[class*="font-mono"]','div[class*="font-code"]','div[class*="whitespace-pre"]',
    ].join(', ');

    const getClaudeArtifactPanelContentSelectors = () => [
        '[id*="wiggle-file-content"]','[data-artifact-content]','[data-testid*="artifact-content"]',
        '.standard-markdown','.progressive-markdown','.markdown',
        'iframe[src]','embed[src]','object[data]','svg','canvas',
        getClaudeArtifactCodeContentSelectors(),
    ].join(', ');

    const getClaudeArtifactPanelSeedSelectors = () => [
        '[id*="wiggle-file-content"]','[data-artifact-content]','[data-testid*="artifact-content"]',
        'iframe[src]','embed[src]','object[data]',
        '.standard-markdown','.progressive-markdown',
    ].join(', ');

    const getClaudeArtifactMessageSelectors = () => [
        '[data-testid="user-message"]','.font-claude-response','.font-user-message',
    ].join(', ');

    const getClaudeArtifactViewerRoot = (seed) => {
        const cardSelector = getClaudeArtifactCardSelectors();
        if (seed.closest(cardSelector)) return { root: null, reason: 'seed inside card' };
        let current = seed.parentElement;
        const skipped = [];
        while (current && current !== document.body) {
            if (!isVisibleElement(current)) {
                skipped.push({ el: current.tagName + '.' + classSnippet(current), reason: 'invisible' });
                current = current.parentElement;
                continue;
            }
            const hasCodeToggle = current.querySelector('button[aria-label~="Code"], [role="radio"][aria-label~="Code"]') !== null;
            const contentSel = `.standard-markdown, .progressive-markdown, .markdown, [data-artifact-content], iframe[src], embed[src], object[data], svg, canvas, pre, code, ${getClaudeArtifactCodeContentSelectors()}`;
            const hasContent = current.querySelector(contentSel) !== null;
            if (hasCodeToggle && hasContent) {
                const textLen = current.textContent?.replace(/\s+/g,'').length ?? 0;
                if (textLen > 50) {
                    return { root: current, depth: 0, skipped };
                }
            }
            current = current.parentElement;
        }
        return { root: null, reason: 'reached body', skipped };
    };

    const getClaudeArtifactContentViewerRoot = (seed) => {
        const cardSelector = getClaudeArtifactCardSelectors();
        if (seed.closest(cardSelector)) return { root: null, reason: 'seed inside card' };

        const isDedicatedContentRoot = seed.matches(
            '[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"], iframe[src], embed[src], object[data], svg, canvas'
        );
        if (seed.closest(getClaudeArtifactMessageSelectors()) && !isDedicatedContentRoot) {
            return { root: null, reason: 'seed inside message content' };
        }

        let current = (!isDedicatedContentRoot && seed.matches('.standard-markdown, .progressive-markdown, .markdown'))
            ? seed.parentElement
            : seed;
        const skipped = [];
        let fallback = null;
        while (current && current !== document.body) {
            if (!isVisibleElement(current)) {
                skipped.push({ el: current.tagName + '.' + classSnippet(current), reason: 'invisible' });
                current = current.parentElement;
                continue;
            }
            if (current.closest(cardSelector)) {
                return { root: null, reason: 'ancestor inside card', skipped };
            }
            const hasContent = current.matches(getClaudeArtifactPanelContentSelectors())
                || current.querySelector(getClaudeArtifactPanelContentSelectors()) !== null;
            if (!hasContent) {
                current = current.parentElement;
                continue;
            }
            const textLen = current.textContent?.replace(/\s+/g,'').length ?? 0;
            const substantial = textLen > 80 || current.matches('[id*="wiggle-file-content"], iframe[src], embed[src], object[data], svg, canvas');
            if (!substantial) {
                current = current.parentElement;
                continue;
            }
            if (!fallback) fallback = current;
            const rect = current.getBoundingClientRect();
            const hasHeading = current.querySelector('[role="heading"], h1, h2, h3, h4, [data-testid*="title"], .artifact-title, [class*="artifact-title"]') !== null;
            const hasDismiss = current.querySelector('button[aria-label*="Close"], button[aria-label*="Dismiss"], button[aria-label*="Exit"]') !== null;
            if (isDedicatedContentRoot || hasHeading || hasDismiss || (rect.width >= 260 && rect.height >= 180)) {
                return { root: current, skipped };
            }
            current = current.parentElement;
        }
        return fallback ? { root: fallback, skipped } : { root: null, reason: 'reached body', skipped };
    };

    // UPDATED: also walk UP (return chain) from each seed — document artifact content is often
    // on the parent React component (ArtifactPanel) rather than on a child fiber.
    const CONTENT_KEYS = new Set(['content', 'source', 'code', 'src', 'markdown', 'document', 'initialValue', 'defaultValue', 'text']);
    const isCssOrSvgNoise = (s) =>
        /\binline-flex\b|\bitems-center\b|\bjustify-center\b/.test(s)
        || /^\s*M[\d-]/.test(s)
        || /^https?:\/\//.test(s);

    const getFiber = (el) => {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        return key ? el[key] : null;
    };

    const checkProps = (f, hits) => {
        const props = f.memoizedProps ?? f.pendingProps ?? {};
        for (const key of Object.keys(props)) {
            if (!CONTENT_KEYS.has(key)) continue;
            const v = props[key];
            if (typeof v === 'string' && v.length >= 80 && !isCssOrSvgNoise(v)) {
                hits.push({ key, len: v.length, preview: v.slice(0, 120) });
            }
        }
    };

    const runFiberWalk = (root) => {
        const hits = [];
        const fiberRoots = [
            root,
            ...Array.from(root.querySelectorAll('[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"], .standard-markdown, .progressive-markdown, .markdown')),
        ].filter((candidate, index, all) => all.indexOf(candidate) === index);
        let nodesWalked = 0;
        const rootFiber = getFiber(root);

        for (const fiberRoot of fiberRoots) {
            const fiber = getFiber(fiberRoot) ?? (fiberRoot.firstElementChild ? getFiber(fiberRoot.firstElementChild) : null);
            if (!fiber) continue;

            // Walk UP (return chain) up to 40 levels — stop at panelRoot's fiber boundary.
            let up = fiber.return;
            for (let depth = 0; up && depth < 40; depth++) {
                if (up === rootFiber) break;
                checkProps(up, hits);
                up = up.return;
            }

            // Walk DOWN (child/sibling subtree).
            const seen = new WeakSet();
            const stack = [fiber];
            let n = 0;
            while (stack.length > 0 && n < 8000) {
                const f = stack.pop();
                if (!f || seen.has(f)) continue;
                seen.add(f);
                n++;
                checkProps(f, hits);
                if (f.sibling) stack.push(f.sibling);
                if (f.child) stack.push(f.child);
            }
            nodesWalked += n;
        }
        hits.sort((a, b) => b.len - a.len);
        return { fiber: nodesWalked > 0, nodesWalked, hits };
    };

    // ── STEP 1: find panel candidates ────────────────────────────────────────

    console.group('[PanelFiberSim] Step 1: Panel candidates');

    const panelSelectors = [
        '[aria-label^="Artifact panel"]', '[role="region"][aria-label*="Artifact"]',
        '[data-testid*="artifact-panel"]', '[data-testid*="artifact-view"]',
        '[class*="artifact-panel"]', '[class*="artifact-view"]', '[class*="artifact-editor"]',
    ];
    const selectorCandidates = panelSelectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
    console.log(`Explicit selector hits: ${selectorCandidates.length}`);
    selectorCandidates.forEach((el, i) => {
        console.log(`  [${i}] ${el.tagName} aria-label="${el.getAttribute('aria-label')?.slice(0,60)}" textLen=${el.textContent?.length}`);
    });

    const cardSelector = getClaudeArtifactCardSelectors();
    const codeToggles = Array.from(document.querySelectorAll('button[aria-label~="Code"], [role="radio"][aria-label~="Code"]'));
    console.log(`Code toggles in DOM: ${codeToggles.length}`);
    const viewerCandidates = codeToggles.flatMap((toggle, i) => {
        const inCard = toggle.closest(cardSelector);
        const rect = toggle.getBoundingClientRect();
        console.log(`  Toggle[${i}]: inCard=${!!inCard} visible=${isVisibleElement(toggle)} rect=${rect.width.toFixed(0)}x${rect.height.toFixed(0)} label="${toggle.getAttribute('aria-label')}"`);
        if (inCard) return [];
        const result = getClaudeArtifactViewerRoot(toggle);
        if (result.root) {
            const r = result.root.getBoundingClientRect();
            console.log(`    → ViewerRoot: ${result.root.tagName} class="${result.root.className.slice(0,60)}" textLen=${result.root.textContent?.length} rect=${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
            console.log(`    → Skipped invisible: ${result.skipped?.length}`);
        } else {
            console.log(`    → ViewerRoot: null (${result.reason})`);
        }
        return result.root ? [result.root] : [];
    });

    const contentSeeds = Array.from(document.querySelectorAll(getClaudeArtifactPanelSeedSelectors()));
    console.log(`Content roots in DOM: ${contentSeeds.length}`);
    const contentCandidates = contentSeeds.flatMap((seed, i) => {
        if (!(seed instanceof Element)) return [];
        const inCard = seed.closest(cardSelector);
        console.log(`  Content[${i}]: ${seed.tagName}${seed.id ? '#' + seed.id : ''} inCard=${!!inCard} textLen=${seed.textContent?.length}`);
        if (inCard) return [];
        const result = getClaudeArtifactContentViewerRoot(seed);
        if (result.root) {
            const r = result.root.getBoundingClientRect();
            console.log(`    → ContentRoot: ${result.root.tagName}${result.root.id ? '#' + result.root.id : ''} class="${result.root.className.slice(0,60)}" textLen=${result.root.textContent?.length} rect=${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
        } else {
            console.log(`    → ContentRoot: null (${result.reason})`);
        }
        return result.root ? [result.root] : [];
    });

    const allCandidates = [...selectorCandidates, ...viewerCandidates, ...contentCandidates].filter((c, i, all) => all.indexOf(c) === i);
    console.log(`Total unique panel candidates: ${allCandidates.length}`);
    console.groupEnd();

    if (allCandidates.length === 0) {
        console.log('[PanelFiberSim] ❌ No panel candidates found. Is the panel open?');
        return;
    }

    // ── STEP 2: filter candidates (visibility + content check) ───────────────

    console.group('[PanelFiberSim] Step 2: Filter candidates');
    const filteredCandidates = allCandidates.filter(candidate => {
        if (!isVisibleElement(candidate)) {
            console.log(`  SKIP (invisible): ${candidate.tagName} ${candidate.className.slice(0,40)}`);
            return false;
        }
        // Reject candidates containing conversation messages — they're the entire page root.
        // NOTE: do NOT check .font-claude-response here — Claude applies it to the
        // .standard-markdown inside #wiggle-file-content, which would incorrectly reject
        // the artifact panel itself. [data-testid="user-message"] is sufficient.
        if (candidate.querySelector('[data-testid="user-message"]') !== null) {
            console.log(`  SKIP (contains user-message turn - too broad): ${candidate.tagName}#${candidate.id}`);
            return false;
        }
        const text = (candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '').replace(/[\u00ad\u200b]/g, '');
        if (text.length > 40) return true;
        const hasChild = !!candidate.querySelector(
            `${getClaudeArtifactPanelContentSelectors()}, pre, code, button[aria-label~="Code"], [role="radio"][aria-label~="Code"]`);
        if (!hasChild) {
            console.log(`  SKIP (no content): ${candidate.tagName} textLen=${text.length}`);
            return false;
        }
        return true;
    });
    console.log(`Filtered candidates: ${filteredCandidates.length}`);
    console.groupEnd();

    const panelRoot = filteredCandidates[0];
    if (!panelRoot) {
        console.log('[PanelFiberSim] ❌ No valid panel after filter.');
        return;
    }

    const panelRect = panelRoot.getBoundingClientRect();
    console.log(`[PanelFiberSim] Using panelRoot: ${panelRoot.tagName} class="${panelRoot.className.slice(0,80)}"`);
    console.log(`  aria-label: "${panelRoot.getAttribute('aria-label')}"`);
    console.log(`  text len: ${panelRoot.textContent?.length}`);
    console.log(`  rect: ${panelRect.width.toFixed(0)}×${panelRect.height.toFixed(0)}`);
    console.log(`  viewport: ${window.innerWidth}×${window.innerHeight}`);
    console.log(`  Occupies ${(panelRect.width / window.innerWidth * 100).toFixed(0)}% viewport width`);

    // ── STEP 3: fiber extraction ─────────────────────────────────────────────

    console.group('[PanelFiberSim] Step 3: Fiber extraction');
    const fiberResult = runFiberWalk(panelRoot);
    console.log(`Fiber attached: ${fiberResult.fiber}`);
    console.log(`Nodes walked: ${fiberResult.nodesWalked}`);
    console.log(`Hits (up-walk + down-walk): ${fiberResult.hits.length}`);
    fiberResult.hits.slice(0, 8).forEach((h, i) =>
        console.log(`  [${i}] key="${h.key}" len=${h.len} preview: ${h.preview.slice(0, 100).replace(/\n/g, '↵')}`));
    const fiberContent = fiberResult.hits[0]?.value ?? null;
    console.log(`fiberContent: ${fiberResult.hits[0] ? fiberResult.hits[0].len + ' chars (key="' + fiberResult.hits[0].key + '")' : 'null'}`);
    console.groupEnd();

    // Also try fiber from children (first 3)
    if (!fiberResult.fiber) {
        console.group('[PanelFiberSim] Step 3b: Trying fiber from children');
        Array.from(panelRoot.children).slice(0, 3).forEach((child, i) => {
            const r = runFiberWalk(child);
            console.log(`  child[${i}]: fiber=${r.fiber} nodes=${r.nodesWalked} hits=${r.hits.length}`);
            if (r.hits[0]) console.log(`    best: key="${r.hits[0].key}" len=${r.hits[0].len}`);
        });
        console.groupEnd();
    }

    // ── STEP 4: DOM content extraction ───────────────────────────────────────

    console.group('[PanelFiberSim] Step 4: DOM content (preview root)');
    const markdownEl = panelRoot.querySelector('.standard-markdown, .progressive-markdown, .markdown');
    console.log(`.standard-markdown: ${markdownEl ? 'found, textLen=' + markdownEl.textContent?.length : 'not found'}`);
    const codeToggle = panelRoot.querySelector('button[aria-label="Code"], [role="radio"][aria-label="Code"]');
    console.log(`Code toggle: ${codeToggle ? 'found' : 'not found'}`);
    if (codeToggle) {
        console.log(`  data-state: "${codeToggle.getAttribute('data-state')}"`);
        console.log(`  aria-checked: "${codeToggle.getAttribute('aria-checked')}"`);
    }
    const previewToggle = panelRoot.querySelector('button[aria-label="Preview"], [role="radio"][aria-label="Preview"]');
    console.log(`Preview toggle: ${previewToggle ? 'found' : 'not found'}`);
    if (previewToggle) {
        console.log(`  data-state: "${previewToggle.getAttribute('data-state')}"`);
    }
    console.groupEnd();

    // ── STEP 5: isNoiseOnlyArtifactText check ────────────────────────────────

    const isNoiseOnly = (text) => {
        const normalized = text.replace(/[\u00ad\u200b\u2028\u2029]/g, '')
            .replace(/\s+/g, ' ').trim().toLowerCase();
        if (!normalized) return true;
        return /^(artifact|artifact links|open|download|source|insert(ed)?|this message|up to message|chatgpt said|claude said|gemini said)$/.test(normalized);
    };

    console.group('[PanelFiberSim] Step 5: Noise check');
    if (fiberResult.hits[0]) {
        const best = fiberResult.hits[0];
        const slice200 = best.preview;
        console.log(`Fiber content first 200 chars: "${slice200.slice(0,200).replace(/\n/g,' ')}"`);
        console.log(`isNoiseOnly(best.slice(0,200)): ${isNoiseOnly(slice200)}`);
        console.log(`→ fiberContent would be: ${isNoiseOnly(slice200) ? 'NULL (rejected as noise)' : best.len + ' chars (accepted ✅)'}`);
    } else {
        console.log('No fiber hits — fiber extraction would return null.');
    }
    console.groupEnd();

    // ── Summary ──────────────────────────────────────────────────────────────

    console.group('[PanelFiberSim] Summary');
    const hasFiber = fiberResult.fiber && fiberResult.hits.length > 0;
    console.log(`Panel found: ✅`);
    console.log(`Fiber extraction: ${hasFiber ? '✅ ' + fiberResult.hits[0].len + ' chars' : '❌ no usable content'}`);
    console.log(`DOM preview content: ${markdownEl ? '✅ ' + markdownEl.textContent?.length + ' chars' : '❌ not found'}`);

    if (!hasFiber && !markdownEl) {
        console.log('');
        console.log('❌ DIAGNOSIS: Both fiber and DOM extraction fail on this panelRoot.');
        console.log('   The panelRoot is likely the OUTER layout container, not the actual artifact panel.');
        console.log('   The real artifact panel is nested inside — need a more specific heuristic.');
    } else if (hasFiber) {
        console.log('');
        console.log('✅ Fiber extraction works. If capture still fails, the issue is elsewhere.');
        console.log('   Check: is captureClaudePanelArtifact being called? Add console.log for debug.');
    }
    console.groupEnd();
})();
