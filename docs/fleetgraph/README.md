# FleetGraph

A shared LangGraph.js agentic graph that serves **both** of Fleet's modes from one
compiled `StateGraph` — the trigger differs, the graph does not:

- **Proactive plan review** — judges a Project's `plan` as a hypothesis (what changes /
  for whom / by how much / by when) and surfaces a quality score + recommendation,
  cached on the Project Details card.
- **On-demand context-scoped chat** — "Ask Fleet" from a Project/Week page, grounded in
  exactly that entity's context, with **human-in-the-loop confirmed writes** (the agent
  *proposes* a change; nothing is written until the user confirms).

**Source:** `api/src/services/fleetgraph/` (`graph.ts` assembles, `nodes/*` implement,
`index.ts` exposes entry points), `api/src/routes/fleetgraph.ts` (HTTP/SSE),
`web/src/components/fleetgraph/` + `web/src/hooks/useFleetGraphChat.ts` (UI).

## Documents

| Doc | What it is |
|-----|------------|
| [presearch.md](./presearch.md) | The agent's full design, grounded in the implementation — Phase 1 (responsibility scoping, use cases, trigger model), Phase 2 (the shipped graph: nodes, state, HITL, error handling), Phase 3 (deployment, performance, cost). Each item tagged **[shipped]** vs **[deferred]**. |
| [fleetgraph.md](./fleetgraph.md) | Design Q&A — answered questions on what the agent monitors, autonomy boundaries, notification, people/roles, on-demand context, and the hybrid trigger-model recommendation (event-driven primary + scheduled backstop sweep). |
| [fleetgraph-graph.md](./fleetgraph-graph.md) | The compiled LangGraph shape — Mermaid + ASCII diagram of `scope → fetch → reason → (policyRoute) → action \| output`, the custom JSONB checkpointer, and the HITL `interrupt`/resume invariant. |
