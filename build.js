import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Content scripts to build
const ADAPTERS = {
    'content/chatgpt': 'src/content/adapters/chatgpt.ts',
    'content/claude': 'src/content/adapters/claude.ts',
    'content/gemini': 'src/content/adapters/gemini.ts',
    'content/grok': 'src/content/adapters/grok.ts',
    'content/bonsai_webui': 'src/content/adapters/bonsai_webui.ts'
};

async function buildAll() {
    // 1. Build UI (Sidepanel + Background)
    console.log('🏗️ Building UI and Background...');
    await build({
        configFile: resolve(__dirname, 'vite.config.ui.ts')
    });

    // 2. Build Content Scripts (Individually as IIFE)
    console.log('🏗️ Building Content Scripts...');
    for (const [name, entry] of Object.entries(ADAPTERS)) {
        console.log(`   - Building ${name}...`);
        await build({
            configFile: false,
            resolve: {
                alias: {
                    '@': resolve(__dirname, 'src')
                }
            },
            build: {
                outDir: 'dist',
                emptyOutDir: false, // Don't wipe the dist folder!
                lib: {
                    entry: resolve(__dirname, entry),
                    name: 'BonsaiCapture' + name.replace('content/', '_'), // Unique variable name
                    formats: ['iife'],
                    fileName: () => `${name}.js`
                },
                rollupOptions: {
                    output: {
                        // Ensure no code splitting for single entry
                        inlineDynamicImports: true
                    }
                },
                sourcemap: true
            }
        });
    }

    console.log('✅ Build complete!');
}

buildAll().catch(err => {
    console.error('❌ Build failed:', err);
    process.exit(1);
});
