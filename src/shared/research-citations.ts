const SOURCE_INDEX_PATTERN = /data-bonsai-source-index="(\d+)"/g;

// Matches single or comma/space-separated multi-index citation brackets:
//   [4†source], 【4†source】, [4,5], [4, 5†source], 【4 5†source】
// Group 1: raw index string (may be "4" or "4,5" or "4 5").
// Group 2: optional dagger-separated source hint.
const CITATION_PATTERN = /[\[【](\d+(?:[,、 ]\d+)*)(?:†([^\]】]+))?[\]】]/g;

/** Split a raw index string like "4", "4,5" or "4 5" into individual numbers. */
export function splitRawIndexes(raw: string): number[] {
    return raw
        .split(/[,、 ]+/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
}

function extractSourceIndexes(fragment: string): number[] {
    const seen = new Set<number>();
    const indexes: number[] = [];

    for (const match of fragment.matchAll(SOURCE_INDEX_PATTERN)) {
        const index = Number.parseInt(match[1], 10);
        if (!Number.isFinite(index) || index <= 0 || seen.has(index)) {
            continue;
        }

        seen.add(index);
        indexes.push(index);
    }

    return indexes;
}

function extractSourceGroups(html: string): number[][] {
    const groups: number[][] = [];

    for (const item of html.match(/<li\b[\s\S]*?<\/li>/gi) || []) {
        const indexes = extractSourceIndexes(item);
        if (indexes.length > 0) {
            groups.push(indexes);
        }
    }

    return groups;
}

function extractCitationIndexesInOrder(html: string): number[] {
    const seen = new Set<number>();
    const ordered: number[] = [];

    const segments = html.split(/(<section\s[^>]*data-bonsai-(?:observed-)?sources[^>]*>[\s\S]*?<\/section>)/gi);
    const contentHtml = segments.filter((_part, idx) => idx % 2 === 0).join('\n');

    const combinedPattern = /(?:[\[【](\d+(?:[,、 ]\d+)*)(?:†[^\]】]+)?[\]】])|(?:<sup\b(?![^>]*class="bonsai-citation")[^>]*\bdata-citation-index="(\d+)"[^>]*>[\s\S]*?<\/sup>)|(?:<sup(?![^>]*class="bonsai-citation")[^>]*>(?:<a\s[^>]*>)?(\d+(?:[,、 ]\d+)*)(?:<\/a>)?<\/sup>)/gi;

    for (const match of contentHtml.matchAll(combinedPattern)) {
        const rawIndexes = match[1] || match[2] || match[3];
        if (!rawIndexes) continue;

        for (const index of splitRawIndexes(rawIndexes)) {
            if (seen.has(index)) {
                continue;
            }

            seen.add(index);
            ordered.push(index);
        }
    }

    return ordered;
}

export function buildResearchCitationDisplayMap(html: string): Map<number, number> {
    const displayMap = new Map<number, number>();
    const sourceGroups = extractSourceGroups(html);

    // When the source list carries sequential indices 1..N (the probe fast-path
    // assigns canonical numbers that already match the rendered Sources panel),
    // preserve those numbers verbatim — no citation-order remapping needed.
    const flatIndexes = sourceGroups.flatMap((g) => g).sort((a, b) => a - b);
    const isSequentialFrom1 = flatIndexes.length > 0
        && flatIndexes[0] === 1
        && flatIndexes.every((v, i) => v === i + 1);

    if (isSequentialFrom1) {
        for (const idx of flatIndexes) {
            displayMap.set(idx, idx);
        }
        return displayMap;
    }

    // ChatGPT deep research HTML already carries the canonical citation numbering on
    // inline <sup data-citation-index="N"> nodes. Preserve those numbers verbatim.
    if (/\bdata-citation-index="\d+"/i.test(html)) {
        for (const rawIndex of extractCitationIndexesInOrder(html)) {
            displayMap.set(rawIndex, rawIndex);
        }

        for (const indexes of sourceGroups) {
            for (const rawIndex of indexes) {
                if (!displayMap.has(rawIndex)) {
                    displayMap.set(rawIndex, rawIndex);
                }
            }
        }

        if (displayMap.size > 0) {
            return displayMap;
        }
    }

    const rawToGroup = new Map<number, string>();
    const groupMembers = new Map<string, number[]>();

    sourceGroups.forEach((indexes, groupIndex) => {
        const groupKey = `source:${groupIndex}`;
        groupMembers.set(groupKey, indexes);
        indexes.forEach((index) => {
            if (!rawToGroup.has(index)) {
                rawToGroup.set(index, groupKey);
            }
        });
    });

    const groupDisplay = new Map<string, number>();
    let nextDisplay = 1;

    for (const rawIndex of extractCitationIndexesInOrder(html)) {
        const groupKey = rawToGroup.get(rawIndex) ?? `standalone:${rawIndex}`;
        if (!groupDisplay.has(groupKey)) {
            groupDisplay.set(groupKey, nextDisplay);
            nextDisplay += 1;
        }
    }

    for (let groupIndex = 0; groupIndex < sourceGroups.length; groupIndex += 1) {
        const groupKey = `source:${groupIndex}`;
        if (!groupDisplay.has(groupKey)) {
            groupDisplay.set(groupKey, nextDisplay);
            nextDisplay += 1;
        }
    }

    for (const [groupKey, displayIndex] of groupDisplay) {
        if (groupKey.startsWith('standalone:')) {
            const rawIndex = Number.parseInt(groupKey.slice('standalone:'.length), 10);
            if (Number.isFinite(rawIndex) && rawIndex > 0) {
                displayMap.set(rawIndex, displayIndex);
            }
            continue;
        }

        for (const rawIndex of groupMembers.get(groupKey) || []) {
            displayMap.set(rawIndex, displayIndex);
        }
    }

    if (displayMap.size === 0) {
        let fallbackDisplay = 1;
        for (const rawIndex of extractSourceIndexes(html)) {
            if (!displayMap.has(rawIndex)) {
                displayMap.set(rawIndex, fallbackDisplay);
                fallbackDisplay += 1;
            }
        }
    }

    return displayMap;
}

export function getResearchCitationDisplayNumber(rawIndex: number | string, displayMap: Map<number, number>): number {
    const numericIndex = typeof rawIndex === 'number'
        ? rawIndex
        : Number.parseInt(rawIndex, 10);

    if (!Number.isFinite(numericIndex) || numericIndex <= 0) {
        return 0;
    }

    return displayMap.get(numericIndex) ?? numericIndex;
}

export function rewriteResearchSourceDisplayNumbers(html: string, displayMap: Map<number, number>): string {
    return html.replace(/<li\b[\s\S]*?<\/li>/gi, (item) => {
        const indexes = extractSourceIndexes(item);
        if (indexes.length === 0) {
            return item;
        }

        // Build a display label from all indexes in the source group.
        const displayNumbers = indexes
            .map((idx) => getResearchCitationDisplayNumber(idx, displayMap))
            .filter((n) => n > 0);

        if (displayNumbers.length === 0) {
            return item;
        }

        const label = displayNumbers.join(', ');

        if (/<sup\b/i.test(item)) {
            return item.replace(/<sup\b([^>]*)>[\s\S]*?<\/sup>/i, `<sup$1>${label}</sup>`);
        }

        return item;
    });
}