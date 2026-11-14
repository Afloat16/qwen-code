# Round 8 exact candidate validation

This workflow checks the immutable source commits below on separate hosted runners. Both jobs run the standard full build, complete workspace and integration type checks, the production bundle, affected tests and production-owner counterfactual checks. Source restoration is verified before completion.

- MCP PR #17120: `ddfab5ea762c2e70ce46754d8898cce25c3020d5`, tree `a2f4efec0b37e4c921381684bd214a8fb8793fad`.
- Memory PR #17108: `c950a2af68ffaea34ef4290cb0dc720b01ebdb5b`, tree `25bfebdb05bacef1c9a8e2d21360351776145cfc`.

The MCP job also runs thirteen real-bundle cases with temporary settings and runtime storage. It does not start a configured MCP server. The independent parser baseline and verification are recorded separately at [09e793dc](https://github.com/Afloat16/qwen-code/tree/09e793dcbc4a01ff297b5a0d298f4c1af911bb6c/.github/validation/round8-independent).

Permissions are read-only and checkout credentials are not persisted. Test-only mutations are restored in `finally`; no validation files enter either PR's source branch.

Trigger: initial exact-candidate validation.
