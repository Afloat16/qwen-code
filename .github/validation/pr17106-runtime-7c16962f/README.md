# ACP active-load runtime observation — PR #17106

**Observed head:** `7c16962f5ed04d61eff25accadc105e18be6cb34`  
**Completed:** 2026-11-14 15:46:56 UTC  
**Result:** all eight scenarios completed successfully; the runner exited 0 and every child process exited during bridge shutdown.  
**Environment:** Linux x64, Node.js v24.22.1, ACP SDK 0.14.1.

This report addresses the request for a runtime observation of the active-load refresh path in [the maintainer's closeout note](https://github.com/QwenLM/qwen-code/pull/17106#issuecomment-6879079792). The approved PR head and its product source were not changed.

## What actually ran

The standalone Node runner loaded a bundle built from this head's production `createAcpSessionBridge`, `BridgeClient`, session control plane, and `createSpawnChannelFactory`. The factory launched a separate Node process for each scenario. The host PID was **7**; the eight peer PIDs were **15, 24, 33, 42, 51, 60, 69, and 78**. Communication between the bridge and the peer went through the production stdio transport and actual ACP JSON-RPC serialization, parsing, and dispatch.

The ACP peer is a controlled implementation, not the packaged Qwen CLI or a model. It emits protocol notifications, holds prompt replies, and returns persisted-page JSON read from an isolated fixture file. Its loopback HTTP listener only controls when that separate process emits or releases ACP messages; it never writes bridge internals. The runner calls the real public bridge APIs and observes live replay, activity state, event output, and request counts. It does not use Vitest, the repository's in-memory channel, or a substituted bridge implementation.

The Core export facade only re-exports the required symbols from their original production source modules. There are no function stubs. [The build manifest](build-manifest.json) records all 909 production source inputs and their SHA-256 hashes; a read-only check matched every hash to the clean checkout. [Runtime file hashes](runtime-file-hashes.json) bind the executed runner, peer, build script, and generated bundle. The generated bundle is reproducible from the scripts and source; it is not included in this evidence branch.

## Observed behavior

| Scenario | Actual observation | Control |
| --- | --- | --- |
| Foreground prompt active | Two concurrent paged loads returned the live response while the prompt was still active; **0** transcript RPCs | After releasing the prompt, an idle load issued **1** transcript RPC and returned persisted content |
| Admitted background-notification turn active | Admission returned `accepted: true`; two concurrent paged loads returned live replay; **0** transcript RPCs | After the terminal notification, an idle load issued **1** transcript RPC and returned persisted content |
| Goal turn active | Two concurrent paged loads returned the live response while Goal activity remained set; **0** transcript RPCs | After a valid Goal terminal, an idle load issued **1** transcript RPC and returned persisted content |
| Goal starts during an idle page read, without a journal event | The peer received **1** transcript request, then sent Goal start without a session update; the bridge's event watermark stayed unchanged. Releasing the stale page returned no stale content and caused **0** further transcript requests | Wire order: transcript request sequence 5, Goal start sequence 6, page reply sequence 7 |
| Foreground prompt starts while an empty page is held | The held empty page advertised `hasMore: true` and an older-page cursor; the load returned the new live response after release; **0** cursor-followup RPCs | The peer received only the initial idle transcript request |
| Goal terminal with valid `end_turn` reason | The undrained message was accepted during Goal activity; no prompt was sent early; it was promoted and dispatched **once**, and the mid-turn queue became empty | Exactly **1** Goal completion event; the next idle load issued **1** transcript RPC and returned persisted content |
| Goal terminal with empty reason | The queued message was promoted and dispatched **once**, and the mid-turn queue became empty | **0** Goal completion events for the invalid terminal; idle refresh still issued **1** transcript RPC and returned persisted content |
| Goal terminal with 129-character reason | The queued message was promoted and dispatched **once**, and the mid-turn queue became empty | **0** Goal completion events for the invalid terminal; idle refresh still issued **1** transcript RPC and returned persisted content |

The completion-event counts match the Goal terminal's own prompt ID. The later completion of the promoted user prompt is a separate event and is not included in those counts.

The active-turn checks explicitly require the paged loads to have returned before releasing the active prompt or sending the terminal notification. They are not latency measurements. The idle controls demonstrate that transcript RPCs and persisted content still work when refresh is eligible. These eight observations cover the listed cases, not every possible malformed terminal payload or every interleaving.

## Evidence

- [Structured results](runtime-results.json) and [runner output](observation.log).
- [Exact runner](run-observation.mjs), [controlled ACP peer](acp-peer.mjs), and [build script](build-runtime.mjs).
- [Direct runtime dependency versions](runtime-dependencies.json) and [installed package versions/integrities](installed-runtime-dependencies.json).
- Per-scenario [raw ACP traces and bridge event output](runs/2026-11-14T15-46-54-778Z). Generated handshake capability values are redacted. All session contents are synthetic fixture data.

The wire traces were independently checked against the result files: each scenario used its recorded separate PID; each active scenario's only transcript request occurred after the turn ended; the in-flight cases issued no retry/cursor request; the three queue scenarios dispatched exactly one prompt; the Goal completion-event counts were 1/0/0. Every peer trace ends with the fixture's shutdown signal record, and the runner also required that the process no longer existed after bridge shutdown.

## Commands and reproduction

The actual observation command was run from the clean checkout root with the runtime directory isolated inside the verification directory:

```sh
QWEN_RUNTIME_DIR="$PWD/.qwen/pr-ui-verify/17106/runtime" \
  node .qwen/pr-ui-verify/17106/run-observation.mjs
```

To reproduce, check out the exact observed head, copy the three `.mjs` scripts into `.qwen/pr-ui-verify/17106/`, prepare the repository's pinned dependencies (or the recorded runtime subset plus TypeScript 5.8.3 and esbuild 0.25.12), then run:

```sh
node .qwen/pr-ui-verify/17106/build-runtime.mjs
QWEN_RUNTIME_DIR="$PWD/.qwen/pr-ui-verify/17106/runtime" \
  node .qwen/pr-ui-verify/17106/run-observation.mjs
```

The successful run creates its own timestamped directory and records the child PIDs, protocol traffic, bridge events, and observations. The local runtime setup used a selected dependency installation; it was not a fresh full frozen-lockfile workspace installation. The source build manifest and installed dependency inventory describe that boundary.

## Setup correction and limits

The first attempt passed the foreground active/idle assertions but the controlled peer did not handle SIGTERM. Production bridge shutdown therefore reported an unclean signal exit and the overall runner failed. The peer was given a normal SIGTERM exit handler, and the full eight-scenario run then completed with exit 0. [That first attempt's output](observation-attempt1.log) and [failure record](runtime-failure-attempt1.json) are retained; it is not counted as a successful full run. Product source was not changed for this correction.

This is an actual bridge/stdio protocol-process observation with a controlled ACP peer. It does not claim a packaged Qwen CLI, authenticated model, complete daemon HTTP server, browser UI, macOS, or Windows run. The existing exact-head hosted build/typecheck and 2,961-test evidence remain separate; this report supplies runtime observations rather than repeating those test totals.
