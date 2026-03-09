import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { test, expect, chromium } from '@playwright/test';

import {
  createRunDir,
  getRunArtifactPaths,
  writeArtifact,
  writeChecksums,
  writeJsonArtifact,
} from './utils/artifacts';

type SmokeFixture = {
  name: string;
  url: string;
  prompt: string;
  captureTarget: string;
  artifacts: string[];
};

test('creates a ChatGPT smoke harness run folder', async () => {
  const fixture = JSON.parse(
    await fs.readFile(new URL('./fixtures/chatgpt-smoke.json', import.meta.url), 'utf8'),
  ) as SmokeFixture;
  const extensionPath = process.env.CAPTURE_EXTENSION_PATH || path.resolve(process.cwd(), 'dist');
  const userDataDir = path.resolve(process.cwd(), '.playwright', 'chatgpt-smoke-profile');
  const runDir = await createRunDir();
  const artifactPaths = getRunArtifactPaths(runDir);
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const targetUrl = process.env.CAPTURE_SMOKE_URL || fixture.url;
  const command = [
    'CAPTURE_EXTENSION_PATH=' + extensionPath,
    'CAPTURE_SMOKE_URL=' + targetUrl,
    `CAPTURE_HEADLESS=${process.env.CAPTURE_HEADLESS !== 'false'}`,
    'npm run test:harness',
  ].join(' ');

  await fs.mkdir(userDataDir, { recursive: true });
  await writeArtifact(
    runDir,
    'harness.log',
    [`fixture=${fixture.name}`, `url=${targetUrl}`, `started_at=${startedAt}`].join('\n') + '\n',
  );

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.CAPTURE_HEADLESS !== 'false',
    recordHar: {
      path: artifactPaths.browserHar,
    },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let pageTitle = '';
  let finalUrl = targetUrl;
  let pageLoaded = false;
  let validationPassed = false;
  let failureMessage: string | null = null;
  const consoleMessages: string[] = [];

  try {
    const page = context.pages()[0] || await context.newPage();

    page.on('console', (message) => {
      consoleMessages.push(`[${message.type()}] ${message.text()}`);
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    finalUrl = page.url();
    pageTitle = await page.title();
    pageLoaded = true;

    await expect(page).toHaveURL(/chatgpt\.com|chat\.openai\.com/);
    validationPassed = true;
  } catch (error) {
    failureMessage = error instanceof Error ? (error.stack || error.message) : String(error);
    throw error;
  } finally {
    await context.close();

    const finishedAt = new Date().toISOString();
    const durationMs = Math.round(performance.now() - startedAtMs);
    const browserVersion = context.browser()?.version() ?? 'chromium-channel';

    await writeArtifact(runDir, 'extension_console.log', `${consoleMessages.join('\n')}\n`);
    await writeJsonArtifact(runDir, 'capture_raw.json', {
      fixture,
      target_url: targetUrl,
      final_url: finalUrl,
      page_loaded: pageLoaded,
      page_title: pageTitle,
      started_at: startedAt,
      finished_at: finishedAt,
      extension_path: extensionPath,
      browser_version: browserVersion,
    });
    await writeJsonArtifact(runDir, 'capture_parsed.json', {
      validation_passed: validationPassed,
      checks: {
        url_match: /chatgpt\.com|chat\.openai\.com/.test(finalUrl),
        page_loaded: pageLoaded,
      },
      page_title: pageTitle,
      console_message_count: consoleMessages.length,
      failure: failureMessage,
    });
    await writeJsonArtifact(runDir, 'performance.json', {
      duration_ms: durationMs,
      capture_target: fixture.captureTarget,
      headless: process.env.CAPTURE_HEADLESS !== 'false',
      target_url: targetUrl,
      thresholds: {
        capture_1mb_under_ms: 3000,
        capture_10mb_under_ms: 15000,
        memory_under_mb: 500,
        cpu_under_percent: 80,
        disk_under_mb_per_min: 50,
      },
      notes: 'Smoke run only; benchmark thresholds are recorded but not exercised by this spec.',
    });
    await writeJsonArtifact(runDir, 'stress_results.json', {
      status: 'not_run',
      reason: 'Stress scenarios are deferred to dedicated Week 2 scale runs.',
      targets: {
        concurrent_captures: 1000,
        burst_messages_per_second: 100,
        attachment_size_mb: 100,
        latency_range_ms: [100, 1000],
      },
    });
    await writeArtifact(
      runDir,
      'reproduction.md',
      [
        '# ChatGPT Smoke Run',
        '',
        `- Command: ${command}`,
        `- URL: ${targetUrl}`,
        `- Prompt fixture: ${fixture.prompt}`,
        `- Extension path: ${extensionPath}`,
        `- Browser version: ${browserVersion}`,
        `- Network conditions: default local network unless overridden externally`,
        `- Resource limits: not capped in this smoke run`,
        `- Timing expectation: page reaches DOMContentLoaded and URL validation completes within ${durationMs} ms`,
        '- To complete end-to-end capture, provide a logged-in profile or storage state.',
      ].join('\n') + '\n',
    );
    await writeArtifact(
      runDir,
      'certification.md',
      [
        '# Week 2 Certification Status',
        '',
        `- Smoke harness validation: ${validationPassed ? 'pass' : 'fail'}`,
        '- Export certification: pending dedicated round-trip coverage',
        '- Performance benchmarking: pending dedicated benchmark suite',
        '- Stress testing: pending dedicated scale suite',
        `- Failure detail: ${failureMessage ?? 'none'}`,
      ].join('\n') + '\n',
    );
    await writeChecksums(
      [
        artifactPaths.harnessLog,
        artifactPaths.browserHar,
        artifactPaths.extensionConsole,
        artifactPaths.captureRaw,
        artifactPaths.captureParsed,
        artifactPaths.reproduction,
        artifactPaths.performance,
        artifactPaths.stressResults,
        artifactPaths.certification,
      ],
      artifactPaths.checksums,
    );
  }
});