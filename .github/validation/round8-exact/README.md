# Round 8 exact candidate validation

The original shared run 43564873472 checked the immutable MCP and Memory source commits on separate hosted runners. This revision reruns only the corrected MCP candidate below. The gates cover the standard full build, complete workspace and integration type checks, the production bundle, affected tests and production-owner counterfactual checks. Source restoration is verified before completion.

- Final MCP PR #17120 candidate: `9c48bdcd106ee04f792dfa754866d00bb8fc19df`, tree `52d17024a24458da427872ae8392e2d450a7a095`.
- Memory PR #17108: `c950a2af68ffaea34ef4290cb0dc720b01ebdb5b`, tree `25bfebdb05bacef1c9a8e2d21360351776145cfc`.

The MCP job also runs thirteen real-bundle cases with temporary settings and runtime storage. It does not start a configured MCP server. The independent parser baseline and verification are recorded separately at [09e793dc](https://github.com/Afloat16/qwen-code/tree/09e793dcbc4a01ff297b5a0d298f4c1af911bb6c/.github/validation/round8-independent).

Permissions are read-only and checkout credentials are not persisted. Test-only mutations are restored in `finally`; no validation files enter either PR's source branch.

Trigger: corrected MCP negative assertion validation.

## MCP negative assertion correction

The initial MCP job in run 43564873472 completed the full build, workspace/integration typecheck and bundle, then reported 199 passing tests and two failures. Both failures were the newly added negative controls: yargs throws validation errors synchronously from `parseAsync`, before a direct promise assertion can observe them. Candidate `9c48bdcd106ee04f792dfa754866d00bb8fc19df` changes only those assertions from the initial `ddfab5ea` candidate, wrapping parsing in a promise continuation so both synchronous throws and asynchronous rejections are checked. The exact extracted production builder and corrected assertions passed a local two-case ESM yargs/Vitest preflight; this is a bounded harness check, not the full CLI suite. Production source is byte-identical (SHA256 `fb4854727e2e70785f4497d372fdcfdf5ae6f24e41cfb3a69aaf3ac086c10fad`). The rerun checks the final candidate's full gates and real bundle cases. The unchanged Memory job remains in the original run and is not repeated by this workflow revision.
