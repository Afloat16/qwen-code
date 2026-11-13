# Qwen #17108 R3 independent reproduction

Exact baseline: `eedc5dc22d7b67d4b6210088b277ede7347e3181`.
Requests: [4563353238](https://github.com/QwenLM/qwen-code/pull/17108#discussion_r4563353238), [4563353276](https://github.com/QwenLM/qwen-code/pull/17108#discussion_r4563353276).

This is a temporary test-script fallback using the real MemoryMessage, useDaemonMemory, useDaemonResource, and useWorkspaceEventReload. The provider action/availability/event signals are controlled at their existing test seam. No product source is changed. The local executor is unavailable; the hosted runner records a global qwen availability attempt. The reported paths require interactive Web Shell refresh state and deterministic interleaving, so a headless CLI cannot observe these controls.

## Reproduction report

Pending hosted observations. Five focused cases cover the real daemon-error transcript, superseded resolve/reject refresh recovery, and two controls (uncontended recovery and unavailable generic feedback). Baseline acceptance requires exactly three direct assertion failures and both controls passing, with no runtime/setup errors. The runner records exact production SHA256 before/after and removes the temporary test in finally.

## Verification report

Pending the same unchanged fixture against the owner's exact candidate.
