# Python SDK: closing a query during process startup may leave its child running

Repository: QwenLM/qwen-code, unchanged main 488a6874acfeaa66cc2cf0f92d8b25f6d9e99373.

A source review suggests a startup/close interleaving in the Python SDK: a caller begins using a new query, and calls and awaits close while the first process launch is still pending. The expected observable contract is that the started CLI process is reaped and no prompt runs after close has completed. The suspected behavior is that close returns before the child is published, and the pending startup can subsequently leave a live child owned by a closed query.

This is a hypothesis, not a runtime-confirmed report. Determine whether the public API can exhibit it using an actual subprocess. Do not change product code.

## Reproduction report

**Status**: REPRODUCED
**Method**: e2e-headless, with a supplementary local test-script confirmation
**Binary**: official `qwen` 0.27.4 at `/workspace/scratch/4bed741d4966/.cache/qwen-runtime/node_modules/.bin/qwen`; the supplementary regression uses an actual local Python subprocess and no CLI or network.
**Command**: From `packages/sdk-python`, `/workspace/scratch/4bed741d4966/.venv-qwen/bin/python -m pytest tests/integration/test_start_close_reproduction.py -q -s --tb=short --basetemp=/workspace/scratch/4bed741d4966/audit/qwen-start-close-pytest`

### Observed behavior

The first reproduction used the unchanged Python SDK with the installed official CLI. A task called the public `supported_commands()` method, the caller yielded once with `await asyncio.sleep(0)`, and then awaited `close()` before startup returned. No transport methods or process-launch functions were patched.

At the close call, no child handle was visible yet. `close()` returned in 0.019819 ms and `is_closed()` was true. The startup task then raised `RuntimeError('Query is closed')`, but its actual CLI child was still alive one second later (`returncode=None`, and the OS liveness check succeeded). Calling `close()` again left that child alive. The reproduction manually terminated and awaited that child afterward; its cleanup return code was -15.

The supplementary regression performs the same public-method scheduling against a local Python child that waits without making network calls. On the unchanged base it fails its assertion that no live child remains after close: **1 failed**. The test also terminates and awaits its child in `finally`.

### Expected behavior

After `await close()` completes, a query's pending startup should not leave a live owned child process behind. Closing it repeatedly should not leave that child running either.

### Key context

- Source: unchanged `488a6874acfeaa66cc2cf0f92d8b25f6d9e99373`; `git diff -- packages/sdk-python/src` was empty.
- Environment: Linux, Python 3.12.14, installed CLI 0.27.4, Node.js 24.22.1.
- The SDK was imported from this worktree's `packages/sdk-python/src/qwen_code_sdk`, not a different installed checkout.
- The confirmed symptom is child liveness after close. This run did not observe a model prompt executing after close, so it does not establish that additional symptom.
- E2E evidence: `/workspace/scratch/4bed741d4966/audit/qwen-start-close-e2e.log`.
- Repeatable test: `packages/sdk-python/tests/integration/test_start_close_reproduction.py`; result: `/workspace/scratch/4bed741d4966/audit/qwen-start-close-fallback.log`.
- The official CLI continuation was later blocked by automatic approval review because it attempted unexpected HTTPS telemetry to an untrusted third-party host with an unestablished payload. No retry or bypass was performed. The supplementary fixture provides a fully local reproduction after that restriction.
- Product source files were not changed by the independent test role. At the time of the baseline reproduction, no fix had been verified.

## Verification report

**Status**: VERIFIED_FIXED for the original local subprocess test-script scenario; the full repository workflow is not complete.
**Method**: test-script
**Binary**: Python 3.12.14 importing the SDK from `worktrees/qwen-close-start`; the regression and existing happy paths launch only local Python protocol fixtures. No official Qwen CLI was executed for this verification.
**Production head**: `905841175ce10efac4ba68f0b9882a466a262c6f`.
**Command**: From `worktrees/qwen-close-start/packages/sdk-python`:

```sh
PYTHONPATH=/workspace/scratch/4bed741d4966/worktrees/qwen-close-start/packages/sdk-python/src /workspace/scratch/4bed741d4966/.venv-qwen/bin/python /workspace/scratch/4bed741d4966/audit/qwen-independent-verify.py /workspace/scratch/4bed741d4966/worktrees/qwen-close-start 905841175ce10efac4ba68f0b9882a466a262c6f /workspace/scratch/4bed741d4966/repos/qwen-code/packages/sdk-python/tests/integration/test_start_close_reproduction.py /workspace/scratch/4bed741d4966/repos/qwen-code/packages/sdk-python/tests/integration/test_async_query.py::test_single_turn_query /workspace/scratch/4bed741d4966/repos/qwen-code/packages/sdk-python/tests/integration/test_async_query.py::test_async_context_manager -q -s --tb=short -p no:cacheprovider --basetemp=/workspace/scratch/4bed741d4966/audit/qwen-start-close-postfix-pytest > /workspace/scratch/4bed741d4966/audit/qwen-start-close-independent-postfix.log 2>&1
```

### Observed behavior after the fix

The unchanged original subprocess regression and two existing happy paths report **3 passed in 0.29 s**. The original scheduling still starts a public control task, yields once, and awaits close before a child handle is visible. Close completes in approximately **1.65 ms**, the query reports closed, and the actual local Python child is no longer alive. The existing single-turn query and asynchronous-context-manager tests both pass with the repository's local Python protocol fixture.

The helper asserts the exact Git commit and imported SDK path before pytest, and verifies that production source has no working-tree changes. The original reproduction file and existing happy-path tests were reused from the unchanged base checkout. No process-launch function or transport method was patched for this test.

### Verification scope

This confirms the local subprocess lifecycle case and the two local protocol happy paths. It does not revalidate the installed official CLI. The rejected official-CLI operation was not retried, moved, or modified. Repository build, bundle, and preflight remain incomplete: the implementation owner reports the CLI TypeScript build being terminated with exit 137 without a TypeScript diagnostic, including its final lower-heap attempt. The test-script result must not be described as completion of those gates.

Evidence: `/workspace/scratch/4bed741d4966/audit/qwen-start-close-independent-postfix.log`. The original baseline failures and initial CLI observation are preserved above.
