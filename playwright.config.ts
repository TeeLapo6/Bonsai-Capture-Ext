import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionPath = process.env.CAPTURE_EXTENSION_PATH || path.resolve(__dirname, 'dist');

export default defineConfig({
  testDir: './tests/harness',
  timeout: 90000,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    baseURL: process.env.CAPTURE_SMOKE_URL || 'https://chatgpt.com/',
  },
  metadata: {
    extensionPath,
  },
});