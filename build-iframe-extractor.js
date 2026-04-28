import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function buildIframeExtractor() {
    console.log('Building iframe-extractor content script...');
    await build({
        configFile: false,
        resolve: {
            alias: {
                '@': resolve(__dirname, 'src')
            }
        },
        build: {
            outDir: 'dist',
            emptyOutDir: false,
            lib: {
                entry: resolve(__dirname, 'src/content/iframe-extractor.ts'),
                name: 'BonsaiCapture_iframe_extractor',
                formats: ['iife'],
                fileName: () => 'content/iframe_extractor.js'
            },
            rollupOptions: {
                output: {
                    inlineDynamicImports: true
                }
            },
            sourcemap: true
        }
    });
    console.log('iframe-extractor built successfully!');
}

buildIframeExtractor().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
});
