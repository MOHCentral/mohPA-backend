## 2024-06-25 - Parallelize player persona lookups
**Learning:** In `packages/fesl-engine/src/gamespy/stats-ingest.ts`, resolving `await` promises sequentially in a `for` loop caused N+1 issues when parsing match snapshots with 64 players. Replacing it with `Promise.all` reduced 660ms of sequential latency to 12ms.
**Action:** When performing independent asynchronous lookups in a loop, always use `Promise.all` to batch resolving tasks concurrently.
