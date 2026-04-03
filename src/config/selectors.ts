/** 
 * Provider Selectors Configuration
 * Configurable CSS selectors for each provider's DOM structure.
 */
export interface ProviderSelectors {
  conversationContainer: string;
  messageBlock: string;
  roleAttribute?: string;
  roleClassUser?: string;
  roleClassAssistant?: string;
  roleClassSystem?: string;
  codeBlock: string;
  codeLanguage?: string;
  artifactPanel?: string;
  modelIndicator?: string;
  inputField: string;
  submitButton?: string;
  sidebarItem?: string;
  sidebarList?: string;
  projectConversationList?: string;
  projectConversationItem?: string;
}

export const PROVIDER_SELECTORS: Record<string, ProviderSelectors> = {
  'chatgpt.com': {
    conversationContainer: '[data-testid="conversation-turn-list"], [data-testid="chat-history"], div[role="log"], main .flex-col',
    messageBlock: 'section[data-testid*="conversation-turn"], section[data-testid*="chat-message"], section, article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], [data-testid="chat-message"], div[role="listitem"], div[class*="group"]',
    roleAttribute: 'data-message-author-role',
    codeBlock: 'pre code, .code-block code',
    codeLanguage: '.code-header span, pre > div.flex span',
    artifactPanel: '[data-testid="artifact-panel"], .artifact-container',
    modelIndicator: '[data-testid="model-info"], .model-selector',
    inputField: '#prompt-textarea, textarea[data-id="root"], [contenteditable="true"]',
    submitButton: '[data-testid="send-button"], button[data-testid="fruitjuice-send-button"]',
    sidebarItem: '[data-testid="history-item"], nav a',
    sidebarList: 'nav',
    projectConversationItem: 'a[href^="/c/"], .project-chat-item a',
    projectConversationList: 'main, .project-conversations-list'
  },
  'chat.com': {
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
    conversationContainer: '[data-testid="conversation-turn-list"], [data-testid="chat-history"], div[role="log"], main .flex-col',
    messageBlock: 'section[data-testid*="conversation-turn"], section[data-testid*="chat-message"], section, article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], [data-testid="chat-message"], div[role="listitem"], div[class*="group"]',
    roleAttribute: 'data-message-author-role',
    codeBlock: 'pre code, .code-block code',
    codeLanguage: '.code-header span',
    artifactPanel: '[data-testid="artifact-panel"]',
    modelIndicator: '[data-testid="model-info"]',
    inputField: '#prompt-textarea, textarea[data-id="root"], [contenteditable="true"]',
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
  },
  'jules.google.com': {
    // Jules is TASK-BASED, not chat-based
    conversationContainer: '.tasks-container, .source-content, [class*="tasks-"], main',
    messageBlock: '.task-container, .task-description, [class*="task-"]',
    roleClassUser: 'user-task, [data-user]',
    roleClassAssistant: 'jules-task, .task-icon, [data-task], .task-description',
    codeBlock: 'pre code, code-block, .code-block',
    codeLanguage: '.language-label, [data-language]',
    artifactPanel: '.artifact-panel, [data-testid="artifact"]',
    modelIndicator: '.model-selector, [data-testid="model-info"]',
    inputField: '.ProseMirror, textarea, [contenteditable="true"], .text-input',
    submitButton: 'button[type="submit"], [data-testid="send-button"]'
  }
};

export function getSelectorsForSite(hostname: string): ProviderSelectors | null {
  const normalized = hostname.replace(/^www\./, '');
  return PROVIDER_SELECTORS[normalized] ?? null;
}

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

export function queryAllWithFallbacks(
  root: Element | Document,
  selectorString: string
): Element[] {
  try {
    const results = root.querySelectorAll(selectorString);
    if (results.length > 0) return Array.from(results);
  } catch {
    // Invalid combined selector, try individual fallbacks
  }

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
