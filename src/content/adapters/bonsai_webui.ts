// Bonsai WebUI Content Script
// Listens for configuration updates from the Bonsai App

console.log('Bonsai: WebUI Content Script loaded');

// Define interface for the custom event detail
interface BonsaiConfigEvent extends CustomEvent {
    detail: {
        host?: string;
        apiKey?: string;
    }
}

// Listen for configuration updates
window.addEventListener('BONSAI_CONFIG_UPDATE', (event: Event) => {
    const customEvent = event as BonsaiConfigEvent;
    const { host, apiKey } = customEvent.detail || {};

    if (host && apiKey) {
        console.log('Bonsai: Configuration update received from WebUI');
        chrome.runtime.sendMessage({
            type: 'UPDATE_CONFIG',
            payload: { host, apiKey }
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Bonsai: Error communicating with background:', chrome.runtime.lastError);
                window.dispatchEvent(new CustomEvent('BONSAI_CONFIG_RECEIVED', { detail: { success: false, error: 'Communication error' } }));
                return;
            }

            if (response && response.success) {
                console.log('Bonsai: Configuration updated successfully');
                window.dispatchEvent(new CustomEvent('BONSAI_CONFIG_RECEIVED', { detail: { success: true } }));
            } else {
                console.error('Bonsai: Failed to update configuration');
                window.dispatchEvent(new CustomEvent('BONSAI_CONFIG_RECEIVED', { detail: { success: false } }));
            }
        });
    } else {
        console.warn('Bonsai: Received incomplete configuration update', customEvent.detail);
    }
});

// Inject meta tag for static detection — safe for document_start
function injectMetaTag() {
    if (document.querySelector('meta[name="bonsai-extension"]')) return;
    const target = document.head || document.documentElement;
    if (target) {
        const meta = document.createElement('meta');
        meta.name = 'bonsai-extension';
        meta.content = 'installed';
        target.appendChild(meta);
    }
}

// Signal that the extension is installed and ready
function signalReady() {
    window.dispatchEvent(new CustomEvent('BONSAI_EXTENSION_READY'));
    injectMetaTag();
}

// Register probe listener BEFORE signalReady so it always works even if
// signalReady encounters an issue on the first call
window.addEventListener('BONSAI_EXTENSION_PROBE', () => {
    signalReady();
});

// Signal immediately
signalReady();

// If document.head wasn't available yet (document_start), retry after DOM loads
if (!document.head) {
    document.addEventListener('DOMContentLoaded', injectMetaTag, { once: true });
}
