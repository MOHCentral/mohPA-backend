## 2023-10-08 - Promise.any for UDP port probing
**Learning:** The game-query component was probing multiple UDP ports in parallel using `Promise.all`. This caused the function to wait for the timeouts (~1500ms) on closed ports even if an open port had already successfully responded (e.g. in 50ms). This was a major bottleneck given this is polled across hundreds of servers.
**Action:** Replaced `Promise.all` with `Promise.any` and rejected promises on failure instead of resolving to null, allowing the probe to short-circuit upon the first successful port response.
