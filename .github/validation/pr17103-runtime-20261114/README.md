# Runtime verification for PR #17103

This report answers the [head-bound runtime evidence request](https://github.com/QwenLM/qwen-code/pull/17103#issuecomment-6879079037). It verifies **`58069518e9971bae2c989e1c99bd3e24f18b2221`** without changing the PR branch.

Recorded: 2026-11-14T15:40:12.510Z. Environment: Linux x64, Node v24.22.1, tsx 4.23.9.

## What ran

The harness imports the exact SDK `negotiateTransport.ts` through the TypeScript loader, together with its real REST and ACP-HTTP transport implementations. It starts a real loopback HTTP server and uses Node's native fetch. An observing fetch wrapper forwards the original URL, options, and Response unchanged while recording header and AbortSignal events. There are no fake timers or substituted transport classes.

The candidate source blob is `f6d86af0439107f65e346a5a0940db0e05eb62e0`. The unfixed control uses the actual source blob `bf15a89cade1c7855be6a45fdd651265c17bf711` from base `84b5b53f1738ef154bca3b3bd8bb40f4f3378510`; its other runtime modules come from the candidate and are unchanged by this PR. The harness verifies the candidate checkout SHA and source hashes before running, and verifies that tracked source files remain unchanged afterward.

## Observations

Six candidate scenarios and one unfixed control completed with all runtime assertions passing:

| Scenario                                                              | Observed result                                                                                                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete advertised ACP HTTP body                                     | Actual ACP-HTTP transport selected at 57.2 ms; no late abort after the configured deadline.                                                                |
| 100 ms budget, 200 headers followed by a body kept open               | Headers arrived at 5.8 ms; client abort at 101.2 ms; REST selected at 103.4 ms, before harness cleanup.                                                    |
| Body completed after a deliberate 75 ms delay, within a 250 ms budget | ACP-HTTP selected at 78.2 ms; no late abort after the deadline.                                                                                            |
| Malformed finite JSON                                                 | REST selected at 3.5 ms; no late abort.                                                                                                                    |
| 100 ms budget, response headers never sent                            | Client abort at 100.7 ms; REST selected at 101.4 ms, before harness cleanup.                                                                               |
| Default budget, body kept open                                        | Still pending at 4805.7 ms; client abort at 5015.5 ms; REST selected at 5042.4 ms.                                                                         |
| Unfixed source, same 100 ms budget and stalled body                   | Still pending after the 450 ms observation window (525.5 ms elapsed). Only the harness's later forced disconnect released negotiation to REST at 526.7 ms. |

Elapsed times include setup and lazy module loading; the raw report separately records native fetch start. These are real-clock observations, not a claim of millisecond-perfect scheduling.

[Raw events and assertions](report.json) include server requests, received headers, aborts, negotiation completion, and explicit harness teardown, so timeout completion can be distinguished from cleanup-induced completion.

## Reproduce

Use a clean source checkout at the verified SHA above, plus Node 24 and tsx 4.23.9. Keep this evidence directory separate from the source checkout:

```sh
npx --yes --package=tsx@4.23.9 tsx /path/to/evidence/runtime-check.mjs /path/to/source-checkout /path/to/report.json
```

The included baseline source must remain next to the script. The script creates a local `baseline-runtime` directory beside itself for the control; it does not edit the source checkout.

## Scope

This is an actual SDK negotiation run against controlled HTTP responses, including a stalled native response body. It is not a running daemon/model integration, WebSocket-handshake verification, or a new full-workspace build. Existing hosted build and unit-test evidence remain separately identified in the PR description. The upstream approval and required CI gates remain separate from this report.
