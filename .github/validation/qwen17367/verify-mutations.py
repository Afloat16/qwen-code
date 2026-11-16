#!/usr/bin/env python3
"""Prove the two review regressions fail, then restore the exact candidate."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


HOSTED_SOURCE = "packages/cli/src/serve/hosted-extension-command.ts"
SHELL_SOURCE = "packages/cli/src/services/prompt-processors/shellProcessor.ts"
HOSTED_TEST = "src/serve/hosted-extension-command.test.ts"
SHELL_TEST = "src/services/prompt-processors/shellProcessor.test.ts"
HOSTED_TITLE = "keeps argument text literal when expanding a hosted file path"
SHELL_TITLE = (
    "substitutes safe {} arguments consistently for permissions and execution"
)
SHELL_SELECTOR = (
    "substitutes safe .* arguments consistently for permissions and execution"
)
HOSTED_BEFORE = r"""    return text.replace(
      /\{\{args\}\}|\$ARGUMENTS|\$\{extensionPath\}/g,
      (placeholder) =>
        placeholder === '${extensionPath}'
          ? `extension://${command.extensionId}`
          : options.args,
    );"""
HOSTED_AFTER = """    return text
      .replaceAll('{{args}}', options.args)
      .replaceAll('$ARGUMENTS', options.args)
      .replaceAll('${extensionPath}', `extension://${command.extensionId}`);"""
SHELL_BEFORE = """          (placeholder) =>
            placeholder === SHORTHAND_ARGS_PLACEHOLDER
              ? userArgsEscaped
              : userArgsForArgumentsPlaceholder,"""
SHELL_AFTER = """          () => userArgsEscaped,"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    originals = {
        relative: (repo / relative).read_bytes()
        for relative in (HOSTED_SOURCE, SHELL_SOURCE)
    }
    summary = {
        "original_sha256": {key: digest(value) for key, value in originals.items()},
        "runs": [],
        "success": False,
    }
    expected_titles = {
        HOSTED_TITLE: "passed",
        SHELL_TITLE.format("{{args}}"): "passed",
        SHELL_TITLE.format("$ARGUMENTS"): "passed",
    }

    def run_tests(label, test_files, selector, expected):
        report_path = output / (label + ".json")
        command = [
            "node",
            str(repo / "node_modules/vitest/vitest.mjs"),
            "run",
            *test_files,
            "--testNamePattern",
            selector,
            "--reporter=default",
            "--reporter=json",
            "--outputFile=" + str(report_path),
            "--coverage.enabled=false",
            "--maxWorkers=2",
            "--no-file-parallelism",
        ]
        result = subprocess.run(
            command,
            cwd=repo / "packages/cli",
            env={**os.environ, "FORCE_COLOR": "0"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            check=False,
        )
        (output / (label + ".log")).write_text(result.stdout, encoding="utf-8")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        assertions = [
            assertion
            for suite in report["testResults"]
            for assertion in suite["assertionResults"]
        ]
        active = [
            assertion
            for assertion in assertions
            if assertion["status"] not in ("pending", "skipped", "todo")
        ]
        actual = {item["title"]: item["status"] for item in active}
        summary["runs"].append(
            {"label": label, "exit_code": result.returncode, "tests": actual}
        )
        expected_code = 1 if "failed" in expected.values() else 0
        if result.returncode != expected_code:
            raise AssertionError(
                f"{label}: exit {result.returncode}, expected {expected_code}"
            )
        if len(active) != len(expected) or actual != expected:
            raise AssertionError(f"{label}: unexpected test results: {actual}")
        for item in active:
            if item["status"] == "failed":
                failures = "\n".join(item.get("failureMessages", []))
                if "AssertionError" not in failures:
                    raise AssertionError(f"{label}: failure is not an assertion")
        print(f"{label}: {actual}", flush=True)

    def mutate(label, relative, before, after, test_file, selector, expected):
        path = repo / relative
        source = originals[relative].decode("utf-8")
        if source.count(before) != 1:
            raise AssertionError(f"{label}: mutation anchor is not unique")
        try:
            path.write_bytes(source.replace(before, after, 1).encode("utf-8"))
            run_tests(label, [test_file], selector, expected)
        finally:
            path.write_bytes(originals[relative])
            if digest(path.read_bytes()) != summary["original_sha256"][relative]:
                raise AssertionError(f"{label}: source restoration failed")

    try:
        selector = f"{HOSTED_TITLE}|{SHELL_SELECTOR}"
        run_tests(
            "candidate-control", [HOSTED_TEST, SHELL_TEST], selector, expected_titles
        )
        mutate(
            "hosted-chained-string-replacement",
            HOSTED_SOURCE,
            HOSTED_BEFORE,
            HOSTED_AFTER,
            HOSTED_TEST,
            HOSTED_TITLE,
            {HOSTED_TITLE: "failed"},
        )
        mutate(
            "shell-always-escaped-arguments",
            SHELL_SOURCE,
            SHELL_BEFORE,
            SHELL_AFTER,
            SHELL_TEST,
            SHELL_SELECTOR,
            {
                SHELL_TITLE.format("{{args}}"): "passed",
                SHELL_TITLE.format("$ARGUMENTS"): "failed",
            },
        )
        run_tests(
            "restored-candidate", [HOSTED_TEST, SHELL_TEST], selector, expected_titles
        )
        summary["success"] = True
    except Exception as error:
        summary["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        for relative, original in originals.items():
            (repo / relative).write_bytes(original)
        summary["restored_sha256"] = {
            relative: digest((repo / relative).read_bytes()) for relative in originals
        }
        summary["sources_restored"] = (
            summary["restored_sha256"] == summary["original_sha256"]
        )
        (output / "summary.json").write_text(
            json.dumps(summary, indent=2) + "\n", encoding="utf-8"
        )
        if not summary["sources_restored"]:
            raise AssertionError("Original production source hashes were not restored")


if __name__ == "__main__":
    main()
