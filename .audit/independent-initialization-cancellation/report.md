# Python SDK: cancelling one initialization waiter may cancel unrelated work

Repository: QwenLM/qwen-code, unchanged base `488a6874acfeaa66cc2cf0f92d8b25f6d9e99373`.

Investigate whether cancellation of one public control-method task before the initialize response arrives also cancels another independently awaiting control method, prevents the initial prompt from being written, and makes later control methods fail despite the query remaining open. Compare with the same handshake and no cancellation, for a string prompt and an asynchronous input stream. Do not modify product source or propose a fix.

This is separate from issue #17494's already-initialized request cleanup scenario, in which independent later calls still succeed. Before reproduction, issue/PR searches and the preserved complete Python SDK source history were checked. PR #15837 changes CLI readiness response timing and the timeout payload, #14311 changes buffered/terminal message delivery, and #13862 changes Windows subprocess resolution and cleanup. None supplies this per-caller initialization cancellation isolation.

## Reproduction report

**Status**: REPRODUCED
**Method**: test-script
**Binary**: Python 3.12.14 and the unchanged local Python SDK; no CLI binary was executed for this candidate
**Command**: From `packages/sdk-python`, `PYTHONPATH=src /workspace/scratch/4bed741d4966/.venv-qwen/bin/python -m pytest tests/unit/test_initialization_cancellation_reproduction.py -q -s --tb=short --basetemp=/workspace/scratch/4bed741d4966/audit/qwen-initialization-cancellation-pytest > /workspace/scratch/4bed741d4966/audit/qwen-initialization-cancellation-reproduction.log 2>&1`

### Observed behavior

The unchanged base produces **2 failed, 2 passed in 0.13 s**. The same controlled initialize handshake is exercised with a string prompt and an asynchronous input stream, each with and without cancellation of one public `supported_commands()` task.

| Condition | Independent `mcp_server_status()` | Later `get_available_models()` | Prompt/input messages written |
| --- | --- | --- | --- |
| No cancellation, string prompt | Correct correlated response | Correct correlated response | 1 |
| No cancellation, async input | Correct correlated response | Correct correlated response | 1 |
| Cancel only `supported_commands()`, string prompt | `CancelledError` | `CancelledError` | 0 |
| Cancel only `supported_commands()`, async input | `CancelledError` | `CancelledError` | 0 |

In both failing cases, a successful initialize response is supplied after cancellation. The query and transport still report open, but the input task is cancelled and the only control request written is `initialize`. No `interrupt()` or `close()` call is made until final cleanup. The independent and later callers are never explicitly cancelled during the observation. The test uses `asyncio.wait` to bound observation without cancelling those tasks.

The two no-cancellation controls use the same transport and scheduling, deliver the prompt, and receive all three control responses. Cleanup closes the query and gathers all test tasks in every case.

### Expected behavior

Cancelling one independently awaited control call should end that caller's wait. Once a successful initialize response arrives, unrelated control calls and the existing prompt/input stream should remain usable unless the query itself has been interrupted or closed.

### Key context

- Source is unchanged `488a6874acfeaa66cc2cf0f92d8b25f6d9e99373`. The test prints its imported module path under this checkout, and `git diff --exit-code -- packages/sdk-python/src` passes.
- The previously required official-CLI attempt for this SDK lifecycle investigation hit an initialize timeout and an automatic approval rejection for unestablished outbound telemetry. That rejected operation was not repeated, moved, or modified to evade the block. The safe fallback is the repository's existing local `FakeTransport`, extended only to withhold the initialize response and answer other control requests. No CLI subprocess, credentials, or network requests are used here.
- This is a controlled protocol reproduction, not a claim of an observed real-CLI or production incident.
- Unlike #17494, cancellation occurs **before a public caller's own control request has been sent**, and unrelated calls stop working. In the earlier already-initialized reproduction, later independent calls succeeded despite retained per-request resources. The two observable failures are distinct.
- The issue/PR searches, relevant PR descriptions/patches, and preserved 28-version initialization-wait audit are recorded in `audit/qwen-initialization-cancellation-dedup.json` and `audit/qwen-wait-initialized-history.json`. PR #15837 affects CLI readiness timing and the client's timeout payload; it does not cover this cancellation observation. #14311 and #13862 address the separate behaviors described above.
- Reproduction script: `packages/sdk-python/tests/unit/test_initialization_cancellation_reproduction.py`.
- Raw result: `/workspace/scratch/4bed741d4966/audit/qwen-initialization-cancellation-reproduction.log`.
- The existing pytest-asyncio fixture-loop-scope deprecation warning is unrelated to the two assertion failures.
- Product source was not changed. No fix has been proposed or verified by this independent test role.

## Verification report

Pending. No product fix has been applied or verified for this report.
