/**
 * TOON Exporter
 * 
 * Exports ConversationGraph to TOON format.
 * TOON is a wrapper format that includes mapping metadata for import.
 */

import type { ConversationGraph } from '../schema';

export interface TOONDocument {
    toon_version: string;
    graph: ConversationGraph;
    mapping: {
        message_to_node: Record<string, string>;
        artifact_to_node: Record<string, string>;
        branch_points?: string[];
    };
    metadata?: {
        export_tool: string;
        export_version: string;
        export_timestamp: string;
    };
}

export function exportToTOON(graph: ConversationGraph): TOONDocument {
    // Build mapping from external IDs to node paths
    const messageMapping: Record<string, string> = {};
    const artifactMapping: Record<string, string> = {};

    graph.messages.forEach((msg, idx) => {
        messageMapping[msg.message_id] = `messages[${idx}]`;
    });

    graph.artifacts.forEach((art, idx) => {
        artifactMapping[art.artifact_id] = `artifacts[${idx}]`;
    });

    return {
        toon_version: '0.1',
        graph,
        mapping: {
            message_to_node: messageMapping,
            artifact_to_node: artifactMapping
        },
        metadata: {
            export_tool: 'bonsai-capture',
            export_version: '0.1.0',
            export_timestamp: new Date().toISOString()
        }
    };
}

export function exportToTOONString(graph: ConversationGraph, pretty: boolean = true): string {
    const doc = exportToTOON(graph);
    return pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc);
}
