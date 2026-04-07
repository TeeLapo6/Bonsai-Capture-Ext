export interface ClaudeCaptureSettings {
    xPath: string;
    panelCaptureDelayMs: number;
}

export interface ProviderCaptureSettings {
    claude: ClaudeCaptureSettings;
}

export const DEFAULT_CLAUDE_CAPTURE_SETTINGS: ClaudeCaptureSettings = {
    xPath: '//*[contains(@id,"wiggle")]',
    panelCaptureDelayMs: 250,
};

export const DEFAULT_PROVIDER_CAPTURE_SETTINGS: ProviderCaptureSettings = {
    claude: { ...DEFAULT_CLAUDE_CAPTURE_SETTINGS },
};

export function normalizeProviderCaptureSettings(
    settings?: Partial<ProviderCaptureSettings> | null
): ProviderCaptureSettings {
    const rawClaude = settings?.claude;
    const normalizedXPath = typeof rawClaude?.xPath === 'string' && rawClaude.xPath.trim().length > 0
        ? rawClaude.xPath.trim()
        : DEFAULT_CLAUDE_CAPTURE_SETTINGS.xPath;
    const normalizedDelay = Number.isFinite(rawClaude?.panelCaptureDelayMs)
        ? Math.max(0, Math.round(rawClaude!.panelCaptureDelayMs))
        : DEFAULT_CLAUDE_CAPTURE_SETTINGS.panelCaptureDelayMs;

    return {
        claude: {
            xPath: normalizedXPath,
            panelCaptureDelayMs: normalizedDelay,
        },
    };
}