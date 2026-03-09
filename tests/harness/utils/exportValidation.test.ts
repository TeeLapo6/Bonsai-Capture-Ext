import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeExportValidationArtifacts } from './exportValidation';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('harness export validation artifacts', () => {
  it('writes export certification artifacts for a run folder', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bonsai-capture-export-validation-'));
    tempDirs.push(runDir);

    const summary = await writeExportValidationArtifacts(runDir);
    const files = await fs.readdir(runDir);
    const exportValidation = JSON.parse(await fs.readFile(path.join(runDir, 'export_validation.json'), 'utf8'));
    const importPackage = JSON.parse(await fs.readFile(path.join(runDir, 'export_package.json'), 'utf8'));

    expect(summary.passed).toBe(true);
    expect(exportValidation.checks.json_roundtrip).toBe(true);
    expect(importPackage.messages).toHaveLength(2);
    expect(files.sort()).toEqual([
      'export_graph.json',
      'export_markdown.md',
      'export_package.json',
      'export_toon.json',
      'export_validation.json',
    ]);
  });
});