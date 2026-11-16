# Python SDK: cancelled control calls may retain pending requests and timeout handles

Repository: QwenLM/qwen-code, unchanged main 488a6874acfeaa66cc2cf0f92d8b25f6d9e99373.

A source review suggests that cancelling the task awaiting a Python SDK control method leaves the completed/cancelled request and its timer in the query until the original control timeout elapses. A control request whose transport write fails may retain similar state. Repeated cancelled calls in a long-lived query should release their local pending-request resources promptly, without closing the otherwise usable query or losing independent replies.

This is a hypothesis, not a runtime-confirmed report. Determine whether repeated cancellations or a write failure cause observable retained resources, delayed exception warnings, or incorrect later request handling. Do not change product code.

## Reproduction report

**Status**: REPRODUCED
**Method**: test-script, after the required e2e-headless attempt could not reach the control-call scenario
**Binary**: official `qwen` 0.27.4 for the E2E attempt; Python 3.12.14 with the unchanged SDK and its existing local `FakeTransport` for the completed reproduction
**Command**: From `packages/sdk-python`, `/workspace/scratch/4bed741d4966/.venv-qwen/bin/python -m pytest tests/unit/test_control_cancellation_reproduction.py -q -s --tb=short --basetemp=/workspace/scratch/4bed741d4966/audit/qwen-reproduction-pytest`

### Observed behavior

Both new tests fail on the unchanged base: **2 failed in 1.30 s**.

1. Sixteen public `supported_commands()` calls were sent and their awaiting tasks were cancelled. All 16 tasks returned `CancelledError`, but the query still retained **16 pending request records, 16 active timeout handles, and 16 cancelled futures**. The query remained open, and an independent subsequent control call received its own response successfully.
2. A controlled transport write raised `ConnectionResetError` to the public caller. Immediately afterward the query retained **one pending request and one active timeout handle**. With the control timeout configured to one second, the record disappeared after the timeout, and the event loop reported **`Future exception was never retrieved`**, carrying **`ControlRequestTimeoutError: Control request timeout: supported_commands`**. The query remained open and a later independent control call succeeded.

The tests close the query and restore the event-loop exception handler during cleanup.

### Expected behavior

Cancellation or a failed write should release that call's local pending-request resources promptly. A write error already delivered to the caller should not produce a later unhandled timeout warning for the same abandoned request. Independent control calls should remain usable.

### Key context

- Source: unchanged `488a6874acfeaa66cc2cf0f92d8b25f6d9e99373`; `git diff -- packages/sdk-python/src` was empty.
- The required E2E attempt used the installed official CLI and the SDK's public `supported_commands()` API. Initialization hit `ControlRequestTimeoutError: ... initialize` before reaching the target scenario. The real child was terminated during cleanup.
- Continuing the official CLI session was subsequently rejected by automatic approval review because of unexpected HTTPS telemetry to an untrusted third-party host, with the payload not established. It was not retried or bypassed.
- The fallback therefore uses the repository's existing `FakeTransport` protocol fixture, which does not launch the CLI or make network calls. Cancellation and transport failure are controlled test conditions; these observations do not claim that the real CLI produced those conditions during the blocked E2E attempt.
- Reproduction script: `packages/sdk-python/tests/unit/test_control_cancellation_reproduction.py`.
- Completed reproduction output: `/workspace/scratch/4bed741d4966/audit/qwen-control-cancellation-fallback.log`.
- E2E attempt output: `/workspace/scratch/4bed741d4966/audit/qwen-control-cancellation-e2e.log`.
- The pre-existing pytest-asyncio loop-scope deprecation warning is separate from the captured delayed control-request warning.
- Product source files were not changed by the independent test role. At the time of the baseline reproduction, no fix had been verified.

## Verification report

**Status**: VERIFIED_FIXED for the two original test-script scenarios; the full repository workflow is not complete.
**Method**: test-script
**Binary**: Python 3.12.14 importing the SDK from `worktrees/qwen-control-cleanup`; no official Qwen CLI was executed for this verification.
**Production head**: `e96d8980f129433b09c16dd76ed21e8a4dce5542`.
**Command**: From `worktrees/qwen-control-cleanup/packages/sdk-python`:

```sh
PYTHONPATH=/workspace/scratch/4bed741d4966/worktrees/qwen-control-cleanup/packages/sdk-python/src:/workspace/scratch/4bed741d4966/repos/qwen-code/packages/sdk-python/tests/unit /workspace/scratch/4bed741d4966/.venv-qwen/bin/python /workspace/scratch/4bed741d4966/audit/qwen-independent-verify.py /workspace/scratch/4bed741d4966/worktrees/qwen-control-cleanup e96d8980f129433b09c16dd76ed21e8a4dce5542 /workspace/scratch/4bed741d4966/repos/qwen-code/packages/sdk-python/tests/unit/test_control_cancellation_reproduction.py -q -s --tb=short -p no:cacheprovider --basetemp=/workspace/scratch/4bed741d4966/audit/qwen-control-postfix-pytest > /workspace/scratch/4bed741d4966/audit/qwen-control-independent-postfix.log 2>&1
```

### Observed behavior after the fix

The unchanged original reproduction script now reports **2 passed in 1.27 s**. After cancelling 16 public calls, all 16 tasks return cancellation and the query retains **0 requests, 0 active timeout handles, and 0 cancelled futures**. After the controlled write failure, it immediately retains **0 requests and 0 active timers**; after the original timeout interval, the captured event-loop warning list is empty. In both tests the query remains open and a later independent control request receives its response successfully.

The helper asserts the exact Git commit and imported SDK path before pytest, and verifies that production source has no working-tree changes. The original test file was reused from the unchanged base checkout. This verification did not modify product code.

### Verification scope

This confirms the two controlled protocol scenarios and their independent-call happy paths using the repository's local `FakeTransport`. It does not establish a real-CLI end-to-end result. The rejected official-CLI operation was not retried, moved, or modified. Repository build, bundle, and preflight remain incomplete: the implementation owner reports the CLI TypeScript build being terminated with exit 137 without a TypeScript diagnostic, including its final lower-heap attempt. The test-script result must not be described as completion of those gates.

Evidence: `/workspace/scratch/4bed741d4966/audit/qwen-control-independent-postfix.log`. The original baseline failures and E2E limitation are preserved above.
