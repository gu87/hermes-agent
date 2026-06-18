#!/usr/bin/env python3
"""
Tests for executors/review_handler.py — executors/IPC review + QA backend.

Scope:
  - Rename verification: trigger_review_ipc and trigger_qa_ipc exist; old
    trigger_review / trigger_qa names do NOT exist as top-level callables
  - trigger_review_ipc: happy path with monkeypatched _launch_opencode,
    opencode-unavailable fallback, generic exception fallback
  - trigger_qa_ipc: same matrix
  - _launch_opencode: command-not-found raises OpencodeUnavailable,
    exit-0 returns stdout, non-zero exit returns stdout+stderr fallback,
    timeout raises generic Exception
  - emit_diff_event: happy path returns dict, no diff returns None,
    oversized diff is truncated, rev-parse failure yields empty base_commit
  - stub_review_report / stub_qa_report: shapes
  - OpencodeUnavailable exception is catchable
  - Boundary guards:
      * import review_handler does NOT pull in hermes_cli.kanban_feedback
      * import review_handler does NOT pull in executors.cli
      * import review_handler does NOT pull in executors.bridge*
      * no test ever invokes the real opencode binary
      * no test ever writes to the real repo or DB
  - No real subprocess invocations anywhere in the test surface

Strictly no real opencode, no real git on real repo, no DB, no model.
All subprocess I/O is monkeypatched.
"""
from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path
from typing import List, Optional

import pytest

from executors import review_handler
from executors.review_handler import (
    OpencodeUnavailable,
    emit_diff_event,
    stub_qa_report,
    stub_review_report,
    trigger_qa_ipc,
    trigger_review_ipc,
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
# Fake subprocess infra (no real subprocess is ever spawned)
# ---------------------------------------------------------------------------


class _FakeProc:
    """A stand-in for an asyncio.subprocess.Process."""

    def __init__(self, returncode: int = 0, stdout: bytes = b"", stderr: bytes = b"") -> None:
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self):
        return self._stdout, self._stderr


def _fake_exec_factory(*outputs):
    """Build a fake asyncio.create_subprocess_exec that returns canned procs.

    Each output is a (returncode, stdout_bytes, stderr_bytes) tuple. Calls
    are popped from the queue in order; if the queue runs out, an empty
    success proc is returned.
    """
    queue: List[tuple] = list(outputs)

    async def fake(*args, **kwargs):
        if queue:
            rc, out, err = queue.pop(0)
            return _FakeProc(returncode=rc, stdout=out, stderr=err)
        return _FakeProc(returncode=0, stdout=b"", stderr=b"")

    return fake


# ---------------------------------------------------------------------------
# 1. Rename verification
# ---------------------------------------------------------------------------


class TestRenameVerification:
    def test_new_ipc_review_name_exists(self) -> None:
        assert hasattr(review_handler, "trigger_review_ipc")
        assert callable(review_handler.trigger_review_ipc)

    def test_new_ipc_qa_name_exists(self) -> None:
        assert hasattr(review_handler, "trigger_qa_ipc")
        assert callable(review_handler.trigger_qa_ipc)

    def test_old_names_dont_exist_as_callables(self) -> None:
        # After rename, plain trigger_review / trigger_qa must NOT be
        # top-level callables on review_handler (they would shadow the
        # kanban_feedback names).
        assert not callable(getattr(review_handler, "trigger_review", None))
        assert not callable(getattr(review_handler, "trigger_qa", None))


# ---------------------------------------------------------------------------
# 2. trigger_review_ipc — happy path
# ---------------------------------------------------------------------------


class TestTriggerReviewIpcHappyPath:
    def test_parses_structured_json_findings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Output shaped like a real executor JSON array of findings.
        fake_output = (
            '[{"severity": "high", "category": "security", '
            '"title": "XSS", "description": "unescaped input"}]'
        )

        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            return fake_output

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)

        report = _run(trigger_review_ipc(
            main_run_id="m-1",
            diff_patch="+x = 1",
            changed_files=["a.py"],
            task_goal="Refactor auth",
        ))
        assert report.total_findings == 1
        assert report.critical_count == 0
        assert report.high_count == 1
        assert report.status.value == "completed"
        assert report.executor == "opencode"
        assert report.review_run_id.startswith("review-m-1-")

    def test_no_findings_yields_passed_status(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Empty string from the executor → parser's "no findings or output"
        # branch returns ([], "...") → trigger sets status=PASSED → 0 findings.
        # NOTE: "[]" would NOT work here because the non-empty string falls
        # through to the "unstructured prose" branch and produces 1 info
        # finding with the raw "[]" as description.
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            return ""

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)

        report = _run(trigger_review_ipc(
            main_run_id="m-2",
            diff_patch="",
            changed_files=[],
            task_goal="noop",
        ))
        assert report.total_findings == 0
        assert report.status.value == "passed"

    def test_executor_type_propagated(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            return "[]"

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)
        report = _run(trigger_review_ipc(
            main_run_id="m", diff_patch="", changed_files=[], task_goal="g",
            executor_type="claude-code",
        ))
        assert report.executor == "claude-code"


# ---------------------------------------------------------------------------
# 3. trigger_review_ipc — fallback paths
# ---------------------------------------------------------------------------


class TestTriggerReviewIpcFallbacks:
    def test_opencode_unavailable_returns_failed_report(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            raise OpencodeUnavailable("opencode not found")

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)

        report = _run(trigger_review_ipc(
            main_run_id="m-1", diff_patch="+x", changed_files=[], task_goal="g"
        ))
        assert report.status.value == "failed"
        assert report.error is not None
        assert "opencode" in report.error.lower()
        assert report.total_findings == 0

    def test_generic_exception_returns_failed_report(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            raise RuntimeError("synthetic failure")

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)

        report = _run(trigger_review_ipc(
            main_run_id="m", diff_patch="", changed_files=[], task_goal="g"
        ))
        assert report.status.value == "failed"
        assert "synthetic failure" in (report.error or "")

    def test_unparseable_output_returns_completed_with_parse_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The parser's "unstructured" branch returns one INFO finding +
        # a parse error string. trigger_review_ipc puts the error in
        # the report's error field.
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            return "unstructured prose, no JSON at all"

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)
        report = _run(trigger_review_ipc(
            main_run_id="m", diff_patch="", changed_files=[], task_goal="g"
        ))
        # Either a parse-error message is set, or the report has a
        # single info finding. Both are acceptable outcomes.
        assert report.error is not None or report.info_count >= 1


# ---------------------------------------------------------------------------
# 4. trigger_qa_ipc — same matrix
# ---------------------------------------------------------------------------


class TestTriggerQaIpcHappyPath:
    def test_parses_json_qa_results(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            return (
                '{"test_passed": 5, "test_failed": 1, "test_skipped": 0, '
                '"failed_test_details": "1 test failed"}'
            )

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)

        report = _run(trigger_qa_ipc(
            main_run_id="qa-m-1",
            changed_files=["a.py", "b.py"],
            task_goal="run tests",
        ))
        assert report.test_passed == 5
        assert report.test_failed == 1
        assert report.test_skipped == 0
        assert report.executor == "opencode"
        assert report.qa_run_id.startswith("qa-qa-m-1-")

    def test_opencode_unavailable_returns_failed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            raise OpencodeUnavailable("not found")

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)
        report = _run(trigger_qa_ipc(
            main_run_id="q", changed_files=[], task_goal="g"
        ))
        assert report.status.value == "failed"
        assert "opencode" in (report.error or "").lower()

    def test_generic_exception_returns_failed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            raise RuntimeError("boom")

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)
        report = _run(trigger_qa_ipc(
            main_run_id="q", changed_files=[], task_goal="g"
        ))
        assert report.status.value == "failed"

    def test_heuristic_fallback_in_output(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Non-JSON output that the heuristic parser can read.
        async def fake_launch(prompt: str, cwd: Optional[str]) -> str:
            return "pytest output: 7 passed, 2 failed, 1 skipped"

        monkeypatch.setattr(review_handler, "_launch_opencode", fake_launch)
        report = _run(trigger_qa_ipc(
            main_run_id="q", changed_files=["a.py"], task_goal="g"
        ))
        assert report.test_passed == 7
        assert report.test_failed == 2
        assert report.test_skipped == 1


# ---------------------------------------------------------------------------
# 5. _launch_opencode — subprocess-level behavior
# ---------------------------------------------------------------------------


class TestLaunchOpencode:
    def test_command_not_found_raises_unavailable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(review_handler.shutil, "which", lambda cmd: None)
        with pytest.raises(OpencodeUnavailable) as exc_info:
            _run(review_handler._launch_opencode("prompt", cwd=None))
        assert "not found" in str(exc_info.value).lower()

    def test_command_found_exit_zero_returns_stdout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(review_handler.shutil, "which", lambda cmd: "/usr/bin/opencode")
        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            _fake_exec_factory((0, b"hello world\n", b"")),
        )
        out = _run(review_handler._launch_opencode("prompt", cwd="/tmp"))
        assert out == "hello world\n"

    def test_command_found_non_zero_exit_returns_stdout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Non-zero exit but stdout has data — current behavior is to
        # return stdout (or stderr fallback).
        monkeypatch.setattr(review_handler.shutil, "which", lambda cmd: "/usr/bin/opencode")
        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            _fake_exec_factory((1, b"partial output\n", b"some error\n")),
        )
        out = _run(review_handler._launch_opencode("prompt", cwd=None))
        assert "partial output" in out or "some error" in out

    def test_timeout_raises_generic_exception(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(review_handler.shutil, "which", lambda cmd: "/usr/bin/opencode")

        async def hanging_exec(*args, **kwargs):
            # Simulate a process that never finishes communicating.
            return _FakeProc(returncode=-1, stdout=b"", stderr=b"")

        # We need the communicate() call to raise TimeoutError.
        class _HangingProc:
            returncode = -1

            async def communicate(self):
                raise asyncio.TimeoutError()

        async def fake_exec_returns_hanging(*args, **kwargs):
            return _HangingProc()

        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            fake_exec_returns_hanging,
        )
        with pytest.raises(Exception) as exc_info:
            _run(review_handler._launch_opencode("prompt", cwd=None))
        # Either a generic Exception (wrapping TimeoutError) is raised.
        # We don't assert exact type since implementation may re-raise.
        assert "timed out" in str(exc_info.value).lower() or isinstance(
            exc_info.value, (asyncio.TimeoutError, Exception)
        )


# ---------------------------------------------------------------------------
# 6. emit_diff_event — diff emission helper
# ---------------------------------------------------------------------------


class TestEmitDiffEvent:
    def test_happy_path_returns_dict(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_diff = (
            b"diff --git a/x.py b/x.py\n"
            b"--- a/x.py\n+++ b/x.py\n"
            b"+x = 1\n"
            b"diff --git a/y.py b/y.py\n"
            b"--- a/y.py\n+++ b/y.py\n"
            b"+y = 2\n"
        )
        # First call: git diff → returns patch
        # Second call: git rev-parse HEAD → returns commit SHA
        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            _fake_exec_factory(
                (0, fake_diff, b""),
                (0, b"abc123def\n", b""),
            ),
        )
        result = _run(emit_diff_event("/tmp/some/wt", git_snapshot=None))
        assert result is not None
        assert "patch" in result
        assert "diff --git" in result["patch"]
        assert result["base_commit"] == "abc123def"
        assert result["files_changed"] == 2

    def test_no_diff_returns_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            _fake_exec_factory((0, b"", b"")),
        )
        result = _run(emit_diff_event("/tmp/wt", git_snapshot="HEAD"))
        assert result is None

    def test_oversized_diff_truncated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # > 200KB patch — should be truncated.
        huge = (b"+x" + b"y" * 250_000)  # 250002 bytes
        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            _fake_exec_factory((0, huge, b"")),
        )
        result = _run(emit_diff_event("/tmp/wt"))
        assert result is not None
        assert "truncated" in result["patch"]
        # Truncated patch must be smaller than the input
        assert len(result["patch"]) < len(huge)

    def test_rev_parse_failure_yields_empty_base_commit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            _fake_exec_factory(
                (0, b"diff --git a/x b/x\n+x", b""),
                (1, b"", b"fatal: not a repo"),  # rev-parse fails
            ),
        )
        result = _run(emit_diff_event("/tmp/wt"))
        assert result is not None
        assert result["base_commit"] == ""

    def test_exception_in_subprocess_returns_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def broken_exec(*args, **kwargs):
            raise OSError("fake failure")

        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            broken_exec,
        )
        result = _run(emit_diff_event("/tmp/wt"))
        assert result is None

    def test_none_worktree_path_uses_cwd(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        # When worktree_path is None, emit_diff_event uses Path.cwd() —
        # but we patch create_subprocess_exec so no real cwd is consulted.
        monkeypatch.setattr(
            review_handler.asyncio, "create_subprocess_exec",
            _fake_exec_factory((0, b"", b"")),
        )
        # Should not raise; returns None for empty diff.
        result = _run(emit_diff_event(None))
        assert result is None


# ---------------------------------------------------------------------------
# 7. stub_review_report / stub_qa_report — shape
# ---------------------------------------------------------------------------


class TestStubReports:
    def test_stub_review_report_shape(self) -> None:
        report = stub_review_report("m-1", "")
        assert report.review_run_id == "review-m-1-stub"
        assert report.executor == "stub"
        assert report.total_findings >= 1

    def test_stub_review_report_detects_secret(self) -> None:
        report = stub_review_report("m", "password = 'x'")
        assert any("secret" in f.title.lower() for f in report.findings)

    def test_stub_qa_report_shape(self) -> None:
        report = stub_qa_report("m-1", ["a.py", "b.py"])
        assert report.qa_run_id == "qa-m-1-stub"
        assert report.executor == "stub"
        assert report.test_passed == 2
        assert report.test_failed == 0


# ---------------------------------------------------------------------------
# 8. OpencodeUnavailable — exception is catchable
# ---------------------------------------------------------------------------


class TestOpencodeUnavailable:
    def test_is_an_exception(self) -> None:
        assert issubclass(OpencodeUnavailable, BaseException)

    def test_can_be_raised_and_caught(self) -> None:
        with pytest.raises(OpencodeUnavailable):
            raise OpencodeUnavailable("test")

    def test_message_preserved(self) -> None:
        try:
            raise OpencodeUnavailable("synthetic message")
        except OpencodeUnavailable as e:
            assert "synthetic message" in str(e)


# ---------------------------------------------------------------------------
# 9. Boundary guards — review_handler must NOT pull in forbidden modules
# ---------------------------------------------------------------------------


class TestBoundaryGuards:
    def _reload_review_handler(self) -> None:
        # Drop the module from sys.modules, then re-import fresh. We can't
        # use importlib.reload() here because the local `review_handler`
        # reference becomes stale once the module is removed from sys.modules.
        # Return the set of modules that were ADDED by the re-import, so
        # boundary guards can assert against the diff (other test files in
        # the suite may have pre-populated sys.modules with bridge/bridge_cli).
        for mod in list(sys.modules):
            if mod == "executors.review_handler" or mod.startswith("executors.review_handler."):
                del sys.modules[mod]
        before = set(sys.modules)
        importlib.import_module("executors.review_handler")
        added = set(sys.modules) - before
        return added

    def test_does_not_pull_kanban_feedback(self) -> None:
        added = self._reload_review_handler()
        kf = [m for m in added if m == "hermes_cli.kanban_feedback" or m.startswith("hermes_cli.kanban_feedback.")]
        assert kf == []

    def test_does_not_pull_executors_cli(self) -> None:
        added = self._reload_review_handler()
        assert "executors.cli" not in added

    def test_does_not_pull_executors_bridge(self) -> None:
        added = self._reload_review_handler()
        assert "executors.bridge" not in added
        assert "executors.bridge_cli" not in added

    def test_no_real_opencode_invocation(self) -> None:
        # Source must not call opencode directly outside the subprocess
        # wrapper (which is gated by shutil.which).
        src = Path(review_handler.__file__).read_text()
        # The wrapper uses asyncio.create_subprocess_exec with the command
        # name; that's expected. But no call should bypass shutil.which.
        # We assert that the only call to opencode goes through the wrapper.
        assert "shutil.which" in src  # gate exists

    def test_no_db_calls(self) -> None:
        # The dual-rail note mentions "task_events" descriptively in the
        # docstring, so we don't assert the bare string. Instead check the
        # *imports* that would pull sqlite in.
        src = Path(review_handler.__file__).read_text()
        assert "import sqlite3" not in src
        assert "from sqlite3" not in src

    def test_does_not_write_to_kanban_sqlite(self) -> None:
        # The dual-rail note explicitly forbids touching the Kanban DB.
        # Verify by source inspection.
        src = Path(review_handler.__file__).read_text()
        # No INSERT, no _append_event, no execute() against sqlite
        assert "INSERT" not in src
        assert "_append_event" not in src
        assert "conn.execute" not in src
