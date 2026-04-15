/**
 * Claude.ai Adapter
 * 
 * Captures conversations from claude.ai
 */

import { BaseAdapter, ParsedConversation, SidebarItem } from './interface';
import {
    MessageNode,
    ArtifactNode,
    DeepLink,
    Provenance,
    ContentBlock,
    createMessageNode,
    createCodeBlock,
    createHtmlBlock,
    createMarkdownBlock
} from '../../shared/schema';
import {
    getSelectorsForSite,
    queryWithFallbacks,
    queryAllWithFallbacks
} from '../../config/selectors';
import { captureEngine } from '../capture-engine';
import {
    DEFAULT_CLAUDE_CAPTURE_SETTINGS,
    normalizeProviderCaptureSettings,
    type ClaudeCaptureSettings,
    type ProviderCaptureSettings,
} from '../../shared/capture-settings';

type ClaudeArtifactProbeVersion = 'v1' | 'v2' | 'v3' | 'v4';
type ClaudeArtifactProbeStrategy = 'Fiber' | 'Copy' | 'Scrape';
type ClaudeArtifactProbeContentType = 'Code' | 'Doc';

interface ClaudeArtifactProbeResult {
    version: ClaudeArtifactProbeVersion;
    strategy: ClaudeArtifactProbeStrategy;
    sourceText: string;
    contentRoot?: Element;
}

const CLAUDE_ARTIFACT_COPY_EVENT = 'bonsai:claude-artifact-copy';

export class ClaudeAdapter extends BaseAdapter {
    readonly providerName = 'Anthropic';
    readonly providerSite = 'claude.ai';
    private claudeCaptureSettings: ClaudeCaptureSettings = { ...DEFAULT_CLAUDE_CAPTURE_SETTINGS };
    private warnedInvalidXPathExpressions = new Set<string>();

    setCaptureSettings(settings: ProviderCaptureSettings): void {
        this.claudeCaptureSettings = normalizeProviderCaptureSettings(settings).claude;
    }

    getArtifactCount(): number {
        const artifactIdentities = new Set<string>();

        this.listMessages().forEach((messageEl) => {
            this.getClaudeArtifactRefs(messageEl).forEach((candidate) => {
                const identity = this.getClaudeArtifactIdentity(candidate);
                if (identity) {
                    artifactIdentities.add(identity);
                }
            });
        });

        this.getClaudeArtifactPanelCandidates().forEach((candidate) => {
            const identity = this.getClaudeArtifactIdentity(candidate);
            if (identity) {
                artifactIdentities.add(identity);
            }
        });

        return artifactIdentities.size;
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    private getClaudeArtifactIdentity(candidate: Element | null): string | null {
        if (!candidate) {
            return null;
        }

        const explicitId = candidate.getAttribute('data-artifact-id')
            ?? candidate.querySelector('[data-artifact-id]')?.getAttribute('data-artifact-id');
        if (explicitId) {
            return explicitId;
        }

        const normalizedTitle = this.normalizeClaudeTitle(
            this.getClaudeArtifactPanelTitle(candidate)
            || this.getClaudeArtifactOpenerTitle(candidate)
            || candidate.getAttribute('title')
            || candidate.getAttribute('aria-label')
            || candidate.textContent
        );

        return normalizedTitle || null;
    }

    private isVisibleElement(el: Element): boolean {
        const node = el as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();

        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
    }

    private isClaudeArtifactNavigationLink(el: Element): boolean {
        const href = el.getAttribute('href')?.trim() ?? '';
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const label = (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

        return href.endsWith('/artifacts')
            || href === '/artifacts'
            || text === 'artifacts'
            || label === 'artifacts';
    }

    private getClaudeArtifactOpeners(root: ParentNode = document): HTMLElement[] {
        const selector = '[aria-label*="Open artifact"], [aria-label*="open artifact"], .artifact-block-cell[role="button"], .artifact-block-cell[aria-label], .artifact-block-cell [role="button"], .artifact-block-cell button, .artifact-block-cell div[aria-label]';
        const scopedCandidates = Array.from(root.querySelectorAll(selector))
            .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
        const selfCandidate = root instanceof Element && root.matches(selector) && root instanceof HTMLElement
            ? [root]
            : [];
        const candidates = [...selfCandidate, ...scopedCandidates]
            .filter((candidate, index, all) => all.indexOf(candidate) === index);

        return candidates.filter((candidate) => {
            if (!this.isVisibleElement(candidate) || this.isClaudeArtifactNavigationLink(candidate)) {
                return false;
            }

            const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`.replace(/\s+/g, ' ').trim();
            if (!/open artifact/i.test(label)) {
                return false;
            }

            // Claude artifacts live in div#main-content (NOT <main>), so requiring a <main>
            // ancestor always fails. Just verify the opener is not inside a nav/header/footer.
            const navContainer = candidate.closest('nav, aside, header, footer');
            return !navContainer;
        });
    }

    private getClaudeArtifactCardSelectors(): string {
        return [
            '[data-artifact]',
            '[data-artifact-id]',
            '[data-testid*="artifact"]',
            '[data-testid*="attachment"]',
            '[aria-label*="Open artifact"]',
            '[aria-label*="open artifact"]',
            '.artifact-card',
            '.artifact-preview',
            '.artifact-block-cell',
            '[class*="artifact-card"]',
            // NOTE: Do NOT add [class*="artifact-block"] here. Tailwind group modifier classes
            // like `group-hover/artifact-block:scale-[1.035]` contain "artifact-block" as a
            // substring and will falsely match thumbnail/animation divs *inside* the real card.
            // The most-specific filter then drops the real .artifact-block-cell because it
            // contains those matched thumbnails. Use .artifact-block-cell instead.
        ].join(', ');
    }

    private getClaudeArtifactScopeSelector(): string {
        return [
            this.getClaudeArtifactCardSelectors(),
            '[id*="wiggle-file-content"]',
            '[data-artifact-content]',
            '[aria-label^="Artifact panel"]',
            '[role="region"][aria-label*="Artifact"]',
            '[data-testid*="artifact-panel"]',
            '[data-testid*="artifact-view"]',
            '[class*="artifact-panel"]',
            '[class*="artifact-view"]',
            '[class*="artifact-editor"]',
        ].join(', ');
    }

    private isClaudeArtifactScopedElement(el: Element | null): boolean {
        if (!el) {
            return false;
        }

        return el.closest(this.getClaudeArtifactScopeSelector()) !== null;
    }

    private normalizeClaudeTitle(value: string | null | undefined): string {
        return this.cleanArtifactText(value ?? '')
            .replace(/\.?\s*open artifact\.?/gi, '')
            .trim()
            .toLowerCase();
    }

    private getClaudeTitleTokens(value: string | null | undefined): string[] {
        const ignoredTokens = new Set(['md', 'txt', 'pdf', 'doc']);

        return this.normalizeClaudeTitle(value)
            .replace(/[^a-z0-9]+/g, ' ')
            .split(/\s+/)
            .filter((token) => token.length > 1 && !ignoredTokens.has(token));
    }

    private claudeTitlesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
        const normalizedLeft = this.normalizeClaudeTitle(left);
        const normalizedRight = this.normalizeClaudeTitle(right);

        if (!normalizedLeft || !normalizedRight) {
            return false;
        }

        if (normalizedLeft === normalizedRight) {
            return true;
        }

        if (normalizedLeft.includes(normalizedRight)
            || normalizedRight.includes(normalizedLeft)) {
            // Substring match — accept only when the non-overlapping part is
            // noise (format indicators like " · md", "txt", etc.) rather than
            // meaningful new words.  Without this guard "Bonsai strategy" falsely
            // matches "Bonsai strategy supplement" and the wrong content gets captured.
            const [shorter, longer] = normalizedLeft.length <= normalizedRight.length
                ? [normalizedLeft, normalizedRight]
                : [normalizedRight, normalizedLeft];
            const remainder = longer.replace(shorter, '').trim();
            const noiseTokens = new Set([
                'md', 'txt', 'pdf', 'html', 'docx', 'csv', 'json', 'markdown',
                'tsx', 'jsx', 'ts', 'js', 'py', 'rs', 'go', 'rb', 'sh', 'yml', 'yaml', 'toml',
                'code', 'file', 'source', 'text', 'document', 'preview',
            ]);
            const significantTokens = remainder
                .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
                .filter((tok) => tok.length >= 3 && !noiseTokens.has(tok));
            if (significantTokens.length === 0) {
                return true;
            }
            // Has meaningful extra words — these are distinct artifacts, reject.
            return false;
        }

        const leftTokens = this.getClaudeTitleTokens(left);
        const rightTokens = this.getClaudeTitleTokens(right);
        if (!leftTokens.length || !rightTokens.length) {
            return false;
        }

        const [shorterTokens, longerTokens] = leftTokens.length <= rightTokens.length
            ? [leftTokens, rightTokens]
            : [rightTokens, leftTokens];
        const longerTokenSet = new Set(longerTokens);
        const overlap = shorterTokens.filter((token) => longerTokenSet.has(token)).length;
        const requiredOverlap = Math.max(2, Math.ceil(shorterTokens.length * 0.75));
        return overlap >= requiredOverlap;
    }

    private getClaudeReactFiberNode(el: Element): Record<string, unknown> | null {
        const fiberHost = el as unknown as Record<string, unknown>;
        const fiberKey = Object.keys(fiberHost).find(
            (candidate) => candidate.startsWith('__reactFiber') || candidate.startsWith('__reactInternalInstance')
        );

        return fiberKey ? (fiberHost[fiberKey] as Record<string, unknown>) : null;
    }

    private getClaudeArtifactProbeType(
        panelRoot: Element,
        options?: { fallbackTitle?: string; viewUrl?: string; sourceUrl?: string; typeHint?: 'code' | 'doc' | 'unknown' },
        sampleText?: string
    ): ClaudeArtifactProbeContentType {
        if (options?.typeHint === 'code') {
            return 'Code';
        }

        if (options?.typeHint === 'doc') {
            return 'Doc';
        }

        if (sampleText) {
            const inferredMimeType = this.inferClaudeArtifactMimeType(
                options?.fallbackTitle ?? (this.getClaudeArtifactPanelTitle(panelRoot) || 'Artifact'),
                sampleText,
                options?.sourceUrl ?? options?.viewUrl
            );
            return inferredMimeType === 'text/plain' ? 'Code' : 'Doc';
        }

        const descriptor = `${panelRoot.className || ''} ${panelRoot.getAttribute('data-testid') || ''}`.toLowerCase();
        return /code|source|editor|monaco|ace/.test(descriptor) ? 'Code' : 'Doc';
    }

    private logClaudeArtifactAttempt(
        version: ClaudeArtifactProbeVersion,
        title: string,
        contentType: ClaudeArtifactProbeContentType,
        strategy: ClaudeArtifactProbeStrategy
    ): void {
        console.log(`Bonsai [Claude-Artifact]: Attempting ${version} | Found: ${title || 'Artifact'} | Content Type: ${contentType} | Strategy: ${strategy}`);
    }

    private verifyClaudeArtifactTitleLock(panelRoot: Element, expectedTitle?: string): boolean {
        if (!expectedTitle) {
            return true;
        }

        const panelTitle = this.getClaudeArtifactPanelTitle(panelRoot);
        if (!panelTitle) {
            return false;
        }

        const n1 = this.normalizeClaudeTitle(panelTitle);
        const n2 = this.normalizeClaudeTitle(expectedTitle);

        if (n1 === n2) {
            return true;
        }

        // Accept substring matches where the non-overlapping part is only
        // formatting noise (e.g. "· MD", ".txt").  Do NOT fall through to the
        // 75% token-overlap heuristic used by claudeTitlesMatch — it is too
        // permissive here: "strategy" (4 tokens) would falsely match
        // "strategy supplement" (5 tokens) because all 4 tokens appear in the
        // longer set, causing the supplement artifact to be skipped.
        if (!n1.includes(n2) && !n2.includes(n1)) {
            return false;
        }

        const [shorter, longer] = n1.length <= n2.length ? [n1, n2] : [n2, n1];
        const remainder = longer.replace(shorter, '').trim();
        const noiseTokens = new Set([
            'md', 'txt', 'pdf', 'html', 'docx', 'csv', 'json', 'markdown',
            'tsx', 'jsx', 'ts', 'js', 'py', 'rs', 'go', 'rb', 'sh', 'yml', 'yaml', 'toml',
            'code', 'file', 'source', 'text', 'document', 'preview',
        ]);
        const significantTokens = remainder
            .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
            .filter((tok) => tok.length >= 3 && !noiseTokens.has(tok));
        return significantTokens.length === 0;
    }

    private getClaudeArtifactPanelSelectors(): string[] {
        return [
            // Claude panel aria-label is "Artifact panel: <title>" — use prefix match to avoid
            // matching the opener div ("<title>. Open artifact.").
            '[aria-label^="Artifact panel"]',
            '[role="region"][aria-label*="Artifact"]',
            '[data-testid*="artifact-panel"]',
            '[data-testid*="artifact-view"]',
            '[class*="artifact-panel"]',
            '[class*="artifact-view"]',
            '[class*="artifact-editor"]',
        ];
    }

    private getClaudeArtifactPanelContentSelectors(): string {
        return [
            '[id*="wiggle-file-content"]',
            '[data-artifact-content]',
            '[data-testid*="artifact-content"]',
            '.standard-markdown',
            '.progressive-markdown',
            '.markdown',
            'iframe[src]',
            'embed[src]',
            'object[data]',
            'svg',
            'canvas',
            this.getClaudeArtifactCodeContentSelectors(),
        ].join(', ');
    }

    private getClaudeArtifactPanelSeedSelectors(): string {
        return [
            '[id*="wiggle-file-content"]',
            '[data-artifact-content]',
            '[data-testid*="artifact-content"]',
            'iframe[src]',
            'embed[src]',
            'object[data]',
            '.standard-markdown',
            '.progressive-markdown',
        ].join(', ');
    }

    private getClaudeArtifactMessageSelectors(): string {
        return [
            '[data-testid="user-message"]',
            '.font-claude-response',
            '.font-user-message',
        ].join(', ');
    }

    private getClaudeArtifactCodeContentSelectors(): string {
        return [
            '[id*="wiggle"]',
            '[data-testid*="editor"]:not(button):not([role="radio"])',
            '[data-testid*="source"]:not(button):not([role="radio"])',
            '[data-testid*="code"]:not(button):not([role="radio"])',
            '.viewer-body',
            '[class*="overflow-y-scroll"]',
            'div[class*="font-mono"]',
            'div[class*="font-code"]',
            'div[class*="whitespace-pre"]',
        ].join(', ');
    }

    private getClaudeArtifactViewerRoot(seed: Element): Element | null {
        // Artifact card thumbnails contain their own Preview/Code segmented controls for
        // the mini inline preview. These are NOT open artifact panels — bail immediately
        // so we never walk up from a card toggle into a conversation message container.
        if (seed.closest(this.getClaudeArtifactCardSelectors())) {
            return null;
        }

        let current = seed.parentElement;

        while (current && current !== document.body) {
            if (!this.isVisibleElement(current)) {
                current = current.parentElement;
                continue;
            }

            const hasCodeToggle = current.querySelector('button[aria-label~="Code"], [role="radio"][aria-label~="Code"]') !== null;
            const hasContent = current.querySelector(
                `.standard-markdown, .progressive-markdown, .markdown, [data-artifact-content], [data-testid*="artifact-content"], iframe[src], embed[src], object[data], svg, canvas, ${this.getClaudeArtifactCodeContentSelectors()}`
            ) !== null;

            if (hasCodeToggle && hasContent) {
                // Toggle button groups (role="group" / the segmented control) contain SVG icons
                // that match our 'svg' content selector but are NOT actual artifact content.
                // Require meaningful text (> 50 chars collapsed) to distinguish the real panel
                // container from the button row that wraps the Preview/Code toggles.
                const hasSubstantialContent = (current.textContent?.replace(/\s+/g, '').length ?? 0) > 50;
                if (hasSubstantialContent) {
                    return current;
                }
            }

            current = current.parentElement;
        }

        return null;
    }

    private getClaudeArtifactContentViewerRoot(seed: Element): Element | null {
        const cardSelector = this.getClaudeArtifactCardSelectors();
        if (seed.closest(cardSelector)) {
            return null;
        }

        const isDedicatedContentRoot = seed.matches(
            '[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"], iframe[src], embed[src], object[data], svg, canvas'
        );

        if (seed.closest(this.getClaudeArtifactMessageSelectors()) && !isDedicatedContentRoot) {
            return null;
        }

        // For markdown section seeds (e.g. .standard-markdown), start the walk from
        // the parent element — document artifacts render as multiple sibling sections,
        // and returning a single section produces a content fragment instead of the
        // full panel.  Dedicated content roots (wiggle-file-content, iframes, etc.)
        // are fine as-is because they are single containers wrapping the whole artifact.
        let current: Element | null = (!isDedicatedContentRoot && seed.matches('.standard-markdown, .progressive-markdown, .markdown'))
            ? seed.parentElement
            : seed;
        let fallback: Element | null = null;
        const contentSelectors = this.getClaudeArtifactPanelContentSelectors();

        while (current && current !== document.body) {
            if (!this.isVisibleElement(current)) {
                current = current.parentElement;
                continue;
            }

            if (current.closest(cardSelector)) {
                return null;
            }

            const hasContent = current.matches(contentSelectors)
                || current.querySelector(contentSelectors) !== null;
            if (!hasContent) {
                current = current.parentElement;
                continue;
            }

            const text = this.cleanArtifactText(current.textContent?.replace(/\s+/g, ' ').trim() ?? '');
            const hasSubstantialContent = text.length > 80 || current.matches('[id*="wiggle-file-content"], iframe[src], embed[src], object[data], svg, canvas');
            if (!hasSubstantialContent) {
                current = current.parentElement;
                continue;
            }

            if (!fallback) {
                fallback = current;
            }

            const rect = current.getBoundingClientRect();
            const hasHeading = current.querySelector('[role="heading"], h1, h2, h3, h4, [data-testid*="title"], .artifact-title, [class*="artifact-title"]') !== null;
            const hasDismissControl = current.querySelector('button[aria-label*="Close"], button[aria-label*="Dismiss"], button[aria-label*="Exit"]') !== null;
            const looksPanelSized = rect.width >= 260 && rect.height >= 180;

            if (isDedicatedContentRoot || hasHeading || hasDismissControl || looksPanelSized) {
                return current;
            }

            current = current.parentElement;
        }

        return fallback;
    }

    private getClaudeArtifactPanelCandidates(): Element[] {
        const selectorCandidates = this.getClaudeArtifactPanelSelectors()
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)));
        const cardSelector = this.getClaudeArtifactCardSelectors();
        const viewerCandidates = Array.from(
            // Use word-boundary match (~=) so 'More options for Codebase...' buttons do NOT match
            document.querySelectorAll('button[aria-label~="Code"], [role="radio"][aria-label~="Code"]')
        ).flatMap((candidate) => {
            if (!(candidate instanceof Element)) {
                return [];
            }

            // Artifact card thumbnails expose their own Preview/Code toggles in the inline mini
            // preview. Skip any Code toggle that lives inside a card — those are thumbnails, not
            // open artifact panels. (getClaudeArtifactViewerRoot also guards this, but filtering
            // here avoids the entire upward DOM traversal for every card on the page.)
            if (candidate.closest(cardSelector)) {
                return [];
            }

            const viewerRoot = this.getClaudeArtifactViewerRoot(candidate);
            return viewerRoot ? [viewerRoot] : [];
        });

        const contentCandidates = Array.from(document.querySelectorAll(this.getClaudeArtifactPanelSeedSelectors()))
            .flatMap((candidate) => {
                if (!(candidate instanceof Element)) {
                    return [];
                }

                if (candidate.closest(cardSelector)) {
                    return [];
                }

                const viewerRoot = this.getClaudeArtifactContentViewerRoot(candidate);
                return viewerRoot ? [viewerRoot] : [];
            });

        const scoreCandidate = (candidate: Element): number => {
            const textLength = this.cleanArtifactText(candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '').length;
            const rect = candidate.getBoundingClientRect();

            let score = textLength;

            if (candidate.matches('[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"]')) {
                score += 5000;
            }
            if (candidate.querySelector('[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"]')) {
                score += 2500;
            }
            if (candidate.matches('.standard-markdown, .progressive-markdown, .markdown')) {
                score += 1500;
            }
            if (candidate.querySelector('[role="heading"], h1, h2, h3, h4, [data-testid*="title"], .artifact-title, [class*="artifact-title"]')) {
                score += 600;
            }
            if (candidate.querySelector('button[aria-label*="Close"], button[aria-label*="Dismiss"], button[aria-label*="Exit"]')) {
                score += 400;
            }
            if (candidate.querySelector('button[aria-label~="Code"], [role="radio"][aria-label~="Code"]')) {
                score += 300;
            }
            if (rect.width >= 260) {
                score += 100;
            }
            if (rect.height >= 180) {
                score += 100;
            }

            return score;
        };

        const canonicalCandidates: Element[] = [];

        [...selectorCandidates, ...viewerCandidates, ...contentCandidates]
            .filter((candidate): candidate is Element => candidate instanceof Element)
            .filter((candidate, index, all) => all.indexOf(candidate) === index)
            .filter((candidate) => {
                if (!this.isVisibleElement(candidate)) {
                    return false;
                }

                // Reject candidates that contain conversation messages — those are the entire
                // page root (e.g. <div id="root">), not the artifact panel.
                // NOTE: do NOT check for .font-claude-response here. Claude reuses that class
                // on document content inside #wiggle-file-content (the standard-markdown div
                // carries it), so the check would reject the artifact panel itself. The
                // [data-testid="user-message"] check is sufficient to reject overbroad roots.
                if (candidate.querySelector('[data-testid="user-message"]') !== null) {
                    return false;
                }

                const text = this.cleanArtifactText(candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '');
                return text.length > 40 || Boolean(candidate.querySelector(
                    `${this.getClaudeArtifactPanelContentSelectors()}, pre, code, button[aria-label~="Code"], [role="radio"][aria-label~="Code"]`
                ));
            })
            .map((candidate) => ({ candidate, score: scoreCandidate(candidate) }))
            .sort((left, right) => right.score - left.score)
            .forEach(({ candidate }) => {
                if (canonicalCandidates.some((existing) => existing.contains(candidate) || candidate.contains(existing))) {
                    return;
                }

                canonicalCandidates.push(candidate);
            });

        return canonicalCandidates;
    }

    private getClaudeArtifactOpenerTitle(opener: Element | null): string {
        if (!opener) {
            return '';
        }

        return this.cleanArtifactText(
            ((opener.getAttribute('aria-label') ?? opener.textContent ?? '')
                .replace(/\.\s*open artifact\.?/i, '')
                .replace(/\s+open artifact\.?/i, '')
                .trim())
        );
    }

    private getClaudeArtifactPanelTitle(panelRoot: Element | null): string {
        if (!panelRoot) {
            return '';
        }

        // Dedicated content roots (wiggle-file-content, data-artifact-content, etc.)
        // contain the artifact DOCUMENT's own headings (h1/h2/…) which are not the
        // panel title.  Skip internal heading search and walk ancestors, filtering
        // out any heading that lives inside the content root.
        const isDedicatedContentRoot = panelRoot.matches(
            '[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"]'
        );

        if (!isDedicatedContentRoot) {
            const directTitle = this.cleanArtifactText(
                panelRoot.querySelector('[role="heading"], h1, h2, h3, h4, strong')?.textContent?.trim()
                ?? panelRoot.getAttribute('aria-label')?.replace(/^artifact panel:\s*/i, '').trim()
                ?? ''
            );
            if (directTitle) {
                return directTitle;
            }
        }

        const headingSelector = isDedicatedContentRoot
            ? '[role="heading"], h1, h2, h3, h4, strong, [data-testid*="title"], .artifact-title, [class*="artifact-title"]'
            : '[role="heading"], h1, h2, h3, h4, [data-testid*="title"], .artifact-title, [class*="artifact-title"]';

        let current = panelRoot.parentElement;
        while (current && current !== document.body) {
            if (isDedicatedContentRoot) {
                // Find first heading that is NOT inside the content root.
                const heading = Array.from(current.querySelectorAll(headingSelector))
                    .find((el) => !panelRoot.contains(el));
                if (heading) {
                    const t = this.cleanArtifactText(heading.textContent?.trim() ?? '');
                    if (t) return t;
                }
            } else {
                const ancestorTitle = this.cleanArtifactText(
                    current.querySelector(headingSelector)?.textContent?.trim() ?? ''
                );
                if (ancestorTitle) {
                    return ancestorTitle;
                }
            }

            const ariaTitle = current.getAttribute('aria-label')?.replace(/^artifact panel:\s*/i, '').trim();
            if (ariaTitle) {
                return this.cleanArtifactText(ariaTitle);
            }

            current = current.parentElement;
        }

        return '';
    }

    private looksLikeClaudeArtifactRef(candidate: Element): boolean {
        if (candidate.matches(this.getClaudeArtifactCardSelectors())) {
            return true;
        }

        const label = `${candidate.getAttribute('aria-label') ?? ''} ${candidate.getAttribute('title') ?? ''} ${candidate.textContent ?? ''}`
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        const hasArtifactTitle = candidate.querySelector('.artifact-title, [data-testid="artifact-title"], h1, h2, h3, strong, [class*="title"], [class*="name"]') !== null;
        const hasArtifactOpener = /open artifact/i.test(label)
            || candidate.querySelector('[aria-label*="Open artifact"], [aria-label*="open artifact"]') !== null;
        const hasDownloadControl = /\bdownload\b/i.test(label)
            || candidate.querySelector('button[aria-label*="Download"], a[download], button[title*="Download"]') !== null;

        return hasArtifactTitle && (hasArtifactOpener || hasDownloadControl);
    }

    private getClaudeArtifactRefs(messageEl: Element): Element[] {
        const strictSelector = this.getClaudeArtifactCardSelectors();
        const candidates: Element[] = [];
        const addCandidate = (candidate: Element | null) => {
            if (!(candidate instanceof Element)) {
                return;
            }

            if (!this.looksLikeClaudeArtifactRef(candidate)) {
                return;
            }

            candidates.push(candidate);
        };

        if (messageEl.matches(strictSelector)) {
            addCandidate(messageEl);
        }

        Array.from(messageEl.querySelectorAll(strictSelector)).forEach((candidate) => addCandidate(candidate));

        // Artifact cards are always siblings/descendants of ASSISTANT messages, never of
        // user messages.  Skip the sibling scan entirely for user-message elements so we
        // don't accidentally collect cards that belong to the preceding or following turn.
        const isUserMessage = messageEl.matches('[data-testid="user-message"], .font-user-message')
            || messageEl.getAttribute('data-role') === 'user'
            || messageEl.getAttribute('data-message-role') === 'user';

        if (!isUserMessage) {
            // Scan siblings that appear AFTER messageEl in the parent container, stopping when
            // we reach the next message element (which belongs to a different turn).  This prevents
            // leaking artifact refs from other turns into the wrong parseArtifacts call when Claude
            // renders artifact cards as flat siblings of the assistant message element.
            const siblingContainer = messageEl.parentElement;
            if (siblingContainer) {
                const messageSelector = this.getClaudeArtifactMessageSelectors();
                let pastSelf = false;

                for (const child of Array.from(siblingContainer.children)) {
                    if (!(child instanceof Element)) continue;
                    if (child === messageEl) { pastSelf = true; continue; }
                    if (!pastSelf) continue; // only look at siblings AFTER messageEl

                    // Stop when we hit the start of the next conversation turn.
                    if (child.matches(messageSelector)) break;

                    if (child.matches(strictSelector)) {
                        addCandidate(child);
                    } else {
                        const nestedStrictMatches = Array.from(child.querySelectorAll(strictSelector));
                        if (nestedStrictMatches.length > 0) {
                            nestedStrictMatches.forEach((candidate) => addCandidate(candidate));
                        } else if (this.looksLikeClaudeArtifactRef(child)) {
                            addCandidate(child);
                        }
                    }
                }
            }
        }

        const deduped = candidates.filter((candidate, index, all) => all.indexOf(candidate) === index);

        // Prefer the most specific artifact node. Once we widened the search to sibling scopes,
        // keeping ancestors causes wrapper divs to win over the actual card/open-button node.
        return deduped.filter((candidate, _index, all) => !all.some((other) => other !== candidate && candidate.contains(other)));
    }

    private getClaudeArtifactPanelRoot(expectedTitle?: string, strictTitleMatch = false): Element | null {
        const candidates = this.getClaudeArtifactPanelCandidates();

        if (!expectedTitle) {
            return candidates[0] ?? null;
        }

        const matchingCandidate = candidates.find((candidate) => this.claudeTitlesMatch(this.getClaudeArtifactPanelTitle(candidate), expectedTitle));
        if (strictTitleMatch) {
            return matchingCandidate ?? null;
        }

        return matchingCandidate ?? candidates[0] ?? null;
    }

    private hasClaudeDedicatedArtifactContentRoot(panelRoot: Element): boolean {
        return panelRoot.matches('[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"]')
            || panelRoot.querySelector('[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"]') !== null;
    }

    private getClaudeConfiguredXPathExpression(): string {
        return this.claudeCaptureSettings.xPath.trim() || DEFAULT_CLAUDE_CAPTURE_SETTINGS.xPath;
    }

    private scoreClaudeConfiguredXPathRoot(panelRoot: Element, candidate: Element): number {
        let score = this.cleanArtifactText(this.getTextContentPreservingLines(candidate)).length;

        // Strong preference for dedicated document content containers — these are always
        // the authoritative source and should win over any generic div, even the panelRoot.
        if (candidate.matches('[id*="wiggle"], [data-artifact-content], [data-testid*="artifact-content"]')) {
            score += 5000;
        }
        // Prefer elements that are *inside* the panel over the panel container itself.
        // This prevents broad XPaths like //div from selecting the outermost layout div
        // (which includes UI chrome such as buttons) when a better inner element exists.
        if (panelRoot.contains(candidate) && candidate !== panelRoot) {
            score += 3000;
        }
        // Rendered markdown / code structure is a positive indicator of content quality.
        if (candidate.querySelector('.standard-markdown, .progressive-markdown, .markdown, pre, code')) {
            score += 400;
        }

        return score;
    }

    private getClaudeConfiguredXPathContentRoot(panelRoot: Element): Element | null {
        const expression = this.getClaudeConfiguredXPathExpression();
        const doc = panelRoot.ownerDocument ?? document;
        const evaluationContext: Node = expression.startsWith('.') ? panelRoot : doc;
        let snapshot: XPathResult;

        try {
            snapshot = doc.evaluate(expression, evaluationContext, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        } catch (error) {
            if (!this.warnedInvalidXPathExpressions.has(expression)) {
                this.warnedInvalidXPathExpressions.add(expression);
                console.warn('Bonsai [Claude-Artifact]: Invalid configured XPath', { expression, error });
            }
            return null;
        }

        const candidates: Element[] = [];
        for (let index = 0; index < snapshot.snapshotLength; index += 1) {
            const node = snapshot.snapshotItem(index);
            if (!(node instanceof Element) || !this.isVisibleElement(node)) {
                continue;
            }

            candidates.push(node);
        }

        // Allow panelRoot itself and its descendants. Reject ancestors so a broad
        // XPath like //div cannot return a container that wraps the entire page.
        const relevantCandidates = candidates.filter(
            (candidate) => candidate === panelRoot || panelRoot.contains(candidate),
        );

        relevantCandidates.sort((left, right) => this.scoreClaudeConfiguredXPathRoot(panelRoot, right) - this.scoreClaudeConfiguredXPathRoot(panelRoot, left));

        console.log('Bonsai [Claude-XPath]: XPath evaluation', {
            expression,
            totalMatches: snapshot.snapshotLength,
            visibleMatches: candidates.length,
            relevantMatches: relevantCandidates.length,
            panelRootTag: panelRoot.tagName,
            panelRootId: panelRoot.id,
            panelRootClass: panelRoot.className.slice(0, 60),
            winner: relevantCandidates[0]
                ? `${relevantCandidates[0].tagName}#${relevantCandidates[0].id} class="${relevantCandidates[0].className.slice(0,40)}" textLen=${relevantCandidates[0].textContent?.length}`
                : 'null',
            top3Scores: relevantCandidates.slice(0, 3).map(c => ({
                el: `${c.tagName}#${c.id} .${c.className.slice(0,30)}`,
                score: this.scoreClaudeConfiguredXPathRoot(panelRoot, c),
                textLen: c.textContent?.length,
            })),
        });

        return relevantCandidates[0] ?? null;
    }

    private shouldClaudeProbeDocumentSource(panelRoot: Element, contentRoot: Element | null): boolean {
        if (this.getClaudeArtifactContentFromFiber(panelRoot)) {
            return true;
        }

        if (!contentRoot) {
            return true;
        }

        if (contentRoot.matches('[id*="wiggle"], [data-artifact-content], [data-testid*="artifact-content"]')) {
            // Skip probing only when the dedicated content root has accessible text.
            // When it's a code editor (Monaco, virtualized list) textContent is empty —
            // in that case we must probe (clipboard / force-toggle) to get the source.
            const accessibleText = this.cleanArtifactText(this.getTextContentPreservingLines(contentRoot));
            const hasStructured = contentRoot.querySelector('.standard-markdown, .progressive-markdown, .markdown, pre, code') !== null;
            if (accessibleText.length >= 80 || hasStructured) {
                return false;
            }
            // Fall through — probe to extract inaccessible content.
        }

        const previewText = this.cleanArtifactText(
            this.getTextContentPreservingLines(contentRoot)
                .replace(/\n{3,}/g, '\n\n')
                .trim()
        );
        const hasHeading = contentRoot.querySelector('h1, h2, h3, [role="heading"], strong') !== null;
        const markdownSectionCount = contentRoot.querySelectorAll('.standard-markdown, .progressive-markdown, .markdown').length;

        if (previewText.length >= 160) {
            return false;
        }

        if ((hasHeading || markdownSectionCount > 1) && previewText.length >= 80) {
            return false;
        }

        return this.getClaudeArtifactCodeToggle(panelRoot) !== null
            || this.getClaudeArtifactCopyButton(panelRoot) !== null;
    }

    private async waitForClaudeConfiguredXPathContentRoot(panelRoot: Element, timeoutMs = 450): Promise<Element | null> {
        const resolveCurrent = (): Element | null => {
            const configuredRoot = this.getClaudeConfiguredXPathContentRoot(panelRoot);
            if (!configuredRoot) {
                return null;
            }

            const isDedicatedRoot = configuredRoot.matches('[id*="wiggle"], [data-artifact-content], [data-testid*="artifact-content"]');
            const textLength = this.cleanArtifactText(this.getTextContentPreservingLines(configuredRoot)).length;
            const hasStructuredContent = configuredRoot.querySelector('.standard-markdown, .progressive-markdown, .markdown, pre, code') !== null;
            // Dedicated roots (wiggle-file-content, etc.) are the authoritative target;
            // accept them at a lower threshold (30 chars) since we know they're correct.
            // Non-dedicated roots require 80 chars or explicit structured markup to avoid
            // capturing navigation chrome, empty shells, or loading states.
            const threshold = isDedicatedRoot ? 30 : 80;
            return (textLength >= threshold || hasStructuredContent) ? configuredRoot : null;
        };

        const immediate = resolveCurrent();
        if (immediate) {
            return immediate;
        }

        return new Promise((resolve) => {
            let settled = false;

            const finish = (result: Element | null) => {
                if (settled) {
                    return;
                }

                settled = true;
                observer.disconnect();
                clearInterval(pollInterval);
                clearTimeout(timeoutHandle);
                resolve(result);
            };

            const observer = new MutationObserver(() => {
                if (!panelRoot.isConnected) {
                    finish(null);
                    return;
                }

                const current = resolveCurrent();
                if (current) {
                    finish(current);
                }
            });
            observer.observe(panelRoot, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });

            const pollInterval = window.setInterval(() => {
                if (!panelRoot.isConnected) {
                    finish(null);
                    return;
                }

                const current = resolveCurrent();
                if (current) {
                    finish(current);
                }
            }, 120);

            const timeoutHandle = window.setTimeout(() => finish(null), timeoutMs);
        });
    }

    private getClaudeArtifactWiggleContentRoot(panelRoot: Element): Element | null {
        return (panelRoot.matches('[id*="wiggle"]')
            ? panelRoot
            : panelRoot.querySelector('[id*="wiggle"]')) as Element | null;
    }

    private async waitForClaudeArtifactWiggleContentRoot(panelRoot: Element, timeoutMs = 1800): Promise<Element | null> {
        const resolveCurrent = (): Element | null => {
            const wiggleRoot = this.getClaudeArtifactWiggleContentRoot(panelRoot);
            if (!wiggleRoot || !this.isVisibleElement(wiggleRoot)) {
                return null;
            }

            const textLength = this.cleanArtifactText(this.getTextContentPreservingLines(wiggleRoot)).length;
            const hasStructuredContent = wiggleRoot.querySelector('.standard-markdown, .progressive-markdown, .markdown, pre, code') !== null;
            return (textLength >= 80 || hasStructuredContent) ? wiggleRoot : null;
        };

        const immediate = resolveCurrent();
        if (immediate) {
            return immediate;
        }

        return new Promise((resolve) => {
            let settled = false;

            const finish = (result: Element | null) => {
                if (settled) {
                    return;
                }

                settled = true;
                observer.disconnect();
                clearInterval(pollInterval);
                clearTimeout(timeoutHandle);
                resolve(result);
            };

            const observer = new MutationObserver(() => {
                if (!panelRoot.isConnected) {
                    finish(null);
                    return;
                }

                const current = resolveCurrent();
                if (current) {
                    finish(current);
                }
            });
            observer.observe(panelRoot, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });

            const pollInterval = window.setInterval(() => {
                if (!panelRoot.isConnected) {
                    finish(null);
                    return;
                }

                const current = resolveCurrent();
                if (current) {
                    finish(current);
                }
            }, 120);

            const timeoutHandle = window.setTimeout(() => finish(null), timeoutMs);
        });
    }

    private getClaudeArtifactCloseButton(panelRoot: Element): HTMLElement | null {
        const panelContainer = panelRoot.closest('[role="dialog"], [aria-modal="true"], body') ?? document.body;
        const candidates = Array.from(panelContainer.querySelectorAll('button, [role="button"], a'))
            .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);

        return candidates.find((candidate) => {
            if (!this.isVisibleElement(candidate)) {
                return false;
            }

            const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`.replace(/\s+/g, ' ').trim();
            return /\b(close|dismiss|exit)\b/i.test(label);
        }) ?? null;
    }

    private async closeClaudeArtifactPanel(panelRoot: Element | null): Promise<boolean> {
        if (!panelRoot) {
            return true;
        }

        const closeButton = this.getClaudeArtifactCloseButton(panelRoot);
        if (closeButton) {
            closeButton.click();
        } else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
        }

        for (let attempt = 0; attempt < 12; attempt += 1) {
            if (!panelRoot.isConnected || !this.isVisibleElement(panelRoot)) {
                return true;
            }

            await this.delay(120);
        }

        return !panelRoot.isConnected || !this.isVisibleElement(panelRoot);
    }

    private getClaudeArtifactCodeToggle(panelRoot: Element): HTMLElement | null {
        return Array.from(panelRoot.querySelectorAll('button[aria-label="Code"], [role="radio"][aria-label="Code"], button[aria-label*="Code"], [role="radio"][aria-label*="Code"]'))
            .find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement && this.isVisibleElement(candidate)) ?? null;
    }

    private normalizeClaudeCodeLine(text: string): string {
        return text
            .replace(/\u00a0/g, ' ')
            .replace(/\u200b/g, '')
            .replace(/\r/g, '');
    }

    private getClaudeArtifactGroupedCodeNodes(root: Element): HTMLElement[] {
        return Array.from(root.querySelectorAll('code'))
            .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement)
            .filter((candidate) => !candidate.closest('button, [role="button"]'));
    }

    private isClaudeArtifactCodeViewActive(panelRoot: Element): boolean {
        const codeToggle = this.getClaudeArtifactCodeToggle(panelRoot);
        if (codeToggle) {
            const state = (codeToggle.getAttribute('data-state') ?? '').toLowerCase();
            // "on"/"active" — explicitly selected → code view is active.
            if (state === 'on' || state === 'active') return true;
            // "off" — explicitly deselected → do NOT rely on content heuristics.
            // The preview (standard-markdown) may contain <code> spans from inline backtick
            // formatting that would otherwise cause the fallback to return true incorrectly.
            if (state === 'off') return false;

            if (codeToggle.getAttribute('aria-checked') === 'true') return true;
            // Explicit "false" takes precedence over content-based fallback for the same reason.
            if (codeToggle.getAttribute('aria-checked') === 'false') return false;

            if (codeToggle.getAttribute('aria-selected') === 'true') return true;
            if (codeToggle.getAttribute('aria-selected') === 'false') return false;

            if (codeToggle.getAttribute('aria-pressed') === 'true') return true;
            if (codeToggle.getAttribute('aria-pressed') === 'false') return false;

            if (codeToggle.getAttribute('data-active') === 'true') return true;
            if (codeToggle.getAttribute('data-active') === 'false') return false;
        }

        // No toggle found — fall back to content heuristics only.
        // (Never reaches here when both data-state and aria-checked are present.)
        return Array.from(panelRoot.querySelectorAll('pre code[class*="language-"], code[class*="language-"]'))
            .some((el): boolean => el instanceof HTMLElement && this.isVisibleElement(el))
            || (Boolean(codeToggle) && this.getClaudeArtifactGroupedCodeNodes(panelRoot).length > 1);
    }

    private getClaudeArtifactPreviewContentRoot(panelRoot: Element): Element {
        const explicitContentRoot = (panelRoot.matches('[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"]')
            ? panelRoot
            : panelRoot.querySelector('[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"]')) as Element | null;
        if (explicitContentRoot && this.isVisibleElement(explicitContentRoot)) {
            return explicitContentRoot;
        }

        // Claude renders each paragraph/section of a document artifact as a separate
        // .standard-markdown element. querySelector returns only the FIRST one, giving
        // partial content. When multiple sections exist, walk up to find the nearest
        // ancestor that contains ALL of them so downstream sanitization captures the
        // full document rather than just the opening snippet.
        const allMarkdownSections = Array.from(
            panelRoot.querySelectorAll('.standard-markdown, .progressive-markdown')
        );
        if (allMarkdownSections.length > 1) {
            let ancestor = allMarkdownSections[0].parentElement;
            while (ancestor && ancestor !== document.body) {
                if (allMarkdownSections.every((s) => ancestor!.contains(s))) {
                    return ancestor as Element;
                }
                ancestor = ancestor.parentElement;
            }
        }

        return (panelRoot.querySelector(
            '.standard-markdown, .progressive-markdown, .markdown, [data-artifact-content], [data-testid*="artifact-content"], iframe[src], embed[src], object[data], svg, canvas'
        ) ?? panelRoot) as Element;
    }

    private getClaudeArtifactCodeContentRoot(panelRoot: Element): Element {
        const codeRootSelectors = this.getClaudeArtifactCodeContentSelectors();

        // Prefer an explicit language-tagged code block — its nearest code container is the true source root.
        const langCode = Array.from(panelRoot.querySelectorAll('code[class*="language-"]'))
            .find((el): el is HTMLElement => el instanceof HTMLElement);
        if (langCode) {
            return (langCode.closest(codeRootSelectors) ?? langCode.closest('pre') ?? langCode) as Element;
        }

        const groupedContainerCandidates = [
            ...(panelRoot.matches(codeRootSelectors) ? [panelRoot] : []),
            ...Array.from(panelRoot.querySelectorAll(codeRootSelectors)),
        ].filter((candidate, index, all): candidate is Element => {
            if (!(candidate instanceof Element) || all.indexOf(candidate) !== index) {
                return false;
            }

            if (!this.isVisibleElement(candidate)) {
                return false;
            }

            const codeNodeCount = this.getClaudeArtifactGroupedCodeNodes(candidate).length;
            const className = typeof candidate.className === 'string' ? candidate.className : '';
            return codeNodeCount > 1 || /wiggle|viewer-body|overflow-y-scroll|font-mono|font-code|whitespace-pre/i.test(`${candidate.id} ${className}`);
        }).sort((left, right) => {
            const codeCountDelta = this.getClaudeArtifactGroupedCodeNodes(right).length - this.getClaudeArtifactGroupedCodeNodes(left).length;
            if (codeCountDelta !== 0) {
                return codeCountDelta;
            }

            return (right.textContent?.length ?? 0) - (left.textContent?.length ?? 0);
        });

        if (groupedContainerCandidates.length > 0) {
            return groupedContainerCandidates[0];
        }

        return (panelRoot.querySelector(
            codeRootSelectors
        )
            ?? panelRoot.querySelector('pre, code')
            ?? panelRoot) as Element;
    }

    private getClaudeArtifactHiddenDomRoots(panelRoot: Element): Element[] {
        const scoreCandidate = (candidate: Element): number => {
            let score = candidate.textContent?.length ?? 0;

            if (candidate.matches('[id*="wiggle-file-content"]')) {
                score += 5000;
            }
            if (candidate.matches('.viewer-body')) {
                score += 2500;
            }
            if (candidate.querySelector('pre, code, div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"]')) {
                score += 800;
            }

            return score;
        };

        return [
            ...(panelRoot.matches('[id*="wiggle-file-content"], .viewer-body, [data-artifact-content], [data-testid*="artifact-content"]') ? [panelRoot] : []),
            ...Array.from(panelRoot.querySelectorAll(
                '[id*="wiggle-file-content"], .viewer-body, [data-artifact-content], [data-testid*="artifact-content"], pre, code, div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"]'
            )),
        ]
            .filter((candidate, index, all): candidate is Element => candidate instanceof Element && all.indexOf(candidate) === index)
            .filter((candidate) => !candidate.closest('button, [role="button"]'))
            .sort((left, right) => scoreCandidate(right) - scoreCandidate(left));
    }

    private captureClaudeArtifactViaHiddenDom(panelRoot: Element): { sourceText: string; contentRoot: Element } | null {
        const hiddenDomRoots = this.getClaudeArtifactHiddenDomRoots(panelRoot);

        for (const candidate of hiddenDomRoots) {
            const hasCodeLikeContent = candidate.matches(
                'pre, code, div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"]'
            ) || candidate.querySelector('pre, code, div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"]') !== null;

            if (!hasCodeLikeContent) {
                continue;
            }

            const extractedCode = this.extractClaudeCodeArtifact(candidate);
            const sourceText = extractedCode?.code ?? this.normalizeClaudeCodeText(this.getTextContentPreservingLines(candidate), true);

            if (!sourceText || sourceText === '</>' || this.isNoiseOnlyArtifactText(sourceText) || sourceText.trim().length < 12) {
                continue;
            }

            return {
                sourceText,
                contentRoot: candidate,
            };
        }

        return null;
    }

    private dispatchPointerClickSequence(el: HTMLElement): void {
        const opts: MouseEventInit = { bubbles: true, cancelable: true };
        const pointerOpts: PointerEventInit = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
    }

    private invokeClaudeToggleFiberHandler(codeToggle: HTMLElement): boolean {
        let currentFiber: Record<string, unknown> | null = this.getClaudeReactFiberNode(codeToggle)
            ?? (codeToggle.parentElement ? this.getClaudeReactFiberNode(codeToggle.parentElement) : null);

        for (let depth = 0; currentFiber && depth < 60; depth += 1) {
            const props = (currentFiber['memoizedProps'] ?? currentFiber['pendingProps'] ?? {}) as Record<string, unknown>;

            if (typeof props['onValueChange'] === 'function') {
                (props['onValueChange'] as (value: string) => void)('raw');
                return true;
            }

            if (typeof props['onCheckedChange'] === 'function') {
                (props['onCheckedChange'] as (value: boolean) => void)(true);
                return true;
            }

            if (typeof props['onClick'] === 'function') {
                (props['onClick'] as (event: Record<string, unknown>) => void)({
                    type: 'click',
                    target: codeToggle,
                    currentTarget: codeToggle,
                    bubbles: true,
                    nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
                    stopPropagation() { },
                    preventDefault() { },
                });
                return true;
            }

            const parentFiber = currentFiber['return'];
            currentFiber = parentFiber && typeof parentFiber === 'object'
                ? parentFiber as Record<string, unknown>
                : null;
        }

        return false;
    }

    private dispatchClaudeKeyboardToggle(codeToggle: HTMLElement): void {
        codeToggle.focus();
        const keyboardOptions: KeyboardEventInit = {
            key: ' ',
            code: 'Space',
            keyCode: 32,
            bubbles: true,
            cancelable: true,
        };

        codeToggle.dispatchEvent(new KeyboardEvent('keydown', keyboardOptions));
        codeToggle.dispatchEvent(new KeyboardEvent('keyup', keyboardOptions));
    }

    private async waitForClaudeForcedSource(panelRoot: Element, timeoutMs = 900): Promise<{ sourceText: string; contentRoot: Element } | null> {
        const resolveSource = (): { sourceText: string; contentRoot: Element } | null => {
            const hiddenDomSource = this.captureClaudeArtifactViaHiddenDom(panelRoot);
            if (hiddenDomSource) {
                return hiddenDomSource;
            }

            if (!this.isClaudeArtifactCodeViewActive(panelRoot)) {
                return null;
            }

            const codeRoot = this.getClaudeArtifactCodeContentRoot(panelRoot);
            const extractedCode = this.extractClaudeCodeArtifact(codeRoot);
            const sourceText = extractedCode?.code ?? this.normalizeClaudeCodeText(this.getTextContentPreservingLines(codeRoot), true);

            if (!sourceText || sourceText === '</>' || this.isNoiseOnlyArtifactText(sourceText)) {
                return null;
            }

            return {
                sourceText,
                contentRoot: codeRoot,
            };
        };

        const immediate = resolveSource();
        if (immediate) {
            return immediate;
        }

        return new Promise((resolve) => {
            let settled = false;
            const observationRoot = panelRoot.isConnected ? panelRoot : document.body;

            const finish = (result: { sourceText: string; contentRoot: Element } | null) => {
                if (settled) {
                    return;
                }

                settled = true;
                observer.disconnect();
                clearInterval(pollInterval);
                clearTimeout(timeoutTimer);
                resolve(result);
            };

            const observer = new MutationObserver(() => {
                if (!panelRoot.isConnected) {
                    finish(null);
                    return;
                }

                const result = resolveSource();
                if (result) {
                    finish(result);
                }
            });
            observer.observe(observationRoot, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });

            const pollInterval = window.setInterval(() => {
                if (!panelRoot.isConnected) {
                    finish(null);
                    return;
                }

                const result = resolveSource();
                if (result) {
                    finish(result);
                }
            }, 150);

            const timeoutTimer = window.setTimeout(() => finish(null), timeoutMs);
        });
    }

    private async switchClaudeArtifactToCodeView(panelRoot: Element): Promise<boolean> {
        const codeToggle = this.getClaudeArtifactCodeToggle(panelRoot);
        if (!codeToggle) {
            return false;
        }

        if (await this.waitForClaudeForcedSource(panelRoot, 200)) {
            return true;
        }

        const toggleStrategies = [
            () => this.dispatchPointerClickSequence(codeToggle),
            () => this.invokeClaudeToggleFiberHandler(codeToggle),
            () => this.dispatchClaudeKeyboardToggle(codeToggle),
            () => codeToggle.click(),
        ];

        for (const toggleStrategy of toggleStrategies) {
            toggleStrategy();

            if (await this.waitForClaudeForcedSource(panelRoot, 900)) {
                return true;
            }

            if (!panelRoot.isConnected || !this.isVisibleElement(panelRoot)) {
                return false;
            }
        }

        return this.isClaudeArtifactCodeViewActive(panelRoot);
    }

    private inferClaudeArtifactMimeType(title: string, content: string, sourceUrl?: string): string {
        const normalizedTitle = title.toLowerCase();
        const normalizedContent = content.trim();
        const normalizedSourceUrl = (sourceUrl ?? '').toLowerCase();

        if (/\.(md|markdown)(?:$|[?#])/.test(normalizedSourceUrl)
            || /(^|\n)\s{0,3}(#|[-*+] |\d+\. )/m.test(normalizedContent)
            || /[·•|-]\s*md\b/i.test(normalizedTitle)) {
            return 'text/markdown';
        }

        if (/\.(html?)(?:$|[?#])/.test(normalizedSourceUrl)
            || /^\s*<(?:!doctype|html|body|main|article|section|div|p|h1|h2|h3)\b/i.test(normalizedContent)) {
            return 'text/html';
        }

        if (/\.(json)(?:$|[?#])/.test(normalizedSourceUrl) || /^\s*[\[{]/.test(normalizedContent)) {
            return 'application/json';
        }

        return 'text/plain';
    }

    private async captureClaudeRemoteDocumentArtifact(options: {
        artifactId: string;
        title: string;
        viewUrl?: string;
        sourceUrl?: string;
    }): Promise<ArtifactNode | null> {
        const candidateUrls = Array.from(new Set([
            options.sourceUrl,
            options.viewUrl,
        ].filter((url): url is string => Boolean(url))));

        for (const candidateUrl of candidateUrls) {
            const fetched = await this.fetchRemoteResource(candidateUrl);
            if (!fetched?.ok || !fetched.text) {
                continue;
            }

            const finalUrl = fetched.finalUrl || candidateUrl;
            const contentType = (fetched.contentType ?? '').split(';')[0].trim().toLowerCase();
            const parsedDocument = this.extractFetchedDocumentContent(fetched.text, finalUrl);

            let content = parsedDocument?.html ?? parsedDocument?.text ?? '';
            let mimeType = parsedDocument?.html
                ? 'text/html'
                : (contentType || this.inferClaudeArtifactMimeType(options.title, parsedDocument?.text ?? fetched.text, finalUrl));
            let title = parsedDocument?.title ?? options.title;

            if (!content) {
                const plainText = this.cleanArtifactText(fetched.text);
                if (!plainText || this.isNoiseOnlyArtifactText(plainText)) {
                    continue;
                }

                content = plainText;
                mimeType = contentType || this.inferClaudeArtifactMimeType(title, plainText, finalUrl);
            }

            return {
                artifact_id: options.artifactId,
                type: 'artifact_doc',
                title,
                content,
                source_message_id: '',
                source_url: options.sourceUrl ?? finalUrl,
                view_url: options.viewUrl ?? finalUrl,
                exportable: true,
                mime_type: mimeType,
            };
        }

        return null;
    }

    private async installClaudeClipboardInterceptor(): Promise<boolean> {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
            return false;
        }

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'INSTALL_CLAUDE_CLIPBOARD_INTERCEPTOR',
                eventName: CLAUDE_ARTIFACT_COPY_EVENT,
            });

            return Boolean(response && typeof response === 'object' && 'success' in response && response.success);
        } catch {
            return false;
        }
    }

    private waitForClaudeClipboardCapture(timeoutMs = 1500): Promise<string | null> {
        return new Promise((resolve) => {
            let settled = false;

            const finish = (value: string | null) => {
                if (settled) {
                    return;
                }

                settled = true;
                window.removeEventListener(CLAUDE_ARTIFACT_COPY_EVENT, handleCapture as EventListener);
                clearTimeout(timeoutHandle);
                resolve(value);
            };

            const handleCapture = (event: Event) => {
                const detail = (event as CustomEvent<string>).detail;
                finish(typeof detail === 'string' ? detail : null);
            };

            const timeoutHandle = window.setTimeout(() => finish(null), timeoutMs);
            window.addEventListener(CLAUDE_ARTIFACT_COPY_EVENT, handleCapture as EventListener, { once: true });
        });
    }

    private getClaudeArtifactCopyButton(panelRoot: Element): HTMLElement | null {
        return Array.from(panelRoot.querySelectorAll('button, [role="button"]'))
            .filter((btn): btn is HTMLElement => btn instanceof HTMLElement && this.isVisibleElement(btn))
            .find((btn) => {
                const label = `${btn.getAttribute('aria-label') ?? ''} ${btn.textContent ?? ''}`.trim().toLowerCase();
                return /\bcopy\b/.test(label) && !/close|dismiss|cancel|download/.test(label);
            }) ?? null;
    }

    /**
     * Click the panel's Copy button and read the raw artifact source from the clipboard.
     *
     * This is the most reliable way to capture document artifact content when:
     *   - React fiber extraction returns null (content prop not found within node budget), AND
     *   - Radix UI blocks the synthetic Code-view toggle click (isTrusted=false).
     *
     * The Copy button copies the raw source (markdown, code, etc.) regardless of which
     * view tab is currently active, bypassing both of those limitations. It requires the
     * `clipboardRead` extension permission (already present in manifest.json).
     */
    private async captureClaudeArtifactViaClipboard(panelRoot: Element): Promise<string | null> {
        const copyButton = this.getClaudeArtifactCopyButton(panelRoot);
        if (!copyButton) {
            return null;
        }

        await this.installClaudeClipboardInterceptor();
        const interceptedTextPromise = this.waitForClaudeClipboardCapture();
        copyButton.click();

        const interceptedText = await interceptedTextPromise;
        if (interceptedText && !this.isNoiseOnlyArtifactText(interceptedText)) {
            return interceptedText;
        }

        // Allow the page's async navigator.clipboard.writeText() call to complete.
        await this.delay(250);

        try {
            const text = await navigator.clipboard.readText();
            if (text && !this.isNoiseOnlyArtifactText(text)) {
                return text;
            }
        } catch {
            // clipboard-read permission not available or document not focused — non-fatal.
        }

        return null;
    }

    private async captureClaudeArtifactViaForceToggle(panelRoot: Element): Promise<{ sourceText: string; contentRoot: Element } | null> {
        const codeToggle = this.getClaudeArtifactCodeToggle(panelRoot);
        if (!codeToggle) {
            return null;
        }

        const switched = await this.switchClaudeArtifactToCodeView(panelRoot);
        if (!switched) {
            return null;
        }

        return this.waitForClaudeForcedSource(panelRoot, 300);
    }

    private async runClaudeArtifactProbeSequence(
        panelRoot: Element,
        options?: { fallbackTitle?: string; viewUrl?: string; sourceUrl?: string; typeHint?: 'code' | 'doc' | 'unknown' }
    ): Promise<ClaudeArtifactProbeResult | null> {
        const title = this.cleanArtifactText(
            this.getClaudeArtifactPanelTitle(panelRoot)
            || options?.fallbackTitle
            || 'Artifact'
        ) || options?.fallbackTitle || 'Artifact';
        const contentType = this.getClaudeArtifactProbeType(panelRoot, options);

        this.logClaudeArtifactAttempt('v1', title, contentType, 'Fiber');
        const fiberContent = this.getClaudeArtifactContentFromFiber(panelRoot);
        if (fiberContent) {
            return {
                version: 'v1',
                strategy: 'Fiber',
                sourceText: fiberContent,
            };
        }

        this.logClaudeArtifactAttempt('v2', title, contentType, 'Copy');
        const copiedContent = await this.captureClaudeArtifactViaClipboard(panelRoot);
        if (copiedContent) {
            return {
                version: 'v2',
                strategy: 'Copy',
                sourceText: copiedContent,
            };
        }

        this.logClaudeArtifactAttempt('v3', title, contentType, 'Scrape');
        const hiddenDomContent = this.captureClaudeArtifactViaHiddenDom(panelRoot);
        if (hiddenDomContent) {
            return {
                version: 'v3',
                strategy: 'Scrape',
                sourceText: hiddenDomContent.sourceText,
                contentRoot: hiddenDomContent.contentRoot,
            };
        }

        this.logClaudeArtifactAttempt('v4', title, contentType, 'Scrape');
        const forcedToggleContent = await this.captureClaudeArtifactViaForceToggle(panelRoot);
        if (forcedToggleContent) {
            return {
                version: 'v4',
                strategy: 'Scrape',
                sourceText: forcedToggleContent.sourceText,
                contentRoot: forcedToggleContent.contentRoot,
            };
        }

        return null;
    }

    private async captureClaudePanelArtifact(
        panelRoot: Element,
        options?: { artifactId?: string; fallbackTitle?: string; viewUrl?: string; sourceUrl?: string; typeHint?: 'code' | 'doc' | 'unknown' }
    ): Promise<ArtifactNode | null> {
        const panelTitle = this.getClaudeArtifactPanelTitle(panelRoot);
        const hasDedicatedContentRoot = this.hasClaudeDedicatedArtifactContentRoot(panelRoot);
        const title = this.cleanArtifactText(
            panelTitle
            || options?.fallbackTitle
            || 'Artifact'
        ) || options?.fallbackTitle || 'Artifact';

        if (options?.fallbackTitle && panelTitle && !this.claudeTitlesMatch(panelTitle, options.fallbackTitle)) {
            return null;
        }

        if (options?.fallbackTitle && !panelTitle && !hasDedicatedContentRoot) {
            return null;
        }

        // Be deliberately conservative here. Larger / denser Claude artifacts appear to
        // hydrate their DOM content later than smaller ones, so use a doubled wait budget.
        const configuredXPathWaitMs = Math.max(600, this.claudeCaptureSettings.panelCaptureDelayMs * 2);

        console.log('Bonsai [Claude-Artifact]: captureClaudePanelArtifact entry', {
            title,
            typeHint: options?.typeHint,
            panelRootTag: panelRoot.tagName,
            panelRootId: panelRoot.id,
            panelRootClass: panelRoot.className.slice(0, 80),
            panelRootTextLen: panelRoot.textContent?.length,
            xPath: this.claudeCaptureSettings.xPath,
        });

        // Always attempt XPath first — the panel XPath setting is the primary content
        // source for all artifact types, including panels opened without a typeHint
        // (e.g. from parseVisibleArtifacts).  If the XPath resolves we use that element
        // regardless of typeHint.  If it does not resolve:
        //   • typeHint === 'doc' → bail (strict; XPath must succeed or we return null)
        //   • everything else   → fall through to the probe sequence
        const configuredXPathContentRoot = await this.waitForClaudeConfiguredXPathContentRoot(panelRoot, configuredXPathWaitMs);

        console.log('Bonsai [Claude-Artifact]: XPath result', {
            configuredXPathContentRoot: configuredXPathContentRoot
                ? `${configuredXPathContentRoot.tagName}#${configuredXPathContentRoot.id} textLen=${configuredXPathContentRoot.textContent?.length}`
                : 'null',
            typeHint: options?.typeHint,
            willBail: !configuredXPathContentRoot && options?.typeHint === 'doc',
            willProbe: !configuredXPathContentRoot && options?.typeHint !== 'doc',
        });

        // ── XPath fast path ───────────────────────────────────────────────────
        // When XPath resolves, it is the SOLE authority. No probe, no fiber, no
        // type inference from child elements. Capture text + sanitised HTML from
        // the matched element and return immediately.
        if (configuredXPathContentRoot) {
            const panelLinks = this.extractArtifactLinks(panelRoot);
            const viewUrl = panelLinks.viewUrl ?? options?.viewUrl;
            const sourceUrl = panelLinks.sourceUrl ?? options?.sourceUrl;

            const xpathText = this.cleanArtifactText(
                this.getTextContentPreservingLines(configuredXPathContentRoot).replace(/\n{3,}/g, '\n\n').trim()
            );
            const xpathHtml = configuredXPathContentRoot.matches('svg, canvas, iframe, embed, object')
                ? ''
                : this.sanitizeRichHtml(configuredXPathContentRoot, {
                    removeSelectors: ['.bonsai-insert-btn', '.bonsai-action-container', 'button', '[role="button"]', '[aria-label*="Copy"]', '[aria-label*="Retry"]', '[aria-label*="Edit"]']
                });

            if (!xpathHtml && this.isNoiseOnlyArtifactText(xpathText) && !viewUrl && !sourceUrl) {
                return null;
            }

            const artifactId = options?.artifactId ?? crypto.randomUUID();

            const svg = configuredXPathContentRoot.matches('svg')
                ? configuredXPathContentRoot as SVGSVGElement
                : configuredXPathContentRoot.querySelector('svg');
            if (svg && !xpathHtml) {
                return {
                    artifact_id: `${artifactId}-svg`,
                    type: 'image',
                    title: title || 'Diagram',
                    mime_type: 'image/svg+xml',
                    content: this.svgToDataUrl(svg as SVGSVGElement),
                    source_message_id: '',
                    source_url: sourceUrl,
                    view_url: viewUrl ?? window.location.href,
                    exportable: true,
                };
            }

            const useHtml = Boolean(xpathHtml) && !this.isNoiseOnlyArtifactText(xpathHtml.replace(/<[^>]+>/g, ' '));
            return {
                artifact_id: artifactId,
                type: 'artifact_doc',
                title,
                content: useHtml ? xpathHtml : (xpathText || title),
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl ?? window.location.href,
                exportable: true,
                mime_type: useHtml ? 'text/html' : this.inferClaudeArtifactMimeType(title, xpathText, sourceUrl),
            };
        }

        // ── XPath returned null ───────────────────────────────────────────────
        // Doc artifacts bail; code/unknown fall through to the probe sequence.
        if (options?.typeHint === 'doc') {
            return null;
        }

        // ── Probe path (code / unknown artifacts only) ────────────────────────
        const probeResult = await this.runClaudeArtifactProbeSequence(panelRoot, {
            fallbackTitle: title,
            viewUrl: options?.viewUrl,
            sourceUrl: options?.sourceUrl,
            typeHint: options?.typeHint,
        });
        const effectiveSourceContent = probeResult?.sourceText ?? null;
        const usingCodeView = Boolean(effectiveSourceContent) || this.isClaudeArtifactCodeViewActive(panelRoot);
        const contentRoot = probeResult?.contentRoot
            ?? (usingCodeView
                ? this.getClaudeArtifactCodeContentRoot(panelRoot)
                : this.getClaudeArtifactPreviewContentRoot(panelRoot));
        const extractedCode = effectiveSourceContent ? null : this.extractClaudeCodeArtifact(contentRoot);
        const panelLinks = this.extractArtifactLinks(panelRoot);
        const viewUrl = panelLinks.viewUrl ?? options?.viewUrl;
        const sourceUrl = panelLinks.sourceUrl ?? options?.sourceUrl;
        const descriptor = `${panelRoot.className || ''} ${panelRoot.getAttribute('data-testid') || ''} ${contentRoot.tagName} ${contentRoot.className || ''}`.toLowerCase();
        const sourceText = effectiveSourceContent ?? extractedCode?.code ?? this.normalizeClaudeCodeText(this.getTextContentPreservingLines(contentRoot), true);
        const previewText = this.cleanArtifactText(this.getTextContentPreservingLines(contentRoot).replace(/\n{3,}/g, '\n\n').trim());
        const inferredMimeType = this.inferClaudeArtifactMimeType(title, usingCodeView ? sourceText : previewText, sourceUrl);
        const looksLikeEmbeddedDocument = /pdf/.test(descriptor) || /\.(pdf)(?:$|[?#])/.test(sourceUrl ?? '') || contentRoot.matches('iframe, embed, object');
        let type: ArtifactNode['type'] = 'artifact_doc';
        if (options?.typeHint === 'code') {
            type = 'code_artifact';
        } else if (usingCodeView || /code|source/.test(descriptor) || Boolean(contentRoot.querySelector('pre, code')) || contentRoot.matches('pre, code') || Boolean(extractedCode)) {
            type = inferredMimeType === 'text/markdown' ? 'artifact_doc' : 'code_artifact';
        } else if (/document|doc|pdf/.test(descriptor) || looksLikeEmbeddedDocument) {
            type = looksLikeEmbeddedDocument ? 'embedded_doc' : 'artifact_doc';
        }
        const content = (type === 'code_artifact' || usingCodeView) ? sourceText : previewText;
        const structuredHtml = type !== 'code_artifact' && !usingCodeView && !contentRoot.matches('svg, canvas, iframe, embed, object')
            ? this.sanitizeRichHtml(contentRoot, {
                removeSelectors: ['.bonsai-insert-btn', '.bonsai-action-container', 'button', '[role="button"]', '[aria-label*="Copy"]', '[aria-label*="Retry"]', '[aria-label*="Edit"]']
            })
            : '';
        if (!structuredHtml && this.isNoiseOnlyArtifactText(content) && !viewUrl && !sourceUrl) {
            return null;
        }
        const artifactId = options?.artifactId ?? crypto.randomUUID();
        const svg = type === 'code_artifact'
            ? null
            : (contentRoot.matches('svg') ? contentRoot as SVGSVGElement : contentRoot.querySelector('svg'));
        if (svg) {
            return {
                artifact_id: `${artifactId}-svg`,
                type: 'image',
                title: title || 'Diagram',
                mime_type: 'image/svg+xml',
                content: this.svgToDataUrl(svg as SVGSVGElement),
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl ?? window.location.href,
                exportable: true,
            };
        }
        const canvas = type === 'code_artifact'
            ? null
            : (contentRoot.matches('canvas') ? contentRoot as HTMLCanvasElement : contentRoot.querySelector('canvas'));
        if (canvas) {
            const dataUrl = this.canvasToDataUrl(canvas as HTMLCanvasElement);
            if (dataUrl) {
                return {
                    artifact_id: `${artifactId}-canvas`,
                    type: 'image',
                    title: title || 'Diagram',
                    mime_type: 'image/png',
                    content: dataUrl,
                    source_message_id: '',
                    source_url: sourceUrl,
                    view_url: viewUrl ?? window.location.href,
                    exportable: true,
                };
            }
        }
        return {
            artifact_id: artifactId,
            type,
            title,
            content: type !== 'code_artifact' && structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                ? structuredHtml
                : (content || title),
            source_message_id: '',
            source_url: sourceUrl,
            view_url: viewUrl ?? window.location.href,
            exportable: true,
            mime_type: type !== 'code_artifact' && structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                ? 'text/html'
                : (type === 'code_artifact' ? 'text/plain' : inferredMimeType),
        };
    }

    private normalizeClaudeCodeText(text: string, collapseExtraNewlines = false): string {
        let normalized = text
            .replace(/\u00a0/g, ' ')
            .replace(/\u200b/g, '');

        if (collapseExtraNewlines) {
            normalized = normalized.replace(/\n{3,}/g, '\n\n');
        }

        return normalized.trim();
    }

    /**
     * Read artifact source directly from the React fiber prop tree.
     *
     * Claude uses Radix UI RadioGroup for the Preview/Code toggle. Radix checks
     * `event.isTrusted` and silently ignores untrusted (JS-dispatched) click events,
     * so NO synthetic click strategy can switch views programmatically. Instead, we
     * walk the React fiber tree rooted at `panelRoot` and look for the raw `content`
     * prop that Claude passes to its sandbox/renderer components. This prop holds the
     * actual artifact source regardless of which view is currently active.
     *
     * Noise filters exclude:
     *   - Tailwind/CSS class strings (contain `inline-flex`, `items-center`, etc.)
     *   - SVG path data (`d` prop starting with `M<digit>`)
     *   - URL strings
     */
    private getClaudeArtifactContentFromFiber(root: Element): string | null {
        const isCssOrSvgNoise = (s: string): boolean =>
            /\binline-flex\b|\bitems-center\b|\bjustify-center\b/.test(s) // Tailwind class lists
            || /^\s*M[\d-]/.test(s)                                         // SVG path `d` attribute
            || /^https?:\/\//.test(s);                                       // URLs

        // Prop keys that may carry raw artifact source. 'markdown', 'document',
        // 'initialValue', and 'defaultValue' are added for document-type artifacts
        // which Claude often stores under a different key than code/diagram artifacts.
        // 'text' is included with caution — the 80-char minimum + noise filter guard
        // against short UI labels, but we stay within the panelRoot fiber subtree only.
        const CONTENT_KEYS = new Set(['content', 'source', 'code', 'src', 'markdown', 'document', 'initialValue', 'defaultValue', 'text']);

        const hits: Array<{ len: number; value: string }> = [];

        const fiberRoots = [
            root,
            ...Array.from(root.querySelectorAll(
                '[id*="wiggle-file-content"], [data-artifact-content], [data-testid*="artifact-content"], .standard-markdown, .progressive-markdown, .markdown'
            )),
        ].filter((candidate, index, all): candidate is Element => candidate instanceof Element && all.indexOf(candidate) === index);

        const checkProps = (f: Record<string, unknown>) => {
            const props = (f['memoizedProps'] ?? f['pendingProps'] ?? {}) as Record<string, unknown>;
            for (const key of Object.keys(props)) {
                if (!CONTENT_KEYS.has(key)) continue;
                const v = props[key];
                if (typeof v === 'string' && v.length >= 80 && !isCssOrSvgNoise(v)) {
                    hits.push({ len: v.length, value: v });
                }
            }
        };

        for (const fiberRoot of fiberRoots) {
            const fiber = this.getClaudeReactFiberNode(fiberRoot)
                ?? (fiberRoot.firstElementChild ? this.getClaudeReactFiberNode(fiberRoot.firstElementChild) : null);
            if (!fiber) {
                continue;
            }

            // Walk UP (return chain) from this seed up to 40 levels — document artifacts
            // store their content prop on the React component that owns the panel, which is
            // an ancestor of #wiggle-file-content / .standard-markdown in the fiber tree.
            // Stop if we hit the panelRoot's fiber to avoid leaking into conversation scope.
            const rootFiber = this.getClaudeReactFiberNode(root);
            let up: Record<string, unknown> | null = fiber['return'] as Record<string, unknown> | null;
            for (let depth = 0; up && depth < 40; depth++) {
                if (up === rootFiber) break;
                checkProps(up);
                up = up['return'] as Record<string, unknown> | null;
            }

            // Walk DOWN (child/sibling subtree) as before.
            const seen = new WeakSet<Record<string, unknown>>();
            const stack: Array<Record<string, unknown>> = [fiber];
            let n = 0;

            while (stack.length > 0 && n < 8000) {
                const f = stack.pop()!;
                if (!f || seen.has(f)) continue;
                seen.add(f);
                n++;

                checkProps(f);

                if (f['sibling']) stack.push(f['sibling'] as Record<string, unknown>);
                if (f['child']) stack.push(f['child'] as Record<string, unknown>);
            }
        }

        if (hits.length === 0) return null;
        hits.sort((a, b) => b.len - a.len);
        const best = hits[0].value;
        // Final sanity check: reject if this looks like more noise.
        return this.isNoiseOnlyArtifactText(best.slice(0, 200)) ? null : best;
    }

    private extractClaudeCodeArtifact(root: Element | null): { code: string; language: string } | null {
        if (!root) {
            return null;
        }

        const groupedInlineCodeNodes = this.getClaudeArtifactGroupedCodeNodes(root);
        if (!root.querySelector('pre') && groupedInlineCodeNodes.length > 1) {
            const code = groupedInlineCodeNodes
                .map((candidate) => this.normalizeClaudeCodeLine(candidate.textContent ?? ''))
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/^\n+|\n+$/g, '');

            if (code.trim().length > 0) {
                return {
                    code,
                    language: this.detectCodeLanguage(groupedInlineCodeNodes[0]),
                };
            }
        }

        const explicitCodeBlocks = Array.from(root.querySelectorAll('pre code, code'))
            .filter((candidate): candidate is Element => candidate instanceof Element)
            .filter((candidate) => !candidate.querySelector('code'))
            .filter((candidate) => !candidate.closest('button, [role="button"]'))
            .map((candidate) => ({
                code: this.normalizeClaudeCodeText(candidate.textContent ?? ''),
                language: this.detectCodeLanguage(candidate),
            }))
            .filter((candidate) => candidate.code.length > 0)
            .sort((left, right) => right.code.length - left.code.length);

        if (explicitCodeBlocks.length > 0) {
            return explicitCodeBlocks[0];
        }

        const preBlocks = Array.from(root.querySelectorAll('pre'))
            .map((candidate) => ({
                code: this.normalizeClaudeCodeText(candidate.textContent ?? ''),
                language: this.detectCodeLanguage(candidate),
            }))
            .filter((candidate) => candidate.code.length > 0)
            .sort((left, right) => right.code.length - left.code.length);

        if (preBlocks.length > 0) {
            return preBlocks[0];
        }

        const fallbackRoots = [
            ...(root.matches('[class*="overflow-y-scroll"], div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"], [data-testid*="code"]') ? [root] : []),
            ...Array.from(root.querySelectorAll('[class*="overflow-y-scroll"], div[class*="font-mono"], div[class*="font-code"], div[class*="whitespace-pre"], [data-testid*="code"]')),
        ].filter((candidate, index, all): candidate is Element => candidate instanceof Element && all.indexOf(candidate) === index);

        const fallbackBlocks = fallbackRoots
            .map((candidate) => ({
                code: this.normalizeClaudeCodeText(this.getTextContentPreservingLines(candidate), true),
                language: this.detectCodeLanguage(candidate),
            }))
            .filter((candidate) => candidate.code.length > 0)
            .sort((left, right) => right.code.length - left.code.length);

        return fallbackBlocks[0] ?? null;
    }

    /**
     * Stable content key for change-detection: captures enough text that two different
     * artifacts are virtually certain to differ, without being so expensive that it
     * can't be called on every MutationObserver tick.
     *
     * Returns null when the panel is empty / transitioning (< 30 chars), so the
     * caller can distinguish "cleared for re-render" from "new content loaded."
     */
    private getClaudeOpenedPanelContentKey(panelRoot: Element): string | null {
        const wiggle = panelRoot.querySelector('[id*="wiggle"]');
        const source = wiggle ?? panelRoot;
        const t = this.cleanArtifactText((source.textContent ?? '').trim());
        // Threshold 30: avoids copy-buttons, aria labels, spinners, and partial React
        // re-render states, while still accepting short-but-real artifact content.
        return t.length >= 30 ? `${t.length}:${t.slice(0, 120)}` : null;
    }

    private async captureClaudeOpenedArtifact(
        opener: HTMLElement,
        options?: { artifactId?: string; fallbackTitle?: string; viewUrl?: string; sourceUrl?: string; typeHint?: 'code' | 'doc' | 'unknown' }
    ): Promise<ArtifactNode | null> {
        const expectedTitle = options?.fallbackTitle || this.getClaudeArtifactOpenerTitle(opener);
        // A generic fallback title ("Artifact") carries no identity information — treat
        // it the same as no title so we don't reject real panels that have specific titles.
        const hasRealTitle = Boolean(expectedTitle)
            && this.normalizeClaudeTitle(expectedTitle) !== 'artifact';

        // If the panel already shows this artifact, capture it directly without clicking.
        const panelBeforeClick = this.getClaudeArtifactPanelRoot();
        if (panelBeforeClick && this.verifyClaudeArtifactTitleLock(panelBeforeClick, expectedTitle)) {
            return this.captureClaudePanelArtifact(panelBeforeClick, {
                artifactId: options?.artifactId,
                fallbackTitle: expectedTitle,
                viewUrl: options?.viewUrl,
                sourceUrl: options?.sourceUrl,
                typeHint: options?.typeHint,
            });
        }

        // Snapshot so we can tell when an existing panel has switched content.
        const contentKeyBeforeClick = panelBeforeClick
            ? this.getClaudeOpenedPanelContentKey(panelBeforeClick)
            : null;

        // Click the opener.  If a panel is already open, Claude switches its content
        // in-place (one panel slot); if no panel is open, Claude inserts a new one.
        opener.click();

        // Resolve when:
        //  (a) panelBeforeClick is still connected AND its content key has changed
        //      ← in-place switch: the same element, different artifact content
        //  (b) panelBeforeClick disconnected OR was null: a new/re-mounted panel appeared
        //      WITH its dedicated content container mounted and populated.
        const resolveReadyPanel = (): Element | null => {
            if (panelBeforeClick && panelBeforeClick.isConnected) {
                // In-place switch: only resolve when content has actually changed AND
                // the panel has meaningful new content (currentKey is non-null).
                // Without the non-null guard, React's panel-clear step (empty wiggle →
                // key goes null) would fire immediately: null !== oldKey → resolves,
                // then XPath captures an empty element → produces a copy-icon artifact.
                const currentKey = this.getClaudeOpenedPanelContentKey(panelBeforeClick);
                const hasNewContent = currentKey !== null && currentKey !== contentKeyBeforeClick;
                return hasNewContent ? panelBeforeClick : null;
            }
            // Prior panel gone or never existed.  Claude's panel DOM can mount in
            // stages: the chrome (heading + Preview/Code toggle) appears first as
            // one subtree, while #wiggle-file-content is inserted later — sometimes
            // under a DIFFERENT ancestor element.  If we resolve as soon as ANY panel
            // candidate appears, captureClaudePanelArtifact receives a panelRoot that
            // does NOT contain the XPath target (#wiggle-file-content), causing the
            // XPath MutationObserver to watch the wrong subtree and silently time out.
            //
            // Guard: require the candidate to have a content region (wiggle,
            // viewer-body, or standard-markdown) with actual text.  Panel chrome
            // (heading + toggles) appears before the content region mounts; this
            // check prevents resolving to that chrome-only shell.
            const candidate = this.getClaudeArtifactPanelRoot();
            if (!candidate) return null;
            const contentRegion = candidate.querySelector(
                '[id*="wiggle"], .viewer-body, .standard-markdown, .progressive-markdown, [data-artifact-content]'
            ) ?? (candidate.matches('[id*="wiggle"], [data-artifact-content]') ? candidate : null);
            if (!contentRegion) return null;
            const contentText = this.cleanArtifactText((contentRegion.textContent ?? '').trim());
            return contentText.length >= 10 ? candidate : null;
        };

        const panelRoot = await new Promise<Element | null>((resolve) => {
            let resolved = false;
            const resolveOnce = (result: Element | null) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutTimer);
                    clearInterval(pollInterval);
                    observer.disconnect();
                    resolve(result);
                }
            };

            const immediate = resolveReadyPanel();
            if (immediate) { resolve(immediate); return; }

            // Conservative open timeout for slower artifact swaps and larger documents.
            const maxWaitMs = Math.max(6000, this.claudeCaptureSettings.panelCaptureDelayMs * 2);
            const timeoutTimer = setTimeout(() => resolveOnce(null), maxWaitMs);

            const observer = new MutationObserver(() => {
                const found = resolveReadyPanel();
                if (found) resolveOnce(found);
            });
            // childList+subtree catches both panel insertions and React in-place re-renders.
            // characterData catches text-only updates inside the panel element.
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });

            const pollInterval = setInterval(() => {
                const found = resolveReadyPanel();
                if (found) resolveOnce(found);
            }, 300);
        });

        if (!panelRoot) {
            console.warn(
                'Bonsai [Claude-Artifact] captureClaudeOpenedArtifact: panel not found',
                { expectedTitle }
            );
            return null;
        }

        // For in-place content switches the content change IS the correctness signal —
        // no title check needed.  For new/re-mounted panels, verify the title to reject
        // stale or mismatched panels (unless the expected title is generic).
        const isInPlaceSwitch = panelRoot === panelBeforeClick;
        if (!isInPlaceSwitch && hasRealTitle) {
            const panelTitle = this.getClaudeArtifactPanelTitle(panelRoot);
            // No panel title = can't verify = optimistically accept.
            if (panelTitle && !this.claudeTitlesMatch(panelTitle, expectedTitle)) {
                console.warn(
                    'Bonsai [Claude-Artifact] captureClaudeOpenedArtifact: title-lock failed',
                    { expectedTitle, panelTitle }
                );
                return null;
            }
        }

        // Caller (parseArtifacts) is responsible for closing the panel after all
        // artifacts in the message have been captured.
        return this.captureClaudePanelArtifact(panelRoot, {
            artifactId: options?.artifactId,
            fallbackTitle: expectedTitle,
            viewUrl: options?.viewUrl,
            sourceUrl: options?.sourceUrl,
            typeHint: options?.typeHint,
        });
    }

    private get selectors() {
        const s = getSelectorsForSite('claude.ai');
        if (!s) {
            console.error('Bonsai: Failed to get selectors for claude.ai');
            // Emergency hardcoded fallback
            return {
                conversationContainer: 'body',
                messageBlock: '[data-testid="user-message"]',
                roleClassUser: 'font-user-message',
                roleClassAssistant: 'font-claude-response',
                inputField: '[contenteditable="true"]',
                modelIndicator: ''
            };
        }
        return s;
    }

    detectConversation(): ParsedConversation | null {
        try {
            console.log('Bonsai: Detecting conversation...');
            let container = queryWithFallbacks(document, this.selectors.conversationContainer);
            console.log('Bonsai: Container probe:', container);

            // Deep Inspect Fallback: If URL matches but container missing, force a capture
            if (!container && window.location.href.includes('/chat/')) {
                console.warn('Bonsai: Claude container not found, using body for inspection');
                container = document.querySelector('main') || document.body;
            }

            if (!container) {
                console.error('Bonsai: Container is null!');
                return null;
            }

            const title = document.title.replace(' - Claude', '').replace('Claude', '').trim()
                || this.extractConversationTitle();

            return {
                url: window.location.href,
                container,
                title: title || 'Claude Chat (Debug)'
            };
        } catch (e) {
            console.error('Bonsai: Fatal error in detectConversation', e);
            // Emergency Recovery
            return {
                url: window.location.href,
                title: 'Claude (Error Recovery)',
                container: document.body
            };
        }
    }

    private extractConversationTitle(): string {
        // Try sidebar or header
        const titleEl = document.querySelector('[data-testid="conversation-title"], .conversation-title');
        return titleEl?.textContent?.trim() ?? '';
    }

    listMessages(): Element[] {
        const conversation = this.detectConversation();
        if (!conversation) return [];

        const all = queryAllWithFallbacks(conversation.container, this.selectors.messageBlock);

        if (all.length === 0 && (conversation.container === document.body || conversation.container === document.querySelector('main'))) {
            // If in debug mode and no messages found, return header as dummy message to trigger artifact parsing
            return [conversation.container];
        }

        // Deduplicate
        return all.filter(msg => !all.some(ancestor => ancestor !== msg && ancestor.contains(msg)));
    }

    parseMessage(el: Element, sequence: number): MessageNode {
        // If debug mode (body), force assistant role
        if (el === document.body || el === document.querySelector('main')) {
            return createMessageNode('assistant', sequence, [], this.getDeepLink(el));
        }

        const role = this.detectRole(el);
        const contentBlocks = this.parseContentBlocks(el, role);
        const deepLink = this.getDeepLink(el);
        const origin = this.getProvenance();

        const message = createMessageNode(role, sequence, contentBlocks, deepLink, role === 'assistant' ? origin : undefined);

        const stableId = el.getAttribute('data-message-id')
            ?? el.getAttribute('data-bonsai-msg-id')
            ?? el.getAttribute('id')
            ?? el.closest('[data-message-id]')?.getAttribute('data-message-id')
            ?? el.closest('[data-bonsai-msg-id]')?.getAttribute('data-bonsai-msg-id')
            ?? el.closest('[id]')?.getAttribute('id');

        if (stableId) {
            message.message_id = stableId;
        }

        return message;
    }

    private detectRole(el: Element): 'user' | 'assistant' | 'system' | 'tool' {
        const classList = el.className.toLowerCase();
        const selectors = this.selectors;

        // Check class-based selectors
        if (selectors.roleClassUser) {
            const userClasses = selectors.roleClassUser.split(',').map(c => c.trim());
            if (userClasses.some(c => classList.includes(c))) return 'user';
        }

        if (selectors.roleClassAssistant) {
            const assistantClasses = selectors.roleClassAssistant.split(',').map(c => c.trim());
            if (assistantClasses.some(c => classList.includes(c))) return 'assistant';
        }

        // Check for Claude avatar/icon
        if (el.querySelector('.claude-avatar, [data-testid="claude-avatar"], svg.claude-icon')) {
            return 'assistant';
        }

        // Check for user avatar
        if (el.querySelector('.user-avatar, [data-testid="user-avatar"]')) {
            return 'user';
        }

        // Check data attributes
        const role = el.getAttribute('data-role') ?? el.getAttribute('data-message-role');
        if (role === 'user' || role === 'human') return 'user';
        if (role === 'assistant' || role === 'ai') return 'assistant';

        // Fallback to position
        const messages = this.listMessages();
        const index = messages.indexOf(el);
        return index % 2 === 0 ? 'user' : 'assistant';
    }

    private getAssistantStructuredContent(el: Element): Element | null {
        const fragments = Array.from(el.querySelectorAll('.standard-markdown, .progressive-markdown'))
            .filter((fragment): fragment is Element => fragment instanceof Element)
            .filter((fragment) => !this.isClaudeArtifactScopedElement(fragment))
            .filter((fragment) => (fragment.textContent || '').trim().length > 0);

        const uniqueFragments = fragments.filter(
            (fragment) => !fragments.some((parent) => parent !== fragment && parent.contains(fragment))
        );

        if (uniqueFragments.length === 0) {
            return null;
        }

        if (uniqueFragments.length === 1) {
            return uniqueFragments[0];
        }

        const wrapper = document.createElement('div');
        uniqueFragments.forEach((fragment) => wrapper.appendChild(fragment.cloneNode(true)));
        return wrapper;
    }

    private parseContentBlocks(el: Element, role: 'user' | 'assistant' | 'system' | 'tool'): ContentBlock[] {
        if (role === 'assistant') {
            const structured = this.getAssistantStructuredContent(el);
            if (structured) {
                const html = this.sanitizeRichHtml(structured, {
                    removeSelectors: ['[aria-label*="Copy"]', '[aria-label="Retry"]', '[aria-label="Edit"]']
                });

                if (html) {
                    return [createHtmlBlock(html)];
                }
            }
        }

        const blocks: ContentBlock[] = [];

        // 1. Mark and Extract Code Blocks (Only REAL code blocks)
        const codeBlocks = this.extractCodeBlocks(el);

        // 2. Clone content for text extraction
        // Prefer Claude-specific content containers to avoid capturing role labels and action buttons.
        const contentArea = Array.from(el.querySelectorAll('.font-claude-response, .prose, .message-content, [data-message-content]'))
            .find((candidate): candidate is Element => candidate instanceof Element && !this.isClaudeArtifactScopedElement(candidate))
            ?? el;
        const clone = contentArea.cloneNode(true) as Element;

        // 3. Replace marked code blocks with Placeholders
        // The data-bonsai-index attribute was set by extractCodeBlocks
        clone.querySelectorAll('[data-bonsai-index]').forEach(captured => {
            const index = captured.getAttribute('data-bonsai-index');
            if (index !== null) {
                const placeholder = document.createTextNode(`\n\n<<<BONSAI_CODE_BLOCK_${index}>>>\n\n`);
                captured.parentNode?.replaceChild(placeholder, captured);
            }
        });

        Array.from(clone.querySelectorAll('*'))
            .filter((candidate): candidate is Element => candidate instanceof Element)
            .filter((candidate) => this.looksLikeClaudeArtifactRef(candidate))
            .forEach((artifactNode) => artifactNode.remove());

        // Also remove artifact cards and action buttons from text
        clone.querySelectorAll(`${this.getClaudeArtifactScopeSelector()}, .font-claude-message-actions, .font-user-message-actions, [role="group"], button, [role="button"]`).forEach(art => art.remove());

        // 4. Get text using recursive walker to guarantee newlines between blocks
        // This handles deep nesting and grid layouts where innerText fails
        const rawText = this.getTextContentPreservingLines(clone);

        // Normalize whitespace: max 2 newlines
        let textContent = rawText.replace(/\n{3,}/g, '\n\n').trim();

        // Cleanup quote markers and conversational prefixes from text
        textContent = this.sanitizeMessageText(textContent);

        // Escape asterisks (The user wants literal asterisks, not bullets/italics)
        textContent = textContent.replace(/\*/g, '\u2217');

        const parts = textContent.split(/<<<BONSAI_CODE_BLOCK_(\d+)>>>/);

        parts.forEach((part, i) => {
            if (i % 2 === 0) {
                // Even indices are Text
                const text = part.trim();
                if (text) {
                    blocks.push(createMarkdownBlock(text));
                }
            } else {
                // Odd indices are the captured ID (from key group regex)
                const blockIndex = parseInt(part, 10);
                const cb = codeBlocks[blockIndex];
                if (cb) {
                    blocks.push(createCodeBlock(cb.code, cb.language));
                }
            }
        });

        return blocks;
    }

    /**
     * Recursive DOM walker that ensures block-level elements are separated by newlines.
     * Use this instead of innerText for grid/deeply nested layouts.
     */
    private getTextContentPreservingLines(root: Node): string {
        if (root.nodeType === Node.TEXT_NODE) {
            return root.textContent || '';
        }

        if (root.nodeType === Node.ELEMENT_NODE) {
            const el = root as Element;
            // Ignore artifacts/hidden
            if (el.matches('[data-artifact], .artifact-card, .artifact-preview, style, script')) return '';

            // Check if block level
            const tag = el.tagName.toLowerCase();
            const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'ul', 'ol', 'pre', 'blockquote'];
            const isBlock = blockTags.includes(tag);

            let text = '';

            // Recurse children
            root.childNodes.forEach(child => {
                text += this.getTextContentPreservingLines(child);
            });

            // Special handling for BR
            if (tag === 'br') return '\n';

            // If block, surround with newlines (unless empty)
            if (isBlock && text.trim().length > 0) {
                return '\n' + text + '\n';
            }
            return text;
        }

        return '';
    }

    protected extractCodeBlocks(el: Element): Array<{ language: string; code: string }> {
        const blocks: Array<{ language: string; code: string }> = [];

        // Helper to capture and mark with Index
        const capture = (element: Element, code: string, lang: string) => {
            const index = blocks.length;
            element.setAttribute('data-bonsai-index', index.toString());

            const wrapper = element.closest('.group, .code-container');
            if (wrapper && wrapper !== element) {
                wrapper.setAttribute('data-bonsai-index', index.toString());
            }

            blocks.push({ language: lang, code });
        };

        // 1. Standard pre/code via base implementation (Manual implementation to allow marking)
        const standard = el.querySelectorAll('pre code, pre');
        standard.forEach(node => {
            if (node.closest('[data-bonsai-index]')) return;

            const codeEl = node.querySelector('code') ?? node;
            const text = codeEl.textContent?.trim() ?? '';
            if (!text) return;

            let lang = '';
            const classes = (codeEl.className + ' ' + node.className).toLowerCase();
            const match = classes.match(/language-(\w+)/);
            if (match) lang = match[1];

            capture(node, text, lang);
        });

        // 2. Heuristic: Scrollable containers (overflow)
        const scrollable = el.querySelectorAll('div[class*="overflow"], div[style*="overflow"]');
        scrollable.forEach(div => {
            if (div.querySelector('table')) return;
            // Ignore if already captured or inside captured
            if (div.closest('[data-bonsai-index]')) return;

            const text = div.textContent?.trim() ?? '';
            // Check if it looks code-like (long, or structured)
            // Simple fallback: if > 50 chars and not a table
            if (text.length > 50 && text.length < (el.textContent?.length ?? 0) * 0.9) {
                // Check if it's already in blocks
                if (!blocks.some(b => b.code === text)) {
                    capture(div, text, '');
                }
            }
        });

        // 3. Heuristic: Copies Button
        const copyButtons = Array.from(el.querySelectorAll('button'));
        copyButtons.forEach(btn => {
            const label = btn.getAttribute('aria-label') || btn.textContent || '';
            if (label.toLowerCase().includes('copy')) {
                const container = btn.closest('.group') || btn.closest('.code-block') || btn.parentElement?.parentElement;
                if (container && !container.closest('[data-bonsai-index]')) {
                    const codePart = container.querySelector('pre')
                        || container.querySelector('code')
                        || container.querySelector('div[class*="overflow"]')
                        || container.querySelector('div[class*="font-mono"]'); // font-mono still useful

                    if (codePart) {
                        const code = codePart.textContent?.trim() ?? '';
                        if (code && code.length < 20000 && !blocks.some(b => b.code === code)) {
                            capture(container, code, '');
                        }
                    }
                }
            }
        });

        return blocks;
    }

    async parseArtifacts(el: Element): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];

        // DEBUG DUMP if we are capturing the main/body fallback
        if (el === document.body || el === document.querySelector('main')) {
            const dump = {
                url: window.location.href,
                mainClasses: document.querySelector('main')?.className,
                bodyStructure: this.analyzeStructure(document.querySelector('main') || document.body)
            };

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'artifact_doc', // Will show as document
                title: 'Claude DOM Dump',
                content: JSON.stringify(dump, null, 2),
                source_message_id: '',
                exportable: true,
                mime_type: 'application/json'
            });
            return artifacts;
        }

        const artifactRefs = this.getClaudeArtifactRefs(el);

        // Track whether a panel was open before we started so we can restore state.
        const panelOpenBeforeCapture = this.getClaudeArtifactPanelRoot();

        for (const ref of artifactRefs) {
          try {
            const typeAttr = ref.getAttribute('data-artifact-type')?.toLowerCase()
                ?? ref.querySelector('[data-artifact-type]')?.getAttribute('data-artifact-type')?.toLowerCase();
            const typeHint: 'code' | 'doc' | 'unknown' = typeAttr?.includes('code')
                ? 'code'
                : typeAttr?.includes('doc') || typeAttr?.includes('text') || typeAttr?.includes('markdown')
                    ? 'doc'
                    : 'unknown';
            const artifactId = ref.getAttribute('data-artifact-id')
                ?? ref.querySelector('[data-artifact-id]')?.getAttribute('data-artifact-id')
                ?? ref.getAttribute('data-testid')
                ?? crypto.randomUUID();
            // Try multiple title sources: explicit title element, first heading, first strong text,
            // aria-label on ref, parent card's "Open artifact." aria-label (strip the suffix), fallback
            const parentCardTitle = (() => {
                const parentCard = ref.closest('[aria-label*="Open artifact"], [aria-label*="open artifact"]');
                const label = parentCard?.getAttribute('aria-label') ?? '';
                return this.cleanArtifactText(
                    label.replace(/\.?\s*open artifact\.?/i, '').trim()
                );
            })();
            const title = this.cleanArtifactText(
                ref.querySelector('.artifact-title, [data-testid="artifact-title"]')?.textContent?.trim()
                ?? ref.querySelector('h1, h2, h3, strong, [class*="title"], [class*="name"]')?.textContent?.trim()
                ?? ref.getAttribute('aria-label')
                ?? ref.getAttribute('title')
                ?? parentCardTitle
                ?? 'Artifact'
            );
            const refLinks = this.extractArtifactLinks(ref);
            // Fallback chain for opener:
            // 1. Explicit inner button/link with "Open artifact" label
            // 2. Closest ancestor div with "Open artifact" aria-label (the outer card wrapper)
            // 3. The ref element itself, but only when it is actually a connected,
            //    interactive opener (role=button / tabindex / explicit open-artifact label).
            const opener: HTMLElement | null = this.getClaudeArtifactOpeners(ref)[0]
                ?? (ref.closest('[aria-label*="Open artifact"], [aria-label*="open artifact"]') as HTMLElement | null)
                ?? (
                    ref instanceof HTMLElement
                    && ref.isConnected
                    && (
                        ref.matches('[aria-label*="Open artifact"], [aria-label*="open artifact"], [role="button"], button, [tabindex]')
                        || typeof ref.onclick === 'function'
                    )
                        ? ref
                        : null
                );

            // Some Claude layouts render the artifact ref as a non-clickable summary card
            // while the full panel is already open elsewhere in the DOM.  In that case,
            // capture the matching open panel directly instead of forcing a click path.
            if (!opener) {
                const existingPanel = title ? this.getClaudeArtifactPanelRoot(title, true) : null;
                if (existingPanel) {
                    const visibleArtifact = await this.captureClaudePanelArtifact(existingPanel, {
                        artifactId,
                        fallbackTitle: title || 'Artifact',
                        viewUrl: refLinks.viewUrl,
                        sourceUrl: refLinks.sourceUrl,
                        typeHint,
                    });

                    if (visibleArtifact) {
                        artifacts.push(visibleArtifact);
                        continue;
                    }
                }
            }

            if (opener) {
                const openedArtifact = await this.captureClaudeOpenedArtifact(opener, {
                    artifactId,
                    fallbackTitle: title || 'Artifact',
                    viewUrl: refLinks.viewUrl,
                    sourceUrl: refLinks.sourceUrl,
                    typeHint,
                });

                if (openedArtifact) {
                    artifacts.push(openedArtifact);
                    continue;
                }
            }

            if (typeHint === 'doc' && (refLinks.sourceUrl || refLinks.viewUrl)) {
                const fetchedArtifact = await this.captureClaudeRemoteDocumentArtifact({
                    artifactId,
                    title: title || 'Artifact',
                    viewUrl: refLinks.viewUrl,
                    sourceUrl: refLinks.sourceUrl,
                });

                if (fetchedArtifact) {
                    artifacts.push(fetchedArtifact);
                    continue;
                }
            }

            const contentRoot = (
                ref.querySelector(`[data-artifact-content="${artifactId}"], .artifact-content, .standard-markdown, .progressive-markdown, .markdown, svg, canvas`)
                ?? ref.parentElement?.querySelector(`[data-artifact-content="${artifactId}"]`)
            ) as Element | null;
            const sourceRoot = contentRoot ?? ref;
            const directLinks = this.extractArtifactLinks(ref);
            const fallbackLinks = sourceRoot !== ref ? this.extractArtifactLinks(sourceRoot) : { viewUrl: undefined, sourceUrl: undefined };
            const viewUrl = directLinks.viewUrl ?? fallbackLinks.viewUrl;
            const sourceUrl = directLinks.sourceUrl ?? fallbackLinks.sourceUrl;
            const extractedCode = sourceRoot instanceof Element ? this.extractClaudeCodeArtifact(sourceRoot) : null;

            let type: ArtifactNode['type'] = 'artifact_doc';
            const looksLikeEmbeddedDocument = sourceRoot instanceof Element && sourceRoot.matches('iframe, embed, object')
                || /\.(pdf)(?:$|[?#])/.test(sourceUrl ?? '');
            if (typeHint === 'code' || (typeHint === 'unknown' && extractedCode)) type = 'code_artifact';
            if (typeHint === 'doc') type = looksLikeEmbeddedDocument ? 'embedded_doc' : 'artifact_doc';

            const svg = sourceRoot instanceof Element ? sourceRoot.querySelector('svg') : null;
            const canvas = sourceRoot instanceof Element ? sourceRoot.querySelector('canvas') : null;
            const structuredHtml = type !== 'code_artifact' && sourceRoot instanceof Element && !sourceRoot.matches('svg, canvas')
                ? this.sanitizeRichHtml(sourceRoot, {
                    removeSelectors: ['.bonsai-insert-btn', '.bonsai-action-container', 'button', '[role="button"]', '[aria-label*="Copy"]', '[aria-label*="Retry"]', '[aria-label*="Edit"]']
                })
                : '';
            const content = type === 'code_artifact'
                ? (extractedCode?.code ?? this.normalizeClaudeCodeText(this.getTextContentPreservingLines(sourceRoot), true))
                : this.cleanArtifactText(sourceRoot?.textContent ?? ref.textContent ?? '');
            const inferredMimeType = this.inferClaudeArtifactMimeType(title || 'Artifact', content, sourceUrl);

            if (svg) {
                artifacts.push({
                    artifact_id: `${artifactId}-svg`,
                    type: 'image',
                    title: title || 'Diagram',
                    mime_type: 'image/svg+xml',
                    content: this.svgToDataUrl(svg as SVGSVGElement),
                    source_message_id: '',
                    source_url: sourceUrl,
                    view_url: viewUrl,
                    exportable: true
                });
            } else if (canvas) {
                const dataUrl = this.canvasToDataUrl(canvas as HTMLCanvasElement);
                if (dataUrl) {
                    artifacts.push({
                        artifact_id: `${artifactId}-canvas`,
                        type: 'image',
                        title: title || 'Diagram',
                        mime_type: 'image/png',
                        content: dataUrl,
                        source_message_id: '',
                        source_url: sourceUrl,
                        view_url: viewUrl,
                        exportable: true
                    });
                }
            }

            if (this.isNoiseOnlyArtifactText(content) && !viewUrl && !sourceUrl) {
                // Even when content is noise, preserve the artifact as a metadata stub
                // so that the artifact list, anchors, and Bonsai export include it.
                if (title && title !== 'Artifact') {
                    artifacts.push({
                        artifact_id: artifactId,
                        type,
                        title,
                        content: title,
                        source_message_id: '',
                        exportable: true,
                        mime_type: type === 'code_artifact' ? 'text/plain' : 'text/markdown',
                    });
                }
                continue;
            }

            artifacts.push({
                artifact_id: artifactId,
                type,
                title: title || 'Artifact',
                content: type !== 'code_artifact' && structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? structuredHtml
                    : (content || title || 'Artifact'),
                source_message_id: '',
                source_url: sourceUrl,
                view_url: viewUrl,
                exportable: true,
                mime_type: type !== 'code_artifact' && structuredHtml && !this.isNoiseOnlyArtifactText(structuredHtml.replace(/<[^>]+>/g, ' '))
                    ? 'text/html'
                    : (type === 'code_artifact' ? 'text/plain' : inferredMimeType)
            });
          } catch (refError) {
            console.warn('[Bonsai] Claude parseArtifacts: failed to process artifact ref', refError);
          }
        }

        // Close whichever panel is now open if none was open before capture began.
        // captureClaudeOpenedArtifact leaves the panel open (switching between artifacts
        // in the same panel slot is faster than close→open per artifact).
        if (!panelOpenBeforeCapture) {
            const finalPanel = this.getClaudeArtifactPanelRoot();
            if (finalPanel) {
                await this.closeClaudeArtifactPanel(finalPanel);
            }
        }

        // Look for images
        el.querySelectorAll('img:not([role="presentation"]):not(.avatar)').forEach(img => {
            const src = img.getAttribute('src');
            if (!src) return;
            const viewUrl = this.extractArtifactViewUrl(img);

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'image',
                title: img.getAttribute('alt') ?? undefined,
                mime_type: 'image/png',
                content: src,
                source_message_id: '',
                source_url: src,
                view_url: viewUrl,
                exportable: true
            });
        });

        return artifacts;
    }

    protected async parseVisibleArtifacts(): Promise<ArtifactNode[]> {
        const artifacts: ArtifactNode[] = [];
        const seenContent = new Set<string>();

        const visiblePanels = this.getClaudeArtifactPanelCandidates();

        for (const panelRoot of visiblePanels) {
            const artifact = await this.captureClaudePanelArtifact(panelRoot, {
                fallbackTitle: this.getClaudeArtifactPanelTitle(panelRoot) || 'Artifact',
            });
            if (!artifact) {
                continue;
            }

            const dedupeKey = this.getArtifactDedupKey(artifact);
            if (seenContent.has(dedupeKey)) {
                continue;
            }

            seenContent.add(dedupeKey);
            artifacts.push(artifact);
        }

        const visibleImages = Array.from(
            document.querySelectorAll('[data-artifact] img, [data-artifact-id] img, .artifact-card img, .artifact-preview img, [class*="artifact"] img')
        ).filter((img): img is HTMLImageElement => img instanceof HTMLImageElement && this.isVisibleElement(img));

        for (const img of visibleImages) {
            const src = img.getAttribute('src');
            if (!src || src.includes('avatar')) continue;

            const dedupeKey = `image|${src}`;
            if (seenContent.has(dedupeKey)) continue;
            seenContent.add(dedupeKey);

            artifacts.push({
                artifact_id: crypto.randomUUID(),
                type: 'image',
                title: img.getAttribute('alt') ?? 'Artifact image',
                mime_type: 'image/png',
                content: src,
                source_message_id: '',
                source_url: src,
                view_url: this.extractArtifactViewUrl(img) ?? window.location.href,
                exportable: true
            });
        }

        return artifacts;
    }

    private analyzeStructure(root: Element): any {
        return {
            tagName: root.tagName,
            classes: root.className,
            attributes: Array.from(root.attributes).map(a => `${a.name}="${a.value}"`),
            children: Array.from(root.children).slice(0, 5).map(c => ({
                tag: c.tagName,
                class: c.className,
                htmlPreview: c.outerHTML.slice(0, 200) + '...'
            }))
        };
    }

    getDeepLink(el: Element): DeepLink {
        const messageId = el.getAttribute('data-message-id')
            ?? el.getAttribute('id')
            ?? el.closest('[data-message-id]')?.getAttribute('data-message-id');

        return {
            url: window.location.href,
            message_anchor: messageId ?? undefined
        };
    }

    async scanSidebar(): Promise<SidebarItem[]> {
        const items: SidebarItem[] = [];

        // On the /recents page: click "Show more" until all conversations are loaded
        const onRecents = window.location.pathname.startsWith('/recents');
        if (onRecents) {
            for (let i = 0; i < 30; i++) {
                const showMoreBtn = Array.from(document.querySelectorAll('button')).find(
                    b => /show more|load more|see more/i.test(b.textContent?.trim() ?? '')
                ) as HTMLButtonElement | undefined;
                if (!showMoreBtn) break;
                showMoreBtn.click();
                await new Promise(r => setTimeout(r, 700));
            }
        } else {
            // Scroll the sidebar to lazy-load older conversations
            const sidebarScrollable = document.querySelector(
                'nav, [class*="sidebar"], [data-testid*="sidebar"], aside'
            ) as HTMLElement | null;
            if (sidebarScrollable) {
                let prevCount = 0;
                let stableRounds = 0;
                for (let i = 0; i < 15; i++) {
                    sidebarScrollable.scrollTop = sidebarScrollable.scrollHeight;
                    await new Promise(r => setTimeout(r, 650));
                    const count = document.querySelectorAll('a[href*="/chat/"], a[href*="/c/"]').length;
                    if (count === prevCount) {
                        if (++stableRounds >= 2) break;
                    } else {
                        stableRounds = 0;
                    }
                    prevCount = count;
                }
                sidebarScrollable.scrollTop = 0;
            }
        }

        const anchors = Array.from(document.querySelectorAll('a[href*="/chat/"], a[href*="/c/"], a[data-testid*="conversation"], a[class*="conversation"], [data-testid*="chat-item"] a')) as HTMLAnchorElement[];

        for (const link of anchors) {
            const rawHref = link.getAttribute('href') || '';
            if (!rawHref || rawHref.startsWith('javascript:')) continue;

            const href = rawHref.startsWith('http') ? rawHref : `${window.location.origin}${rawHref}`;
            const id = href;

            let title = link.innerText?.trim() || link.textContent?.trim() || '';
            if (!title && link.getAttribute('aria-label')) {
                title = link.getAttribute('aria-label')!.trim();
            }
            if (!title) title = 'Untitled';

            if (items.find(i => i.id === id)) continue;
            items.push({ id, title, url: href });
        }

        return items;
    }

    /**
     * Discover Claude projects by scraping the current page for project links.
     *
     * The side panel is responsible for navigating the tab to /projects before
     * calling this method.  This avoids destroying the content script context
     * via hard navigation.
     */
    async discoverProjects(): Promise<import('./interface').ProjectInfo[]> {
        const projects: import('./interface').ProjectInfo[] = [];
        const seen = new Set<string>();

        // Claude project links: /project/{uuid}
        const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/project/"]');
        links.forEach(link => {
            const rawHref = link.getAttribute('href') || '';
            if (!rawHref.includes('/project/')) return;
            // Skip chat links inside projects like /project/{id}/chat/{id}
            if (/\/chat\//.test(rawHref)) return;

            const fullUrl = rawHref.startsWith('http') ? rawHref : `${window.location.origin}${rawHref}`;
            if (seen.has(fullUrl)) return;
            seen.add(fullUrl);

            let name = link.innerText?.trim() || link.textContent?.trim() || '';
            name = name.split('\n')[0].trim();
            if (!name) {
                const uuidMatch = rawHref.match(/\/project\/([a-f0-9-]+)/i);
                name = uuidMatch ? `Project ${uuidMatch[1].slice(0, 8)}` : 'Unnamed Project';
            }

            projects.push({ url: fullUrl, name });
        });

        console.log(`[Bonsai Capture] Discovered ${projects.length} Claude projects.`);
        return projects;
    }

    /**
     * Scroll and scrape conversations on the current Claude project page.
     *
     * The side panel is responsible for navigating the tab to the project URL
     * before calling this method.
     */
    async scanProjectConversations(projectUrl: string, projectName: string): Promise<import('./interface').SidebarItem[]> {
        console.log(`[Bonsai Capture] Scanning Claude project: ${projectName} (${projectUrl})`);

        // Scroll to lazy-load all conversations on the project page
        const scrollable = document.querySelector(
            'main, [role="main"], [class*="scroll"], [class*="content"]'
        ) as HTMLElement | null;
        if (scrollable) {
            let prevCount = 0;
            let stableRounds = 0;
            for (let i = 0; i < 40; i++) {
                scrollable.scrollTop = scrollable.scrollHeight;
                await new Promise(r => setTimeout(r, 700));
                const count = document.querySelectorAll('a[href*="/chat/"]').length;
                if (count === prevCount) {
                    if (++stableRounds >= 3) break;
                } else {
                    stableRounds = 0;
                }
                prevCount = count;
            }
        }

        // Also click "Show more" / "Load more" buttons
        for (let i = 0; i < 20; i++) {
            const showMoreBtn = Array.from(document.querySelectorAll('button')).find(
                b => /show more|load more|see more/i.test(b.textContent?.trim() ?? '')
            ) as HTMLButtonElement | undefined;
            if (!showMoreBtn) break;
            showMoreBtn.click();
            await new Promise(r => setTimeout(r, 700));
        }

        // Collect project conversations from the main content list, not the left sidebar.
        const items: import('./interface').SidebarItem[] = [];
        const seen = new Set<string>();
        const projectRows: HTMLLIElement[] = [];

        try {
            const snapshot = document.evaluate(
                '//li[a[@data-dd-action-name="conversation cell"]]',
                document,
                null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                null,
            );

            for (let index = 0; index < snapshot.snapshotLength; index += 1) {
                const node = snapshot.snapshotItem(index);
                if (node instanceof HTMLLIElement) {
                    projectRows.push(node);
                }
            }
        } catch (error) {
            console.warn('[Bonsai Capture] Claude project XPath evaluation failed', error);
        }

        const scopedRoot = document.querySelector('main, [role="main"]') ?? document.body;
        const fallbackAnchors = projectRows.length === 0
            ? Array.from(scopedRoot.querySelectorAll<HTMLAnchorElement>(
                'a[data-dd-action-name="conversation cell"], li a[href*="/chat/"]'
            ))
            : [];

        const collectItem = (link: HTMLAnchorElement, labelSource: HTMLElement | null) => {
            const rawHref = link.getAttribute('href') || '';
            if (!rawHref.includes('/chat/')) return;

            const href = rawHref.startsWith('http') ? rawHref : `${window.location.origin}${rawHref}`;
            if (seen.has(href)) return;
            seen.add(href);

            let title = labelSource?.innerText?.trim()
                || labelSource?.textContent?.trim()
                || link.innerText?.trim()
                || link.textContent?.trim()
                || 'Untitled';
            title = title.split('\n')[0].trim() || 'Untitled';

            items.push({
                id: href,
                title,
                url: href,
                projectName,
                projectUrl,
            });
        };

        if (projectRows.length > 0) {
            for (const row of projectRows) {
                const link = row.querySelector<HTMLAnchorElement>('a[data-dd-action-name="conversation cell"], a[href*="/chat/"]');
                if (!link) continue;
                collectItem(link, row);
            }
        } else {
            for (const link of fallbackAnchors) {
                collectItem(link, link.closest('li'));
            }
        }

        console.log(`[Bonsai Capture] Found ${items.length} conversations in Claude project "${projectName}".`);
        return items;
    }

    async loadConversation(id: string): Promise<boolean> {
        if (window.location.href.includes(id)) {
            return true;
        }

        const sidebarLink = document.querySelector(`a[href*="${id}"]`) as HTMLElement | null;
        if (sidebarLink) {
            sidebarLink.click();
            return true;
        }

        try {
            window.location.href = id;
            return true;
        } catch {
            return false;
        }
    }

    getProvenance(): Provenance {
        // Look for model indicator
        const modelEl = queryWithFallbacks(document, this.selectors.modelIndicator ?? '');
        const modelText = modelEl?.textContent?.toLowerCase()?.trim() ?? '';
        console.log('Bonsai: Detected model text:', modelText);

        let model: string | undefined;
        let confidence: Provenance['confidence'] = 'unknown';

        if (modelText) {
            const versionMatch = modelText.match(/(\d+(\.\d+)?)/);
            const version = versionMatch ? versionMatch[0] : '';

            if (modelText.includes('opus')) {
                model = version ? `claude-${version}-opus` : 'claude-3-opus';
                confidence = 'observed';
            } else if (modelText.includes('sonnet')) {
                model = version ? `claude-${version}-sonnet` : 'claude-3.5-sonnet';
                confidence = 'observed';
            } else if (modelText.includes('haiku')) {
                model = version ? `claude-${version}-haiku` : 'claude-3-haiku';
                confidence = 'observed';
            } else if (modelText.includes('claude')) {
                model = modelText.replace(/\s+/g, '-');
                confidence = 'inferred';
            }
        }

        if (!model) {
            const bodyText = document.body.innerText ?? document.body.textContent ?? '';
            const match = bodyText.match(/(Sonnet|Haiku|Opus)\s+(\d+(\.\d+)?)/i);
            if (match) {
                const variant = match[1].toLowerCase();
                const ver = match[2];
                model = `claude-${ver}-${variant}`;
                confidence = 'inferred';
            }
        }

        if (!model) {
            model = 'Claude';
            confidence = 'inferred';
        }

        return {
            provider: 'anthropic',
            model,
            confidence
        };
    }

    sendToAI(text: string): boolean {
        const input = queryWithFallbacks(document, this.selectors.inputField);
        if (!input) return false;

        if (input.getAttribute('contenteditable')) {
            // ProseMirror-style editor
            input.innerHTML = `<p>${text}</p>`;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        } else if (input instanceof HTMLTextAreaElement) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        return true;
    }
}

// Auto-register
if (typeof window !== 'undefined') {
    const adapter = new ClaudeAdapter();
    (window as any).__bonsaiAdapter = adapter;
    captureEngine.setAdapter(adapter);
    console.log('Bonsai: ClaudeAdapter registered with engine');

    // Initialize DOM injector
    import('../dom-injector').then(({ domInjector }) => {
        domInjector.start();
        console.log('Bonsai: DOM Injector started for Claude');
    });
}

// Initialize message handler
import '../message-handler';

export default ClaudeAdapter;
