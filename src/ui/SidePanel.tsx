/**
 * SidePanel Component
 * 
 * Main UI for the Bonsai Capture extension.
 * Provides editor, capture controls, history, and export functionality.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Superscript from '@tiptap/extension-superscript';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import type { ConversationGraph } from '../shared/schema';
import { exportToMarkdown } from '../shared/exporters/markdown';
import { exportToJSON } from '../shared/exporters/json';

import { exportToTOONString } from '../shared/exporters/toon';
import { toBonsaiImportPackage } from '../shared/bonsai-adapter';
import { markdownToHtml } from '../shared/markdown-to-html';
import { renderConversationGraphToHtml } from '../shared/render-preview-html';
import bonsaiLogo from '../../../Bonsai-WebUI/src/components/icons/bonsai.png';

import JSZip from 'jszip';

type TabType = 'capture' | 'history' | 'export' | 'settings' | 'bulk';
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
}

const DEFAULT_CAPTURE_METADATA_OPTIONS: CaptureMetadataOptions = {
    includeTimestamps: true,
    includeModels: true,
    includeAnchors: true
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
}

interface Diagnostics {
    provider: string | null;
    site: string | null;
    hasConversation: boolean;
    messageCount: number;
    provenance: { provider?: string; model?: string; confidence: string } | null;
}


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

// Sub-component for Batch History Items to avoid Hook-in-Loop errors
const HistoryBatchItem = ({
    groupKey,
    group,
    onSelectMarkdown,
    onSelectSingle,
    onExportBatchOnly
}: {
    groupKey: string;
    group: CapturedItem[];
    onSelectMarkdown: (markdown: string, mergedItem: CapturedItem, batchItems: CapturedItem[]) => void;
    onSelectSingle: (item: CapturedItem) => void;
    onExportBatchOnly: (group: CapturedItem[]) => void;
}) => {
    const [expanded, setExpanded] = useState(false);

    const handleBatchLoad = () => {
        // Generate Concatenated Markdown
        const fullMarkdown = group.map(item => {
            const md = exportToMarkdown(item.data);
            return `# Conversation: ${item.data.title || 'Untitled'}\n\n${md}`;
        }).join('\n\n---\n\n');

        // Create a merged item structure just for context (retaining the first one's metadata)
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

        onSelectMarkdown(fullMarkdown, mergedItem, group);
    };

    return (
        <div key={groupKey} className="history-group" style={{ marginBottom: '8px', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'var(--bg-secondary)' }}>
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
                        onClick={(e) => {
                            e.stopPropagation();
                            handleBatchLoad();
                        }}
                    >
                        Load
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
    const [bulkLimit, setBulkLimit] = useState(10);
    const [bulkDelay, setBulkDelay] = useState(3000);
    const [bonsaiHost, setBonsaiHost] = useState('http://localhost:8080');
    const [bonsaiApiKey, setBonsaiApiKey] = useState('');
    const isBulkCapturingRef = useRef(false);
    const [lightboxImage, setLightboxImage] = useState<string | null>(null);
    const [exportBatch, setExportBatch] = useState<CapturedItem[] | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [importProgress, setImportProgress] = useState(0);
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

        return {
            ...graph,
            messages: graph.messages.map((message) => ({
                ...message,
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
            artifacts: graph.artifacts.map((artifact) => ({ ...artifact }))
        };
    }, [captureMetadataOptions]);

    const loadCaptureIntoEditor = useCallback((graph: ConversationGraph) => {
        setCurrentCapture(graph);

        if (editor) {
            const html = renderConversationGraphToHtml(graph);
            editor.commands.setContent(html);
        }
    }, [editor]);

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
        chrome.storage.local.get(['captures', 'insertMode', 'bonsaiHost', 'bonsaiApiKey', 'captureMetadataOptions'], (result) => {
            setCaptures(result.captures ?? []);
            if (result.insertMode) setInsertMode(result.insertMode);
            if (result.bonsaiHost) setBonsaiHost(result.bonsaiHost);
            if (result.bonsaiApiKey) setBonsaiApiKey(result.bonsaiApiKey);
            if (result.captureMetadataOptions) {
                setCaptureMetadataOptions({
                    ...DEFAULT_CAPTURE_METADATA_OPTIONS,
                    ...result.captureMetadataOptions
                });
            }
        });
    }, []);

    useEffect(() => {
        chrome.storage.local.set({ captureMetadataOptions });
    }, [captureMetadataOptions]);

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
    }, [insertMode, addToHistory, applyCaptureMetadataOptions, loadCaptureIntoEditor]);

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
                scope: 'entire'
            });

            if (response?.data) {
                const preparedGraph = applyCaptureMetadataOptions(response.data);
                loadCaptureIntoEditor(preparedGraph);
                addToHistory(preparedGraph, tab.url || '');
            }
        } catch (e) {
            console.error('Capture failed:', e);
        }
    }, [addToHistory, applyCaptureMetadataOptions, loadCaptureIntoEditor]);

    // Export handlers
    const handleExport = useCallback((format: string) => {
        if (!currentCapture) return;

        let content: string;
        let filename: string;
        let mimeType: string;

        switch (format) {
            case 'markdown':
                content = exportToMarkdown(currentCapture);
                filename = `${currentCapture.title ?? 'conversation'}.md`;
                mimeType = 'text/markdown';
                break;
            case 'json':
                content = exportToJSON(currentCapture);
                filename = `${currentCapture.title ?? 'conversation'}.json`;
                mimeType = 'application/json';
                break;
            case 'toon':
                content = exportToTOONString(currentCapture);
                filename = `${currentCapture.title ?? 'conversation'}.toon.json`;
                mimeType = 'application/json';
                break;
            case 'bonsai':
                content = JSON.stringify(toBonsaiImportPackage(currentCapture), null, 2);
                filename = `${currentCapture.title ?? 'conversation'}.bonsai.json`;
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
    const handleScanSidebar = async () => {
        setIsBulkScanning(true);
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;

            const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_SIDEBAR' });
            if (response && response.items) {
                const newItems = response.items;
                setBulkItems(prev => {
                    const existingIds = new Set(prev.map(i => i.id));
                    const uniqueNew = newItems.filter((i: any) => !existingIds.has(i.id)).map((i: any) => ({
                        ...i,
                        status: 'pending',
                        selected: true
                    }));
                    return [...prev, ...uniqueNew];
                });
            }
        } catch (e) {
            console.error('Scan failed', e);
        } finally {
            setIsBulkScanning(false);
        }
    };

    const handleBulkCapture = async () => {
        setIsBulkCapturing(true);
        isBulkCapturingRef.current = true;

        try {
            const itemsToCapture = bulkItems.filter(i => i.selected && i.status !== 'success');
            const batchId = crypto.randomUUID();

            for (const item of itemsToCapture) {
                if (!isBulkCapturingRef.current) break;

                setBulkItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'capturing' } : i));

                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.id) continue;

                await chrome.tabs.sendMessage(tab.id, { type: 'LOAD_CONVERSATION', id: item.id });

                await new Promise(r => setTimeout(r, bulkDelay));

                if (!isBulkCapturingRef.current) break;

                const response = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE', scope: 'entire' });

                if (response && response.data) {
                    const graph = applyCaptureMetadataOptions(response.data as ConversationGraph);
                    addToHistory(graph, item.url, ['bulk'], batchId);
                    setBulkItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'success' } : i));
                } else {
                    setBulkItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'error' } : i));
                }
            }

            // Auto-load the captured batch into context if any succeeded
            const successfulIds = bulkItems.filter(i => i.selected && i.status !== 'error').map(i => i.id); // Capturing becomes success
            if (successfulIds.length > 0) {
                // We need to fetch the CapturedItems. We rely on them being in state `captures`.
                // But `captures` state might not be updated immediately in this closure?
                // `addToHistory` calls `setCaptures`.
                // We can construct the batch group here from the `batchId` we just used.

                // However, we don't have access to the full `item` data here easily unless we retained it.
                // Let's assume the user will go to History or Export. 
                // But user specifically said: "I would expect that it should have loaded up the bulk capture"

                // We can trigger a lookup?
                // Or just set `exportBatch` manually if we can find them.
                // Since `captures` is a prop/state, it might be stale here.
                // But we can try to rely on the fact that we pushed them.

                // Alternative: Just Notify?
                // Best effort: set `exportBatch` using a functional update on `captures`? No, `setExportBatch` takes `CapturedItem[]`.

                // Let's defer to the user's manual action for now, OR try to reload from storage.
                chrome.storage.local.get(['captures'], (result) => {
                    const storedCaptures = result.captures as CapturedItem[] || [];
                    const batchItems = storedCaptures.filter(c => c.batchId === batchId);
                    if (batchItems.length > 0) {
                        setExportBatch(batchItems);
                        // Also set currentCapture to merged?
                        const mergedMessages = batchItems.flatMap(g => g.data.messages);
                        const mergedGraph: ConversationGraph = {
                            ...batchItems[0].data,
                            title: `Batch Capture (${batchItems.length}) - ${new Date().toLocaleDateString()}`,
                            messages: mergedMessages,
                            artifacts: batchItems.flatMap(g => g.data.artifacts || [])
                        };
                        setCurrentCapture(mergedGraph);
                        // Do NOT switch tab automatically? User said "Navigating to the export tab...".
                        // So if they navigate, it should be there.
                    }
                });
            }

        } catch (e) {
            console.error('Bulk capture loop error', e);
        } finally {
            setIsBulkCapturing(false);
            isBulkCapturingRef.current = false;
        }
    };

    const handleToggleCaptureMetadataOption = (key: keyof CaptureMetadataOptions) => {
        setCaptureMetadataOptions((prev) => ({
            ...prev,
            [key]: !prev[key]
        }));
    };

    const handleImportToBonsai = async () => {
        if (!currentCapture) return;
        setIsImporting(true);
        setImportProgress(0);

        try {
            const importPkg = toBonsaiImportPackage(currentCapture);

            const response = await fetch(`${bonsaiHost.replace(/\/$/, '')}/api/import/conversation`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `ApiKey ${bonsaiApiKey}`
                },
                body: JSON.stringify(importPkg)
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(err || `Import failed: ${response.statusText}`);
            }

            const result = await response.json();
            const conversationUrl = `${bonsaiHost.replace(/\/$/, '')}/c/${result.conversation_id}`;
            window.open(conversationUrl, '_blank');

            // alert('Imported successfully!');
        } catch (e: any) {
            console.error('Import Error:', e);
            alert(`Error importing to Bonsai: ${e.message}\nMake sure your Host and API Key are correct in Settings.`);
        } finally {
            setIsImporting(false);
            setImportProgress(0);
        }
    };

    const handleBulkImportToBonsai = async (items: CapturedItem[]) => {
        if (items.length === 0) return;
        setIsImporting(true);
        setImportProgress(0);

        let successCount = 0;
        let failCount = 0;

        try {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                try {
                    const importPkg = toBonsaiImportPackage(item.data);
                    const response = await fetch(`${bonsaiHost.replace(/\/$/, '')}/api/import/conversation`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `ApiKey ${bonsaiApiKey}`
                        },
                        body: JSON.stringify(importPkg)
                    });

                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    successCount++;
                } catch (e) {
                    console.error(`Failed to import item ${i}:`, e);
                    failCount++;
                }
                setImportProgress(Math.round(((i + 1) / items.length) * 100));
            }

            alert(`Bulk import complete.\nSuccess: ${successCount}\nFailed: ${failCount}`);
        } catch (e: any) {
            alert(`Bulk import failed: ${e.message}`);
        } finally {
            setIsImporting(false);
            setImportProgress(0);
        }
    };

    const handleSaveSettings = () => {
        chrome.storage.local.set({ bonsaiHost, bonsaiApiKey }, () => {
            // Simple visual feedback could be added here
            const btn = document.getElementById('save-settings-btn');
            if (btn) btn.textContent = 'Saved!';
            setTimeout(() => { if (btn) btn.textContent = 'Save Settings'; }, 1000);
        });
    };

    const handleInsertToEditor = useCallback((item: CapturedItem) => {
        if (!editor) return;

        loadCaptureIntoEditor(item.data);
        setActiveTab('capture');
    }, [editor, loadCaptureIntoEditor]);

    const handleBulkExport = async (format: 'markdown' | 'json', items?: CapturedItem[]) => {
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

        for (const item of targetItems) {
            // Use conversation ID to ensure uniqueness in the ZIP file
            const shortId = item.data.conversation_id.substring(0, 8);
            const safeTitle = (item.data.title || 'untitled').replace(/[^a-z0-9\-_]/gi, '_').substring(0, 50);
            const filename = `${safeTitle}_${shortId}`;

            if (format === 'markdown') {
                const content = exportToMarkdown(item.data);
                zip.file(`${filename}.md`, content);
            } else if (format === 'json') {
                const content = exportToJSON(item.data);
                zip.file(`${filename}.json`, content);
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
                    <img src={bonsaiLogo} alt="Bonsai" className="panel-logo" />
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

            {isImporting && (
                <div className="import-progress-overlay">
                    <div className="import-progress-bar">
                        <div
                            className="import-progress-fill"
                            style={{ width: `${importProgress}%` }}
                        ></div>
                    </div>
                    <div className="import-progress-text">Importing... {importProgress}%</div>
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
                    className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
                    onClick={() => setActiveTab('settings')}
                >
                    Settings
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
                                                onClick={() => {
                                                    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
                                                        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_DIAGNOSTICS' });
                                                    });
                                                    // Optimistic update
                                                    setDiagnostics(null);
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
                                        <span className="label">Messages</span>
                                        <span className="value">{diagnostics.messageCount}</span>
                                    </div>
                                    <div className="diagnostics-row">
                                        <span className="label">Model</span>
                                        <span className={`value ${diagnostics.provenance?.confidence === 'observed' ? 'success' : 'warning'}`}>
                                            {diagnostics.provenance?.model ?? 'Unknown'}
                                        </span>
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
                                                onClick={() => {
                                                    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
                                                        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_DIAGNOSTICS' });
                                                    });
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

                        <div className="capture-metadata-panel">
                            <div className="capture-metadata-title">Capture Metadata</div>
                            <label className="capture-metadata-option">
                                <input
                                    type="checkbox"
                                    checked={captureMetadataOptions.includeTimestamps}
                                    onChange={() => handleToggleCaptureMetadataOption('includeTimestamps')}
                                />
                                <span>Per-message timestamps</span>
                            </label>
                            <label className="capture-metadata-option">
                                <input
                                    type="checkbox"
                                    checked={captureMetadataOptions.includeModels}
                                    onChange={() => handleToggleCaptureMetadataOption('includeModels')}
                                />
                                <span>Per-message model metadata</span>
                            </label>
                            <label className="capture-metadata-option">
                                <input
                                    type="checkbox"
                                    checked={captureMetadataOptions.includeAnchors}
                                    onChange={() => handleToggleCaptureMetadataOption('includeAnchors')}
                                />
                                <span>Message jump links / deep links</span>
                            </label>
                            <div className="capture-metadata-hint">
                                                Applies to inline insert, Capture All, and Bulk captures. The capture header keeps the conversation timestamp and provider.
                            </div>
                        </div>

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
                                        onClick={() => handleExport('toon')}
                                        disabled={!!exportBatch}
                                    >
                                        🌳 TOON
                                    </button>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleExport('bonsai')}
                                        disabled={!!exportBatch}
                                    >
                                        🌿 Bonsai Import
                                    </button>
                                </div>

                                <button
                                    className="btn btn-primary btn-full"
                                    style={{ marginTop: '16px' }}
                                    onClick={handleImportToBonsai}
                                    disabled={isImporting}
                                >
                                    {isImporting ? '⏳ Importing...' : '🚀 Send to Bonsai App'}
                                </button>
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
                                        className="btn btn-primary"
                                        onClick={() => handleBulkImportToBonsai(exportBatch)}
                                        title={`Import all ${exportBatch.length} items to Bonsai`}
                                        disabled={isImporting}
                                    >
                                        🚀 Send to Bonsai
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'settings' && (
                    <div className="settings-panel" style={{ padding: '16px' }}>
                        <div className="form-group" style={{ marginBottom: '16px' }}>
                            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>
                                Bonsai Host URL
                            </label>
                            <input
                                type="text"
                                value={bonsaiHost}
                                onChange={(e) => setBonsaiHost(e.target.value)}
                                placeholder="http://localhost:8080"
                                className="input"
                                style={{ width: '100%', padding: '8px', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                            />
                            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                                URL of your running Bonsai instance
                            </p>
                        </div>

                        <button
                            id="save-settings-btn"
                            className="btn btn-primary"
                            onClick={handleSaveSettings}
                            style={{ width: '100%' }}
                        >
                            Save Settings
                        </button>
                    </div>
                )}

                {activeTab === 'bulk' && (
                    <div className="bulk-panel" style={{ padding: '16px' }}>
                        <div className="bulk-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <h3 style={{ margin: 0 }}>Bulk Capture</h3>
                            <button
                                className="btn btn-secondary"
                                onClick={handleScanSidebar}
                                disabled={isBulkCapturing}
                                style={{ padding: '4px 8px', fontSize: '12px' }}
                            >
                                {isBulkScanning ? 'Scanning...' : 'Scan Sidebar'}
                            </button>
                        </div>

                        <div className="bulk-config" style={{ marginBottom: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <label style={{ fontSize: '12px' }}>
                                Limit
                                <input
                                    type="number"
                                    value={bulkLimit}
                                    onChange={e => setBulkLimit(Number(e.target.value))}
                                    min="1" max="500"
                                    className="input"
                                    style={{ width: '100%', marginTop: '4px' }}
                                />
                            </label>
                            <label style={{ fontSize: '12px' }}>
                                Delay (ms)
                                <input
                                    type="number"
                                    value={bulkDelay}
                                    onChange={e => setBulkDelay(Number(e.target.value))}
                                    step="500"
                                    className="input"
                                    style={{ width: '100%', marginTop: '4px' }}
                                />
                            </label>
                        </div>

                        <div style={{ marginBottom: '16px' }}>
                            {bulkItems.length > 0 && (
                                <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <input
                                        type="checkbox"
                                        id="select-all-bulk"
                                        checked={bulkItems.every(i => i.selected)}
                                        onChange={(e) => {
                                            const checked = e.target.checked;
                                            setBulkItems(items => items.map(i => ({ ...i, selected: checked })));
                                        }}
                                        disabled={isBulkCapturing}
                                    />
                                    <label htmlFor="select-all-bulk" style={{ cursor: 'pointer', fontSize: '13px', userSelect: 'none', color: 'var(--text-primary)' }}>
                                        Select All ({bulkItems.filter(i => i.selected).length})
                                    </label>
                                </div>
                            )}
                        </div>

                        <div className="bulk-list" style={{
                            border: '1px solid var(--border-color)',
                            borderRadius: '4px',
                            height: '300px',
                            overflowY: 'auto',
                            marginBottom: '16px',
                            backgroundColor: 'var(--bg-secondary)'
                        }}>
                            {bulkItems.length === 0 ? (
                                <div className="empty-state" style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                                    No conversations found. <br />Click Scan to list sidebar items.
                                </div>
                            ) : (
                                bulkItems.map(item => (
                                    <div key={item.id} className={`bulk-item ${item.status}`} style={{
                                        padding: '8px',
                                        borderBottom: '1px solid var(--border-color)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        background: 'var(--bg-primary)',
                                        color: 'var(--text-primary)'
                                    }}>
                                        <input
                                            type="checkbox"
                                            checked={item.selected}
                                            onChange={() => {
                                                setBulkItems(items => items.map(i =>
                                                    i.id === item.id ? { ...i, selected: !i.selected } : i
                                                ));
                                            }}
                                            disabled={isBulkCapturing}
                                        />
                                        <span
                                            className="bulk-item-title"
                                            title={item.title}
                                            style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '13px' }}
                                        >
                                            {item.title}
                                        </span>
                                        <span className="bulk-item-status" style={{ fontSize: '12px' }}>
                                            {item.status === 'success' && '✅'}
                                            {item.status === 'error' && '❌'}
                                            {item.status === 'capturing' && '⏳'}
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>

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
