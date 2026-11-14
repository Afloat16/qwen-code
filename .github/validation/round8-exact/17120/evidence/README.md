# MCP literal server argument verification

Final source: `9c48bdcd106ee04f792dfa754866d00bb8fc19df`, tree `52d17024a24458da427872ae8392e2d450a7a095`, parent `40978fcaae8aed6cbc67bc4c11e46b099a4450bd`.

## Final hosted result

[Exact-candidate job](https://github.com/Afloat16/qwen-code/actions/runs/43565846363/job/132359403842) completed successfully on Linux with Node.js 22.23.4, pnpm 11.24.0 and frozen dependencies. The standard full workspace build, complete workspace/integration typecheck, CLI bundle, changed-file ESLint and Prettier all passed.

The unmodified CLI Vitest configuration ran 201 tests (155 CLI entry tests and 46 add-command tests), with zero failures or skips. Keeping the candidate tests and restoring only the parent add-command production source produced three direct assertion failures and five passing controls; 193 unrelated cases were filtered. Restoring the exact final source passed all eight selected cases. Source bytes, test hashes and the tracked diff were restored and checked. See `candidate-verification.json`.

The real `node dist/cli.js` entry passed thirteen scenarios, exercising the parser, handler and settings writer. See `bundle-observations.json` for complete argv, stdout/stderr, exits and before/after settings. Literal `--args` and equals forms, similar and replacement-key spellings, numeric strings, typed timeout, separator data and empty server arguments are covered. Three error controls and the empty-server list left settings and synthetic OAuth files byte-identical; every scenario left the synthetic token file unchanged. The fixture uses temporary configuration/runtime directories and a temporary child homedir override, preserves the HOME environment variable and never launches a configured MCP server.

## Reproduction and diagnostic scope

[Independent frozen parser reports](https://github.com/Afloat16/qwen-code/tree/4db06a3d873d45bd244a23290c3cb3a47eec136b/.github/validation/round8-independent) record three direct failures and six passing controls on unchanged parent `40978fca`, followed by nine passes on the final source. That fixture extracts the actual production command and builder with locked ESM yargs; it is separate from the full CLI/settings result above.

The production owner's `diagnose.mjs` generated four parser variants from the adjacent exact parent `add-original.ts`. Ten cases were run both directly and through a nested strict MCP command. The unchanged parent passed 12/20; renaming the variadic key passed 14/20 but lost `--serverArgs`/`--server-args` data and numeric spellings after the separator; retaining a named positional without its explicit type passed 12/20; the raw-tail variant passed 20/20. These are diagnostic parser observations, not full CLI or settings-writer tests. Run this script with the locked TypeScript/yargs dependencies; generated variant files remain beside the fixture. Full observations are in `diagnostic-results.json`.

## Initial negative-test correction

The [initial hosted job](https://github.com/Afloat16/qwen-code/actions/runs/43564873472/job/132356395553) on `ddfab5ea` completed full build/typecheck/bundle, then reported 199 passing tests and two failures. Both new negative assertions invoked yargs before handing a promise to the rejection matcher, and its expected validation errors were synchronous throws. The final candidate wraps parsing in a promise continuation to observe both sync throws and async rejections; production source is byte-identical (SHA256 `fb4854727e2e70785f4497d372fdcfdf5ae6f24e41cfb3a69aaf3ac086c10fad`). The corrected assertion and exact extracted builder passed a local two-case ESM yargs/Vitest preflight before the complete final hosted run. The initial failed result is preserved in `initial-candidate-test-report.json`; it is not counted as a passing full suite.
