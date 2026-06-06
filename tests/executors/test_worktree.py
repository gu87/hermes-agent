#!/usr/bin/env python3
"""
Tests for executors/worktree.py and executors/worktree_cli.py.

These tests use REAL git operations against repos created in pytest's
tmp_path. They never touch /Users/gu/.hermes/hermes-agent.

Coverage:
  1. _check_clean_working_tree bug fix (the previous version was
     dead-code due to a mis-indented function body — dirty main repos
     were silently accepted).
  2. .hermes/ infrastructure files are filtered out of the dirty check.
  3. worktree create / status / list basic paths.
  4. discard confirmation gate (already existed — tests cover it).
  5. merge confirmation gate (NEW safety fix — destructive operations
     now require explicit confirmation or --force).
  6. Safety: nothing in the worktree subsystem ever reaches the real
     /Users/gu/.hermes/hermes-agent repo.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from executors.worktree import WorktreeManager
from executors.worktree_cli import cmd_discard, cmd_merge
from executors.types import WorktreeStatus


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _git(*args: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    """Sync git helper for fixture / test setup."""
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed (rc={result.returncode}): {result.stderr}"
        )
    return result


def _run(coro):
    """Drive an async coroutine on a fresh event loop."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_git_repo(tmp_path: Path) -> Path:
    """A clean git repo in tmp_path with one initial commit on `main`."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git("init", "--initial-branch=main", cwd=repo)
    _git("config", "user.email", "test@example.com", cwd=repo)
    _git("config", "user.name", "Test User", cwd=repo)
    (repo / "README.md").write_text("hello\n")
    _git("add", "README.md", cwd=repo)
    _git("commit", "-m", "initial commit", cwd=repo)
    return repo


@pytest.fixture
def manager(tmp_git_repo: Path) -> WorktreeManager:
    return WorktreeManager(tmp_git_repo)


# ---------------------------------------------------------------------------
# 1. _check_clean_working_tree — bug fix
# ---------------------------------------------------------------------------

class TestDirtyCheckBugFix:
    """The previous implementation had the dirty-check body indented as
    if it belonged to the `if not r.ok:` block. The result: the entire
    dirty-check was dead code; a dirty main repo would silently pass.
    These tests would FAIL against the buggy code (the alloc would be
    READY when it should be FAILED) and PASS against the fix.
    """

    def test_untracked_file_rejects_create(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        (tmp_git_repo / "untracked.txt").write_text("dirty\n")
        alloc = _run(manager.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.FAILED
        assert "uncommitted" in alloc.error.lower()
        # No worktree was actually created.
        assert not (tmp_git_repo / ".hermes" / "worktrees" / "bc12345").exists()

    def test_modified_tracked_file_rejects_create(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        (tmp_git_repo / "README.md").write_text("modified content\n")
        alloc = _run(manager.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.FAILED
        assert "uncommitted" in alloc.error.lower()

    def test_staged_file_rejects_create(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        (tmp_git_repo / "staged.txt").write_text("staged\n")
        _git("add", "staged.txt", cwd=tmp_git_repo)
        alloc = _run(manager.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.FAILED
        assert "uncommitted" in alloc.error.lower()

    def test_hermes_infra_untracked_is_ignored(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        """Files inside .hermes/ (context.json, inbox.json, etc.) are
        managed by the agent itself, so a dirty .hermes/ must NOT
        block worktree creation.
        """
        hermes = tmp_git_repo / ".hermes"
        hermes.mkdir()
        (hermes / "context.json").write_text("{}")
        (hermes / "inbox.json").write_text("[]")
        alloc = _run(manager.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.READY

    def test_mixed_hermes_and_user_dirty_is_rejected(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        """If BOTH .hermes/ infra files AND user files are dirty, only
        the user files should be reported — and create must still fail.
        """
        hermes = tmp_git_repo / ".hermes"
        hermes.mkdir()
        (hermes / "context.json").write_text("{}")
        (tmp_git_repo / "user_change.txt").write_text("user\n")
        alloc = _run(manager.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.FAILED
        assert "uncommitted" in alloc.error.lower()
        # The user file is in the error; the .hermes/ file is filtered out.
        assert "user_change.txt" in alloc.error
        assert "context.json" not in alloc.error

    def test_clean_repo_passes_through(self, manager: WorktreeManager) -> None:
        alloc = _run(manager.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.READY

    def test_dirty_count_in_error_uses_filtered_count(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        """The error message should report the filtered count (not
        the truncated-to-5 count and not the unfiltered total).
        """
        # 7 dirty user files, 1 .hermes/ file (filtered out).
        hermes = tmp_git_repo / ".hermes"
        hermes.mkdir()
        (hermes / "context.json").write_text("{}")
        for i in range(7):
            (tmp_git_repo / f"file_{i}.txt").write_text(f"x{i}\n")
        alloc = _run(manager.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.FAILED
        # Should mention "7 files" (filtered count), not "5 files" (truncated).
        assert "7 files" in alloc.error


# ---------------------------------------------------------------------------
# 2. Create worktree (clean path)
# ---------------------------------------------------------------------------

class TestCreateWorktree:
    def test_create_on_clean_repo_succeeds(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        alloc = _run(manager.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.READY
        assert alloc.branch_name == "hermes/bc12345/1"
        assert alloc.worktree_path.endswith("/.hermes/worktrees/bc12345")
        assert alloc.base_commit is not None
        # Worktree directory exists on disk.
        assert (tmp_git_repo / ".hermes" / "worktrees" / "bc12345").is_dir()
        # Branch exists in git.
        result = _git("branch", "--list", "hermes/bc12345/1", cwd=tmp_git_repo)
        assert "hermes/bc12345/1" in result.stdout

    def test_create_in_non_git_dir_fails(self, tmp_path: Path) -> None:
        not_a_repo = tmp_path / "not_a_repo"
        not_a_repo.mkdir()
        mgr = WorktreeManager(not_a_repo)
        alloc = _run(mgr.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.FAILED
        assert "git" in (alloc.error or "").lower()

    def test_create_is_idempotent_when_already_ready(
        self, manager: WorktreeManager
    ) -> None:
        a1 = _run(manager.create("bc12345", run_seq=1))
        assert a1.status == WorktreeStatus.READY
        a2 = _run(manager.create("bc12345", run_seq=1))
        # Same allocation returned, no second worktree.
        assert a2.status == WorktreeStatus.READY
        assert a2.thread_id == a1.thread_id
        assert a2.branch_name == a1.branch_name

    def test_gitignore_is_extended_with_worktrees_dir(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        gitignore_text = (tmp_git_repo / ".gitignore").read_text()
        assert ".hermes/worktrees/" in gitignore_text


# ---------------------------------------------------------------------------
# 3. Status / list
# ---------------------------------------------------------------------------

class TestStatusAndList:
    def test_get_status_returns_allocation(self, manager: WorktreeManager) -> None:
        _run(manager.create("bc12345", run_seq=1))
        status = _run(manager.get_status("bc12345"))
        assert status is not None
        assert status.thread_id == "bc12345"
        assert status.status in (WorktreeStatus.READY, WorktreeStatus.DIRTY)

    def test_get_status_for_unknown_thread_returns_none(
        self, manager: WorktreeManager
    ) -> None:
        assert _run(manager.get_status("nonexistent")) is None

    def test_get_status_marks_dirty_after_modification(
        self, manager: WorktreeManager, tmp_git_repo: Path
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        wt = tmp_git_repo / ".hermes" / "worktrees" / "bc12345"
        (wt / "new.txt").write_text("new content\n")
        status = _run(manager.get_status("bc12345"))
        assert status.status == WorktreeStatus.DIRTY
        assert status.changed_files_count >= 1

    def test_list_active_excludes_discarded(
        self, manager: WorktreeManager
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        _run(manager.create("task-12345678", run_seq=1))
        assert len(manager.list_active()) == 2
        _run(manager.discard("task-12345678"))
        active = manager.list_active()
        assert len(active) == 1
        assert active[0].thread_id == "bc12345"

    def test_list_all_includes_discarded(
        self, manager: WorktreeManager
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        _run(manager.discard("bc12345"))
        all_allocs = manager.list_all()
        assert len(all_allocs) == 1
        assert all_allocs[0].status == WorktreeStatus.DISCARDED


# ---------------------------------------------------------------------------
# 4. Discard — confirmation gate (existing)
# ---------------------------------------------------------------------------

class TestDiscardConfirmationGate:
    def test_force_skips_confirmation(
        self, manager: WorktreeManager, tmp_git_repo: Path, monkeypatch
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        wt = tmp_git_repo / ".hermes" / "worktrees" / "bc12345"
        (wt / "new.txt").write_text("x\n")
        # If input() were called the test would explode.
        def fail_input(*args, **kwargs):
            raise AssertionError("input() was called despite force=True")
        monkeypatch.setattr("builtins.input", fail_input)
        _run(cmd_discard(manager, "bc12345", force=True))
        status = _run(manager.get_status("bc12345"))
        assert status.status == WorktreeStatus.DISCARDED

    def test_no_response_cancels_discard(
        self, manager: WorktreeManager, tmp_git_repo: Path, monkeypatch, capsys
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        wt = tmp_git_repo / ".hermes" / "worktrees" / "bc12345"
        (wt / "new.txt").write_text("x\n")
        monkeypatch.setattr("builtins.input", lambda *a, **kw: "n")
        _run(cmd_discard(manager, "bc12345", force=False))
        capsys.readouterr()  # consume
        status = _run(manager.get_status("bc12345"))
        # Discard was cancelled — worktree still active.
        assert status.status != WorktreeStatus.DISCARDED

    def test_yes_response_proceeds_with_discard(
        self, manager: WorktreeManager, tmp_git_repo: Path, monkeypatch
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        wt = tmp_git_repo / ".hermes" / "worktrees" / "bc12345"
        (wt / "new.txt").write_text("x\n")
        monkeypatch.setattr("builtins.input", lambda *a, **kw: "y")
        _run(cmd_discard(manager, "bc12345", force=False))
        status = _run(manager.get_status("bc12345"))
        assert status.status == WorktreeStatus.DISCARDED


# ---------------------------------------------------------------------------
# 5. Merge — confirmation gate (NEW safety fix)
# ---------------------------------------------------------------------------

class TestMergeConfirmationGate:
    """Previously, ``cmd_merge`` had no confirmation gate. It would
    directly call ``mgr.merge()`` which runs ``git add -A``,
    ``git commit``, and ``git merge --no-ff`` on the main repo. This is
    a destructive operation that must require explicit user consent.
    """

    def test_force_skips_confirmation(
        self, manager: WorktreeManager, tmp_git_repo: Path, monkeypatch
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        wt = tmp_git_repo / ".hermes" / "worktrees" / "bc12345"
        (wt / "new.txt").write_text("merged content\n")
        # If input() were called the test would explode.
        def fail_input(*args, **kwargs):
            raise AssertionError("input() was called despite force=True")
        monkeypatch.setattr("builtins.input", fail_input)
        _run(cmd_merge(manager, "bc12345", force=True))
        # The merge commit exists in main's history.
        log = _git("log", "--oneline", "--all", cwd=tmp_git_repo)
        assert "hermes: merge" in log.stdout.lower()

    def test_no_response_cancels_merge(
        self, manager: WorktreeManager, tmp_git_repo: Path, monkeypatch, capsys
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        wt = tmp_git_repo / ".hermes" / "worktrees" / "bc12345"
        (wt / "new.txt").write_text("unmerged content\n")
        monkeypatch.setattr("builtins.input", lambda *a, **kw: "n")
        _run(cmd_merge(manager, "bc12345", force=False))
        captured = capsys.readouterr()
        # The branch is still alive — no merge happened.
        result = _git("branch", "--list", "hermes/bc12345/1", cwd=tmp_git_repo)
        assert "hermes/bc12345/1" in result.stdout
        # The main repo has no merge commit.
        log = _git("log", "--oneline", cwd=tmp_git_repo)
        assert "hermes: merge" not in log.stdout.lower()
        # The gate was actually triggered (the "This will commit..."
        # preamble is printed before input() is called).
        assert "this will commit" in captured.out.lower()

    def test_yes_response_proceeds_with_merge(
        self, manager: WorktreeManager, tmp_git_repo: Path, monkeypatch
    ) -> None:
        _run(manager.create("bc12345", run_seq=1))
        wt = tmp_git_repo / ".hermes" / "worktrees" / "bc12345"
        (wt / "new.txt").write_text("merged content\n")
        monkeypatch.setattr("builtins.input", lambda *a, **kw: "y")
        _run(cmd_merge(manager, "bc12345", force=False))
        log = _git("log", "--oneline", "--all", cwd=tmp_git_repo)
        assert "hermes: merge" in log.stdout.lower()


# ---------------------------------------------------------------------------
# 6. Safety: never touches the real repo
# ---------------------------------------------------------------------------

class TestNoRealRepoSideEffects:
    """The worktree subsystem must NEVER point at
    /Users/gu/.hermes/hermes-agent unless explicitly told to. These
    tests are a safety net — if a refactor ever starts defaulting to a
    hard-coded path, these fail.
    """

    REAL_REPO = Path("/Users/gu/.hermes/hermes-agent")

    def test_manager_pointed_at_tmp_repo_does_not_touch_real_repo(
        self, tmp_path: Path
    ) -> None:
        repo = tmp_path / "isolated_repo"
        repo.mkdir()
        _git("init", "--initial-branch=main", cwd=repo)
        _git("config", "user.email", "t@t.com", cwd=repo)
        _git("config", "user.name", "T", cwd=repo)
        (repo / "f.txt").write_text("x")
        _git("add", "f.txt", cwd=repo)
        _git("commit", "-m", "init", cwd=repo)
        mgr = WorktreeManager(repo)
        alloc = _run(mgr.create("task-zzz99999", run_seq=1))
        assert alloc.status == WorktreeStatus.READY
        # The real repo's worktrees dir is untouched.
        real_wt = self.REAL_REPO / ".hermes" / "worktrees" / "zzz99999"
        assert not real_wt.exists(), (
            f"Unexpected write to {real_wt} — WorktreeManager reached the real repo"
        )

    def test_manager_rejects_path_outside_git_repo(
        self, tmp_path: Path
    ) -> None:
        not_a_repo = tmp_path / "not_a_repo"
        not_a_repo.mkdir()
        mgr = WorktreeManager(not_a_repo)
        alloc = _run(mgr.create("bc12345", run_seq=1))
        assert alloc.status == WorktreeStatus.FAILED
        # No real-repo side effects.
        real_wt = self.REAL_REPO / ".hermes" / "worktrees" / "bc12345"
        assert not real_wt.exists()
