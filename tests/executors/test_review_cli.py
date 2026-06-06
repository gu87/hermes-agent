#!/usr/bin/env python3
"""
Tests for executors/review_cli.py — CLI subcommands for review/QA.

Scope:
  - cmd_review_build_prompt: prints prompt + line/char stats
  - cmd_review_parse: parses JSON input, prints findings + report;
    empty input exits with error
  - cmd_review_executor: prints recommended executor + reason
  - cmd_qa_build_prompt: prints prompt + line/char stats
  - cmd_qa_parse: parses JSON input, prints status/counts/coverage/risks;
    empty input exits with error
  - cmd_qa_executor: prints recommended executor + reason
  - handle_review_command / handle_qa_command dispatchers:
      * no subcommand → exits with error
      * each subcommand dispatches correctly
      * unknown subcommand → exits with error
  - Boundary guards:
      * import review_cli does NOT pull in executors.cli
      * import review_cli does NOT pull in hermes_cli.kanban_feedback
      * import review_cli does NOT pull in executors.bridge*

Strictly no subprocess, no DB, no real files (uses --input not --input-file
to keep tests hermetic), no model invocations.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import sys
from pathlib import Path
from typing import List

import pytest

from executors import review_cli
from executors.review_cli import (
    SEVERITY_ICONS,
    cmd_qa_build_prompt,
    cmd_qa_executor,
    cmd_qa_parse,
    cmd_review_build_prompt,
    cmd_review_executor,
    cmd_review_parse,
    handle_qa_command,
    handle_review_command,
)


# ---------------------------------------------------------------------------
# Async helper
# ---------------------------------------------------------------------------


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ---------------------------------------------------------------------------
# 1. cmd_review_build_prompt
# ---------------------------------------------------------------------------


class TestCmdReviewBuildPrompt:
    def test_prints_prompt_with_stats(self, capsys) -> None:
        _run(cmd_review_build_prompt(
            goal="Refactor login",
            diff="+x = 1",
            changed_files="a.py,b.py",
            executor="claude-code",
        ))
        out = capsys.readouterr().out
        assert "--- Review Context ---" in out
        assert "Refactor login" in out
        assert "--- Prompt stats ---" in out
        assert "Lines:" in out
        assert "Chars:" in out

    def test_with_prompt_snapshot(self, capsys) -> None:
        _run(cmd_review_build_prompt(
            goal="g", diff="", changed_files="",
            executor="claude-code",
            prompt_snapshot="user wants to do X",
        ))
        out = capsys.readouterr().out
        assert "user wants to do X" in out

    def test_empty_changed_files_no_crash(self, capsys) -> None:
        _run(cmd_review_build_prompt(
            goal="g", diff="", changed_files="", executor="claude-code",
        ))
        assert "--- Review Context ---" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# 2. cmd_review_parse
# ---------------------------------------------------------------------------


class TestCmdReviewParse:
    def test_parses_json_array(self, capsys) -> None:
        text = (
            '[{"severity": "high", "category": "security", '
            '"title": "XSS", "description": "unescaped input"}]'
        )
        _run(cmd_review_parse(
            review_run_id="r-1",
            input_text=text,
            input_file="",
        ))
        out = capsys.readouterr().out
        assert "Findings: 1" in out
        assert "XSS" in out
        assert "=== Report ===" in out
        assert "Status:" in out
        assert "Total findings:" in out
        assert "High:" in out

    def test_parses_with_prose_around_json(self, capsys) -> None:
        text = (
            "Here is my review:\n"
            '[{"severity": "low", "category": "style", '
            '"title": "naming", "description": "use snake_case"}]\n'
            "Done."
        )
        _run(cmd_review_parse(review_run_id="r-1", input_text=text))
        out = capsys.readouterr().out
        assert "Findings: 1" in out
        assert "naming" in out

    def test_severity_icons_used(self, capsys) -> None:
        text = '[{"severity": "critical", "category": "security", "title": "x", "description": "y"}]'
        _run(cmd_review_parse(review_run_id="r", input_text=text))
        out = capsys.readouterr().out
        # SEVERITY_ICONS["critical"] is "●"
        assert SEVERITY_ICONS["critical"] in out

    def test_empty_input_exits(self) -> None:
        # Whitespace-only input → text.strip() is empty → exits 1.
        # We don't pass both "" because cmd_review_parse falls through
        # to sys.stdin.read() in that case, and pytest's stdin capture
        # raises OSError before the empty-check can fire.
        with pytest.raises(SystemExit) as exc_info:
            _run(cmd_review_parse(review_run_id="r", input_text="   ", input_file=""))
        assert exc_info.value.code == 1

    def test_unparseable_input_returns_info_finding(self, capsys) -> None:
        # No JSON — produces a single INFO finding via the parser's
        # fallback branch.
        _run(cmd_review_parse(review_run_id="r", input_text="just some prose"))
        out = capsys.readouterr().out
        assert "Parse warning:" in out
        assert "Findings: 1" in out


# ---------------------------------------------------------------------------
# 3. cmd_review_executor
# ---------------------------------------------------------------------------


class TestCmdReviewExecutor:
    def test_prints_recommendation(self, capsys) -> None:
        _run(cmd_review_executor(available="claude-code,opencode,hermes-local"))
        out = capsys.readouterr().out
        assert "Recommended: claude-code" in out
        assert "Reason:" in out

    def test_empty_available_uses_hermes_local(self, capsys) -> None:
        _run(cmd_review_executor(available=""))
        out = capsys.readouterr().out
        assert "Recommended: hermes-local" in out
        assert "fallback" in out.lower() or "falling back" in out.lower()


# ---------------------------------------------------------------------------
# 4. cmd_qa_build_prompt
# ---------------------------------------------------------------------------


class TestCmdQaBuildPrompt:
    def test_prints_prompt_with_stats(self, capsys) -> None:
        _run(cmd_qa_build_prompt(
            goal="Run tests",
            changed_files="a.py,b.py",
            test_cmds="unit:pytest -q;lint:ruff check .",
            worktree_path="/tmp/wt",
        ))
        out = capsys.readouterr().out
        assert "--- QA Context ---" in out
        assert "Run tests" in out
        assert "Test Commands:" in out
        assert "unit: pytest -q" in out
        assert "lint: ruff check ." in out
        assert "Worktree Path: /tmp/wt" in out
        assert "--- Prompt stats ---" in out

    def test_empty_test_cmds(self, capsys) -> None:
        _run(cmd_qa_build_prompt(
            goal="g", changed_files="a.py", test_cmds="", worktree_path="",
        ))
        out = capsys.readouterr().out
        assert "No test commands configured" in out


# ---------------------------------------------------------------------------
# 5. cmd_qa_parse
# ---------------------------------------------------------------------------


class TestCmdQaParse:
    def test_parses_json_qa_results(self, capsys) -> None:
        text = json.dumps({
            "test_passed": 10, "test_failed": 2, "test_skipped": 1,
            "failed_test_details": "2 failed",
            "coverage_delta": 0.5,
        })
        _run(cmd_qa_parse(qa_run_id="q-1", input_text=text))
        out = capsys.readouterr().out
        assert "Status:" in out
        assert "Passed:   10" in out
        assert "Failed:   2" in out
        assert "Skipped:  1" in out
        assert "Coverage: +0.5%" in out

    def test_parses_risks(self, capsys) -> None:
        text = json.dumps({
            "test_passed": 5, "test_failed": 0, "test_skipped": 0,
            "risks": [
                {"severity": "low", "title": "minor risk", "description": "x", "affected_areas": ["a"]}
            ],
        })
        _run(cmd_qa_parse(qa_run_id="q", input_text=text))
        out = capsys.readouterr().out
        assert "Risks (1):" in out
        assert "minor risk" in out
        assert "Affected: a" in out

    def test_empty_input_exits(self) -> None:
        # Whitespace-only input → text.strip() is empty → exits 1.
        # We don't pass both "" because cmd_qa_parse falls through to
        # sys.stdin.read() in that case, and pytest's stdin capture
        # raises OSError before the empty-check can fire.
        with pytest.raises(SystemExit) as exc_info:
            _run(cmd_qa_parse(qa_run_id="q", input_text="   ", input_file=""))
        assert exc_info.value.code == 1

    def test_no_coverage_no_coverage_line(self, capsys) -> None:
        text = json.dumps({"test_passed": 1, "test_failed": 0, "test_skipped": 0})
        _run(cmd_qa_parse(qa_run_id="q", input_text=text))
        out = capsys.readouterr().out
        assert "Coverage:" not in out


# ---------------------------------------------------------------------------
# 6. cmd_qa_executor
# ---------------------------------------------------------------------------


class TestCmdQaExecutor:
    def test_prints_recommendation(self, capsys) -> None:
        _run(cmd_qa_executor(available="opencode,claude-code"))
        out = capsys.readouterr().out
        assert "Recommended: opencode" in out
        assert "Reason:" in out

    def test_empty_fallback(self, capsys) -> None:
        _run(cmd_qa_executor(available=""))
        out = capsys.readouterr().out
        assert "Recommended: hermes-local" in out


# ---------------------------------------------------------------------------
# 7. handle_review_command dispatcher
# ---------------------------------------------------------------------------


def _review_args(**kwargs) -> argparse.Namespace:
    base = {
        "review_subcommand": None,
        "goal": "g",
        "diff": "",
        "changed_files": "",
        "executor": "claude-code",
        "prompt_snapshot": "",
        "review_run_id": "r-1",
        "input": "",
        "input_file": "",
        "available": "",
    }
    base.update(kwargs)
    return argparse.Namespace(**base)


def _qa_args(**kwargs) -> argparse.Namespace:
    base = {
        "qa_subcommand": None,
        "goal": "g",
        "changed_files": "",
        "test_cmds": "",
        "worktree_path": "",
        "qa_run_id": "q-1",
        "input": "",
        "input_file": "",
        "available": "",
    }
    base.update(kwargs)
    return argparse.Namespace(**base)


class TestHandleReviewCommand:
    def test_no_subcommand_exits(self) -> None:
        with pytest.raises(SystemExit) as exc_info:
            _run(handle_review_command(_review_args()))
        assert exc_info.value.code == 1

    def test_build_prompt_dispatches(self, capsys) -> None:
        _run(handle_review_command(_review_args(review_subcommand="build-prompt")))
        out = capsys.readouterr().out
        assert "--- Review Context ---" in out

    def test_parse_dispatches(self, capsys) -> None:
        text = '[{"severity": "low", "category": "style", "title": "x", "description": "y"}]'
        _run(handle_review_command(_review_args(
            review_subcommand="parse", input=text
        )))
        out = capsys.readouterr().out
        assert "Findings: 1" in out

    def test_executor_dispatches(self, capsys) -> None:
        _run(handle_review_command(_review_args(
            review_subcommand="executor", available="claude-code"
        )))
        out = capsys.readouterr().out
        assert "Recommended: claude-code" in out

    def test_unknown_subcommand_exits(self) -> None:
        with pytest.raises(SystemExit) as exc_info:
            _run(handle_review_command(_review_args(review_subcommand="not-real")))
        assert exc_info.value.code == 1


class TestHandleQaCommand:
    def test_no_subcommand_exits(self) -> None:
        with pytest.raises(SystemExit) as exc_info:
            _run(handle_qa_command(_qa_args()))
        assert exc_info.value.code == 1

    def test_build_prompt_dispatches(self, capsys) -> None:
        _run(handle_qa_command(_qa_args(qa_subcommand="build-prompt")))
        out = capsys.readouterr().out
        assert "--- QA Context ---" in out

    def test_parse_dispatches(self, capsys) -> None:
        text = json.dumps({"test_passed": 3, "test_failed": 0, "test_skipped": 0})
        _run(handle_qa_command(_qa_args(qa_subcommand="parse", input=text)))
        out = capsys.readouterr().out
        assert "Passed:   3" in out

    def test_executor_dispatches(self, capsys) -> None:
        _run(handle_qa_command(_qa_args(qa_subcommand="executor", available="opencode")))
        out = capsys.readouterr().out
        assert "Recommended: opencode" in out

    def test_unknown_subcommand_exits(self) -> None:
        with pytest.raises(SystemExit) as exc_info:
            _run(handle_qa_command(_qa_args(qa_subcommand="nope")))
        assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# 8. SEVERITY_ICONS — completeness
# ---------------------------------------------------------------------------


class TestSeverityIcons:
    def test_has_all_severities(self) -> None:
        for sev in ("critical", "high", "medium", "low", "info"):
            assert sev in SEVERITY_ICONS, f"missing icon for severity: {sev}"
            assert SEVERITY_ICONS[sev]  # non-empty


# ---------------------------------------------------------------------------
# 9. Boundary guards
# ---------------------------------------------------------------------------


class TestBoundaryGuards:
    def _reload_review_cli(self) -> None:
        # Drop the module from sys.modules, then re-import fresh. We can't
        # use importlib.reload() here because the local `review_cli` reference
        # becomes stale once the module is removed from sys.modules.
        # Return the set of modules that were ADDED by the re-import, so
        # boundary guards can assert against the diff (other test files in
        # the suite may have pre-populated sys.modules with bridge/bridge_cli).
        for mod in list(sys.modules):
            if mod == "executors.review_cli" or mod.startswith("executors.review_cli."):
                del sys.modules[mod]
        before = set(sys.modules)
        importlib.import_module("executors.review_cli")
        added = set(sys.modules) - before
        return added

    def test_does_not_pull_executors_cli(self) -> None:
        added = self._reload_review_cli()
        assert "executors.cli" not in added

    def test_does_not_pull_kanban_feedback(self) -> None:
        added = self._reload_review_cli()
        kf = [m for m in added if m == "hermes_cli.kanban_feedback" or m.startswith("hermes_cli.kanban_feedback.")]
        assert kf == []

    def test_does_not_pull_executors_bridge(self) -> None:
        added = self._reload_review_cli()
        assert "executors.bridge" not in added
        assert "executors.bridge_cli" not in added

    def test_does_not_pull_review_handler(self) -> None:
        # review_cli doesn't currently need review_handler; if you add
        # such a dependency, this guard will fail and force the change
        # to be intentional.
        self._reload_review_cli()
        # It is OK if review_handler gets pulled transitively through
        # review_agent; the guard just checks the direct target.
        # For now: review_cli does not import review_handler.
        src = Path(review_cli.__file__).read_text()
        assert "from executors.review_handler" not in src
        assert "import executors.review_handler" not in src

    def test_no_subprocess_in_review_cli(self) -> None:
        src = Path(review_cli.__file__).read_text()
        assert "subprocess" not in src

    def test_no_db_in_review_cli(self) -> None:
        src = Path(review_cli.__file__).read_text()
        assert "sqlite3" not in src
        assert "kanban_db" not in src
        assert "task_events" not in src
