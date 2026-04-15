/**
 * Bonsai Capture — Document Panel DOM Structure Probe v3
 *
 * PURPOSE: With a Claude document artifact panel already open, verify:
 *   A) How many .standard-markdown sections are in the panel?
 *   B) Where is the bulk of the text content?
 *   C) Does the extension's updated getClaudeArtifactPreviewContentRoot logic
 *      return the right ancestor?
 *
 * HOW TO USE:
 *   1. Navigate to the chat with document artifacts.
 *   2. Manually click a document artifact to open its panel.
 *   3. Paste into DevTools console (no reload needed).
 *
 * WHAT TO LOOK FOR:
 *   - "Standard-markdown section count" > 1? → multiple-section fix needed (already applied)
 *   - "Common ancestor" selector → what class the ancestor has
 *   - "Content root textLen" → should be close to total panel textLen
 *   - "Fiber CONTENT hits" → should be 0 for doc artifacts (text/value are excluded now)
 */

(async () => {
  'use strict';

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
  ];

  const findViewerRoot = seed => {
    if (seed.closest(CARD_SEL)) return null;
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

  // ─────────────────────────────────────────────────────────────────────────
  const panels = findPanelCandidates();
  if (panels.length === 0) {
    console.error('❌ No open panel found. Click a document artifact first, then run this probe.');
    return;
  }

  const panelRoot = panels[0];
  const panelTextLen = (panelRoot.textContent ?? '').replace(/\s+/g, '').length;
  console.log(`\n[DOM] Panel root: ${panelRoot.tagName}.${[...panelRoot.classList].slice(0,3).join('.')} aria-label="${panelRoot.getAttribute('aria-label')?.slice(0,60) ?? ''}"`);
  console.log(`[DOM] Total panel textLen (collapsed): ${panelTextLen}`);

  // ── Standard-markdown section count ─────────────────────────────────────
  const allMarkdown = [...panelRoot.querySelectorAll('.standard-markdown, .progressive-markdown')];
  console.log(`\n[DOM] .standard-markdown sections: ${allMarkdown.length}`);
  allMarkdown.forEach((s, i) => {
    const len = (s.textContent ?? '').replace(/\s+/g, '').length;
    const preview = (s.textContent ?? '').replace(/\s+/g, ' ').slice(0, 80);
    console.log(`  Section ${i+1}: ${len} chars — "${preview}"`);
  });

  // ── Common ancestor logic (mirrors updated extension code) ────────────────
  if (allMarkdown.length > 1) {
    let ancestor = allMarkdown[0].parentElement;
    while (ancestor && ancestor !== document.body) {
      if (allMarkdown.every(s => ancestor.contains(s))) break;
      ancestor = ancestor.parentElement;
    }
    const ancestorLen = ancestor ? (ancestor.textContent ?? '').replace(/\s+/g, '').length : 0;
    const ancestorClass = ancestor ? [...ancestor.classList].slice(0, 5).join('.') : '(none)';
    console.log(`\n[DOM] Common ancestor: ${ancestor?.tagName ?? 'none'}.${ancestorClass}`);
    console.log(`[DOM] Common ancestor textLen: ${ancestorLen} (panel total: ${panelTextLen})`);
    console.log(`[DOM] Coverage: ${((ancestorLen / panelTextLen) * 100).toFixed(0)}% of panel text`);
    const ancestorTextPreview = (ancestor?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200);
    console.log(`[DOM] Ancestor preview: "${ancestorTextPreview}"`);
  } else if (allMarkdown.length === 1) {
    const len = (allMarkdown[0].textContent ?? '').replace(/\s+/g, '').length;
    console.log(`\n[DOM] Single .standard-markdown textLen: ${len} / ${panelTextLen} (${((len/panelTextLen)*100).toFixed(0)}%)`);
    console.log(`[DOM] Panel total much larger → content may be in non-.standard-markdown elements`);
  } else {
    console.log('\n[DOM] NO .standard-markdown found — panel uses different renderer');
  }

  // ── Top elements by text length ──────────────────────────────────────────
  console.log('\n[DOM] Top 15 elements by textLen (to find where content lives):');
  const allEls = [...panelRoot.querySelectorAll('*')];
  allEls
    .map(el => ({
      sel: `${el.tagName}${el.id ? '#'+el.id : ''}.${[...el.classList].slice(0,3).join('.')}`,
      textLen: (el.textContent ?? '').replace(/\s+/g, '').length,
      childCount: el.childElementCount,
    }))
    .filter(e => e.textLen > 100)
    .sort((a, b) => b.textLen - a.textLen)
    .slice(0, 15)
    .forEach((e, i) => console.log(`  ${i+1}. ${e.sel} — ${e.textLen} chars, ${e.childCount} children`));

  // ── Fiber inspection (with tightened CONTENT_KEYS) ────────────────────────
  const getFiber = el => {
    const k = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    return k ? el[k] : null;
  };

  // Test BOTH old (text/value included) and new (excluded) CONTENT_KEYS
  const getTopFiberHits = (el, keys, maxNodes = 8000) => {
    const fiber = getFiber(el) ?? (el.firstElementChild ? getFiber(el.firstElementChild) : null);
    if (!fiber) return { nodesVisited: 0, hits: [] };
    const keysSet = new Set(keys);
    const isCssNoise = s => /\binline-flex\b|\bitems-center\b/.test(s) || /^\s*M[\d-]/.test(s) || /^https?:\/\//.test(s);
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
        if (!keysSet.has(key)) continue;
        const v = props[key];
        if (typeof v === 'string' && v.length >= 80 && !isCssNoise(v))
          hits.push({ key, len: v.length, preview: v.slice(0, 120) });
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return { nodesVisited: n, hits: hits.sort((a, b) => b.len - a.len).slice(0, 5) };
  };

  console.log('\n[FIBER] Old CONTENT_KEYS (content, source, code, text, value, src):');
  const oldFiber = getTopFiberHits(panelRoot, ['content', 'source', 'code', 'text', 'value', 'src']);
  console.log(`  Nodes: ${oldFiber.nodesVisited}  Hits: ${oldFiber.hits.length}`);
  oldFiber.hits.slice(0, 3).forEach(h => console.log(`  prop="${h.key}" len=${h.len}: "${h.preview.replace(/\n/g,'↵').slice(0,100)}"`));

  console.log('\n[FIBER] New CONTENT_KEYS (content, source, code, src only):');
  const newFiber = getTopFiberHits(panelRoot, ['content', 'source', 'code', 'src']);
  console.log(`  Nodes: ${newFiber.nodesVisited}  Hits: ${newFiber.hits.length}`);
  newFiber.hits.slice(0, 3).forEach(h => console.log(`  prop="${h.key}" len=${h.len}: "${h.preview.replace(/\n/g,'↵').slice(0,100)}"`));

  console.log('\n════════════════ SUMMARY ═══════════════');
  console.log(`Panel textLen:     ${panelTextLen}`);
  console.log(`.standard-markdown sections: ${allMarkdown.length}`);
  const totalMarkdownLen = allMarkdown.reduce((s, el) => s + (el.textContent ?? '').replace(/\s+/g, '').length, 0);
  console.log(`All sections combined len:   ${totalMarkdownLen}`);
  console.log(`Old fiber hits: ${oldFiber.hits.length}  New fiber hits: ${newFiber.hits.length}`);
  console.log('');
  if (allMarkdown.length > 1 && totalMarkdownLen > panelTextLen * 0.5) {
    console.log('✅ Multiple sections + good coverage → common-ancestor fix should work');
  } else if (allMarkdown.length === 1 && totalMarkdownLen < panelTextLen * 0.5) {
    console.log('⚠️  Single section with low coverage → content in non-.standard-markdown element');
    console.log('   → Need to broaden content root selector (see top-15 list above)');
  } else if (allMarkdown.length === 0) {
    console.log('⚠️  No .standard-markdown → panel uses completely different renderer');
  }
  if (newFiber.hits.length === 0) {
    console.log('✅ Tightened fiber keys return 0 hits — no false positive from prop.text');
  } else {
    console.log('⚠️  New fiber still has hits — may still have false positives');
    console.log(`   Best: prop="${newFiber.hits[0]?.key}" len=${newFiber.hits[0]?.len}`);
  }
  console.log('════════════════════════════════════════');

})();
