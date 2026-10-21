## 2023-10-08 - Promise.any for UDP port probing
**Learning:** The game-query component was probing multiple UDP ports in parallel using `Promise.all`. This caused the function to wait for the timeouts (~1500ms) on closed ports even if an open port had already successfully responded (e.g. in 50ms). This was a major bottleneck given this is polled across hundreds of servers.
**Action:** Replaced `Promise.all` with `Promise.any` and rejected promises on failure instead of resolving to null, allowing the probe to short-circuit upon the first successful port response.
## 2023-10-09 - Custom in-memory DB requires manual SQL parser updates
**Learning:** Adding new Postgres features like `= ANY($1)` to repositories requires updating the custom SQL parser in `MemoryDbClient` (`evaluateSimpleCondition`), otherwise tests will fail because the mock DB doesn't understand the syntax.
**Action:** Always verify new SQL syntax against the `MemoryDbClient` parser logic and extend it if necessary to ensure tests remain green.
## 2024-05-24 - Fix N+1 Query in Persona Game Lookup
**Learning:** Sequential, awaited loops doing single database lookups result in significant N+1 performance bottlenecks.
**Action:** Replace sequential lookups across sets (like game slugs) with an `ANY()` or `IN` array query using Postgres arrays, drastically reducing I/O and query overhead.
