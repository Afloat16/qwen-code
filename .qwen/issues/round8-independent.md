# Independent reproduction: Qwen PRs 17108 and 17120, round 8

Reviewed source: 17108 caa528f0d4dcccf5521971d902257c3ecdeed8cd; 17120 40978fcaae8aed6cbc67bc4c11e46b099a4450bd.

17108 review: https://github.com/QwenLM/qwen-code/pull/17108#discussion_r4566604819. A superseded refresh must preserve newer save feedback, must not emit a false error, and genuine unavailable/list errors must retain their feedback. Same-path background load can use neutral retry feedback, with the next uncontended refresh recovering content.

17120 review: https://github.com/QwenLM/qwen-code/pull/17120#discussion_r4566731415. Literal server arguments --args value and --args=value img lose values. Preserve unknown flags and numeric-looking strings while keeping the declared timeout numeric.

## Reproduction report

Pending hosted run. Global qwen availability is checked first. If unavailable, test-script fallbacks use real React/resource hooks or exact production command/builder with locked yargs; the parser probe observes its handler input and does not claim whole-CLI/settings persistence. Source files are not edited. Meaningful controls and source hashes are recorded.

## Verification report

Pending unchanged-fixture rerun on fixed source.
