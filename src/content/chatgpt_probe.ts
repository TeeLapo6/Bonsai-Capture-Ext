/**
 * ChatGPT Deep Research Probe Bootstrap
 *
 * Runs at document_start and asks the background worker to install a MAIN-world
 * probe in ChatGPT and OpenAI sandbox frames before the app starts fetching.
 */

if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
        type: 'INSTALL_OPENAI_RESEARCH_PROBE',
    }).catch(() => {
        // Ignore missing-background or early-start failures.
    });
}