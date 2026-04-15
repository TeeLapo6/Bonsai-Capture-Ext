/**
 * Bonsai Capture — Document Panel Detection Probe v2
 *
 * PURPOSE: After the card-thumbnail fix, determine:
 *   A) Does opener.click() actually open the Claude document panel?
 *   B) Which click target works (outer wrapper vs inner button)?
 *   C) Does the actual opened panel get found by getClaudeArtifactPanelCandidates?
 *   D) What fiber/DOM content is available on the correct panel?
 *
 * HOW TO USE:
 *   1. Navigate to the chat with document artifacts.
 *      Close any open panel first.
 *   2. Paste into DevTools console.
 *   3. The probe tries multiple opener strategies, polls for the panel,
 *      then reports what each path yields.
 *
 * KEY DIFFERENCE FROM PREVIOUS PROBE:
 *   - Card thumbnail Code toggles are now EXCLUDED from panel detection.
 *   - Pre-click count should be 0.
 *   - Longer poll window (5s) to catch slow-rendering panels.
 *   - Multiple opener targets tried per card.
 */

(async () => {
  'use strict';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // ── Selectors matching the extension ──────────────────────────────────────
  const CARD_SEL = [
    '[data-artifact]', '[data-artifact-id]',
    '[data-testid*="artifact"]', '[data-testid*="attachment"]',
    '.artifact-card', '.artifact-preview', '.artifact-block-cell',
    '[class*="artifact-card"]',
  ].join(', ');

  const PANEL_SELS = [
    '[aria-label^="Artifact panel"]',
    '[role="region"][aria-label*="Artifact"]',
    '[data-testid*="artifact-panel"]',
    '[data-testid*="artifact-view"]',
    '[class*="artifact-panel"]',
    '[class*="artifact-view"]',
    '[class*="artifact-editor"]',
  ];

  // ── Panel candidate detection (mirrors fixed extension code) ─────────────
  const findViewerRoot = seed => {
    if (seed.closest(CARD_SEL)) return null; // card-thumbnail guard
    let el = seed.parentElement;
    while (el && el !== document.body) {
      const textLen = (el.textContent ?? '').replace(/\s+/g, '').length;
      if (
        el.querySelector('[role="radio"][aria-label="Code"], button[aria-label="Code"]') &&
        el.querySelector('svg, canvas, pre, code, [id*="wiggle"], .standard-markdown, .progressive-markdown, iframe[src]') &&
        textLen > 50
      ) return el;
      el = el.parentElement;
    }
    return null;
  };

  const findPanelCandidates = () => {
    const bySel = PANEL_SELS.flatMap(s => [...document.querySelectorAll(s)]);
    const byHeuristic = [...document.querySelectorAll('[role="radio"][aria-label*="Code"], button[aria-label*="Code"]')]
      .filter(btn => !btn.closest(CARD_SEL))
      .flatMap(btn => { const r = findViewerRoot(btn); return r ? [r] : []; });
    return [...bySel, ...byHeuristic]
      .filter((el, i, a) => a.indexOf(el) === i)
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  };

  // ── Fiber extraction (mirrors extension, but more liberal) ────────────────
  const getFiber = el => {
    const k = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    return k ? el[k] : null;
  };

  const CONTENT_KEYS = new Set(['content', 'source', 'code', 'text', 'value', 'initialValue', 'defaultValue', 'children', 'body', 'markdown', 'raw']);
  const isNoiseStr = s =>
    /\binline-flex\b|\bitems-center\b/.test(s) || /^\s*M[\d-]/.test(s) || /^https?:\/\//.test(s);

  const fiberWalk = (root, minLen = 100, maxNodes = 20000) => {
    const fiber = getFiber(root) ?? (root.firstElementChild ? getFiber(root.firstElementChild) : null);
    if (!fiber) return [];
    const hits = [];
    const seen = new WeakSet();
    const stack = [fiber];
    let n = 0;
    while (stack.length && n < maxNodes) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f); n++;
      const props = f.memoizedProps ?? f.pendingProps ?? {};
      for (const key of Object.keys(props)) {
        if (!CONTENT_KEYS.has(key)) continue;
        const v = props[key];
        if (typeof v === 'string' && v.length >= minLen && !isNoiseStr(v))
          hits.push({ key, len: v.length, preview: v.slice(0, 150) });
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return { nodesVisited: n, hits: hits.sort((a, b) => b.len - a.len) };
  };

  // ── Poll for panel (clean, no pre-existing state bias) ────────────────────
  const pollForPanel = async (priorCount, maxMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await delay(150);
      const candidates = findPanelCandidates();
      const newOnes = candidates.filter(c => !priorPanels.includes(c));
      if (newOnes.length > 0) return newOnes[0];
      if (candidates.length > priorCount) return candidates.find(c => !priorPanels.includes(c)) ?? candidates[0];
    }
    return null;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 0: Baseline — no panel should be open
  // ─────────────────────────────────────────────────────────────────────────
  const priorPanels = findPanelCandidates();
  console.log(`\n[P0] Pre-click panel candidates (should be 0 after card-fix): ${priorPanels.length}`);
  if (priorPanels.length > 0) {
    priorPanels.forEach(p => console.log(`  ${p.tagName} aria-label="${p.getAttribute('aria-label')?.slice(0,60)}" class="${p.className.slice(0,60)}"`));
    console.warn('⚠️  Pre-existing panels! Card-thumbnail fix may not be applied. Close all panels and re-run.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 1: Find document artifact cards
  // ─────────────────────────────────────────────────────────────────────────
  const cards = [...document.querySelectorAll(CARD_SEL)].filter(c => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  console.log(`\n[P1] Visible artifact cards: ${cards.length}`);

  if (cards.length === 0) {
    console.error('❌ No artifact cards found. Navigate to the document artifact chat and try again.');
    return;
  }

  cards.forEach((c, i) => {
    const text = (c.textContent ?? '').replace(/\s+/g, ' ').slice(0, 70);
    console.log(`  Card #${i+1}: "${text}" [${c.tagName}.${[...c.classList].slice(0,2).join('.')}]`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 2: For each card, enumerate click targets
  // ─────────────────────────────────────────────────────────────────────────
  const results = [];

  for (let ci = 0; ci < Math.min(cards.length, 3); ci++) {
    const card = cards[ci];
    const cardText = (card.textContent ?? '').replace(/\s+/g, ' ').slice(0, 50);
    console.log(`\n[P2] === Card #${ci+1}: "${cardText}" ===`);

    // Enumerate click target candidates with priority order
    const clickTargets = [];

    // T1: elements with "Open artifact" label inside the card
    const openLabels = [...card.querySelectorAll('[aria-label*="Open artifact" i], [title*="Open artifact" i]')]
      .filter(el => el instanceof HTMLElement);
    openLabels.forEach(el => clickTargets.push({ label: 'inner[aria-label*=Open]', el }));

    // T2: the card's closest ancestor with "Open artifact" label
    const ancestor = card.closest('[aria-label*="Open artifact" i]');
    if (ancestor instanceof HTMLElement && ancestor !== card) {
      clickTargets.push({ label: 'ancestor[aria-label*=Open]', el: ancestor });
    }

    // T3: the card itself if it has "Open artifact" in label
    const cardLabel = card.getAttribute('aria-label') ?? '';
    if (/open artifact/i.test(cardLabel)) {
      clickTargets.push({ label: 'card-self[aria-label*=Open]', el: card });
    }

    // T4: first button inside the card
    const firstBtn = card.querySelector('button');
    if (firstBtn instanceof HTMLElement) {
      clickTargets.push({ label: 'first-button-in-card', el: firstBtn });
    }

    // T5: first role=button inside the card
    const firstRoleBtn = card.querySelector('[role="button"]');
    if (firstRoleBtn instanceof HTMLElement) {
      clickTargets.push({ label: 'first-role-button-in-card', el: firstRoleBtn });
    }

    // T6: thumbnail/preview area (first child div inside the card that looks like a preview)
    const thumbnail = card.querySelector('div[class*="preview"], div[class*="thumbnail"], div[class*="content"], div > div');
    if (thumbnail instanceof HTMLElement) {
      clickTargets.push({ label: 'thumbnail-div', el: thumbnail });
    }

    console.log(`  [P2] Click target candidates (${clickTargets.length}):`);
    clickTargets.forEach((t, i) => console.log(`    T${i+1}: ${t.label} → ${t.el.tagName} aria-label="${(t.el.getAttribute('aria-label') ?? '').slice(0,50)}"`));

    // ── Try each click target ────────────────────────────────────────────
    for (let ti = 0; ti < clickTargets.length; ti++) {
      const { label, el: target } = clickTargets[ti];

      // Close any open panel first
      const existingPanelForClose = findPanelCandidates().find(p => !priorPanels.includes(p));
      if (existingPanelForClose) {
        const closeBtn = [...document.querySelectorAll('button')]
          .find(b => /close|dismiss/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
        if (closeBtn) closeBtn.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await delay(600);
      }

      const preCount = findPanelCandidates().length;
      console.log(`\n  [T${ti+1}] Trying "${label}" — pre-click panels: ${preCount}`);

      // ── Mutation observer: watch for new elements appearing ───────────
      let panelMutated = false;
      let newPanelEl = null;
      const mo = new MutationObserver(muts => {
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            // Look for panel-like elements in added nodes
            const candidates = [node, ...node.querySelectorAll('[aria-label^="Artifact panel"], .standard-markdown, [id*="wiggle"], [role="radio"][aria-label="Code"]')];
            for (const candidate of candidates) {
              if (candidate instanceof HTMLElement && candidate.tagName !== 'SCRIPT' && candidate.tagName !== 'STYLE') {
                panelMutated = true;
                if (!newPanelEl && (candidate.matches('[aria-label^="Artifact panel"], [role="radio"][aria-label="Code"]') || candidate.tagName === 'DIV')) {
                  newPanelEl = candidate;
                }
              }
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });

      target.click();
      await delay(150);

      // ── Poll for up to 5 seconds ─────────────────────────────────────
      let panelRoot = null;
      for (let attempt = 0; attempt < 33; attempt++) { // 33 × 150ms ≈ 5s
        await delay(150);
        const candidates = findPanelCandidates();
        const newOnes = candidates.filter(c => !priorPanels.includes(c));
        if (newOnes.length > 0) {
          panelRoot = newOnes[0];
          break;
        }
      }

      mo.disconnect();

      if (!panelRoot) {
        // Also check if ANY new aria-label^="Artifact panel" appeared (even if our heuristic missed it)
        const byAriaAll = PANEL_SELS.flatMap(s => [...document.querySelectorAll(s)]).filter(p => !priorPanels.includes(p));
        if (byAriaAll.length > 0) {
          panelRoot = byAriaAll[0];
          console.log(`  [T${ti+1}] ⚠️  Panel found via aria-label only (viewer-root heuristic likely failed): ${panelRoot.getAttribute('aria-label')?.slice(0,60)}`);
        }
      }

      console.log(`  [T${ti+1}] Panel found: ${!!panelRoot}  DOM mutations: ${panelMutated}`);

      if (panelRoot) {
        const ariaLabel = panelRoot.getAttribute('aria-label') ?? '';
        const textLen = (panelRoot.textContent ?? '').replace(/\s+/g, '').length;
        const codeBtn = panelRoot.querySelector('[role="radio"][aria-label="Code"]');
        const previewEl = panelRoot.querySelector('.standard-markdown, .progressive-markdown, .markdown');
        const previewTextLen = (previewEl?.textContent ?? '').length;
        const wiggle = panelRoot.querySelector('[id*="wiggle"]');

        console.log(`  Panel: aria-label="${ariaLabel.slice(0,60)}" textLen=${textLen}`);
        console.log(`  Code toggle: ${!!codeBtn} state=${codeBtn?.getAttribute('data-state')}`);
        console.log(`  .standard-markdown: ${!!previewEl} textLen=${previewTextLen}`);
        console.log(`  wiggle: ${!!wiggle} codes=${wiggle?.querySelectorAll('code').length ?? 0}`);

        // Fiber walk
        const fiberResult = fiberWalk(panelRoot, 80, 20000);
        const contentHits = (fiberResult.hits ?? []).filter(h =>
          !h.preview.includes('I\'ve created two') && h.len > 200
        );
        console.log(`  Fiber: ${fiberResult.nodesVisited} nodes visited, ${fiberResult.hits?.length ?? 0} string hits, ${contentHits.length} non-summary hits`);
        if (contentHits.length > 0) {
          console.log(`  Best fiber hit: prop="${contentHits[0].key}" len=${contentHits[0].len}`);
          console.log(`  Preview: ${contentHits[0].preview.replace(/\n/g, '↵').slice(0, 200)}`);
        } else if ((fiberResult.hits ?? []).length > 0) {
          const top = fiberResult.hits[0];
          console.log(`  ⚠️  Only summary-like hits. Best: prop="${top.key}" len=${top.len}: ${top.preview.replace(/\n/g, '↵').slice(0, 100)}`);
        } else {
          console.log('  ❌ No fiber content found');
        }

        results.push({
          card: ci + 1,
          target: `T${ti+1}:${label}`,
          panelFound: true,
          hasAriaLabel: !!ariaLabel,
          textLen,
          hasCodeToggle: !!codeBtn,
          previewTextLen,
          fiberContentLen: contentHits[0]?.len ?? 0,
          fiberKey: contentHits[0]?.key ?? null,
        });

        // Close panel before next target
        const closeBtn = [...document.querySelectorAll('button')]
          .find(b => /close|dismiss/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
        if (closeBtn) closeBtn.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await delay(800);

        break; // Found a working target for this card — move to next card
      } else {
        console.log(`  [T${ti+1}] ❌ No panel after 5s. DOM mutations: ${panelMutated}  newPanelEl: ${newPanelEl?.tagName ?? 'none'}`);
        results.push({ card: ci + 1, target: `T${ti+1}:${label}`, panelFound: false });
        // Don't break — try next target for this card
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 3: After-panel probe — separately verify panel contents with panel open
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[P3] === Panel-open sanity check ===');
  console.log('     Open a document artifact panel manually, then check the following:');
  const currentCandidates = findPanelCandidates();
  console.log(`     Current panel candidates: ${currentCandidates.length}`);
  if (currentCandidates.length > 0) {
    const p = currentCandidates[0];
    const previewEl = p.querySelector('.standard-markdown, .progressive-markdown, .markdown');
    const previewTextLen = (previewEl?.textContent ?? '').length;
    const fiberResult = fiberWalk(p, 80, 20000);
    const contentHits = (fiberResult.hits ?? []).filter(h => !h.preview.includes('I\'ve created two') && h.len > 200);
    console.log(`     Panel: "${p.getAttribute('aria-label')?.slice(0,60) ?? '(no aria-label)'}" textLen=${(p.textContent ?? '').replace(/\s+/g,'').length}`);
    console.log(`     Preview text: ${previewTextLen} chars`);
    console.log(`     Fiber content hits (excluding summary): ${contentHits.length}`);
    if (contentHits[0]) console.log(`     Best: prop="${contentHits[0].key}" len=${contentHits[0].len}: ${contentHits[0].preview.slice(0,200)}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY TABLE
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  RESULTS SUMMARY');
  console.log('════════════════════════════════════════════════════════');
  console.table(results.map(r => ({
    Card: r.card,
    Target: r.target,
    'Panel found': r.panelFound,
    'has aria-label': r.hasAriaLabel ?? '-',
    'textLen': r.textLen ?? 0,
    'previewLen': r.previewTextLen ?? 0,
    'fiberLen': r.fiberContentLen ?? 0,
    'fiberKey': r.fiberKey ?? 'n/a',
  })));
  console.log('════════════════════════════════════════════════════════');
  console.log('KEY:');
  console.log('  "Panel found"=true + fiberLen>1000 → fiber extraction works');
  console.log('  "Panel found"=true + previewLen>1000 + fiberLen=0 → use DOM preview fallback');
  console.log('  "Panel found"=false for ALL targets → opener click broken, need different approach');

  return results;
})();
