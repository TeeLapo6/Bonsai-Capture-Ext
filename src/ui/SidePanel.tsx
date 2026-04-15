/**
 * SidePanel Component
 * 
 * Main UI for the Bonsai Capture extension.
 * Provides editor, capture controls, history, and export functionality.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension, Node as TipTapNode, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Superscript from '@tiptap/extension-superscript';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import type { ContentBlock, ConversationGraph } from '../shared/schema';
import { exportToMarkdown, type MarkdownExportOptions } from '../shared/exporters/markdown';
import { exportToJSON } from '../shared/exporters/json';
import { exportToHtml } from '../shared/exporters/html';

import { exportToTOONString } from '../shared/exporters/toon';
import { markdownToHtml } from '../shared/markdown-to-html';
import { renderConversationGraphToHtml } from '../shared/render-preview-html';
import {
    DEFAULT_PROVIDER_CAPTURE_SETTINGS,
    normalizeProviderCaptureSettings,
    type ProviderCaptureSettings,
} from '../shared/capture-settings';

import JSZip from 'jszip';

type TabType = 'capture' | 'history' | 'export' | 'bulk';
type ThemePreference = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'bonsai-capture-theme';
const THEME_OPTIONS: ThemePreference[] = ['light', 'dark', 'system'];
const THEME_LABELS: Record<ThemePreference, string> = {
    light: 'Light',
    dark: 'Dark',
    system: 'System',
};

const THEME_ICONS: Record<ThemePreference, string> = {
    light: '☀️',
    dark: '🌙',
    system: '🖥️',
};

function resolveThemePreference(theme: ThemePreference): 'light' | 'dark' {
    if (theme === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    return theme;
}

function applyThemePreference(theme: ThemePreference) {
    const resolvedTheme = resolveThemePreference(theme);
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = theme;
}

const BonsaiAnchorAttributes = Extension.create({
    name: 'bonsaiAnchorAttributes',

    addGlobalAttributes() {
        return [
            {
                types: ['heading', 'paragraph', 'listItem'],
                attributes: {
                    id: {
                        default: null,
                        parseHTML: (element) => element.getAttribute('id'),
                        renderHTML: (attributes) => attributes.id ? { id: attributes.id } : {},
                    },
                    'data-artifact-id': {
                        default: null,
                        parseHTML: (element) => element.getAttribute('data-artifact-id'),
                        renderHTML: (attributes) => attributes['data-artifact-id'] ? { 'data-artifact-id': attributes['data-artifact-id'] } : {},
                    },
                    'data-bonsai-source-index': {
                        default: null,
                        parseHTML: (element) => element.getAttribute('data-bonsai-source-index'),
                        renderHTML: (attributes) => attributes['data-bonsai-source-index'] ? { 'data-bonsai-source-index': attributes['data-bonsai-source-index'] } : {},
                    },
                },
            },
        ];
    },
});

interface CaptureMetadataOptions {
    includeTimestamps: boolean;
    includeModels: boolean;
    includeAnchors: boolean;
    includeArtifacts: boolean;
    artifactMode: 'inline' | 'appendix';
}

const DEFAULT_CAPTURE_METADATA_OPTIONS: CaptureMetadataOptions = {
    includeTimestamps: true,
    includeModels: true,
    includeAnchors: true,
    includeArtifacts: true,
    artifactMode: 'appendix',
};

interface CapturedItem {
    id: string;
    timestamp: string;
    data: ConversationGraph;
    source?: string;

    tags?: string[];
    batchId?: string;
}

interface BulkItem {
    id: string;
    title: string;
    url: string;
    status: 'pending' | 'capturing' | 'success' | 'error';
    selected: boolean;
    failureReason?: string;
    /** Populated when the conversation belongs to a project. */
    projectName?: string;
    /** Project page URL used to reopen project-scoped lists before clicking the conversation. */
    projectUrl?: string;
}

interface ProjectInfo {
    url: string;
    name: string;
}

interface Diagnostics {
    provider: string | null;
    site: string | null;
    hasConversation: boolean;
    messageCount: number;
    artifactCount: number;
    provenance: { provider?: string; model?: string; confidence: string } | null;
}

const BonsaiVideoNode = TipTapNode.create({
    name: 'bonsaiVideo',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    isolating: true,

    addAttributes() {
        return {
            src: {
                default: null,
                parseHTML: (element) => element.getAttribute('src'),
            },
            title: {
                default: null,
                parseHTML: (element) => element.getAttribute('title'),
            },
            poster: {
                default: null,
                parseHTML: (element) => element.getAttribute('poster'),
            },
            preload: {
                default: 'metadata',
                parseHTML: (element) => element.getAttribute('preload') ?? 'metadata',
            },
        };
    },

    parseHTML() {
        return [{ tag: 'video[src]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return [
            'video',
            mergeAttributes(HTMLAttributes, {
                controls: '',
                playsinline: '',
                preload: HTMLAttributes.preload ?? 'metadata',
            }),
        ];
    },
});


function getTextNodesIn(el: Element): Text[] {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        nodes.push(node as Text);
    }
    return nodes;
}

function findTextMatches(
    textNodes: Text[],
    query: string
): Array<{ node: Text; start: number; end: number }> {
    const matches: Array<{ node: Text; start: number; end: number }> = [];
    const lowerQuery = query.toLowerCase();
    for (const textNode of textNodes) {
        const data = textNode.data.toLowerCase();
        let pos = 0;
        while ((pos = data.indexOf(lowerQuery, pos)) !== -1) {
            matches.push({ node: textNode, start: pos, end: pos + query.length });
            pos++;
        }
    }
    return matches;
}

function normalizeConversationPath(url: string): string {
    try {
        return new URL(url, window.location.href).pathname.replace(/\/$/, '');
    } catch {
        return url.split(/[?#]/)[0].replace(/\/$/, '');
    }
}

/**
 * Extract the conversation UUID from a URL that may be either:
 *   /c/{id}                        — plain conversation
 *   /g/{gpt-slug}/c/{id}           — custom-GPT-scoped conversation
 *   /gem/{hex}/{hex}               — Gemini Gem conversation
 */
function extractConversationIdFromUrl(url: string): string | null {
    const path = normalizeConversationPath(url);
    // ChatGPT-style: /c/{uuid} or /g/{slug}/c/{uuid}
    const chatgptMatch = path.match(/\/c\/([a-f0-9-]{8,})/i);
    if (chatgptMatch) return chatgptMatch[1].toLowerCase();
    // Gemini Gem: /gem/{hex}/{hex}
    const gemMatch = path.match(/\/gem\/([a-f0-9]+\/[a-f0-9]+)/i);
    if (gemMatch) return gemMatch[1].toLowerCase();
    return null;
}

function matchesBulkCaptureTarget(graph: ConversationGraph, item: BulkItem): boolean {
    const graphId = extractConversationIdFromUrl(graph.source.url);
    const itemId  = extractConversationIdFromUrl(item.url) ?? item.id.toLowerCase();
    if (graphId && itemId) return graphId === itemId;
    // Fallback: full path comparison
    return normalizeConversationPath(graph.source.url) === normalizeConversationPath(item.url);
}

function isGenericBulkCaptureTitle(title: string | undefined): boolean {
    if (!title) return true;
    return /^(chatgpt|untitled|project overview|new chat|google gemini|gemini|claude|claude chat|grok|copilot)$/i.test(title.trim());
}

function normalizeBulkCapturedGraph(graph: ConversationGraph, item: BulkItem): ConversationGraph {
    return {
        ...graph,
        title: isGenericBulkCaptureTitle(graph.title) ? item.title : graph.title,
    };
}

function hasNonEmptyContent(graph: ConversationGraph): boolean {
    return graph.messages.some(m =>
        m.content_blocks.some(b => {
            switch (b.type) {
                case 'markdown':
                case 'html':
                case 'text':
                case 'code':
                    return b.value.trim().length > 0;
                case 'image_ref':
                    return true;
                case 'table':
                    return b.rows.length > 0;
                case 'list':
                    return b.items.some(i => i.trim().length > 0);
                default:
                    return false;
            }
        })
    );
}

function isUsableBulkCapture(graph: ConversationGraph | undefined, item: BulkItem): graph is ConversationGraph {
    return Boolean(
        graph
        && matchesBulkCaptureTarget(graph, item)
        && graph.messages.length > 0
        && hasNonEmptyContent(graph)
    );
}

/**
 * Produce a human-readable diagnostic explaining why isUsableBulkCapture rejected
 * the graph. Returns null when the graph IS usable (shouldn't happen in practice
 * since this is only called on the failure path).
 */
function diagnoseBulkCaptureRejection(graph: ConversationGraph | undefined, item: BulkItem): string {
    if (!graph) return 'No graph returned by capture.';

    const urlMatch = matchesBulkCaptureTarget(graph, item);
    if (!urlMatch) {
        const graphId = extractConversationIdFromUrl(graph.source.url) ?? normalizeConversationPath(graph.source.url);
        const itemId  = extractConversationIdFromUrl(item.url) ?? item.id;
        return (
            `URL mismatch — captured ID "${graphId}" ≠ expected "${itemId}". ` +
            `Full captured path: "${normalizeConversationPath(graph.source.url)}".`
        );
    }

    if (graph.messages.length === 0) return 'Graph has 0 messages.';

    // Detailed content inspection
    const perMessage = graph.messages.map((m, i) => {
        const blockCount = m.content_blocks.length;
        const nonEmpty = m.content_blocks.filter(b => {
            switch (b.type) {
                case 'markdown': case 'html': case 'text': case 'code':
                    return b.value.trim().length > 0;
                case 'image_ref': return true;
                case 'table': return b.rows.length > 0;
                case 'list': return b.items.some(ii => ii.trim().length > 0);
                default: return false;
            }
        }).length;
        const types = m.content_blocks.map(b => b.type).join(',') || 'none';
        return `msg[${i}] role=${m.role} blocks=${blockCount} nonEmpty=${nonEmpty} types=[${types}]`;
    });

    return `All ${graph.messages.length} message(s) have empty content.\n` + perMessage.join('\n');
}

function stringifyBulkCaptureError(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.name || 'Unknown error';
    }

    if (typeof error === 'string') {
        return error;
    }

    if (error === null || error === undefined) {
        return 'Unknown error';
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function formatBulkFailureReason(stage: string, error?: unknown): string {
    const detail = error === undefined ? '' : stringifyBulkCaptureError(error).replace(/\s+/g, ' ').trim();
    const message = detail && detail !== 'Unknown error' ? `${stage}: ${detail}` : stage;
    return message.slice(0, 240);
}

/**
 * After loadConversation returns, verify the tab has arrived at the target URL
 * with a live content script AND that the conversation content is fully rendered.
 *
 * Using LOAD_CONVERSATION (rather than a bare GET_DIAGNOSTICS ping) achieves both:
 * - If the content script isn't alive yet, sendMessage throws → we keep polling.
 * - If the content script is alive but the conversation hasn't rendered yet,
 *   loadConversation() waits for a stable DOM fingerprint before returning.
 *
 * Required for the window.location.href fallback path where the page fully reloads
 * and a new content script must boot, navigate, and render before capture is safe.
 * For SPA navigations the call completes in < 50 ms (already at URL, content loaded).
 */
async function waitForTabReadyAtUrl(
    tabId: number,
    urlFragment: string,
    projectUrl?: string,
    timeoutMs = 90000
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.url?.includes(urlFragment)) {
                // Send LOAD_CONVERSATION — it waits internally for stable DOM content.
                // Throws if content script is not alive → caught below, keep polling.
                const loadResp = await chrome.tabs.sendMessage(tabId, {
                    type: 'LOAD_CONVERSATION',
                    id: urlFragment,
                    projectUrl,
                }).catch(() => null);
                if (loadResp?.success) return true;
            }
        } catch { /* tab navigating or content script not ready; continue */ }

        await new Promise(r => setTimeout(r, 600));
    }

    return false;
}

// Sub-component for Batch History Items to avoid Hook-in-Loop errors
const HistoryBatchItem = ({
    groupKey,
    group,
    onSelectMarkdown,
    onSelectSingle,
    onExportBatchOnly,
    markdownOptions
}: {
    groupKey: string;
    group: CapturedItem[];
    onSelectMarkdown: (markdown: string, mergedItem: CapturedItem, batchItems: CapturedItem[]) => void;
    onSelectSingle: (item: CapturedItem) => void;
    onExportBatchOnly: (group: CapturedItem[]) => void;
    markdownOptions?: MarkdownExportOptions;
}) => {
    const [expanded, setExpanded] = useState(false);
    const [batchLoading, setBatchLoading] = useState(false);
    const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
    const cancelRef = useRef(false);

    const handleBatchLoad = async () => {
        cancelRef.current = false;
        setBatchLoading(true);
        setBatchProgress({ current: 0, total: group.length });

        const CHUNK_SIZE = 5;
        const markdowns: string[] = [];

        for (let i = 0; i < group.length; i += CHUNK_SIZE) {
            if (cancelRef.current) {
                setBatchLoading(false);
                return;
            }

            const chunk = group.slice(i, i + CHUNK_SIZE);
            for (const item of chunk) {
                const md = exportToMarkdown(item.data, markdownOptions);
                markdowns.push(`# Conversation: ${item.data.title || 'Untitled'}\n\n${md}`);
            }
            setBatchProgress({ current: Math.min(i + CHUNK_SIZE, group.length), total: group.length });

            // Yield to the browser between chunks
            await new Promise(r => setTimeout(r, 0));
        }

        if (cancelRef.current) {
            setBatchLoading(false);
            return;
        }

        const fullMarkdown = markdowns.join('\n\n---\n\n');

        const mergedMessages = group.flatMap(g => g.data.messages);
        const mergedGraph: ConversationGraph = {
            ...group[0].data,
            title: `Batch Capture (${group.length}) - ${new Date(group[0].timestamp).toLocaleDateString()}`,
            messages: mergedMessages,
            artifacts: group.flatMap(g => g.data.artifacts || [])
        };

        const mergedItem: CapturedItem = {
            id: 'batch-merged',
            timestamp: group[0].timestamp,
            data: mergedGraph,
            batchId: groupKey
        };

        setBatchLoading(false);
        onSelectMarkdown(fullMarkdown, mergedItem, group);
    };

    const handleCancel = () => {
        cancelRef.current = true;
    };

    return (
        <div key={groupKey} className="history-group" style={{ marginBottom: '8px', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'var(--bg-secondary)', position: 'relative' }}>
            {/* Batch loading overlay */}
            {batchLoading && (
                <div style={{
                    position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 20,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    borderRadius: '4px', gap: '8px',
                }}>
                    <div style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>
                        Loading {batchProgress.current} / {batchProgress.total}
                    </div>
                    <div style={{ width: '70%', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}>
                        <div style={{
                            width: `${batchProgress.total ? (batchProgress.current / batchProgress.total) * 100 : 0}%`,
                            height: '100%', background: '#4ade80', borderRadius: '3px', transition: 'width 0.15s ease',
                        }} />
                    </div>
                    <button
                        className="btn btn-sm"
                        style={{ padding: '3px 14px', fontSize: '11px', background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', borderRadius: '4px', marginTop: '4px' }}
                        onClick={handleCancel}
                    >
                        Cancel
                    </button>
                </div>
            )}
            <div
                className="history-group-header"
                style={{ padding: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', userSelect: 'none' }}
            >
                <div
                    onClick={() => setExpanded(!expanded)}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)', flex: 1 }}
                >
                    <span style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', display: 'inline-block' }}>▶</span>
                    Batch Capture ({group.length})
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                        {new Date(group[0].timestamp).toLocaleDateString()}
                    </span>
                    <button
                        className="btn btn-sm btn-secondary"
                        style={{ padding: '2px 8px', fontSize: '11px', height: '24px', lineHeight: '1' }}
                        disabled={batchLoading}
                        onClick={(e) => {
                            e.stopPropagation();
                            handleBatchLoad();
                        }}
                    >
                        {batchLoading ? '⏳' : 'Load'}
                    </button>
                </div>
            </div>
            {expanded && (
                <div className="history-group-items" style={{ borderTop: '1px solid var(--border-color)' }}>
                    <div style={{ padding: '8px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-primary)' }}>
                        <button
                            className="btn btn-secondary btn-sm"
                            style={{ width: '100%', fontSize: '11px' }}
                            onClick={(e) => {
                                e.stopPropagation();
                                onExportBatchOnly(group);
                            }}
                        >
                            Export Batch Only
                        </button>
                    </div>
                    {group.map(item => (
                        <div
                            key={item.id}
                            className="history-item"
                            onClick={(e) => {
                                e.stopPropagation();
                                onSelectSingle(item);
                            }}
                            style={{ borderLeft: '3px solid var(--border-color)', marginLeft: '10px', padding: '8px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                        >
                            <div className="history-item-header">
                                <span className="history-item-title" style={{ color: 'var(--text-primary)' }}>
                                    {item.data.title ?? 'Untitled'}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export function SidePanel() {
    const [activeTab, setActiveTab] = useState<TabType>('capture');
    const [showCaptureMenu, setShowCaptureMenu] = useState(false);
    const [captures, setCaptures] = useState<CapturedItem[]>([]);
    const [currentCapture, setCurrentCapture] = useState<ConversationGraph | null>(null);
    const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
    const [insertMode, setInsertMode] = useState<'single' | 'upto' | 'from'>('upto');
    const [bulkItems, setBulkItems] = useState<BulkItem[]>([]);
    const [isBulkScanning, setIsBulkScanning] = useState(false);
    const [isBulkCapturing, setIsBulkCapturing] = useState(false);
    const [bulkDelay] = useState(3000);
    const isBulkCapturingRef = useRef(false);
    const [availableProjects, setAvailableProjects] = useState<ProjectInfo[]>([]);
    // scopeIncludeSidebar / scopeProjectUrls control what gets scanned; auto-discovered when bulk tab opens
    const [scopeIncludeSidebar, setScopeIncludeSidebar] = useState(true);
    const [scopeProjectUrls, setScopeProjectUrls] = useState<Set<string>>(new Set());
    const [isDiscoveringProjects, setIsDiscoveringProjects] = useState(false);
    const [lightboxImage, setLightboxImage] = useState<string | null>(null);
    const [exportBatch, setExportBatch] = useState<CapturedItem[] | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [captureSearchQuery, setCaptureSearchQuery] = useState('');
    const [captureSearchMiss, setCaptureSearchMiss] = useState(false);
    const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
        if (typeof window === 'undefined') {
            return 'system';
        }

        const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
        return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    });
    const [captureMetadataOptions, setCaptureMetadataOptions] = useState<CaptureMetadataOptions>(DEFAULT_CAPTURE_METADATA_OPTIONS);
    const [providerCaptureSettings, setProviderCaptureSettings] = useState<ProviderCaptureSettings>(() => normalizeProviderCaptureSettings(DEFAULT_PROVIDER_CAPTURE_SETTINGS));
    const captureSearchInputRef = useRef<HTMLInputElement | null>(null);
    const lastCaptureSearchQueryRef = useRef('');
    const [findStats, setFindStats] = useState<{ current: number; total: number } | null>(null);
    const findMatchesRef = useRef<Array<{ node: Text; start: number; end: number }>>([]);
    const findCurrentIndexRef = useRef(-1);

    const editor = useEditor({
        extensions: [
            StarterKit,
            BonsaiAnchorAttributes,
            Link.configure({
                openOnClick: false,
                autolink: false,
                linkOnPaste: true,
            }),
            Superscript,
            Table.configure({
                resizable: false,
            }),
            TableRow,
            TableHeader,
            TableCell,
            Image.configure({
                inline: true,
                allowBase64: true,
            }),
            BonsaiVideoNode,
            Placeholder.configure({
                placeholder: 'Type here or paste text to refine with AI...',
            }),
        ],
        content: '',
    });

    // Lightbox image and link click handler (Delegation)
    useEffect(() => {
        const handlePanelClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'IMG' && target.closest('.editor')) {
                const img = target as HTMLImageElement;
                setLightboxImage(img.src);
                return;
            }

            const anchor = target.closest('.editor a[href]') as HTMLAnchorElement | null;
            if (!anchor) {
                return;
            }

            const rawHref = anchor.getAttribute('href') ?? '';
            if (!rawHref) {
                return;
            }

            if (rawHref.startsWith('#')) {
                e.preventDefault();

                const targetId = rawHref.slice(1);
                const editorRoot = anchor.closest('.ProseMirror') ?? document.querySelector('.editor .ProseMirror');
                const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                    ? CSS.escape(targetId)
                    : targetId.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
                const destination = editorRoot?.querySelector<HTMLElement>(`#${escapedId}`);

                destination?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                return;
            }

            if (/^(https?:|mailto:)/i.test(rawHref)) {
                e.preventDefault();
                window.open(anchor.href, '_blank', 'noopener,noreferrer');
            }
        };

        const root = document.querySelector('.panel-content');
        if (root) root.addEventListener('click', handlePanelClick as any);
        return () => {
            if (root) root.removeEventListener('click', handlePanelClick as any);
        };
    }, []);

    // Helper to add capture to history
    const addToHistory = useCallback((data: ConversationGraph, url: string, tags?: string[], batchId?: string) => {
        const newCapture: CapturedItem = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            data,
            source: url,
            tags: tags || [],
            batchId
        };
        setCaptures(prev => {
            const newCaptures = [newCapture, ...prev].slice(0, 500);
            chrome.storage.local.set({ captures: newCaptures });
            return newCaptures;
        });
    }, []);

    const applyCaptureMetadataOptions = useCallback((graph: ConversationGraph): ConversationGraph => {
        const includeTimestamps = captureMetadataOptions.includeTimestamps;
        const includeModels = captureMetadataOptions.includeModels;
        const includeAnchors = captureMetadataOptions.includeAnchors;
        const includeArtifacts = captureMetadataOptions.includeArtifacts;
        const shouldKeepArtifactBlocks = (block: ContentBlock): boolean => {
            if (block.type === 'image_ref') {
                return false;
            }

            if (block.type === 'markdown') {
                return !/^\s*See appendix:/i.test(block.value.trim());
            }

            return true;
        };

        return {
            ...graph,
            messages: graph.messages.map((message) => ({
                ...message,
                artifact_ids: includeArtifacts ? message.artifact_ids : [],
                content_blocks: includeArtifacts ? message.content_blocks : message.content_blocks.filter(shouldKeepArtifactBlocks),
                created_at: includeTimestamps ? message.created_at : undefined,
                origin: includeModels
                    ? message.origin
                    : {
                        ...message.origin,
                        model: undefined,
                        confidence: 'unknown'
                    },
                deep_link: includeAnchors
                    ? message.deep_link
                    : {
                        ...message.deep_link,
                        message_anchor: undefined,
                        selector_hint: undefined
                    }
            })),
            artifacts: includeArtifacts
                ? graph.artifacts.map((artifact) => ({ ...artifact }))
                : []
        };
    }, [captureMetadataOptions]);

    const loadCaptureIntoEditor = useCallback((graph: ConversationGraph) => {
        setCurrentCapture(graph);

        if (editor) {
            const html = renderConversationGraphToHtml(graph, { artifactMode: captureMetadataOptions.artifactMode });
            editor.commands.setContent(html);
        }
    }, [editor, captureMetadataOptions.artifactMode]);

    const handleCaptureFind = useCallback((direction: 'forward' | 'backward' = 'forward') => {
        const query = captureSearchQuery.trim();
        if (!query) {
            setCaptureSearchMiss(false);
            setFindStats(null);
            findMatchesRef.current = [];
            findCurrentIndexRef.current = -1;
            return;
        }

        // Switch to capture tab first, then retry after DOM settles
        if (activeTab !== 'capture') {
            setActiveTab('capture');
            requestAnimationFrame(() => requestAnimationFrame(() => handleCaptureFind(direction)));
            return;
        }

        const editorRoot = document.querySelector<Element>('.editor .ProseMirror');
        if (!editorRoot) {
            setCaptureSearchMiss(true);
            return;
        }

        // Recompute match list when query changes
        const queryChanged = lastCaptureSearchQueryRef.current !== query;
        if (queryChanged) {
            findMatchesRef.current = findTextMatches(getTextNodesIn(editorRoot), query);
            findCurrentIndexRef.current = -1;
            lastCaptureSearchQueryRef.current = query;
        }

        const matches = findMatchesRef.current;
        if (matches.length === 0) {
            setCaptureSearchMiss(true);
            setFindStats({ current: 0, total: 0 });
            return;
        }

        // Advance index
        const prev = findCurrentIndexRef.current;
        let next: number;
        if (prev < 0 || queryChanged) {
            next = direction === 'backward' ? matches.length - 1 : 0;
        } else if (direction === 'forward') {
            next = (prev + 1) % matches.length;
        } else {
            next = (prev - 1 + matches.length) % matches.length;
        }
        findCurrentIndexRef.current = next;

        setFindStats({ current: next + 1, total: matches.length });
        setCaptureSearchMiss(false);

        // Select the matched text range and scroll it into view
        const match = matches[next];
        try {
            const range = document.createRange();
            range.setStart(match.node, match.start);
            range.setEnd(match.node, match.end);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            match.node.parentElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch {
            // Text node may have been removed by a DOM mutation — reset for next search
            findMatchesRef.current = [];
            findCurrentIndexRef.current = -1;
            lastCaptureSearchQueryRef.current = '';
        }
    }, [activeTab, captureSearchQuery]);

    const handleCaptureSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleCaptureFind(event.shiftKey ? 'backward' : 'forward');
        }

        if (event.key === 'Escape') {
            setCaptureSearchQuery('');
            setCaptureSearchMiss(false);
        }
    }, [handleCaptureFind]);

    const handleAddTag = (id: string, tag: string) => {
        if (!tag.trim()) return;
        setCaptures(prev => {
            const updated = prev.map(c => {
                if (c.id === id) {
                    const tags = c.tags || [];
                    if (!tags.includes(tag)) return { ...c, tags: [...tags, tag] };
                }
                return c;
            });
            chrome.storage.local.set({ captures: updated });
            return updated;
        });
    };

    const handleRemoveTag = (id: string, tag: string) => {
        setCaptures(prev => {
            const updated = prev.map(c => {
                if (c.id === id) {
                    return { ...c, tags: (c.tags || []).filter(t => t !== tag) };
                }
                return c;
            });
            chrome.storage.local.set({ captures: updated });
            return updated;
        });
    };

    // Load captures from storage
    useEffect(() => {
        chrome.storage.local.get(['captures', 'insertMode', 'captureMetadataOptions', 'providerCaptureSettings'], (result) => {
            setCaptures(result.captures ?? []);
            if (result.insertMode) setInsertMode(result.insertMode);
            if (result.captureMetadataOptions) {
                setCaptureMetadataOptions({
                    ...DEFAULT_CAPTURE_METADATA_OPTIONS,
                    ...result.captureMetadataOptions
                });
            }
            setProviderCaptureSettings(normalizeProviderCaptureSettings(result.providerCaptureSettings));
        });
    }, []);

    useEffect(() => {
        chrome.storage.local.set({ captureMetadataOptions });
    }, [captureMetadataOptions]);

    useEffect(() => {
        chrome.storage.local.set({ providerCaptureSettings });
    }, [providerCaptureSettings]);

    useEffect(() => {
        applyThemePreference(themePreference);
        window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    }, [themePreference]);

    useEffect(() => {
        if (themePreference !== 'system') return;

        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleThemeChange = () => applyThemePreference('system');

        mediaQuery.addEventListener('change', handleThemeChange);
        return () => mediaQuery.removeEventListener('change', handleThemeChange);
    }, [themePreference]);

    useEffect(() => {
        if (!captureSearchQuery.trim()) {
            setCaptureSearchMiss(false);
            setFindStats(null);
            findMatchesRef.current = [];
            findCurrentIndexRef.current = -1;
            lastCaptureSearchQueryRef.current = '';
        }
    }, [captureSearchQuery]);

    useEffect(() => {
        lastCaptureSearchQueryRef.current = '';
        findMatchesRef.current = [];
        findCurrentIndexRef.current = -1;
        setCaptureSearchMiss(false);
        setFindStats(null);
    }, [currentCapture?.conversation_id]);

    // Save insert mode when changed
    const handleSetInsertMode = (mode: 'single' | 'upto' | 'from') => {
        setInsertMode(mode);
        chrome.storage.local.set({ insertMode: mode });
        setShowCaptureMenu(false);
    };

    const handleClaudeCaptureSettingsChange = useCallback((updates: Partial<ProviderCaptureSettings['claude']>) => {
        setProviderCaptureSettings((prev) => normalizeProviderCaptureSettings({
            ...prev,
            claude: {
                ...prev.claude,
                ...updates,
            },
        }));
    }, []);

    // Get diagnostics from content script
    useEffect(() => {
        const getDiagnostics = async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.id) return;

                const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTICS' });
                if (response) {
                    setDiagnostics(response);
                }
            } catch (e) {
                // Content script not loaded or site not supported
                setDiagnostics(null);
            }
        };

        getDiagnostics();
        const interval = setInterval(getDiagnostics, 3000);
        return () => clearInterval(interval);
    }, []);

    // Immediately reset diagnostics when the user switches tabs so the next poll picks up the new provider
    useEffect(() => {
        const handleTabActivated = () => setDiagnostics(null);
        const handleTabUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
            if (changeInfo.status === 'complete') setDiagnostics(null);
        };
        chrome.tabs.onActivated.addListener(handleTabActivated);
        chrome.tabs.onUpdated.addListener(handleTabUpdated);
        return () => {
            chrome.tabs.onActivated.removeListener(handleTabActivated);
            chrome.tabs.onUpdated.removeListener(handleTabUpdated);
        };
    }, []);

    // Auto-discover projects when the user opens the Bulk tab
    useEffect(() => {
        if (activeTab === 'bulk' && availableProjects.length === 0 && !isDiscoveringProjects) {
            discoverProjectsForScope();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab]);

    // Listen for inline button clicks (MESSAGE_SELECTED from background)
    useEffect(() => {
        const handleMessage = async (message: any) => {
            if (message.type === 'MESSAGE_SELECTED') {
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (!tab?.id) return;

                    const response = await chrome.tabs.sendMessage(tab.id, {
                        type: 'CAPTURE',
                        scope: insertMode,
                        providerCaptureSettings,
                        messageId: message.messageId,
                        messageIndex: message.messageIndex
                    });

                    if (response?.data) {
                        const preparedGraph = applyCaptureMetadataOptions(response.data);
                        loadCaptureIntoEditor(preparedGraph);

                        // Add to history
                        addToHistory(preparedGraph, tab.url || '');

                        setActiveTab('capture');
                    }
                } catch (e) {
                    console.error('Insert from DOM failed:', e);
                }
            }
        };

        chrome.runtime.onMessage.addListener(handleMessage);
        return () => chrome.runtime.onMessage.removeListener(handleMessage);
    }, [insertMode, providerCaptureSettings, addToHistory, applyCaptureMetadataOptions, loadCaptureIntoEditor]);

    // Paste captured content into the focused element on the active page
    const handlePaste = useCallback(async () => {
        if (!editor) return;

        const text = editor.getText();
        if (!text.trim()) return;

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;

            await chrome.tabs.sendMessage(tab.id, { type: 'PASTE_TEXT', text });
        } catch (e) {
            console.error('Failed to paste:', e);
        }
    }, [editor]);

    // Capture entire conversation
    const handleCaptureAll = useCallback(async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;

            const response = await chrome.tabs.sendMessage(tab.id, {
                type: 'CAPTURE',
                scope: 'entire',
                providerCaptureSettings,
            });

            if (response?.data) {
                const preparedGraph = applyCaptureMetadataOptions(response.data);
                loadCaptureIntoEditor(preparedGraph);
                addToHistory(preparedGraph, tab.url || '');
            }
        } catch (e) {
            console.error('Capture failed:', e);
        }
    }, [providerCaptureSettings, addToHistory, applyCaptureMetadataOptions, loadCaptureIntoEditor]);

    // Export handlers
    const handleExport = useCallback((format: 'markdown' | 'json' | 'html' | 'toon') => {
        if (!currentCapture) return;

        let content: string;
        let filename: string;
        let mimeType: string;

        switch (format) {
            case 'markdown':
                content = exportToMarkdown(currentCapture, { artifactMode: captureMetadataOptions.artifactMode });
                filename = `${currentCapture.title ?? 'conversation'}.md`;
                mimeType = 'text/markdown';
                break;
            case 'json':
                content = exportToJSON(currentCapture);
                filename = `${currentCapture.title ?? 'conversation'}.json`;
                mimeType = 'application/json';
                break;
            case 'html':
                content = exportToHtml(currentCapture, { artifactMode: captureMetadataOptions.artifactMode });
                filename = `${currentCapture.title ?? 'conversation'}.html`;
                mimeType = 'text/html';
                break;
            case 'toon':
                content = exportToTOONString(currentCapture);
                filename = `${currentCapture.title ?? 'conversation'}.toon.json`;
                mimeType = 'application/json';
                break;
            default:
                return;
        }

        // Download file
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }, [currentCapture]);

    // Insert to editor
    const discoverProjectsForScope = async () => {
        setIsDiscoveringProjects(true);
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'DISCOVER_PROJECTS' }).catch(() => null);
            if (response?.projects) {
                const projects = response.projects as ProjectInfo[];
                setAvailableProjects(projects);
                // Auto-select all discovered projects that aren't already scoped
                setScopeProjectUrls(prev => {
                    const next = new Set(prev);
                    projects.forEach(p => next.add(p.url));
                    return next;
                });
            }
        } catch (e) {
            console.error('Project discovery failed', e);
        } finally {
            setIsDiscoveringProjects(false);
        }
    };

    const handleScan = async () => {
        setIsBulkScanning(true);
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;

            const addItems = (newItems: any[], projectName?: string) => {
                setBulkItems(prev => {
                    const existingIds = new Set(prev.map(i => i.id));
                    const mapped = newItems
                        .filter((i: any) => !existingIds.has(i.id))
                        .map((i: any) => ({
                            id: i.id,
                            title: i.title,
                            url: i.url,
                            status: 'pending' as const,
                            selected: true,
                            ...(projectName ? { projectName } : i.projectName ? { projectName: i.projectName } : {}),
                            ...(i.projectUrl ? { projectUrl: i.projectUrl } : {}),
                        }));
                    return [...prev, ...mapped];
                });
            };

            // 1. Sidebar scan
            if (scopeIncludeSidebar) {
                const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_SIDEBAR' }).catch(() => null);
                if (response?.items) addItems(response.items);
            }

            // 2. Project scans — done sequentially so the content script has time to navigate
            for (const project of availableProjects) {
                if (!scopeProjectUrls.has(project.url)) continue;

                // SCAN_PROJECT causes the page to navigate; wait for the new content script
                // The SCAN_PROJECT handler returns only after it has finished scrolling.
                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'SCAN_PROJECT',
                    projectUrl: project.url,
                    projectName: project.name,
                }).catch(() => null);

                if (response?.items) {
                    addItems(response.items, project.name);
                }

                // After navigation, re-query the tab to get updated tabId if needed
                // (tab ID stays stable across SPA navigations; refresh the handle)
                const [refreshedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (refreshedTab?.id) Object.assign(tab, refreshedTab);
            }
        } catch (e) {
            console.error('Scan failed', e);
        } finally {
            setIsBulkScanning(false);
        }
    };

    /** Send a message to a tab with a timeout — prevents the bulk loop from stalling
     *  indefinitely when a content script hangs on a complex page. */
    const sendMessageWithTimeout = <T = unknown>(
        tabId: number,
        message: unknown,
        timeoutMs: number,
    ): Promise<T> => {
        return Promise.race([
            chrome.tabs.sendMessage(tabId, message) as Promise<T>,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`sendMessage timed out after ${timeoutMs}ms`)), timeoutMs),
            ),
        ]);
    };

    const handleBulkCapture = async () => {
        setIsBulkCapturing(true);
        isBulkCapturingRef.current = true;

        // Reset all previously-captured items back to pending so they re-capture
        setBulkItems(prev => prev.map(i =>
            i.selected && (i.status === 'success' || i.status === 'error')
                ? { ...i, status: 'pending' as const, failureReason: undefined }
                : i
        ));

        try {
            const setBulkItemStatus = (itemId: string, status: BulkItem['status'], failureReason?: string) => {
                setBulkItems(prev => prev.map(i => i.id === itemId
                    ? {
                        ...i,
                        status,
                        failureReason: status === 'error' ? (failureReason ?? i.failureReason) : undefined,
                    }
                    : i
                ));
            };

            const itemsToCapture = bulkItems.filter(i => i.selected);
            const batchId = crypto.randomUUID();
            const batchCapturedItems: CapturedItem[] = [];

            for (const item of itemsToCapture) {
                if (!isBulkCapturingRef.current) break;

                let lastFailureReason = '';
                const markFailure = (reason: string) => {
                    lastFailureReason = reason;
                    setBulkItemStatus(item.id, 'error', reason);
                };

                try {
                    setBulkItemStatus(item.id, 'capturing');

                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (!tab?.id) {
                        markFailure('No active tab was available for bulk capture.');
                        continue;
                    }

                    const loadResponse = await sendMessageWithTimeout<any>(tab.id, {
                        type: 'LOAD_CONVERSATION',
                        id: item.id,
                        projectUrl: item.projectUrl,
                    }, 30000).catch(() => null);

                    // If SPA navigation failed AND this is a project conversation,
                    // fall back to a hard URL navigation via scripting.executeScript so
                    // the content script is not required to find a project back-link in
                    // the sidebar (which is unreliable due to virtual DOM rendering).
                    if (!loadResponse?.success) {
                        if (item.projectUrl) {
                            lastFailureReason = 'LOAD_CONVERSATION did not report success; falling back to a direct project reload.';
                            try {
                                await chrome.scripting.executeScript({
                                    target: { tabId: tab.id },
                                    world: 'MAIN',
                                    func: (url: string) => { location.href = url; },
                                    args: [item.url],
                                });
                                // Fall through to waitForTabReadyAtUrl below — it will
                                // poll until the reloaded page's content script is ready.
                            } catch (navError) {
                                markFailure(formatBulkFailureReason('Direct project reload failed', navError));
                                continue;
                            }
                        } else {
                            markFailure('LOAD_CONVERSATION did not report success for a non-project conversation.');
                            continue;
                        }
                    }

                    // Verify the tab has arrived at the target URL with an active content
                    // script and fully-rendered conversation content.
                    // For hard-navigated project items we pass no projectUrl — we are
                    // already at /c/{id} so no further navigation is needed inside
                    // loadConversation; it just checks the DOM fingerprint.
                    const waitProjectUrl = loadResponse?.success ? item.projectUrl : undefined;
                    const tabReady = await waitForTabReadyAtUrl(tab.id, item.id, waitProjectUrl, 90000);
                    if (!tabReady) {
                        markFailure(
                            loadResponse?.success
                                ? 'Timed out waiting for the conversation to stabilize after navigation.'
                                : 'Timed out waiting for the reloaded project conversation to stabilize.'
                        );
                        continue;
                    }

                    let capturedGraph: ConversationGraph | null = null;
                    const maxAttempts = 3;

                    for (let attempt = 0; attempt < maxAttempts && isBulkCapturingRef.current; attempt++) {
                        try {
                            const response = await sendMessageWithTimeout<any>(tab.id, {
                                type: 'CAPTURE',
                                scope: 'entire',
                                providerCaptureSettings,
                            }, 60000);

                            const graph = response?.data as ConversationGraph | undefined;
                            const captureData = response?.data as { messages?: unknown[] } | undefined;
                            const messageCount = Array.isArray(captureData?.messages)
                                ? captureData.messages.length
                                : 0;
                            if (isUsableBulkCapture(graph, item)) {
                                capturedGraph = applyCaptureMetadataOptions(normalizeBulkCapturedGraph(graph, item));
                                break;
                            }

                            const diagDetail = diagnoseBulkCaptureRejection(graph, item);
                            lastFailureReason = messageCount > 0
                                ? `attempt ${attempt + 1}/${maxAttempts}: ${diagDetail}`
                                : `attempt ${attempt + 1}/${maxAttempts}: returned no graph data.`;
                        } catch (captureErr) {
                            lastFailureReason = formatBulkFailureReason(
                                `CAPTURE attempt ${attempt + 1}/${maxAttempts} failed`,
                                captureErr
                            );
                            console.warn('[Bonsai] Bulk CAPTURE attempt failed', item.id, attempt, captureErr);
                        }

                        if (attempt < maxAttempts - 1) {
                            await new Promise(r => setTimeout(r, bulkDelay));
                        }
                    }

                    if (capturedGraph) {
                        addToHistory(capturedGraph, item.url, ['bulk'], batchId);
                        batchCapturedItems.push({
                            id: crypto.randomUUID(),
                            timestamp: new Date().toISOString(),
                            data: capturedGraph,
                            source: item.url,
                            tags: ['bulk'],
                            batchId,
                        });
                        setBulkItemStatus(item.id, 'success');
                    } else {
                        markFailure(lastFailureReason || `CAPTURE failed after ${maxAttempts} attempts.`);
                    }
                } catch (itemError) {
                    const reason = formatBulkFailureReason('Bulk capture item failed', itemError);
                    console.error('Bulk capture item failed', item.id, itemError);
                    setBulkItemStatus(item.id, 'error', reason);
                }
            }

            // Auto-load the captured batch into the export panel from our in-memory list
            // (avoids the race with chrome.storage.local async write).
            if (batchCapturedItems.length > 0) {
                setExportBatch(batchCapturedItems);
                const mergedMessages = batchCapturedItems.flatMap(g => g.data.messages);
                const mergedGraph: ConversationGraph = {
                    ...batchCapturedItems[0].data,
                    title: `Batch Capture (${batchCapturedItems.length}) - ${new Date().toLocaleDateString()}`,
                    messages: mergedMessages,
                    artifacts: batchCapturedItems.flatMap(g => g.data.artifacts || [])
                };
                setCurrentCapture(mergedGraph);
            }

        } catch (e) {
            console.error('Bulk capture loop error', e);
        } finally {
            setIsBulkCapturing(false);
            isBulkCapturingRef.current = false;
        }
    };

    const handleToggleCaptureMetadataOption = (key: 'includeTimestamps' | 'includeModels' | 'includeAnchors' | 'includeArtifacts') => {
        setCaptureMetadataOptions((prev) => ({
            ...prev,
            [key]: !prev[key]
        }));
    };

    const handleSetArtifactMode = (mode: 'inline' | 'appendix') => {
        setCaptureMetadataOptions((prev) => ({
            ...prev,
            artifactMode: mode
        }));
    };

    const isClaudeProvider = diagnostics?.site === 'claude.ai' || diagnostics?.provider === 'Anthropic';

    const handleInsertToEditor = useCallback((item: CapturedItem) => {
        if (!editor) return;

        loadCaptureIntoEditor(item.data);
        setActiveTab('capture');
    }, [editor, loadCaptureIntoEditor]);

    const handleBulkExport = async (format: 'markdown' | 'json' | 'html', items?: CapturedItem[]) => {
        // If items are passed (from History Batch Export), use them.
        // Otherwise use selected bulk items (which might be empty if we moved away).
        // Actually, we are deprecating the Bulk Tab export buttons.
        // So this will primarily be used with 'items' or we need to map BulkItems to CapturedItems if called from Bulk Tab (but we removed those buttons).

        let targetItems: CapturedItem[] = [];

        if (items) {
            targetItems = items;
        } else {
            // Fallback or legacy support if needed, but we rely on 'items' for now.
            return;
        }

        if (targetItems.length === 0) return;

        const zip = new JSZip();

        const titleCounts = new Map<string, number>();
        for (const item of targetItems) {
            const safeTitle = (item.data.title || 'untitled').replace(/[^a-z0-9\-_]/gi, '_').replace(/^_+|_+$/g, '').substring(0, 60) || 'untitled';
            const count = titleCounts.get(safeTitle) ?? 0;
            titleCounts.set(safeTitle, count + 1);
        }
        const titleSeen = new Map<string, number>();

        for (const item of targetItems) {
            const safeTitle = (item.data.title || 'untitled').replace(/[^a-z0-9\-_]/gi, '_').replace(/^_+|_+$/g, '').substring(0, 60) || 'untitled';
            const isDuplicate = (titleCounts.get(safeTitle) ?? 0) > 1;
            const seq = (titleSeen.get(safeTitle) ?? 0) + 1;
            titleSeen.set(safeTitle, seq);
            const filename = isDuplicate ? `${safeTitle}_${seq}` : safeTitle;

            if (format === 'markdown') {
                const content = exportToMarkdown(item.data, { artifactMode: captureMetadataOptions.artifactMode });
                zip.file(`${filename}.md`, content);
            } else if (format === 'json') {
                const content = exportToJSON(item.data);
                zip.file(`${filename}.json`, content);
            } else if (format === 'html') {
                const content = exportToHtml(item.data);
                zip.file(`${filename}.html`, content);
            }
        }

        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bonsai-batch-export-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="side-panel">
            {/* Header */}
            <header className="panel-header">
                <div className="panel-brand">
                    <div className="panel-brand-copy">
                        <h1>Bonsai Capture</h1>
                        <p>Capture, search, and ship conversations cleanly.</p>
                    </div>
                </div>

                <div className="panel-toolbar">
                    <div className={`capture-search ${captureSearchMiss ? 'miss' : ''}`}>
                        <input
                            ref={captureSearchInputRef}
                            type="search"
                            className="input capture-search-input"
                            placeholder="Find in capture"
                            value={captureSearchQuery}
                            onChange={(event) => setCaptureSearchQuery(event.target.value)}
                            onKeyDown={handleCaptureSearchKeyDown}
                            aria-label="Find text in capture"
                        />
                        {findStats !== null && (
                            <span className={`find-stat${findStats.total === 0 ? ' find-stat-miss' : ''}`}>
                                {findStats.total === 0 ? '0/0' : `${findStats.current}/${findStats.total}`}
                            </span>
                        )}
                        <button
                            className="btn btn-ghost btn-icon"
                            onClick={() => handleCaptureFind('backward')}
                            title="Previous match"
                            aria-label="Previous match"
                        >
                            ↑
                        </button>
                        <button
                            className="btn btn-ghost btn-icon"
                            onClick={() => handleCaptureFind('forward')}
                            title="Next match"
                            aria-label="Next match"
                        >
                            ↓
                        </button>
                    </div>

                    <div className="theme-toggle" role="group" aria-label="Theme preference">
                        {THEME_OPTIONS.map((option) => (
                            <button
                                key={option}
                                className={`theme-toggle-option ${themePreference === option ? 'active' : ''}`}
                                onClick={() => setThemePreference(option)}
                                aria-pressed={themePreference === option}
                                title={`${THEME_LABELS[option]} theme`}
                            >
                                {THEME_ICONS[option]}
                            </button>
                        ))}
                    </div>
                </div>
            </header>

            {/* Tabs */}
            {/* Lightbox */}
            {lightboxImage && (
                <div
                    className="lightbox-overlay"
                    onClick={() => setLightboxImage(null)}
                >
                    <img src={lightboxImage} className="lightbox-content" alt="Full size" />
                </div>
            )}

            <nav className="tabs">
                <button
                    className={`tab ${activeTab === 'capture' ? 'active' : ''}`}
                    onClick={() => setActiveTab('capture')}
                >
                    Capture
                </button>
                <button
                    className={`tab ${activeTab === 'history' ? 'active' : ''}`}
                    onClick={() => setActiveTab('history')}
                >
                    History
                </button>
                <button
                    className={`tab ${activeTab === 'export' ? 'active' : ''}`}
                    onClick={() => setActiveTab('export')}
                >
                    Export
                </button>
                <button
                    className={`tab ${activeTab === 'bulk' ? 'active' : ''}`}
                    onClick={() => setActiveTab('bulk')}
                >
                    Bulk
                </button>
            </nav>


            {/* Content */}
            <div className="panel-content">
                {activeTab === 'capture' && (
                    <>
                        {/* Diagnostics */}
                        <div className="diagnostics">
                            {diagnostics ? (
                                <>
                                    <div className="diagnostics-row">
                                        <span className="label">Provider</span>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <span className={`value ${diagnostics.provider ? 'success' : 'error'}`}>
                                                {diagnostics.provider ?? 'Not detected'}
                                            </span>
                                            <button
                                                className="btn-icon-tiny"
                                                onClick={async () => {
                                                    // Force-refresh: re-query diagnostics AND re-capture
                                                    setDiagnostics(null);
                                                    try {
                                                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                                                        if (!tab?.id) return;
                                                        // Re-fetch diagnostics
                                                        const diag = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTICS' }).catch(() => null);
                                                        if (diag) setDiagnostics(diag);
                                                        // Re-capture so the panel shows current content
                                                        const response = await chrome.tabs.sendMessage(tab.id, {
                                                            type: 'CAPTURE',
                                                            scope: 'entire',
                                                            providerCaptureSettings,
                                                        }).catch(() => null);
                                                        if (response?.data) {
                                                            const preparedGraph = applyCaptureMetadataOptions(response.data);
                                                            loadCaptureIntoEditor(preparedGraph);
                                                        }
                                                    } catch { /* content script not ready */ }
                                                }}
                                                title="Refresh Connection"
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    padding: '2px',
                                                    opacity: 0.7
                                                }}
                                            >
                                                🔄
                                            </button>
                                        </div>
                                    </div>
                                    <div className="diagnostics-row">
                                        <span className="label">Model</span>
                                        <span className={`value ${diagnostics.provenance?.confidence === 'observed' ? 'success' : 'warning'}`}>
                                            {diagnostics.provenance?.model ?? 'Unknown'}
                                        </span>
                                    </div>
                                    <div className="diagnostics-row">
                                        <span className="label">Messages</span>
                                        <span className="value">{diagnostics.messageCount}</span>
                                    </div>
                                    <div className="diagnostics-row">
                                        <span className="label">Artifacts</span>
                                        <span className="value">{currentCapture?.artifacts?.length ?? diagnostics.artifactCount ?? 0}</span>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="diagnostics-row">
                                        <span className="label">Status</span>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <span className="value warning">⏳ Connecting...</span>
                                            <button
                                                className="btn-icon-tiny"
                                                onClick={async () => {
                                                    setDiagnostics(null);
                                                    try {
                                                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                                                        if (!tab?.id || !tab.url) return;

                                                        // First try normal diagnostics check
                                                        let diag = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTICS' }).catch(() => null);

                                                        if (!diag) {
                                                            // Content script not loaded — ask background to re-inject
                                                            await chrome.runtime.sendMessage({
                                                                type: 'REINJECT_CONTENT_SCRIPT',
                                                                tabId: tab.id,
                                                                url: tab.url,
                                                            }).catch(() => null);

                                                            // Wait for content script to initialize
                                                            await new Promise(r => setTimeout(r, 1500));

                                                            diag = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTICS' }).catch(() => null);
                                                        }

                                                        if (diag) setDiagnostics(diag);
                                                    } catch { /* content script not ready */ }
                                                }}
                                                title="Retry Connection"
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    padding: '2px',
                                                    opacity: 0.7
                                                }}
                                            >
                                                🔄
                                            </button>
                                        </div>
                                    </div>
                                    <div className="diagnostics-row">
                                        <span className="label">Tip</span>
                                        <span className="value" style={{ fontSize: '11px' }}>
                                            Open a ChatGPT/Claude page and refresh
                                        </span>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Editor */}
                        <div className="editor-container">
                            <EditorContent editor={editor} className="editor" />
                        </div>

                        <div className="capture-settings-row">
                            <div className="capture-metadata-panel">
                                <div className="capture-metadata-title">Metadata</div>
                                <label className="capture-metadata-option">
                                    <input
                                        type="checkbox"
                                        checked={captureMetadataOptions.includeTimestamps}
                                        onChange={() => handleToggleCaptureMetadataOption('includeTimestamps')}
                                    />
                                    <span>Timestamps</span>
                                </label>
                                <label className="capture-metadata-option">
                                    <input
                                        type="checkbox"
                                        checked={captureMetadataOptions.includeModels}
                                        onChange={() => handleToggleCaptureMetadataOption('includeModels')}
                                    />
                                    <span>Model info</span>
                                </label>
                                <label className="capture-metadata-option">
                                    <input
                                        type="checkbox"
                                        checked={captureMetadataOptions.includeAnchors}
                                        onChange={() => handleToggleCaptureMetadataOption('includeAnchors')}
                                    />
                                    <span>Deep links</span>
                                </label>
                            </div>
                            <div className="capture-metadata-panel">
                                <div className="capture-metadata-title">Artifacts</div>
                                <label className="capture-metadata-option">
                                    <input
                                        type="checkbox"
                                        checked={captureMetadataOptions.includeArtifacts}
                                        onChange={() => handleToggleCaptureMetadataOption('includeArtifacts')}
                                    />
                                    <span>Include artifacts</span>
                                </label>
                                {captureMetadataOptions.includeArtifacts && (
                                    <div className="artifact-mode-toggle">
                                        <button
                                            className={`artifact-mode-btn ${captureMetadataOptions.artifactMode === 'inline' ? 'active' : ''}`}
                                            onClick={() => handleSetArtifactMode('inline')}
                                        >
                                            Inline
                                        </button>
                                        <button
                                            className={`artifact-mode-btn ${captureMetadataOptions.artifactMode === 'appendix' ? 'active' : ''}`}
                                            onClick={() => handleSetArtifactMode('appendix')}
                                        >
                                            Appendix
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="capture-metadata-hint">
                            Applies to inline insert, Capture All, and Bulk captures.
                        </div>

                        {isClaudeProvider && (
                            <div className="capture-metadata-panel">
                                <div className="capture-metadata-title">Claude Artifact Capture</div>
                                <label className="capture-provider-setting">
                                    <span className="capture-provider-setting-label">XPath</span>
                                    <input
                                        className="input"
                                        type="text"
                                        value={providerCaptureSettings.claude.xPath}
                                        onChange={(event) => handleClaudeCaptureSettingsChange({ xPath: event.target.value })}
                                        spellCheck={false}
                                    />
                                </label>
                                <label className="capture-provider-setting">
                                    <span className="capture-provider-setting-label">Delay Before Panel Capture (ms)</span>
                                    <input
                                        className="input"
                                        type="number"
                                        min={0}
                                        step={50}
                                        value={providerCaptureSettings.claude.panelCaptureDelayMs}
                                        onChange={(event) => handleClaudeCaptureSettingsChange({
                                            panelCaptureDelayMs: Number.isFinite(event.target.valueAsNumber)
                                                ? event.target.valueAsNumber
                                                : DEFAULT_PROVIDER_CAPTURE_SETTINGS.claude.panelCaptureDelayMs,
                                        })}
                                    />
                                </label>
                                <div className="capture-metadata-hint">
                                    Claude document artifacts use this XPath first, then fall back to the visible panel DOM. These settings apply to inline insert, Capture All, and bulk capture.
                                </div>
                            </div>
                        )}

                        {/* Actions */}
                        <div className="capture-actions">
                            <button className="btn btn-primary btn-full" onClick={handlePaste}>
                                📋 Paste
                            </button>

                            <div className="action-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', marginTop: '8px' }}>
                                <button className="btn btn-secondary" onClick={handleCaptureAll}>
                                    📥 Capture All
                                </button>

                                <div className="capture-dropdown" style={{ position: 'relative' }}>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => setShowCaptureMenu(!showCaptureMenu)}
                                        title="Inline Insert Behavior"
                                        style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', padding: '0 10px' }}
                                    >
                                        <span className="insert-mode-pill">
                                            {insertMode === 'upto' ? 'up to message' : insertMode === 'single' ? 'this message only' : 'from message'}
                                        </span>
                                        {showCaptureMenu ? '▲' : '▼'}
                                    </button>

                                    {showCaptureMenu && (
                                        <div className="capture-menu" style={{ right: 0, left: 'auto', width: '210px' }}>
                                            <div className="menu-header" style={{ padding: '8px', fontSize: '11px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                                                INLINE INSERT BEHAVIOR
                                            </div>
                                            <div
                                                className={`capture-menu-item ${insertMode === 'upto' ? 'active' : ''}`}
                                                onClick={() => handleSetInsertMode('upto')}
                                            >
                                                📍 Up to Message {insertMode === 'upto' && '✓'}
                                            </div>
                                            <div
                                                className={`capture-menu-item ${insertMode === 'single' ? 'active' : ''}`}
                                                onClick={() => handleSetInsertMode('single')}
                                            >
                                                💬 This Message Only {insertMode === 'single' && '✓'}
                                            </div>
                                            <div
                                                className={`capture-menu-item ${insertMode === 'from' ? 'active' : ''}`}
                                                onClick={() => handleSetInsertMode('from')}
                                            >
                                                ⬇️ This Message & Following {insertMode === 'from' && '✓'}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </>
                )}

                {activeTab === 'history' && (
                    <div className="history-list">
                        <div className="search-box" style={{ padding: '12px', position: 'sticky', top: 0, background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-color)', zIndex: 10 }}>
                            <input
                                type="text"
                                className="input"
                                placeholder="Search captures or tags..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                style={{ width: '100%', padding: '8px', fontSize: '13px' }}
                            />
                        </div>
                        {captures.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-state-icon">📭</div>
                                <div className="empty-state-title">No captures yet</div>
                                <div className="empty-state-desc">
                                    Capture a conversation to see it here
                                </div>
                            </div>
                        ) : (
                            (() => {
                                const filtered = captures.filter(item => {
                                    if (!searchTerm) return true;
                                    const term = searchTerm.toLowerCase();
                                    return (item.data.title?.toLowerCase().includes(term) ||
                                        item.tags?.some(tag => tag.toLowerCase().includes(term)));
                                });

                                const groups: Record<string, CapturedItem[]> = {};
                                filtered.forEach(item => {
                                    const key = item.batchId ?? item.id;
                                    if (!groups[key]) groups[key] = [];
                                    groups[key].push(item);
                                });

                                return Object.entries(groups).map(([key, group]) => {
                                    if (group.length > 1 && group[0].batchId) {
                                        return (
                                            <HistoryBatchItem
                                                key={key}
                                                groupKey={key}
                                                group={group}
                                                markdownOptions={{ artifactMode: captureMetadataOptions.artifactMode }}
                                                onSelectMarkdown={(markdown, mergedItem, batchItems) => {
                                                    setExportBatch(batchItems);
                                                    if (editor) {
                                                        const html = markdownToHtml(markdown);
                                                        editor.commands.setContent(html);
                                                    }
                                                    setCurrentCapture(mergedItem.data);
                                                    setActiveTab('capture');
                                                }}
                                                onSelectSingle={(item) => {
                                                    setExportBatch(null);
                                                    handleInsertToEditor(item);
                                                }}
                                                onExportBatchOnly={(grp) => {
                                                    setExportBatch(grp);
                                                    setActiveTab('export');
                                                }}
                                            />
                                        );
                                    } else {
                                        const item = group[0];
                                        return (
                                            <div
                                                key={item.id}
                                                className="history-item"
                                                onClick={() => {
                                                    setExportBatch(null);
                                                    handleInsertToEditor(item);
                                                }}
                                            >
                                                <div className="history-item-header">
                                                    <span className="history-item-title">
                                                        {item.data.title ?? 'Untitled'}
                                                    </span>
                                                    <span className="history-item-time">
                                                        {new Date(item.timestamp).toLocaleString()}
                                                    </span>
                                                </div>
                                                <div className="history-tag-list" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                                                    {item.tags?.map(tag => (
                                                        <span key={tag} className="tag" style={{ fontSize: '10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', padding: '1px 6px', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                            {tag}
                                                            <span onClick={(e) => { e.stopPropagation(); handleRemoveTag(item.id, tag); }} style={{ cursor: 'pointer', opacity: 0.6 }}>×</span>
                                                        </span>
                                                    ))}
                                                    <input
                                                        type="text"
                                                        placeholder="+ tag"
                                                        style={{ background: 'transparent', border: 'none', fontSize: '10px', width: '40px', outline: 'none' }}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                e.stopPropagation();
                                                                handleAddTag(item.id, (e.target as HTMLInputElement).value);
                                                                (e.target as HTMLInputElement).value = '';
                                                            }
                                                        }}
                                                        onClick={(e) => e.stopPropagation()}
                                                    />
                                                </div>
                                                <div className="history-item-preview">
                                                    {item.data.messages.length} messages from {item.data.source.provider_site}
                                                </div>
                                            </div>
                                        );
                                    }
                                });
                            })()
                        )}
                    </div>
                )}

                {activeTab === 'export' && (
                    <div className="export-panel">
                        {!currentCapture && !exportBatch ? (
                            <div className="empty-state">
                                <div className="empty-state-icon">📤</div>
                                <div className="empty-state-title">No capture selected</div>
                                <div className="empty-state-desc">
                                    Capture a conversation first, or select from history
                                </div>
                            </div>
                        ) : (
                            <>
                                {currentCapture && (
                                    <div style={{ marginBottom: '16px', background: 'var(--bg-secondary)', padding: '12px', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                                        {exportBatch ? (
                                            <>
                                                <div style={{ fontWeight: '600', marginBottom: '8px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                    <span style={{ background: 'var(--accent-primary)', color: 'white', padding: '2px 6px', borderRadius: '3px', fontSize: '10px' }}>BATCH</span>
                                                    Batch Selection
                                                </div>
                                                <div className="diagnostics-row">
                                                    <span className="label">Items</span>
                                                    <span className="value">{exportBatch.length} conversations</span>
                                                </div>
                                                <div className="diagnostics-row">
                                                    <span className="label">Total Messages</span>
                                                    <span className="value">{exportBatch.reduce((acc, item) => acc + item.data.messages.length, 0)}</span>
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <div className="diagnostics-row">
                                                    <span className="label">Title</span>
                                                    <span className="value">{currentCapture.title ?? 'Untitled'}</span>
                                                </div>
                                                <div className="diagnostics-row">
                                                    <span className="label">Messages</span>
                                                    <span className="value">{currentCapture.messages.length}</span>
                                                </div>
                                                <div className="diagnostics-row">
                                                    <span className="label">Artifacts</span>
                                                    <span className="value">{currentCapture.artifacts?.length || 0}</span>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}

                                <div className="export-format-grid" style={{ opacity: exportBatch ? 0.4 : 1, pointerEvents: exportBatch ? 'none' : 'auto' }}>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleExport('markdown')}
                                        disabled={!!exportBatch}
                                    >
                                        📝 Markdown
                                    </button>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleExport('json')}
                                        disabled={!!exportBatch}
                                    >
                                        📋 JSON
                                    </button>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleExport('html')}
                                        disabled={!!exportBatch}
                                    >
                                        🌐 HTML
                                    </button>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleExport('toon')}
                                        disabled={!!exportBatch}
                                    >
                                        🌳 TOON
                                    </button>
                                </div>
                            </>
                        )}

                        {exportBatch && (
                            <div style={{ marginTop: '24px', borderTop: '2px solid var(--border-color)', paddingTop: '16px' }}>
                                <div style={{ marginBottom: '12px', background: 'var(--bg-secondary)', padding: '12px', borderRadius: '4px', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                                    <strong>Selected Batch:</strong> {new Date(exportBatch[0].timestamp).toLocaleString()} ({exportBatch.length} items)
                                    <button
                                        style={{ float: 'right', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
                                        onClick={() => setExportBatch(null)}
                                    >
                                        ✕
                                    </button>
                                </div>
                                <div className="export-format-grid">
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleBulkExport('markdown', exportBatch)}
                                        title={`Download ${exportBatch.length} items as ZIP (Markdown)`}
                                    >
                                        📦 ZIP (MD)
                                    </button>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleBulkExport('json', exportBatch)}
                                        title={`Download ${exportBatch.length} items as ZIP (JSON)`}
                                    >
                                        📦 ZIP (JSON)
                                    </button>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleBulkExport('html', exportBatch)}
                                        title={`Download ${exportBatch.length} items as ZIP (HTML)`}
                                    >
                                        📦 ZIP (HTML)
                                    </button>
                                </div>
                                    </div>

                                </div>
                            );
                        })()}

                        <div className="bulk-actions">
                            <button
                                className={`btn btn-primary btn-full ${isBulkCapturing ? 'scanning' : ''}`}
                                onClick={handleBulkCapture}
                                disabled={isBulkScanning || isBulkCapturing || bulkItems.filter(i => i.selected).length === 0}
                            >
                                {isBulkCapturing ? 'Capturing...' : `Capture Selected (${bulkItems.filter(i => i.selected).length})`}
                            </button>
                        </div>

                        {isBulkCapturing && (
                            <button
                                className="btn btn-danger"
                                onClick={() => {
                                    isBulkCapturingRef.current = false;
                                    setIsBulkCapturing(false);
                                }}
                                style={{ width: '100%', marginTop: '8px', backgroundColor: 'var(--error)', color: 'white', border: 'none', padding: '8px' }}
                            >
                                Stop
                            </button>
                        )}

                        {!isBulkCapturing && bulkItems.some(i => i.status === 'success' || i.status === 'error') && (
                            <button
                                className="btn btn-secondary"
                                onClick={() => {
                                    setBulkItems(prev => prev.map(i => ({
                                        ...i,
                                        status: 'pending' as const,
                                        failureReason: undefined
                                    })));
                                }}
                                style={{ width: '100%', marginTop: '8px' }}
                            >
                                Clear Results
                            </button>
                        )}

                        <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border-color)', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                            <strong>Provider export:</strong>{' '}
                            <a href="https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>ChatGPT</a>,{' '}
                            <a href="https://support.anthropic.com/en/articles/8945820-how-can-i-export-my-claude-ai-data" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>Claude</a>,{' '}
                            <a href="https://support.google.com/gemini/answer/13743730" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>Gemini</a>
                        </div>
                    </div>
                )}
            </div>
        </div >
    );
}
