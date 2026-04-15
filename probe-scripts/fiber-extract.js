/**
 * Bonsai Capture — Fiber Content Extraction Probe
 *
 * HOW TO USE:
 *   1. Open claude.ai with ANY artifact panel (doc or code, any view state).
 *   2. Paste into DevTools console.
 *   3. Verify that "fiberContent" shows the actual source.
 *
 * This mirrors the new getClaudeArtifactContentFromFiber() logic in the extension.
 * Panel view state (Preview vs Code) doesn't matter — the fiber holds the source always.
 */
(() => {
  'use strict';

  const getFiber = el => {
    const rec = el;
    const key = Object.keys(rec).find(
      k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    return key ? rec[key] : null;
  };

  const isCssOrSvgNoise = s =>
    /\binline-flex\b|\bitems-center\b|\bjustify-center\b/.test(s)
    || /^\s*M[\d-]/.test(s)
    || /^https?:\/\//.test(s);

  const CONTENT_KEYS = new Set(['content', 'source', 'code', 'text', 'value', 'src']);

  const extractFromFiber = root => {
    const fiber = getFiber(root) ?? (root.firstElementChild ? getFiber(root.firstElementChild) : null);
    if (!fiber) return { error: 'no fiber found on panel root or first child' };

    const hits = [];
    const seen = new WeakSet();
    const stack = [fiber];
    let n = 0;

    while (stack.length > 0 && n < 8000) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f); n++;

      const props = f.memoizedProps ?? f.pendingProps ?? {};
      for (const key of Object.keys(props)) {
        if (!CONTENT_KEYS.has(key)) continue;
        const v = props[key];
        if (typeof v === 'string' && v.length >= 80 && !isCssOrSvgNoise(v)) {
          hits.push({ key, len: v.length, value: v });
        }
      }

      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }

    hits.sort((a, b) => b.len - a.len);
    return { nodesVisited: n, hits: hits.slice(0, 10) };
  };

  // -- Find panel root (same as extension) --
  const findPanelRoot = () => {
    const byLabel = document.querySelector('[aria-label^="Artifact panel"]');
    if (byLabel) return byLabel;

    const codeRadio = document.querySelector(
      'button[role="radio"][data-testid$="-raw"], button[role="radio"][aria-label="Code"]'
    );
    if (!codeRadio) return null;

    let el = codeRadio.parentElement;
    while (el && el !== document.body) {
      const textLen = (el.textContent ?? '').replace(/\s+/g, '').length;
      if (
        el.querySelector('[role="radio"][aria-label="Code"]') &&
        el.querySelector('svg, pre, code, [id*="wiggle"], .standard-markdown, .progressive-markdown') &&
        textLen > 50
      ) return el;
      el = el.parentElement;
    }
    return null;
  };

  const panel = findPanelRoot();
  if (!panel) {
    console.error('❌ No artifact panel found. Open an artifact panel first.');
    return;
  }

  const codeBtn = panel.querySelector('[role="radio"][aria-label="Code"]');
  console.log('Panel :', panel.getAttribute('aria-label') ?? panel.tagName + '.' + panel.className.slice(0, 40));
  console.log('Toggle state:', codeBtn?.getAttribute('data-state'), '/', codeBtn?.getAttribute('aria-checked'));

  const result = extractFromFiber(panel);
  console.log(`\nNodes visited: ${result.nodesVisited ?? 'n/a'}`);

  if (result.error) {
    console.error('❌', result.error);
    return;
  }

  if (result.hits.length === 0) {
    console.warn('⚠️  No content found in fiber. Extension fiber path will fall back to DOM/toggle.');
    return;
  }

  const best = result.hits[0];
  console.log(`\n✅ Best candidate: prop="${best.key}"  len=${best.len}`);
  console.log('Preview:', best.value.slice(0, 500).replace(/\n/g, '↵'));

  console.log('\n📋 All candidates:');
  result.hits.forEach((h, i) =>
    console.log(`  #${i + 1} prop="${h.key}" len=${h.len}: ${h.value.slice(0, 80).replace(/\n/g, '↵')}`)
  );

  return result;
})();
