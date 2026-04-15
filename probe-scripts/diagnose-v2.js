/**
 * Bonsai Capture — Artifact Panel Diagnostic v2
 *
 * PURPOSE: Diagnose WHY code-view toggle clicks don't work for document artifacts,
 * and find alternative extraction paths that bypass the toggle entirely.
 *
 * HOW TO USE:
 *   1. Open claude.ai with a document artifact panel open in PREVIEW mode.
 *      (Code button should have data-state="off" / aria-checked="false")
 *   2. Open DevTools → Console, paste this entire script.
 *   3. Read the SUMMARY at the end.
 *
 * WHAT IT TESTS:
 *   D1 — Does .click() even reach the button? What is event.isTrusted?
 *   D2 — Does any attribute mutate (even momentarily) when we click?
 *   D3 — Is wiggle-file-content in the DOM during preview mode?
 *         If YES → we can read source WITHOUT toggling. Major win.
 *   D4 — What do the button's immediate ancestors look like?
 *   E1 — React fiber tree walk: find raw document content in component props/state
 *   E2 — Copy button + clipboard spy: does clipboard export work?
 *   E3 — Preview DOM plain-text: fallback rendition of the content
 */

(async () => {
  'use strict';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // ─── Finders ─────────────────────────────────────────────────────────────────

  const findPanelRoot = () => {
    // Path A: Mermaid / code artifacts have an explicit aria-label
    const byLabel = document.querySelector('[aria-label^="Artifact panel"]');
    if (byLabel) return byLabel;

    // Path B: Document artifacts — heuristic (mirrors getClaudeArtifactViewerRoot)
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

  const findCodeBtn = root =>
    root.querySelector('button[role="radio"][data-testid$="-raw"]') ??
    root.querySelector('button[role="radio"][aria-label="Code"]') ??
    root.querySelector('[role="radio"][aria-label="Code"]');

  const findPreviewBtn = root =>
    root.querySelector('button[role="radio"][data-testid$="-normal"]') ??
    root.querySelector('button[role="radio"][aria-label="Preview"]') ??
    root.querySelector('[role="radio"][aria-label="Preview"]');

  const codeActive = btn => {
    const s = (btn.getAttribute('data-state') ?? '').toLowerCase();
    if (s === 'on') return true;
    if (s === 'off') return false;
    const a = btn.getAttribute('aria-checked');
    return a === 'true' ? true : a === 'false' ? false : null;
  };

  // ─── React fiber utils ───────────────────────────────────────────────────────

  const getFiber = el => {
    const k = Object.keys(el).find(
      k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    return k ? el[k] : null;
  };

  /**
   * Walk fiber subtree (DFS down via child+sibling) with a node limit.
   * Calls visitor(fiber) — return true to stop early.
   */
  const walkFiberDown = (root, visitor, maxNodes = 6000) => {
    const stack = [root];
    const seen = new WeakSet();
    let n = 0;
    while (stack.length && n < maxNodes) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f); n++;
      if (visitor(f)) return f;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  };

  /**
   * Walk fiber tree UPWARD to find parent components that hold state.
   */
  const walkFiberUp = (start, visitor, maxSteps = 80) => {
    let f = start;
    for (let i = 0; i < maxSteps && f; i++, f = f.return) {
      if (visitor(f)) return f;
    }
    return null;
  };

  /**
   * Collect all string props/state >= minLen chars in the fiber subtree.
   */
  const collectLargeStrings = (rootFiber, minLen = 300) => {
    const hits = [];
    walkFiberDown(rootFiber, f => {
      const typeName = typeof f.type === 'string'
        ? f.type : (f.type?.displayName ?? f.type?.name ?? '?');

      // Props
      const props = f.memoizedProps ?? f.pendingProps ?? {};
      for (const [k, v] of Object.entries(props)) {
        if (typeof v === 'string' && v.length >= minLen && !/^https?:\/\//.test(v)) {
          hits.push({ source: 'prop', key: k, len: v.length, preview: v.slice(0, 120), component: typeName });
        }
      }

      // useState memoizedState chain
      let s = f.memoizedState;
      while (s) {
        if (typeof s.memoizedState === 'string' && s.memoizedState.length >= minLen) {
          hits.push({ source: 'state', key: '[useState]', len: s.memoizedState.length, preview: s.memoizedState.slice(0, 120), component: typeName });
        }
        s = s.next;
      }
      return false; // keep walking
    });
    return hits.sort((a, b) => b.len - a.len);
  };

  // ─── Setup ────────────────────────────────────────────────────────────────────

  const panel = findPanelRoot();
  if (!panel) {
    console.error('❌ No artifact panel found. Open a document artifact panel first, then re-run.');
    return;
  }
  const codeBtn = findCodeBtn(panel);
  if (!codeBtn) {
    console.error('❌ Code toggle button not found inside panel.');
    return;
  }

  console.group('🔍 Artifact Panel Diagnostics v2');
  console.log('Panel root :', panel);
  console.log('Code button:', codeBtn);
  console.log('State      :', codeBtn.getAttribute('data-state'), '/', codeBtn.getAttribute('aria-checked'));

  const R = {};

  // ════════════════════════════════════════════════════════════════════════════
  // D1 — Does click() reach the button? What isTrusted value does it carry?
  // ════════════════════════════════════════════════════════════════════════════
  {
    let reached = false, trusted = null;
    // Use capture phase so we fire BEFORE any stopPropagation on the bubble path
    const h = e => { reached = true; trusted = e.isTrusted; };
    codeBtn.addEventListener('click', h, { capture: true, once: true });
    codeBtn.click();
    await delay(250);
    codeBtn.removeEventListener('click', h, { capture: true });
    const stateAfter = codeActive(codeBtn);
    R.D1 = { reached, isTrusted: trusted, stateChangedToCode: stateAfter };
    console.log(`\n[D1] click() reaches button: ${reached}  |  isTrusted: ${trusted}  |  state changed: ${stateAfter}`);
    if (stateAfter) { findPreviewBtn(panel)?.click(); await delay(600); }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // D2 — MutationObserver: does any attribute mutate (even momentarily)?
  // ════════════════════════════════════════════════════════════════════════════
  {
    const muts = [];
    const obs = new MutationObserver(list => list.forEach(m => muts.push({
      attr: m.attributeName,
      from: m.oldValue,
      to: m.target.getAttribute(m.attributeName),
    })));
    obs.observe(codeBtn, { attributes: true, attributeOldValue: true });
    codeBtn.click();
    await delay(700);
    obs.disconnect();
    R.D2 = { mutations: muts };
    if (muts.length) {
      console.log('[D2] Attribute mutations detected:', muts);
    } else {
      console.log('[D2] ZERO attribute mutations — click has NO effect on the button whatsoever');
    }
    if (codeActive(codeBtn)) { findPreviewBtn(panel)?.click(); await delay(600); }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // D3 — Is wiggle-file-content in the DOM during PREVIEW mode?
  //      If code view content is pre-rendered (just hidden), we can read it
  //      directly without any toggle interaction.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const wiggle = panel.querySelector('[id*="wiggle"]');
    let codeEls = 0, contentLen = 0, contentPreview = '', cssDisplay = 'n/a', cssVis = 'n/a';
    if (wiggle) {
      const style = getComputedStyle(wiggle);
      cssDisplay = style.display;
      cssVis = style.visibility;
      const codes = [...wiggle.querySelectorAll('code')];
      codeEls = codes.length;
      const joined = codes.map(c => c.textContent ?? '').join('\n');
      contentLen = joined.length;
      contentPreview = joined.slice(0, 300);
    }
    R.D3 = { exists: !!wiggle, cssDisplay, cssVis, codeEls, contentLen, contentPreview };
    console.log(`\n[D3] wiggle-file-content in preview DOM:`);
    console.log(`     exists=${!!wiggle}  display=${cssDisplay}  visibility=${cssVis}  code-els=${codeEls}  content-len=${contentLen}`);
    if (contentLen > 0) console.log('[D3] Content preview:', contentPreview.slice(0, 200).replace(/\n/g, '↵'));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // D4 — Button ancestry: which elements surround the Code toggle?
  // ════════════════════════════════════════════════════════════════════════════
  {
    const ancestors = [];
    let el = codeBtn.parentElement;
    for (let i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
      ancestors.push({
        tag: el.tagName,
        role: el.getAttribute('role') ?? '-',
        ariaLabel: el.getAttribute('aria-label') ?? '-',
        dataTestid: el.getAttribute('data-testid') ?? '-',
        classes: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
      });
    }
    R.D4 = { ancestors };
    console.log('\n[D4] Code button ancestors (innermost first):');
    ancestors.forEach((a, i) => console.log(`  #${i+1} ${a.tag} role=${a.role} aria-label=${a.ariaLabel} data-testid=${a.dataTestid}`));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // E1 — React fiber tree walk for large string props/state
  //      The document content MUST be somewhere in the component tree.
  // ════════════════════════════════════════════════════════════════════════════
  {
    console.log('\n[E1] Walking React fiber tree for strings >= 300 chars...');
    const fiber = getFiber(panel);
    if (fiber) {
      const hits = collectLargeStrings(fiber, 300);
      R.E1 = hits;
      console.log(`[E1] Found ${hits.length} large-string candidates:`);
      hits.slice(0, 12).forEach(h =>
        console.log(`  [${h.source}:${h.key}] ${h.len} chars (${h.component}): ${h.preview.replace(/\n/g, '↵')}`)
      );
      if (hits.length === 0) {
        // Try walking UP from the panel — content may live in a parent component
        console.log('[E1] Nothing in subtree — walking UP fiber chain for large strings...');
        const upHits = [];
        walkFiberUp(fiber, f => {
          const typeName = typeof f.type === 'string' ? f.type : (f.type?.displayName ?? f.type?.name ?? '?');
          const props = f.memoizedProps ?? f.pendingProps ?? {};
          for (const [k, v] of Object.entries(props)) {
            if (typeof v === 'string' && v.length >= 300 && !/^https?:\/\//.test(v)) {
              upHits.push({ key: k, len: v.length, preview: v.slice(0, 120), component: typeName });
            }
          }
          return false;
        });
        R.E1_upward = upHits.sort((a, b) => b.len - a.len);
        console.log(`[E1 upward] Found ${upHits.length}:`, upHits.slice(0, 5));
      }
    } else {
      R.E1 = null;
      console.log('[E1] panelRoot has no __reactFiber key — not directly a React element');
      // Try children
      const child = panel.firstElementChild;
      const childFiber = child ? getFiber(child) : null;
      if (childFiber) {
        console.log('[E1] Found fiber on first child, retrying...');
        const hits = collectLargeStrings(childFiber, 300);
        R.E1 = hits;
        hits.slice(0, 5).forEach(h => console.log(`  ${h.key} ${h.len}chars: ${h.preview}`));
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // E2 — Copy button + clipboard spy
  //      Claude has a "Copy" icon in the artifact header.
  //      Spy on clipboard.writeText, click Copy, read what was written.
  // ════════════════════════════════════════════════════════════════════════════
  {
    console.log('\n[E2] Testing Copy button + clipboard spy...');
    let captured = null;
    const origWrite = navigator.clipboard?.writeText?.bind(navigator.clipboard);

    if (navigator.clipboard) {
      navigator.clipboard.writeText = async text => {
        captured = text;
        return origWrite ? origWrite(text) : undefined;
      };
    }

    // Search for copy button — try multiple selector strategies
    const copyBtn =
      panel.querySelector('[aria-label*="Copy" i]') ??
      panel.querySelector('button[title*="Copy" i]') ??
      panel.querySelector('[data-testid*="copy" i]') ??
      // Fallback: look in header area for icon buttons
      [...panel.querySelectorAll('button')].find(b => {
        const label = (b.getAttribute('aria-label') ?? b.title ?? b.textContent ?? '').toLowerCase();
        return label.includes('copy');
      }) ?? null;

    R.E2 = { found: !!copyBtn, ariaLabel: copyBtn?.getAttribute('aria-label') ?? null };
    console.log('[E2] Copy button:', copyBtn ?? 'NOT FOUND');

    if (copyBtn) {
      copyBtn.click();
      await delay(1200);
    }

    if (navigator.clipboard && origWrite) navigator.clipboard.writeText = origWrite;

    R.E2.clipLen = captured?.length ?? 0;
    R.E2.clipPreview = captured?.slice(0, 300) ?? null;
    if (captured) {
      console.log(`[E2] ✅ Clipboard captured ${captured.length} chars!`);
      console.log('[E2] Preview:', captured.slice(0, 300).replace(/\n/g, '↵'));
    } else {
      console.log('[E2] No clipboard content captured');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // E3 — Preview DOM plain-text extraction
  //      Rendered HTML → textContent — not the source, but readable content.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const previewRoot = panel.querySelector('.standard-markdown, .progressive-markdown, .markdown, [data-artifact-content]');
    const text = previewRoot?.textContent ?? '';
    R.E3 = { found: !!previewRoot, textLen: text.length, preview: text.slice(0, 300) };
    console.log(`\n[E3] Preview DOM text: ${text.length} chars (rendered markdown, not source).`);
    if (text) console.log('[E3] Preview:', text.slice(0, 200).replace(/\n/g, '↵'));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // E4 — Any global window stores with artifact data?
  // ════════════════════════════════════════════════════════════════════════════
  {
    const candidates = ['__NEXT_DATA__', '__NUXT__', '__nuxt__', '__APP_STATE__', '__CONVERSATION__', '__ARTIFACTS__'];
    const found = candidates.filter(k => { try { return !!window[k]; } catch { return false; } });
    R.E4 = found;
    console.log('\n[E4] Global window stores:', found.length ? found.join(', ') : 'none found');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════════
  console.groupEnd();
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC SUMMARY');
  console.log('════════════════════════════════════════════════════════');
  console.log(`D1  click() reaches button : ${R.D1?.reached ?? '?'}   isTrusted: ${R.D1?.isTrusted ?? '?'}   state changed to code: ${R.D1?.stateChangedToCode ?? '?'}`);
  console.log(`D2  attr mutations on click: ${R.D2?.mutations?.length ?? 0}`);
  console.log(`D3  wiggle in preview DOM  : exists=${R.D3?.exists}  display=${R.D3?.cssDisplay}  code-els=${R.D3?.codeEls}  content-len=${R.D3?.contentLen}`);
  console.log(`D4  (see ancestor log above)`);
  console.log(`E1  fiber large strings    : ${Array.isArray(R.E1) ? R.E1.length : 'n/a'} found${R.E1_upward?.length ? ` (+${R.E1_upward.length} upward)` : ''}`);
  if (Array.isArray(R.E1) && R.E1[0]) console.log(`    top hit: [${R.E1[0].key}] ${R.E1[0].len} chars @ ${R.E1[0].component}`);
  console.log(`E2  copy button            : ${R.E2?.found}   clipboard len: ${R.E2?.clipLen ?? 0}`);
  console.log(`E3  preview DOM text       : ${R.E3?.textLen ?? 0} chars`);
  console.log(`E4  global stores          : ${R.E4?.join(', ') || 'none'}`);
  console.log('════════════════════════════════════════════════════════');
  console.log('\nINTERPRETATION GUIDE:');
  console.log('  D1 reached=true, isTrusted=false, state unchanged → Claude blocks untrusted clicks');
  console.log('  D1 reached=false                                  → Shadow DOM or event interception upstream');
  console.log('  D2 mutations=0                                    → Confirms click has zero DOM effect');
  console.log('  D3 wiggle exists + contentLen > 0                 → ✅ Read source from wiggle even in preview mode!');
  console.log('  E1 hits > 0 with markdown-looking content         → ✅ Extract from React fiber props');
  console.log('  E2 clipLen > 0                                    → ✅ Use clipboard copy as extraction path');

  return R;
})();
