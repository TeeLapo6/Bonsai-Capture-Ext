/**
 * Jules Adapter Registration
 *
 * Captures tasks from Jules (Google's coding agent)
 */
import { ProviderRegistry } from './factory';

// Register Jules with its specific configuration
ProviderRegistry.register({
    name: 'google',
    displayName: 'Jules',
    domain: 'jules.google.com',
    selectors: {
        container: '.tasks-container, .source-content, [class*="tasks-"], main',
        message: '.task-container, .task-description, [class*="task-"]',
        input: '.ProseMirror, textarea, [contenteditable="true"], .text-input',
        title: '.task-description, h1, .page-title',
        artifact: 'a[href*="/session/"], a[href*="/task/"]'
    },
    roleDetection: {
        userClasses: ['user-task', 'user-prompt'],
        assistantClasses: ['jules-task', 'task-icon', 'status-awaiting-feedback']
    }
});

console.log('[Bonsai Capture] Jules adapter registered via ProviderRegistry');

