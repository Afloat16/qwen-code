# Qwen #17108 R3 independent reproduction

Exact baseline: `eedc5dc22d7b67d4b6210088b277ede7347e3181`.
Requests: [4563353238](https://github.com/QwenLM/qwen-code/pull/17108#discussion_r4563353238), [4563353276](https://github.com/QwenLM/qwen-code/pull/17108#discussion_r4563353276).

This is a temporary test-script fallback using the real MemoryMessage, useDaemonMemory, useDaemonResource, and useWorkspaceEventReload. The provider action/availability/event signals are controlled at their existing test seam. No product source is changed. The local executor is unavailable; the hosted runner records a global qwen availability attempt. The reported paths require interactive Web Shell refresh state and deterministic interleaving, so a headless CLI cannot observe these controls.

## Reproduction report

The first hosted attempt (run 43455399442 / job 131988059893) was blocked during test collection by the missing browser daemon SDK entry, so it executed zero tests and is not reproduction evidence. Its source hashes and tracked diff stayed unchanged, and its temporary fixture was removed. The next attempt builds only that prerequisite with the same esbuild entry/options as the SDK build; it retains the unmodified web-shell Vitest configuration. The selected review alternative is explicit retry feedback for a superseded click, not automatic re-reading. The two interleaving assertions were updated before obtaining the accepted baseline; initial artifacts are retained.

A second setup-only attempt (run 43455904046 / job 131989836721) identified four missing acp-bridge runtime exports used by the browser daemon SDK. No tests executed. The next attempt compiles those four actual source entrypoints and the SDK daemon entry, without any source substitution or Vitest configuration change. This narrow prerequisite compilation is not a full repository build or typecheck.

Pending hosted observations. Five focused cases cover the real daemon-error transcript, explicit retry feedback for superseded resolve/reject refreshes, followed by successful uncontended retry, and two controls (uncontended recovery and unavailable generic feedback). Baseline acceptance requires exactly three direct assertion failures and both controls passing, with no runtime/setup errors. The runner records exact production SHA256 before/after and removes the temporary test in finally.

## Verification report

Pending the same unchanged fixture against the owner's exact candidate.
