# Independent review verification — 2026-11-14

This branch records local validation separately from the production PR branches. The earlier workflow pushes did not create Actions runs while the fork's workflows were disabled. These reports are local results, not hosted CI. This evidence-only commit skips CI; full candidate gates run independently on the owner validation branch.

## Qwen #17120

The unchanged production command and builder were extracted through TypeScript AST. `mcp-probe-esm.mjs` uses the real ESM yargs entrypoint, matching production cli.ts, with frozen workspace dependencies (Node 24.22.1, TypeScript 5.8.3, yargs 17.7.2). Only an observer handler is substituted; this fixture does not execute the settings writer, whole CLI, or a model.

- Baseline `40978fcaae8aed6cbc67bc4c11e46b099a4450bd`: six controls pass; three assertion failures reproduce literal `--args`, `--args=value`, and numeric spelling after `--` being lost.
- Final candidate `9c48bdcd106ee04f792dfa754866d00bb8fc19df`: the identical nine cases all pass. The production blob is unchanged from `ddfab5ea`; only two owner test assertions were corrected to capture both synchronous throws and asynchronous rejections. The independent fixture and all nine expectations are unchanged.
- Both phases preserve production hashes and tracked diffs.

An earlier CJS fixture passed with isolated exact-version dependencies, but the workspace's pre-existing ansi-regex override breaks the CJS help formatter. Production uses ESM. Both exact commits were rerun with the ESM fixture, which is the authoritative result above. No dependency lock changes were made.

## Qwen #17108 corrected baseline and final verification

The fixture uses real MemoryMessage, useDaemonMemory, useDaemonResource, useWorkspaceEventReload, and translations, with controlled transport actions and availability. It does not start a full daemon/browser/model session.

The original Save-case fixture used `Save`, while the actual UI says `Save Memory`. That attempt stopped at its locator and is superseded, not counted as a behavioral reproduction. Only this locator was corrected; both exact commits were then tested with the same assertions.

- Baseline `caa528f0d4dcccf5521971d902257c3ecdeed8cd`: six cases execute, three controls pass, three behavioral assertions fail. Two failures cover superseded-refresh messages. The Save case reaches the write, observes successful save feedback, then fails because the older refresh overwrites it.
- Final candidate `c950a2af68ffaea34ef4290cb0dc720b01ebdb5b`: all six cases pass, with zero skips or runtime errors. Production source hashes and tracked diffs remain unchanged, and the temporary test is removed.
- Production and translation blobs match the earlier `d20ca218` candidate; the final candidate additionally corrects the owner's corresponding Save test locator.

The full local install was killed during optional native audio setup, and full SDK declaration compilation reached the local heap limit. For this bounded fixture only, four ACP constants modules and the SDK daemon runtime were compiled with esbuild from unchanged exact source, then the six tests executed. This is not a complete workspace build claim. The JSON reports and logs in this directory are the corrected baseline and final verification.
