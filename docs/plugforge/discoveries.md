# Plugforge — Discoveries

## Cursor Pagination

A cursor encodes where you left off in the sort order, so the next page picks up cleanly no matter what changed. The tradeoff is you give up jumping to an arbitrary page number, which for an API feed is almost always worth it.

## OAuth Device Authorization Grant in TypeScript

This is the flow you reach for when there's no browser to redirect through — a CLI, a headless box. The device gets a device code and shows the user a short code to enter on another screen, then polls the token endpoint while it waits. The part that's easy to get wrong is the polling loop: you have to actually honor `authorization_pending` and back off on `slow_down` instead of hammering the endpoint. Once I wired that up correctly, logging in from the terminal felt as smooth as the web flow.

## Zod-driven OpenAPI generation with fitness-test parity

I made the Zod schemas the single source of truth and generated the OpenAPI spec from them, so the docs can't describe something the runtime won't accept. The piece I'm happiest with is the fitness test that fails the build if the generated spec drifts from what the endpoints actually validate. That kills the usual problem where docs slowly rot away from real behavior. It means the contract is enforced, not just written down.

## Stripe-style HMAC + timestamp anti-replay

For webhook security I signed each payload with HMAC-SHA256 over the timestamp plus the raw body, then verified it on the other end. The timestamp is the part that does the heavy lifting — rejecting anything older than a short window stops someone from capturing a valid request and replaying it later. I also learned to compare signatures in constant time so you don't leak information through timing, and to sign the raw bytes before any parsing reorders them.

## Async-iterator pagination as a developer-experience pattern

This was the lesson that cursor mechanics are an implementation detail consumers shouldn't have to think about. By exposing an async iterator, a developer can just `for await...of` the results and the SDK handles fetching the next page behind the scenes. They never touch a cursor token or write a paging loop. Good DX is mostly about hiding the machinery you were proud of building.
