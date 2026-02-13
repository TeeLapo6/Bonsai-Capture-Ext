/**
 * JSON Exporter
 * 
 * Exports ConversationGraph to JSON format.
 */

import type { ConversationGraph } from '../schema';

export function exportToJSON(graph: ConversationGraph, pretty: boolean = true): string {
    return pretty
        ? JSON.stringify(graph, null, 2)
        : JSON.stringify(graph);
}

export function parseFromJSON(json: string): ConversationGraph {
    return JSON.parse(json) as ConversationGraph;
}
