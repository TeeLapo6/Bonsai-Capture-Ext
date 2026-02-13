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

// Signal that the extension is installed and ready
// We do this via both a custom event (for the current session)
// and a meta tag (for robust detection even if the page loaded first)
function signalReady() {
    window.dispatchEvent(new CustomEvent('BONSAI_EXTENSION_READY'));

    // Inject meta tag for static detection
    if (!document.querySelector('meta[name="bonsai-extension"]')) {
        const meta = document.createElement('meta');
        meta.name = 'bonsai-extension';
        meta.content = 'installed';
        document.head.appendChild(meta);
    }
}

signalReady();

// Also listen for a "Probe" to respond if the page already loaded before the extension
window.addEventListener('BONSAI_EXTENSION_PROBE', () => {
    signalReady();
});
