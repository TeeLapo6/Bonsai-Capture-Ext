import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function buildContentScripts() {
    const scripts = [
        {
            name: 'content/iframe_extractor',
            entry: 'src/content/iframe-extractor.ts',
            libName: 'BonsaiCapture_iframe_extractor'
        },
        {
            name: 'content/claude',
            entry: 'src/content/adapters/claude.ts',
            libName: 'BonsaiCapture_claude'
        }
    ];

    for (const script of scripts) {
        console.log(`Building ${script.name}...`);
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
                    entry: resolve(__dirname, script.entry),
                    name: script.libName,
                    formats: ['iife'],
                    fileName: () => `${script.name}.js`
                },
                rollupOptions: {
                    output: {
                        inlineDynamicImports: true
                    }
                },
                sourcemap: true
            }
        });
        console.log(`  ${script.name} built successfully!`);
    }
}

buildContentScripts().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
});
