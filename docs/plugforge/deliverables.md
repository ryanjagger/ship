| Deliverable | Requirements |
| --- | --- |
| **GitHub Repository** | https://labs.gauntletai.com/ryanjagger/ship |
| **Pre-Search Document** | [`pre-search.md`](./pre-search.md) — All three phases completed with written answers; saved AI conversation attached as a reference artifact. |
| **Architecture Document** | [`docs/architecture.md`](../architecture.md) — 1–2 pages following the Section/Content table above. |
| **OpenAPI Spec** | Live at [`/api/v1/openapi.json`](https://ship-app-production-6f9e.up.railway.app/api/v1/openapi.json) on the deployed instance; generated from [`api/src/platform/api/v1/openapi/`](../../api/src/platform/api/v1/openapi/), plus a static copy at `docs/openapi.json` in the repo. |
| **AI Cost Analysis** | [`ai-cost-analysis.md`](./ai-cost-analysis.md) — Tracked dev spend, production projections table, explicit assumptions for webhook fanout, agent active rate, and storage retention. |
| **Per-Epic Write-up** | [`per-epic-writeup.md`](./per-epic-writeup.md) — Before → fix → after → proof. For Epic 6, proof is the TTFE drill passing in CI. For Epic 7, proof is the agent's audit-log rows showing OAuth app authentication. |
| **Three Discoveries** | [`discoveries.md`](./discoveries.md) — Strong candidates: OAuth Device Authorization Grant in TypeScript, Zod-driven OpenAPI generation with fitness-test parity, Stripe-style HMAC + timestamp anti-replay, async-iterator pagination as a developer-experience pattern. |
| **Deployed Application** | https://ship-app-production-6f9e.up.railway.app/ — Pre-registered grader OAuth app (read-only scopes): `client_id` = `client_grader_readonly`, `client_secret` = `secret_grader_readonly_demo` (throwaway demo credentials; see [`grader-quickstart.md`](./grader-quickstart.md)). Dev portal reachable; OpenAPI spec resolvable. |
