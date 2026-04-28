import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function buildClaude() {
    console.log('Building claude content script...');
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
                entry: resolve(__dirname, 'src/content/adapters/claude.ts'),
                name: 'BonsaiCapture_claude',
                formats: ['iife'],
                fileName: () => 'content/claude.js'
            },
            rollupOptions: {
                output: {
                    inlineDynamicImports: true
                }
            },
            sourcemap: true
        }
    });
    console.log('claude built successfully!');
}

buildClaude().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
});
