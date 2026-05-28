import { getCompiledGraph } from './graph.js';

/**
 * LangGraph Studio / Agent Server export.
 *
 * The production API continues to use the public entry points in index.ts; this
 * export gives the LangGraph CLI a direct compiled graph to serve locally.
 */
export const fleetgraph = getCompiledGraph();
