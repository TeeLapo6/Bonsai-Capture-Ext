/**
 * Bonsai Capture — Artifact Capture Probe Suite
 *
 * HOW TO USE:
 *   1. Open claude.ai in Chrome with a document artifact panel visible.
 *   2. Leave the panel in PREVIEW mode (Code button NOT active).
 *   3. Open DevTools console and paste this entire script.
 *   4. Wait ~30 seconds for all 8 probes to run sequentially.
 *   5. Check the summary table printed at the end.
 *
 * Each probe (v1–v8) tries a different strategy to switch from preview → code view
 * and extract the source. The table shows which strategies reliably work.
 *
 * Tested against: claude.ai with Radix UI RadioGroup toggle (document artifacts).
 */

(async () => {
  'use strict';

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Step 1: Locate panel root ────────────────────────────────────────────
  // Mirrors the extension's getClaudeArtifactPanelRoot() logic.
  const findPanelRoot = () => {
    // Path A: Mermaid/code artifacts have explicit aria-label
    const byLabel = document.querySelector('[aria-label^="Artifact panel"]');
    if (byLabel) return byLabel;

    // Path B: Document artifacts — viewer root heuristic (matches getClaudeArtifactViewerRoot)
    const codeRadio = document.querySelector(
      'button[role="radio"][data-testid="undefined-raw"], [role="radio"][aria-label="Code"]'
    );
    if (!codeRadio) return null;

    let current = codeRadio.parentElement;
    while (current && current !== document.body) {
      const hasToggle = current.querySelector('[role="radio"][aria-label="Code"]');
      const hasContent = current.querySelector(
        'svg, canvas, pre, code, [id*="wiggle"], .standard-markdown, .progressive-markdown, iframe[src]'
      );
      const textLen = (current.textContent ?? '').replace(/\s+/g, '').length;
      if (hasToggle && hasContent && textLen > 50) return current;
      current = current.parentElement;
    }
    return null;
  };

  // ── Step 2: Locate toggle buttons ────────────────────────────────────────
  const findCodeBtn = (root) =>
    root.querySelector('button[role="radio"][aria-label="Code"], [role="radio"][aria-label="Code"]');

  const findPreviewBtn = (root) =>
    root.querySelector('button[role="radio"][aria-label="Preview"], [role="radio"][aria-label="Preview"]');

  // ── State detection: FIXED (attribute-authoritative) ────────────────────
  const isCodeActive_Fixed = (btn) => {
    const state = (btn.getAttribute('data-state') ?? '').toLowerCase();
    if (state === 'on') return true;
    if (state === 'off') return false;
    const aria = btn.getAttribute('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    return false;
  };

  // ── State detection: BUGGY (current extension pre-fix) ──────────────────
  const isCodeActive_Buggy = (btn, panelRoot) => {
    const state = (btn.getAttribute('data-state') ?? '').toLowerCase();
    if (state === 'on') return true;
    if (btn.getAttribute('aria-checked') === 'true') return true;
    // Content fallback — false-positives on inline <code> in preview
    const langCodes = panelRoot.querySelectorAll('pre code[class*="language-"], code[class*="language-"]');
    if ([...langCodes].some((el) => el.offsetParent !== null)) return true;
    const allCodes = [...panelRoot.querySelectorAll('code')].filter(
      (c) => !c.closest('button, [role="button"]')
    );
    return allCodes.length > 1;
  };

  // ── Content extraction ────────────────────────────────────────────────────
  const extractContent = (panelRoot) => {
    // Prefer wiggle-file-content (document code view)
    const wiggle = panelRoot.querySelector('[id*="wiggle"]');
    if (wiggle) {
      const codes = [...wiggle.querySelectorAll('code')];
      if (codes.length > 0) return codes.map((c) => c.textContent ?? '').join('\n');
    }
    // Prefer language-tagged code block
    const langCode = panelRoot.querySelector('pre > code[class*="language-"]');
    if (langCode) return langCode.textContent ?? '';
    // Pre block
    const pre = panelRoot.querySelector('pre');
    if (pre) return pre.textContent ?? '';
    return '';
  };

  // ── Wait for code view to activate ───────────────────────────────────────
  const waitForCodeActive = async (btn, maxMs = 2500) => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await delay(80);
      if (isCodeActive_Fixed(btn)) return true;
    }
    return false;
  };

  // ── Reset to preview mode between probes ─────────────────────────────────
  const resetToPreview = async (panelRoot) => {
    const codeBtn = findCodeBtn(panelRoot);
    const previewBtn = findPreviewBtn(panelRoot);
    if (!previewBtn) return;
    if (codeBtn && !isCodeActive_Fixed(codeBtn)) return; // already preview
    previewBtn.click();
    await delay(600);
  };

  // ── Pointer event sequence helper ────────────────────────────────────────
  const dispatchPointerClick = (el) => {
    const opts = { bubbles: true, cancelable: true, view: window };
    const pOpts = { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', pOpts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', pOpts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  };

  // ── React fiber walker ────────────────────────────────────────────────────
  const getFiber = (el) => {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    return key ? el[key] : null;
  };

  const walkFiberForProp = (el, propNames) => {
    let fiber = getFiber(el);
    while (fiber) {
      const props = fiber.memoizedProps ?? fiber.pendingProps ?? {};
      for (const name of propNames) {
        if (typeof props[name] === 'function') return { fiber, name, fn: props[name] };
      }
      fiber = fiber.return;
    }
    return null;
  };

  // ── Run all probes ────────────────────────────────────────────────────────
  const panelRoot = findPanelRoot();
  if (!panelRoot) {
    console.error('[Probes] ❌ No artifact panel found. Open a document artifact panel first.');
    return;
  }
  console.log('[Probes] ✅ Panel root found:', panelRoot.tagName, '·', panelRoot.className.slice(0, 80));

  const codeBtn = findCodeBtn(panelRoot);
  if (!codeBtn) {
    console.error('[Probes] ❌ Code toggle button not found inside panel.');
    return;
  }
  console.log('[Probes] ✅ Code button found:', codeBtn.getAttribute('aria-checked'), '/', codeBtn.getAttribute('data-state'));

  const results = [];

  const runProbe = async (id, description, clickFn) => {
    console.log(`\n[${id}] Starting — ${description}`);

    // Reset to preview and snapshot pre-state
    await resetToPreview(panelRoot);
    const btn = findCodeBtn(panelRoot); // re-fetch after DOM reset
    if (!btn) { results.push({ id, description, error: 'Code button missing after reset' }); return; }

    const preFixed = isCodeActive_Fixed(btn);
    const preBuggy = isCodeActive_Buggy(btn, panelRoot);
    const preAria = btn.getAttribute('aria-checked');
    const preState = btn.getAttribute('data-state');
    const preCodeNodeCount = panelRoot.querySelectorAll('code:not(button code):not([role="button"] code)').length;

    // Execute the probe's click strategy
    await clickFn(btn, panelRoot);

    // Wait for view switch
    const switched = await waitForCodeActive(btn, 2500);

    // Extract content
    const content = extractContent(panelRoot);
    const postAria = btn.getAttribute('aria-checked');
    const postState = btn.getAttribute('data-state');

    const result = {
      id,
      description,
      preFixed,
      preBuggy,
      preAria,
      preState,
      preCodeNodeCount,
      postAria,
      postState,
      switched,
      contentLen: content.length,
      contentPreview: content.slice(0, 100).replace(/\n/g, '↵'),
    };
    results.push(result);

    const icon = switched && content.length > 100 ? '✅' : switched ? '⚠️' : '❌';
    console.log(`[${id}] ${icon} switched=${switched} aria=${postAria} dataState=${postState} contentLen=${content.length}`);
    if (content.length > 0) console.log(`[${id}] Preview: ${content.slice(0, 150).replace(/\n/g, '↵')}`);
  };

  // ── v1: .click() — current extension approach ────────────────────────────
  await runProbe('v1', 'element.click()', async (btn) => {
    btn.click();
  });

  // ── v2: MouseEvent dispatched explicitly ─────────────────────────────────
  await runProbe('v2', 'dispatchEvent(new MouseEvent("click", {bubbles,cancelable}))', async (btn) => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });

  // ── v3: MouseEvent with composed:true ───────────────────────────────────
  await runProbe('v3', 'dispatchEvent(new MouseEvent("click", {bubbles,cancelable,composed:true}))', async (btn) => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, composed: true }));
  });

  // ── v4: Full pointer event sequence ─────────────────────────────────────
  await runProbe('v4', 'Full pointer+mouse event sequence (pointerdown→mousedown→pointerup→mouseup→click)', async (btn) => {
    dispatchPointerClick(btn);
  });

  // ── v5: Focus + Space key ────────────────────────────────────────────────
  await runProbe('v5', 'btn.focus() + Space keydown/keyup', async (btn) => {
    btn.focus();
    await delay(50);
    const kbOpts = { key: ' ', code: 'Space', keyCode: 32, bubbles: true, cancelable: true };
    btn.dispatchEvent(new KeyboardEvent('keydown', kbOpts));
    btn.dispatchEvent(new KeyboardEvent('keyup', kbOpts));
  });

  // ── v6: Click Preview unconditionally, then Code ─────────────────────────
  await runProbe('v6', 'Click Preview first (500ms), then Code button', async (btn, root) => {
    const previewBtn = findPreviewBtn(root);
    if (previewBtn) {
      previewBtn.click();
      await delay(500);
    }
    btn.click();
  });

  // ── v7: React fiber onClick ──────────────────────────────────────────────
  await runProbe('v7', 'React fiber: invoke onClick from memoizedProps', async (btn) => {
    const match = walkFiberForProp(btn, ['onClick']);
    if (!match) { console.warn('[v7] No onClick found in fiber tree'); return; }
    const fakeEvent = {
      type: 'click', target: btn, currentTarget: btn, bubbles: true,
      nativeEvent: new MouseEvent('click', { bubbles: true }),
      stopPropagation: () => {}, preventDefault: () => {},
    };
    try { match.fn(fakeEvent); } catch (e) { console.warn('[v7] onClick threw:', e); }
  });

  // ── v8: React fiber onValueChange / onCheckedChange ──────────────────────
  await runProbe('v8', 'React fiber: invoke onValueChange("raw") or onCheckedChange(true)', async (btn) => {
    const match = walkFiberForProp(btn, ['onValueChange', 'onCheckedChange']);
    if (!match) { console.warn('[v8] No onValueChange/onCheckedChange found in fiber tree'); return; }
    try {
      if (match.name === 'onValueChange') match.fn('raw');
      else match.fn(true);
    } catch (e) { console.warn('[v8] handler threw:', e); }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════');
  console.log('📊  PROBE RESULTS SUMMARY');
  console.log('══════════════════════════════════════════════');
  console.table(
    results.map((r) => ({
      Probe: r.id,
      Description: r.description,
      'Pre-buggy?': r.preBuggy,   // true = extension would have SKIPPED the click (bug)
      'Pre-fixed?': r.preFixed,   // should always be false (we reset to preview)
      '#code-nodes': r.preCodeNodeCount,
      Switched: r.switched,
      'Content len': r.contentLen,
      'Content preview': r.contentPreview,
    }))
  );
  console.log('\nKey: "Pre-buggy?" = true means the OLD code would have skipped clicking entirely (false positive).');
  console.log('     "Switched" = true means the toggle reached code view within 2.5s.');
  console.log('     "Content len" > 500 = real source captured; < 100 = likely failed/noise.\n');

  return results;
})();
