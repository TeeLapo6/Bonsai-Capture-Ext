import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function createRunDir(root = 'runs') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(root, `run_${timestamp}`);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

export async function writeArtifact(runDir: string, fileName: string, content: string) {
  await fs.writeFile(path.join(runDir, fileName), content, 'utf8');
}

export async function writeJsonArtifact(runDir: string, fileName: string, content: unknown) {
  await writeArtifact(runDir, fileName, `${JSON.stringify(content, null, 2)}\n`);
}

export function getRunArtifactPaths(runDir: string) {
  return {
    harnessLog: path.join(runDir, 'harness.log'),
    browserHar: path.join(runDir, 'browser_har.har'),
    extensionConsole: path.join(runDir, 'extension_console.log'),
    captureRaw: path.join(runDir, 'capture_raw.json'),
    captureParsed: path.join(runDir, 'capture_parsed.json'),
    reproduction: path.join(runDir, 'reproduction.md'),
    performance: path.join(runDir, 'performance.json'),
    stressResults: path.join(runDir, 'stress_results.json'),
    certification: path.join(runDir, 'certification.md'),
    checksums: path.join(runDir, 'checksums.txt'),
  };
}

async function sha256File(filePath: string) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function writeChecksums(filePaths: string[], outputPath: string) {
  const lines = await Promise.all(
    filePaths.map(async (filePath) => {
      const hash = await sha256File(filePath);
      return `${hash}  ${path.basename(filePath)}`;
    }),
  );

  await fs.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}