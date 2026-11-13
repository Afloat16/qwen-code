# Qwen #17108 R3 independent reproduction

Exact baseline: `eedc5dc22d7b67d4b6210088b277ede7347e3181`.
Requests: [4563353238](https://github.com/QwenLM/qwen-code/pull/17108#discussion_r4563353238), [4563353276](https://github.com/QwenLM/qwen-code/pull/17108#discussion_r4563353276).

This is a temporary test-script fallback using the real MemoryMessage, useDaemonMemory, useDaemonResource, and useWorkspaceEventReload. The provider action/availability/event signals are controlled at their existing test seam. No product source is changed. The local executor is unavailable; the hosted runner records a global qwen availability attempt. The reported paths require interactive Web Shell refresh state and deterministic interleaving, so a headless CLI cannot observe these controls.

## Reproduction report

The first hosted attempt (run 43455399442 / job 131988059893) was blocked during test collection by the missing browser daemon SDK entry, so it executed zero tests and is not reproduction evidence. Its source hashes and tracked diff stayed unchanged, and its temporary fixture was removed. The next attempt builds only that prerequisite with the same esbuild entry/options as the SDK build; it retains the unmodified web-shell Vitest configuration. The selected review alternative is explicit retry feedback for a superseded click, not automatic re-reading. The two interleaving assertions were updated before obtaining the accepted baseline; initial artifacts are retained.

A second setup-only attempt (run 43455904046 / job 131989836721) identified four missing acp-bridge runtime exports used by the browser daemon SDK. No tests executed. The next attempt compiles those four actual source entrypoints and the SDK daemon entry, without any source substitution or Vitest configuration change. This narrow prerequisite compilation is not a full repository build or typecheck.

**Status**: REPRODUCED
**Method**: test-script (standard web-shell Vitest configuration; real React/resource/memory/event hooks)
**Binary**: no global qwen is installed on the hosted runner; no CLI or browser E2E claim
**Run**: https://github.com/Afloat16/qwen-code/actions/runs/43456381151 (job 131991509182)
**Source**: exact eedc5dc22d7b67d4b6210088b277ede7347e3181

Five cases executed: two controls passed and three direct assertions failed, with zero skipped cases and no runtime/setup error. The list loader's workspace-not-trusted cause appears in the panel but the transcript receives generic retry text. For both superseded resolve and reject, the current click produces no transcript feedback, performs no content read, and leaves Edit disabled. The independent uncontended refresh control re-reads once and recovers; the unavailable control keeps the existing generic failure. The new retry-feedback assertions fail directly on zero callback calls.

All four production file SHA256 values and the complete tracked diff match before and after the run. The temporary test was removed in finally. The narrow dependency compilation is setup only; this run does not represent a full repository build or typecheck. The two earlier zero-test setup attempts remain recorded above and are not counted as reproduction evidence.

## Verification report

Pending the same unchanged fixture against the owner's exact candidate.
