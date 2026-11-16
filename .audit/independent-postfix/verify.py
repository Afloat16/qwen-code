"""Run unchanged reproduction scripts against an explicitly checked SDK worktree."""

import json
from pathlib import Path
import subprocess
import sys

import pytest
import qwen_code_sdk

repo = Path(sys.argv[1]).resolve()
expected_head = sys.argv[2]
actual_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
source_root = repo / "packages/sdk-python/src/qwen_code_sdk"
assert actual_head == expected_head, (actual_head, expected_head)
assert Path(qwen_code_sdk.__file__).resolve().parent == source_root, qwen_code_sdk.__file__
subprocess.run(["git", "diff", "--exit-code", "--", "packages/sdk-python/src"], cwd=repo, check=True)
print(json.dumps({"head": actual_head, "sdk_module": qwen_code_sdk.__file__, "python": sys.version}), flush=True)
raise SystemExit(pytest.main(sys.argv[3:]))
