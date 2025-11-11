# QOnCommand – Bug Fixes & Improvements

A full record of every fix applied across all debugging sessions.

---

## Session 1 – Core OSC Reliability

### 1. FIFO Callback Race Condition (Critical)
**Problem:** OSC replies were matched to callbacks via a `Map` keyed by address. Because TCP can coalesce or reorder replies, an out-of-order `/reply/cueLists` could resolve a callback that was waiting for `/reply/connect`, silently delivering wrong data to the wrong caller and leaving the real callback hanging until its 10-second timeout expired.

**Fix:** Replaced the `Map`-based `globalOSCCallbacks` with a single-slot `currentPendingReply` and a serialized `oscRequestQueue` array. Only one OSC request is in-flight at any time. Replies are delivered strictly to the one waiting callback, in order, with no possibility of mismatch.

---

### 2. No TCP Reconnection
**Problem:** If the TCP connection to QLab dropped (app sleep, network blip, QLab restart), `globalOSCPort` became null and every subsequent command silently failed with no recovery.

**Fix:** Added `reconnectGlobalOSCPort()` which stores the last known host/port and re-establishes the TCP socket on `close`/`error` events, then re-authenticates to the active workspace automatically.

---

### 3. Wrong `/updates` Endpoint
**Problem:** Live update subscriptions were sent to the global `/updates` endpoint instead of the workspace-scoped `/workspace/{id}/updates`. QLab 4 ignores the global endpoint, so no push updates were ever received.

**Fix:** Changed the subscription address to `/workspace/${workspaceId}/updates`.

---

### 4. Stale `getCurrentSelectedCue()` Data
**Problem:** `getCurrentSelectedCue()` returned the value captured at constructor time — a reference that was never refreshed. The cue information panel always showed the same cue from when the connection was first made.

**Fix:** Changed `getCurrentSelectedCue()` to call `this.client.getSelectedCue()` live, so the result always reflects the current QLab playback position.

---

### 5. Duplicate `panic` Case in Switch
**Problem:** The command switch statement had two `case 'panic':` entries. The second one was unreachable dead code that could mask future edits.

**Fix:** Removed the duplicate case.

---

### 6. Reply Timeout Too Long
**Problem:** The OSC reply timeout was set to 10 seconds. A single stalled request would block the entire serialized queue for 10 seconds, making the UI appear frozen.

**Fix:** Reduced timeout to 5 seconds.

---

## Session 2 – Debug Instrumentation

### 7. Debug Mode Toggle (`DEBUG_MODE`)
Added a `DEBUG_MODE` constant at the top of `main.js`. When `true`, the spawned server process is started with `LOG_LEVEL=debug`, enabling verbose OSC message logging without changing any other code.

### 8. Console Passthrough Toggle (`CONSOLE_PASSTHROUGH`)
Added a `CONSOLE_PASSTHROUGH` constant at the top of `main.js`. When `true`, all server stdout/stderr is mirrored to the Electron terminal, making it visible during development without opening a separate log file.

### 9. Millisecond Timing Log (`LOG_TIMING_FILE`)
Added a `LOG_TIMING_FILE` toggle in `main.js`. When `true`, the server writes a separate log file named `log-ddmmyy-hhmmss.log` (e.g. `log-230426-142305.log`). Every line is prefixed with a Unix millisecond timestamp, allowing frame-accurate cross-referencing with Wireshark packet captures.

---

## Session 3 – Performance & Protocol Correctness (Log + Wireshark Analysis)

Issues in this session were identified by cross-referencing the timing log against a Wireshark TCP capture.

### 10. `/updates` Subscription Used `expectReply=true` (Critical)
**Problem:** QLab **never** sends a reply to `/workspace/{id}/updates`. Because `expectReply=true` was set, the serialized queue would stall for the full 5-second timeout on every single connection attempt before proceeding, delaying the first cue list fetch and making the initial connection feel broken.

**Evidence:** Log showed `/updates` queued at `23:15:45.399` → `WARN OSC reply timeout` at `23:15:50.400` — exactly 5 seconds stalled.

**Fix:** Changed `expectReply` for the `/updates` message to `false` (fire-and-forget). The connection sequence now completes in ~67ms instead of ~5 seconds.

---

### 11. `QLabClientWrapper` Constructor Called `initialize()` Twice (Double-Init)
**Problem:** The `QLabClientWrapper` constructor called `this.initialize()` directly. All external callers (`getOrCreateWorkspaceConnection`, `connect/:instanceId/:workspaceId`) also called `await clientWrapper.initialize()` explicitly after construction. This resulted in two overlapping workspace connect + cue list fetch sequences racing each other on every connection.

**Fix:** Removed `this.initialize()` from the constructor. Callers are responsible for calling it when ready, as they already were.

---

### 12. `initialize()` Re-Ran `setActiveWorkspace` When Already Connected
**Problem:** `initialize()` called `setActiveWorkspace()` unconditionally, sending `/connect`, `/updates`, and `/cueLists` to QLab even if the wrapper was already connected to the same workspace. This caused redundant OSC traffic on reconnects.

**Fix:** Added a guard: `setActiveWorkspace()` is only called in `initialize()` if `this.client.currentWorkspaceId !== this.workspaceId`.

---

### 13. Full `/cueLists` Fetched on Every Playback Position Update (Performance)
**Problem:** `updateCueInfoForClient()` called `client.client.getNextCue()`, which in turn fetched the full `/workspace/{id}/cueLists` response (~40KB, 162 cues) from QLab via OSC on every single call. QLab pushes a `playbackPosition` update every time the selected cue changes, so this was firing constantly during a show — fetching 40KB of data to answer "what is the next cue?"

**Evidence:** Log showed `/cueLists` being fetched at `23:15:56.446`, `23:16:01.306`, `23:16:02.177`, etc. — every few hundred milliseconds.

**Fix (two parts):**
- Added `type: cue.type || 'unknown'` to every entry stored by `processCueList()` in the flat `cachedCues` array (previously `type` was not cached).
- Added `getNextCueFromCache(currentCueId)` to `QLabClientWrapper` — a synchronous method that finds the next cue in the already-cached flat list by ID, returning `{id, number, name, type}` with zero OSC calls.
- Changed `updateCueInfoForClient()` to call `client.getNextCueFromCache(currentCue.id)` instead of `await client.client.getNextCue()`.

---

### 14. `errorCount` Inflated by Internal OSC Timeouts
**Problem:** `processNextOSCRequest()` incremented `errorCount++` whenever an internal OSC request timed out. But `commandsSent` only increments when a user presses a button. Internal messages like `/updates` and miscellaneous QLab pings timed out frequently (especially before fix #10), making the `error_rate` metric report values like `300%` after a single user NEXT command.

**Evidence:** Wireshark packet showed `error_rate: 300` after 1 user command but 3 internal timeouts.

**Fix:** Removed `errorCount++` from the `processNextOSCRequest` timeout handler. Error counting now only happens in user-facing command handlers where `commandsSent` is also tracked.

---

## Summary Table

| # | Session | Severity | Issue | Result |
|---|---------|----------|-------|--------|
| 1 | 1 | Critical | OSC reply mismatch (FIFO race) | Wrong data silently delivered to wrong callbacks |
| 2 | 1 | High | No TCP reconnection | App permanently broken after any connection drop |
| 3 | 1 | High | `/updates` wrong endpoint | No QLab push updates ever received |
| 4 | 1 | High | Stale cue display | Cue info panel always showed connection-time cue |
| 5 | 1 | Low | Duplicate `panic` case | Dead code |
| 6 | 1 | Medium | 10s reply timeout | 10-second UI freeze on any stall |
| 7 | 2 | — | Debug mode toggle | Development instrumentation |
| 8 | 2 | — | Console passthrough toggle | Development instrumentation |
| 9 | 2 | — | Millisecond timing log | Wireshark correlation capability |
| 10 | 3 | Critical | `/updates` blocks queue for 5s | 5-second stall on every connect (no reply expected) |
| 11 | 3 | High | Double `initialize()` call | Redundant connect+cueLists sequence on every connection |
| 12 | 3 | Medium | `setActiveWorkspace` runs even when already connected | Unnecessary OSC traffic on reconnects |
| 13 | 3 | High | Full `/cueLists` fetch per playback update | 40KB OSC fetch every ~300ms during playback |
| 14 | 3 | Medium | `errorCount` inflated by internal timeouts | `error_rate` metric reported ~300% incorrectly |
