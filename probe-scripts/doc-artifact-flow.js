/**
 * Bonsai Capture — Document Artifact Full-Flow Probe
 *
 * PURPOSE: Step through the exact extension logic for document artifacts
 * ("Bonsai saas website plan", "Bonsai hub blocks directory") to find
 * exactly which step fails.
 *
 * HOW TO USE:
 *   1. Navigate to the chat with the two document artifacts (NOT the Mermaid chat).
 *      Close any open artifact panel first.
 *   2. Paste into DevTools console.
 *   3. The script steps through opener detection → panel open → panel find → fiber read.
 *
 * WHAT IT TESTS:
 *   S1  Artifact card detection (getClaudeArtifactRefs equivalent)
 *   S2  Opener detection (getClaudeArtifactOpeners equivalent)
 *   S3  Opener click → panel appears? (captureClaudeOpenedArtifact equivalent)
 *   S4  Panel root detection — aria-label path AND viewer-root heuristic
 *   S5  Fiber content extraction from the document panel
 *   S6  Full simulated capture result
 */

(async () => {
  'use strict';
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // ── Artifact card selectors (mirrors getClaudeArtifactCardSelectors) ─────
  const CARD_SELECTOR = [
    '[data-artifact]', '[data-artifact-id]',
    '[data-testid*="artifact"]', '[data-testid*="attachment"]',
    '.artifact-card', '.artifact-preview', '.artifact-block-cell',
    '[class*="artifact-card"]',
  ].join(', ');

  // ── Opener label filter ───────────────────────────────────────────────────
  const hasOpenArtifactLabel = el => {
    const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`
      .replace(/\s+/g, ' ').trim();
    return /open artifact/i.test(label);
  };

  // ── Panel candidates (mirrors getClaudeArtifactPanelCandidates) ──────────
  const PANEL_SELECTORS = [
    '[aria-label^="Artifact panel"]',
    '[role="region"][aria-label*="Artifact"]',
    '[data-testid*="artifact-panel"]',
    '[data-testid*="artifact-view"]',
    '[class*="artifact-panel"]',
    '[class*="artifact-view"]',
    '[class*="artifact-editor"]',
  ];

  // ── Viewer-root heuristic (mirrors getClaudeArtifactViewerRoot) ──────────
  const findViewerRoot = (seed, cardSelector) => {
    // Guard: card thumbnail toggles must never be treated as panel toggles
    if (seed.closest(cardSelector)) return null;

    let current = seed.parentElement;
    while (current && current !== document.body) {
      const hasToggle = current.querySelector('[role="radio"][aria-label="Code"], button[aria-label="Code"]');
      const hasContent = current.querySelector(
        'svg, canvas, pre, code, [id*="wiggle"], .standard-markdown, .progressive-markdown, iframe[src]'
      );
      const textLen = (current.textContent ?? '').replace(/\s+/g, '').length;
      if (hasToggle && hasContent && textLen > 50) return current;
      current = current.parentElement;
    }
    return null;
  };

  const findPanelCandidates = () => {
    const bySel = PANEL_SELECTORS.flatMap(sel => [...document.querySelectorAll(sel)]);
    const byHeuristic = [...document.querySelectorAll(
      'button[aria-label*="Code"], [role="radio"][aria-label*="Code"]'
    )].flatMap(btn => {
      // Skip card thumbnail Code toggles (same guard as getClaudeArtifactPanelCandidates)
      if (btn.closest(CARD_SELECTOR)) return [];
      const root = findViewerRoot(btn, CARD_SELECTOR);
      return root ? [root] : [];
    });
    const all = [...bySel, ...byHeuristic].filter((el, i, a) => a.indexOf(el) === i);
    return all.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  };

  // ── Fiber extraction (mirrors getClaudeArtifactContentFromFiber) ─────────
  const getFiber = el => {
    const rec = el;
    const k = Object.keys(rec).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    return k ? rec[k] : null;
  };

  const CONTENT_KEYS = new Set(['content', 'source', 'code', 'text', 'value', 'src']);
  const isCssNoise = s =>
    /\binline-flex\b|\bitems-center\b|\bjustify-center\b/.test(s)
    || /^\s*M[\d-]/.test(s)
    || /^https?:\/\//.test(s);

  const fiberExtract = root => {
    const fiber = getFiber(root) ?? (root.firstElementChild ? getFiber(root.firstElementChild) : null);
    if (!fiber) return null;

    const hits = [];
    const seen = new WeakSet();
    const stack = [fiber];
    let n = 0;
    while (stack.length && n < 8000) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f); n++;
      const props = f.memoizedProps ?? f.pendingProps ?? {};
      for (const key of Object.keys(props)) {
        if (!CONTENT_KEYS.has(key)) continue;
        const v = props[key];
        if (typeof v === 'string' && v.length >= 80 && !isCssNoise(v))
          hits.push({ key, len: v.length, value: v });
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    hits.sort((a, b) => b.len - a.len);
    return hits.length > 0 ? hits[0] : null;
  };

  // ════════════════════════════════════════════════════════════════════════
  // S1 — Find artifact cards in assistant messages
  // ════════════════════════════════════════════════════════════════════════
  console.group('📋 S1: Artifact card detection');
  const allCards = [...document.querySelectorAll(CARD_SELECTOR)];
  console.log(`Found ${allCards.length} raw card matches:`);
  allCards.forEach((c, i) => {
    const rect = c.getBoundingClientRect();
    console.log(`  #${i + 1} ${c.tagName}.${[...c.classList].slice(0, 3).join('.')}  visible=${rect.width > 0 && rect.height > 0}  text="${(c.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60)}"`);
  });
  const visibleCards = allCards.filter(c => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  console.log(`Visible cards: ${visibleCards.length}`);
  console.groupEnd();

  if (visibleCards.length === 0) {
    console.error('❌ No artifact cards found. Make sure you are on the correct chat page with document artifacts visible.');
    return;
  }

  // ════════════════════════════════════════════════════════════════════════
  // S2 — Opener detection for each card
  // ════════════════════════════════════════════════════════════════════════
  console.group('🔗 S2: Opener detection');
  const openerSel = '[aria-label*="Open artifact"], [aria-label*="open artifact"], .artifact-block-cell[role="button"], .artifact-block-cell[aria-label], .artifact-block-cell [role="button"], .artifact-block-cell button, .artifact-block-cell div[aria-label]';

  const cardData = visibleCards.map((ref, i) => {
    // Find openers inside the card
    const innerOpeners = [...ref.querySelectorAll(openerSel)]
      .filter(el => el instanceof HTMLElement && hasOpenArtifactLabel(el));
    // Closest ancestor opener
    const ancestorOpener = ref.closest('[aria-label*="Open artifact"], [aria-label*="open artifact"]');
    // Fallback: the ref itself if it has open-artifact label
    const selfOpener = hasOpenArtifactLabel(ref) ? ref : null;

    const opener = innerOpeners[0] ?? ancestorOpener ?? selfOpener ?? ref;

    const title = (ref.querySelector('.artifact-title, [data-testid="artifact-title"], h1, h2, h3, strong')?.textContent?.trim()
      ?? ref.getAttribute('aria-label')
      ?? (opener !== ref ? opener.getAttribute('aria-label') : null)
      ?? ref.textContent?.replace(/\s+/g, ' ').slice(0, 50));

    console.log(`  Card #${i + 1}: "${title?.slice(0, 50)}"`);
    console.log(`    ref: ${ref.tagName}${ref.id ? '#' + ref.id : ''}.${[...ref.classList].slice(0, 3).join('.')}`);
    console.log(`    innerOpeners: ${innerOpeners.length}  ancestorOpener: ${!!ancestorOpener}  selfOpener: ${!!selfOpener}`);
    console.log(`    chosen opener: ${opener.tagName} aria-label="${opener.getAttribute('aria-label')?.slice(0, 60)}" role="${opener.getAttribute('role')}"`);
    console.log(`    opener.hasOpenArtifact: ${hasOpenArtifactLabel(opener)}`);

    return { ref, opener: opener instanceof HTMLElement ? opener : null, title };
  });
  console.groupEnd();

  // ════════════════════════════════════════════════════════════════════════
  // S3–S6 — For each card: click opener, find panel, extract fiber content
  // ════════════════════════════════════════════════════════════════════════
  const results = [];

  for (const { ref, opener, title } of cardData) {
    console.group(`\n🔄 Testing: "${title?.slice(0, 50)}"`);

    // State before click
    const panelsBefore = findPanelCandidates();
    console.log(`S3: Panel candidates BEFORE click: ${panelsBefore.length}`);

    if (!opener) {
      console.warn('⚠️  No opener element — skipping click');
      results.push({ title, openerFound: false, panelFound: false, fiberContent: null });
      console.groupEnd();
      continue;
    }

    // Click opener
    console.log(`S3: Clicking opener: ${opener.tagName} "${opener.getAttribute('aria-label')?.slice(0, 40) ?? ''}"`);
    opener.click();

    // Wait for panel to appear (mirrors the 15-attempt loop in captureClaudeOpenedArtifact)
    let panelRoot = null;
    let pollCount = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(200);
      pollCount++;
      const candidates = findPanelCandidates();
      if (candidates.length > panelsBefore.length || (candidates.length > 0 && panelsBefore.length === 0)) {
        // New panel appeared
        panelRoot = candidates.find(c => !panelsBefore.includes(c)) ?? candidates[0];
        break;
      }
      // Even if count didn't change, check if we now have any panel at all
      if (candidates.length > 0) {
        panelRoot = candidates[0];
        break;
      }
    }

    console.log(`S3: Panel found after ${pollCount} polls: ${!!panelRoot}`);
    if (panelRoot) {
      const ariaLabel = panelRoot.getAttribute('aria-label');
      const role = panelRoot.getAttribute('role');
      console.log(`S4: Panel root: ${panelRoot.tagName} role="${role}" aria-label="${ariaLabel?.slice(0, 80)}"`);
      console.log(`    class: ${panelRoot.className.slice(0, 80)}`);
      console.log(`    textLen (collapsed): ${(panelRoot.textContent ?? '').replace(/\s+/g, '').length}`);

      // Check which path found it
      const bySelectors = PANEL_SELECTORS.some(sel => panelRoot.matches(sel));
      console.log(`    found via: ${bySelectors ? 'aria-label/selector' : 'viewer-root heuristic'}`);

      // Check Code toggle in panel
      const codeBtn = panelRoot.querySelector('[role="radio"][aria-label="Code"], button[aria-label="Code"]');
      console.log(`    Code toggle present: ${!!codeBtn}  state: ${codeBtn?.getAttribute('data-state')} / ${codeBtn?.getAttribute('aria-checked')}`);

      // S5: Fiber extraction
      const fiber = fiberExtract(panelRoot);
      console.log(`S5: Fiber content: ${fiber ? `✅ prop="${fiber.key}" len=${fiber.len}` : '❌ not found'}`);
      if (fiber) console.log(`    Preview: ${fiber.value.slice(0, 200).replace(/\n/g, '↵')}`);

      results.push({
        title,
        openerFound: true,
        panelFound: true,
        panelHasAriaLabel: !!ariaLabel,
        panelFoundViaSel: bySelectors,
        hasCodeToggle: !!codeBtn,
        fiberContent: fiber ? fiber.value.slice(0, 100) : null,
        fiberLen: fiber?.len ?? 0,
      });

      // Close panel before next iteration
      const closeBtn = [...document.querySelectorAll('button')]
        .find(b => /close|dismiss/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
      if (closeBtn) {
        closeBtn.click();
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      await delay(500);
    } else {
      // Panel didn't appear. Show what's visible in the DOM right now.
      console.warn('⚠️  Panel did NOT appear after 20 polls (4 seconds).');

      // Show what panel candidates ARE present
      const currentCandidates = findPanelCandidates();
      console.log(`    findPanelCandidates() now returns ${currentCandidates.length} elements:`);
      currentCandidates.forEach((c, i) => console.log(`      #${i+1} ${c.tagName} aria-label="${c.getAttribute('aria-label')?.slice(0,60)}" textLen=${(c.textContent ?? '').replace(/\s+/g,'').length}`));

      // Check if there are ANY radio buttons visible (Code/Preview toggle indicators)
      const radios = [...document.querySelectorAll('[role="radio"]')];
      console.log(`    [role="radio"] elements in DOM: ${radios.length}`);
      radios.slice(0, 6).forEach(r => console.log(`      aria-label="${r.getAttribute('aria-label')}" data-state="${r.getAttribute('data-state')}"`));

      // Check if iframe or foreign content appeared
      const iframes = document.querySelectorAll('iframe');
      console.log(`    <iframe> elements: ${iframes.length}`);

      results.push({ title, openerFound: true, panelFound: false, fiberContent: null, fiberLen: 0 });

      // Try Escape to clean up any partial state
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(500);
    }

    console.groupEnd();
    await delay(800);
  }

  // ════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  DOCUMENT ARTIFACT CAPTURE SUMMARY');
  console.log('════════════════════════════════════════════════════════════');
  console.table(results.map(r => ({
    Title: r.title?.slice(0, 35),
    'Opener found': r.openerFound,
    'Panel found': r.panelFound,
    'aria-label': r.panelHasAriaLabel ?? '-',
    'via selector': r.panelFoundViaSel ?? '-',
    'Code toggle': r.hasCodeToggle ?? '-',
    'Fiber len': r.fiberLen ?? 0,
    'Fiber preview': r.fiberContent?.slice(0, 40) ?? 'n/a',
  })));
  console.log('════════════════════════════════════════════════════════════');

  return results;
})();
