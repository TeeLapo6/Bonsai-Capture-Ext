/**
 * Provider Selectors Configuration
 * 
 * Configurable CSS selectors for each provider's DOM structure.
 * Allows easy updates when chat UIs change without modifying adapter code.
 */

export interface ProviderSelectors {
    /** Root container for the conversation */
    conversationContainer: string;
    /** Individual message blocks */
    messageBlock: string;
    /** Attribute or selector to determine role */
    roleAttribute?: string;
    roleClassUser?: string;
    roleClassAssistant?: string;
    roleClassSystem?: string;
    /** Code blocks within messages */
    codeBlock: string;
    /** Language indicator for code blocks */
    codeLanguage?: string;
    /** Artifact/canvas panel if present */
    artifactPanel?: string;
    /** Model indicator in UI */
    modelIndicator?: string;
    /** Message input field (for "Send to AI") */
    inputField: string;
    /** Submit button */
    submitButton?: string;
    /** Sidebar conversation list items */
    sidebarItem?: string;
    /** Sidebar container list */
    sidebarList?: string;
    /** Project-specific conversation list */
    projectConversationList?: string;
    /** Individual conversation items within a project list */
    projectConversationItem?: string;
}

export const PROVIDER_SELECTORS: Record<string, ProviderSelectors> = {
    'chatgpt.com': {
        conversationContainer: '[data-testid="conversation-turn-list"], main .flex-col',
        messageBlock: 'article[data-testid^="conversation-turn"]',
        roleAttribute: 'data-message-author-role',
        codeBlock: 'pre code, .code-block code',
        codeLanguage: '.code-header span, pre > div.flex span',
        artifactPanel: '[data-testid="artifact-panel"], .artifact-container',
        modelIndicator: '[data-testid="model-info"], .model-selector',
        inputField: '#prompt-textarea, textarea[data-id="root"]',
        submitButton: '[data-testid="send-button"], button[data-testid="fruitjuice-send-button"]',
        sidebarItem: '[data-testid="history-item"], nav a',
        sidebarList: 'nav',
        projectConversationItem: 'a[href^="/c/"], .project-chat-item a',
        projectConversationList: 'main, .project-conversations-list'
    },

    'chat.openai.com': {
        conversationContainer: '[data-testid="conversation-turn-list"], main .flex-col',
        messageBlock: 'article[data-testid^="conversation-turn"]',
        roleAttribute: 'data-message-author-role',
        codeBlock: 'pre code, .code-block code',
        codeLanguage: '.code-header span',
        artifactPanel: '[data-testid="artifact-panel"]',
        modelIndicator: '[data-testid="model-info"]',
        inputField: '#prompt-textarea, textarea[data-id="root"]',
        submitButton: '[data-testid="send-button"]'
    },

    'claude.ai': {
        conversationContainer: '#main-content, main, .flex-1.overflow-y-auto, body',
        messageBlock: '[data-testid="user-message"], .font-claude-response',
        roleClassUser: 'font-user-message, user-message',
        roleClassAssistant: 'font-claude-response, assistant-message',
        codeBlock: 'pre code, .code-block code',
        codeLanguage: '.code-block-header, [data-language]',
        artifactPanel: '.artifact-panel, [data-testid="artifact"]',
        modelIndicator: '[data-testid="chat-controls-model-selector"], [aria-haspopup="menu"], button[class*="font-tiempos"], .font-tiempos',
        inputField: '[contenteditable="true"], .ProseMirror',
        submitButton: '[data-testid="send-message-button"], button[aria-label="Send"]'
    },

    'gemini.google.com': {
        conversationContainer: 'infinite-scroller.chat-history, .chat-history-scroll-container',
        // Note: These are custom Angular elements, not CSS selectors with comma fallback
        messageBlock: 'user-query, model-response',
        roleClassUser: 'user-query',
        roleClassAssistant: 'model-response',
        codeBlock: 'code-block, pre code',
        codeLanguage: '.code-block-header',
        artifactPanel: '.canvas-container',
        modelIndicator: '.model-picker',
        inputField: '.ql-editor.textarea, div[aria-label="Enter a prompt here"], [contenteditable="true"]',
        submitButton: 'button[aria-label="Send message"]'
    },

    'grok.com': {
        conversationContainer: '.chat-container, [data-testid="chat"]',
        messageBlock: '.message, [data-testid="message-container"]',
        roleClassUser: 'user-message',
        roleClassAssistant: 'assistant-message, grok-message',
        codeBlock: 'pre code, .code-snippet',
        codeLanguage: '.language-label',
        inputField: 'textarea, [contenteditable="true"]',
        submitButton: 'button[type="submit"], [data-testid="send-button"]'
    }
};

/**
 * Get selectors for the current site
 */
export function getSelectorsForSite(hostname: string): ProviderSelectors | null {
    // Normalize hostname
    const normalized = hostname.replace(/^www\./, '');
    return PROVIDER_SELECTORS[normalized] ?? null;
}

/**
 * Try multiple selectors and return first match
 */
export function queryWithFallbacks(
    root: Element | Document,
    selectorString: string
): Element | null {
    const selectors = selectorString.split(',').map(s => s.trim());
    for (const selector of selectors) {
        try {
            const result = root.querySelector(selector);
            if (result) return result;
        } catch {
            // Invalid selector, continue to next
        }
    }
    return null;
}

/**
 * Query all elements with fallback selectors.
 * First tries the full selector string (which may contain comma-separated selectors),
 * then falls back to trying each selector individually.
 */
export function queryAllWithFallbacks(
    root: Element | Document,
    selectorString: string
): Element[] {
    // First, try the entire selector string as-is (supports CSS selector lists like "a, b")
    try {
        const results = root.querySelectorAll(selectorString);
        if (results.length > 0) return Array.from(results);
    } catch {
        // Invalid combined selector, try individual fallbacks
    }

    // Fall back to trying each selector individually  
    const selectors = selectorString.split(',').map(s => s.trim());
    for (const selector of selectors) {
        try {
            const results = root.querySelectorAll(selector);
            if (results.length > 0) return Array.from(results);
        } catch {
            // Invalid selector, continue to next
        }
    }
    return [];
}
