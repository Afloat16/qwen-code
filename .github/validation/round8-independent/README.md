# Independent review verification — 2026-11-14

This branch records local validation, separately from the production PR branches. No GitHub Actions run was created for the earlier workflow pushes; these results are not presented as hosted CI.

## Qwen #17120

The unchanged production `addCommand.command` and builder were extracted through the TypeScript AST. The fixture uses the real ESM `yargs` entry point, matching `cli.ts`, with the installed frozen-lockfile workspace dependencies (Node 24.22.1, TypeScript 5.8.3, yargs 17.7.2). The only substituted part is an observer handler; this does not execute the production settings writer, whole CLI, or a model.

- Baseline `40978fcaae8aed6cbc67bc4c11e46b099a4450bd`: six controls pass; three assertion failures reproduce literal `--args`, `--args=value`, and numeric spelling after `--` being lost.
- Candidate `ddfab5ea762c2e70ce46754d8898cce25c3020d5`: the identical nine cases all pass.
- Source hashes and tracked diffs remain unchanged in both phases.

`mcp-probe-esm.mjs` is the authoritative production-import fixture. An earlier CJS bootstrap ran successfully with isolated exact-version dependencies, but the full workspace's existing ansi-regex override breaks the CJS help formatter. Production uses ESM; the ESM fixture was rerun on both exact commits and is the evidence above. No unrelated dependency lock changes were made.

## Qwen #17108 baseline

At unchanged `caa528f0d4dcccf5521971d902257c3ecdeed8cd`, six React/component/hook cases execute: three controls pass and three assertion failures reproduce superseded-refresh messages and an older Refresh overwriting successful Save feedback. There are no skipped tests or runtime errors. Production source hashes and tracked diffs are unchanged; the temporary test is removed afterward.

The test uses the real MemoryMessage, useDaemonMemory, useDaemonResource, useWorkspaceEventReload, and translations with controlled transport actions and availability. It does not start a full daemon/browser/model session. A full install was killed during optional native audio setup; full SDK declaration build encountered the local heap limit. For this bounded fixture only, four ACP constants modules and the SDK daemon runtime were compiled from the unchanged source with esbuild, then the six cases executed. This is not a claim that a complete workspace build passed. Final fixed-head verification will be recorded separately.
