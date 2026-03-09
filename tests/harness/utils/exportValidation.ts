import { toBonsaiImportPackage } from '../../../src/shared/bonsai-adapter';
import { canonicalConversationGraph } from '../../../src/shared/exporters/fixtures/canonicalGraph';
import { exportToJSON, parseFromJSON } from '../../../src/shared/exporters/json';
import { exportToMarkdown } from '../../../src/shared/exporters/markdown';
import { exportToTOON } from '../../../src/shared/exporters/toon';

import { writeArtifact, writeJsonArtifact } from './artifacts';

export type ExportValidationSummary = {
  passed: boolean;
  checks: {
    json_roundtrip: boolean;
    markdown_rendered: boolean;
    toon_mapping_complete: boolean;
    bonsai_import_ready: boolean;
  };
  stats: {
    message_count: number;
    artifact_count: number;
    attachment_count: number;
  };
};

export async function writeExportValidationArtifacts(runDir: string): Promise<ExportValidationSummary> {
  const graph = canonicalConversationGraph;
  const exportedJson = exportToJSON(graph);
  const parsedGraph = parseFromJSON(exportedJson);
  const markdown = exportToMarkdown(graph);
  const toon = exportToTOON(graph);
  const importPackage = toBonsaiImportPackage(graph);

  const summary: ExportValidationSummary = {
    passed: false,
    checks: {
      json_roundtrip: JSON.stringify(parsedGraph) === JSON.stringify(graph),
      markdown_rendered:
        markdown.includes('# Export Contract Fixture') && markdown.includes('![preview](artifact:artifact_image)'),
      toon_mapping_complete:
        Object.keys(toon.mapping.message_to_node).length === graph.messages.length &&
        Object.keys(toon.mapping.artifact_to_node).length === graph.artifacts.length,
      bonsai_import_ready:
        importPackage.messages.length === graph.messages.length &&
        importPackage.attachments.length === graph.artifacts.length,
    },
    stats: {
      message_count: graph.messages.length,
      artifact_count: graph.artifacts.length,
      attachment_count: importPackage.attachments.length,
    },
  };
  summary.passed = Object.values(summary.checks).every(Boolean);

  await writeJsonArtifact(runDir, 'export_graph.json', graph);
  await writeJsonArtifact(runDir, 'export_toon.json', toon);
  await writeJsonArtifact(runDir, 'export_package.json', importPackage);
  await writeArtifact(runDir, 'export_markdown.md', markdown);
  await writeJsonArtifact(runDir, 'export_validation.json', summary);

  return summary;
}