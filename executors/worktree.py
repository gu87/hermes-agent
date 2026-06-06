#!/usr/bin/env python3
"""
WorktreeManager — git worktree lifecycle management for v0.4.

Creates isolated worktrees per task thread, tracks status, supports
merge-back and discard operations, and enforces parallel-run safety.

Design:
  - All git operations are async subprocess calls
  - Worktree path: ``<project_root>/.hermes/worktrees/<thread_id_short>/``
  - Branch name:  ``hermes/<thread_id_short>/<run_seq>``
  - State tracked in-memory; persistence to Store layer is v0.5+
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Set

from executors.types import WorktreeStatus, WorktreeAllocation

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

async def _git(*args: str, cwd: Path, timeout: float = 30.0) -> _GitResult:
    """Run a git command and return stdout, stderr, returncode."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd),
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
        return _GitResult(
            returncode=proc.returncode or 0,
            stdout=stdout.decode("utf-8", errors="replace").strip(),
            stderr=stderr.decode("utf-8", errors="replace").strip(),
        )
    except asyncio.TimeoutError:
        return _GitResult(returncode=-1, stdout="", stderr="git command timed out")
    except FileNotFoundError:
        return _GitResult(returncode=-1, stdout="", stderr="git not found in PATH")
    except Exception as e:
        return _GitResult(returncode=-1, stdout="", stderr=str(e))


class _GitResult:
    __slots__ = ("returncode", "stdout", "stderr")
    def __init__(self, returncode: int, stdout: str, stderr: str):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    @property
    def ok(self) -> bool:
        return self.returncode == 0


# ---------------------------------------------------------------------------
# WorktreeManager
# ---------------------------------------------------------------------------

class WorktreeManager:
    """Manages git worktree lifecycle for agent task threads.

    Usage::

        mgr = WorktreeManager(project_root=Path("/path/to/repo"))
        alloc = await mgr.create(thread_id="task-abc12345", run_seq=1)
        # ... agent runs in alloc.worktree_path ...
        await mgr.merge(thread_id)
        # or await mgr.discard(thread_id)
    """

    def __init__(self, project_root: Path):
        self._project_root = Path(project_root).resolve()
        self._worktrees_dir = self._project_root / ".hermes" / "worktrees"
        self._allocations: Dict[str, WorktreeAllocation] = {}

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def project_root(self) -> Path:
        return self._project_root

    @property
    def worktrees_dir(self) -> Path:
        return self._worktrees_dir

    # ------------------------------------------------------------------
    # Thread ID shortener
    # ------------------------------------------------------------------

    @staticmethod
    def _short_id(thread_id: str) -> str:
        """Return last 8 chars of thread id for branch/worktree naming."""
        clean = re.sub(r"[^a-zA-Z0-9_-]", "", thread_id)
        return clean[-8:] if len(clean) >= 8 else clean

    # ------------------------------------------------------------------
    # Branch / path naming
    # ------------------------------------------------------------------

    @staticmethod
    def _branch_name(short_id: str, run_seq: int) -> str:
        return f"hermes/{short_id}/{run_seq}"

    def _worktree_path(self, short_id: str) -> Path:
        return self._worktrees_dir / short_id

    # ------------------------------------------------------------------
    # Pre-flight checks
    # ------------------------------------------------------------------

    async def _check_is_git_repo(self) -> Optional[str]:
        """Return None if project_root is a git repo, else error message."""
        r = await _git("rev-parse", "--git-dir", cwd=self._project_root)
        if not r.ok:
            return f"Not a git repository: {self._project_root}"
        return None

    async def _check_clean_working_tree(self) -> Optional[str]:
        """Return None if main repo is clean, else list of dirty files.

        ``.hermes/`` infrastructure files (context.json, inbox.json,
        worktrees/, etc.) are managed by the worktree subsystem itself
        and are filtered out — a dirty ``.hermes/`` does not block
        worktree creation. Anything else dirty is a hard error.
        """
        r = await _git("status", "--porcelain", cwd=self._project_root)
        if not r.ok:
            return f"git status failed: {r.stderr}"

        # Porcelain returns "" for a clean repo; split() on that yields
        # [""], which would falsely report one dirty file. Filter that
        # out first, then drop any line touching .hermes/.
        dirty_lines = [l for l in r.stdout.split("\n") if l.strip()]
        non_infra = [l for l in dirty_lines if ".hermes/" not in l]
        if not non_infra:
            return None  # only .hermes/ changes, OK

        dirty_files = non_infra[:5]
        dirty_list = "\n  ".join(dirty_files)
        plural = "s" if len(non_infra) > 1 else ""
        return (
            f"Main repository has uncommitted changes ({len(non_infra)} file{plural}):\n"
            f"  {dirty_list}\n"
            f"Please commit or stash before creating a worktree."
        )

    async def _get_head_commit(self) -> Optional[str]:
        """Return HEAD sha, or None on failure."""
        r = await _git("rev-parse", "HEAD", cwd=self._project_root)
        return r.stdout if r.ok else None

    # ------------------------------------------------------------------
    # Create worktree
    # ------------------------------------------------------------------

    async def create(
        self,
        thread_id: str,
        run_seq: int = 1,
    ) -> WorktreeAllocation:
        """Create a git worktree for a task thread.

        Args:
            thread_id: The task thread identifier.
            run_seq: Run sequence number for branch naming.

        Returns:
            WorktreeAllocation with status READY on success,
            FAILED on error.

        Rules:
            - Main repo must be clean (no uncommitted changes).
            - Worktree is created at ``.hermes/worktrees/<short_id>/``.
            - Branch is named ``hermes/<short_id>/<run_seq>``.
            - Idempotent: if allocation already exists in READY/DIRTY/FAILED,
              returns existing allocation.
        """
        # Idempotency check
        if thread_id in self._allocations:
            existing = self._allocations[thread_id]
            if existing.status in (
                WorktreeStatus.READY,
                WorktreeStatus.DIRTY,
                WorktreeStatus.CREATING,
            ):
                logger.info("Worktree already exists for thread %s: %s", thread_id, existing.status.value)
                return existing
            if existing.status == WorktreeStatus.FAILED:
                # Allow retry after failed creation
                logger.info("Retrying worktree creation after previous failure for thread %s", thread_id)

        short_id = self._short_id(thread_id)
        branch = self._branch_name(short_id, run_seq)
        wt_path = self._worktree_path(short_id)

        # Initialize allocation as CREATING
        alloc = WorktreeAllocation(
            thread_id=thread_id,
            worktree_path=str(wt_path),
            branch_name=branch,
            status=WorktreeStatus.CREATING,
            created_at=datetime.datetime.utcnow(),
        )
        self._allocations[thread_id] = alloc

        # Pre-flight: is it a git repo?
        err = await self._check_is_git_repo()
        if err:
            alloc.status = WorktreeStatus.FAILED
            alloc.error = err
            return alloc

        # Pre-flight: is the working tree clean?
        err = await self._check_clean_working_tree()
        if err:
            alloc.status = WorktreeStatus.FAILED
            alloc.error = err
            return alloc

        # Ensure worktrees directory exists and is gitignored
        self._worktrees_dir.mkdir(parents=True, exist_ok=True)
        await self._ensure_gitignored()

        base_commit = await self._get_head_commit()
        if not base_commit:
            alloc.status = WorktreeStatus.FAILED
            alloc.error = "Cannot determine HEAD commit"
            return alloc

        alloc.base_commit = base_commit

        # Create the worktree
        r = await _git(
            "worktree", "add",
            str(wt_path),
            "-b", branch,
            cwd=self._project_root,
            timeout=60.0,
        )

        if not r.ok:
            alloc.status = WorktreeStatus.FAILED
            alloc.error = f"git worktree add failed: {r.stderr or r.stdout}"
            return alloc

        alloc.status = WorktreeStatus.READY
        logger.info(
            "Worktree created: thread=%s branch=%s path=%s base=%s",
            thread_id, branch, wt_path, base_commit[:8],
        )
        return alloc

    # ------------------------------------------------------------------
    # Status check
    # ------------------------------------------------------------------

    async def get_status(self, thread_id: str) -> Optional[WorktreeAllocation]:
        """Return current worktree status for a thread, refreshing dirty state."""
        alloc = self._allocations.get(thread_id)
        if alloc is None:
            return None

        # Refresh dirty state if worktree is in a checkable state
        if alloc.status in (WorktreeStatus.READY, WorktreeStatus.DIRTY):
            is_dirty = await self._is_worktree_dirty(alloc.worktree_path)
            changed = await self._count_changed_files(alloc.worktree_path)

            if is_dirty:
                alloc.status = WorktreeStatus.DIRTY
                alloc.changed_files_count = changed
            else:
                alloc.status = WorktreeStatus.READY
                alloc.changed_files_count = 0

        return alloc

    async def _is_worktree_dirty(self, worktree_path: str) -> bool:
        """Check if worktree has uncommitted changes."""
        r = await _git("status", "--porcelain", cwd=Path(worktree_path))
        return r.ok and bool(r.stdout.strip())

    async def _count_changed_files(self, worktree_path: str) -> int:
        """Count changed files in worktree."""
        r = await _git("diff", "--stat", "HEAD", cwd=Path(worktree_path))
        if not r.ok or not r.stdout:
            r = await _git("diff", "--stat", cwd=Path(worktree_path))
        if r.ok and r.stdout:
            # Last line of diff --stat shows "N files changed"
            last_line = r.stdout.strip().split("\n")[-1]
            match = re.search(r"(\d+)\s+files?\s+changed", last_line)
            if match:
                return int(match.group(1))
        # Fallback: count dirty lines from status
        r2 = await _git("status", "--porcelain", cwd=Path(worktree_path))
        if r2.ok:
            return len([l for l in r2.stdout.split("\n") if l.strip()])
        return 0

    # ------------------------------------------------------------------
    # Merge back
    # ------------------------------------------------------------------

    async def merge(self, thread_id: str) -> WorktreeAllocation:
        """Merge worktree changes into the main repository.

        Flow:
            1. Commit any uncommitted changes in worktree
            2. Fetch main repo
            3. Merge branch into main repo with --no-ff

        Returns updated allocation.
        """
        alloc = self._allocations.get(thread_id)
        if alloc is None:
            raise ValueError(f"No worktree for thread: {thread_id}")

        if alloc.status not in (WorktreeStatus.READY, WorktreeStatus.DIRTY):
            raise ValueError(
                f"Cannot merge worktree in status '{alloc.status.value}'. "
                f"Must be 'ready' or 'dirty'."
            )

        alloc.status = WorktreeStatus.MERGING
        wt_path = Path(alloc.worktree_path)

        # Step 1: Commit any uncommitted changes in worktree
        is_dirty = await self._is_worktree_dirty(str(wt_path))
        if is_dirty:
            r_add = await _git("add", "-A", cwd=wt_path)
            if not r_add.ok:
                alloc.status = WorktreeStatus.FAILED
                alloc.error = f"git add failed: {r_add.stderr}"
                return alloc

            commit_msg = f"hermes: task [{thread_id[:8]}] via {alloc.branch_name}"
            r_commit = await _git(
                "commit", "-m", commit_msg,
                cwd=wt_path,
            )
            if not r_commit.ok:
                # Check if "nothing to commit" — that's OK
                if "nothing to commit" not in r_commit.stderr.lower() and \
                   "nothing to commit" not in r_commit.stdout.lower():
                    alloc.status = WorktreeStatus.FAILED
                    alloc.error = f"git commit failed: {r_commit.stderr}"
                    return alloc

        # Step 2: Fetch main repo
        r_fetch = await _git("fetch", "origin", cwd=self._project_root, timeout=60.0)
        if not r_fetch.ok:
            logger.warning("git fetch failed (non-fatal): %s", r_fetch.stderr)

        # Step 3: Merge into main repo
        r_merge = await _git(
            "merge", "--no-ff", alloc.branch_name,
            "-m", f"hermes: merge worktree {alloc.branch_name}",
            cwd=self._project_root,
            timeout=60.0,
        )

        if not r_merge.ok:
            alloc.status = WorktreeStatus.FAILED
            alloc.error = (
                f"Merge conflict. Branch '{alloc.branch_name}' could not be "
                f"merged automatically.\n"
                f"git merge output: {r_merge.stderr[:500]}"
            )
            return alloc

        # Get merge commit SHA
        merge_sha_r = await _git("rev-parse", "HEAD", cwd=self._project_root)
        if merge_sha_r.ok:
            alloc.merge_commit_sha = merge_sha_r.stdout[:8]

        alloc.status = WorktreeStatus.MERGED
        alloc.released_at = datetime.datetime.utcnow()

        # Background: clean up worktree
        asyncio.create_task(self._cleanup_worktree(alloc))

        logger.info(
            "Worktree merged: thread=%s branch=%s merge=%s",
            thread_id, alloc.branch_name, alloc.merge_commit_sha,
        )
        return alloc

    # ------------------------------------------------------------------
    # Discard worktree
    # ------------------------------------------------------------------

    async def discard(self, thread_id: str) -> WorktreeAllocation:
        """Discard worktree changes irreversibly.

        This operation:
            1. Force-removes the worktree directory
            2. Deletes the associated branch
            3. Marks allocation as DISCARDED

        Returns updated allocation. This cannot be undone.
        """
        alloc = self._allocations.get(thread_id)
        if alloc is None:
            raise ValueError(f"No worktree for thread: {thread_id}")

        if alloc.status == WorktreeStatus.MERGING:
            raise ValueError("Cannot discard worktree while merging is in progress")

        if alloc.status == WorktreeStatus.DISCARDED:
            return alloc  # already discarded

        wt_path = Path(alloc.worktree_path)
        branch = alloc.branch_name

        errors: List[str] = []

        # Step 1: Remove worktree
        if wt_path.exists():
            r = await _git(
                "worktree", "remove", "--force", str(wt_path),
                cwd=self._project_root,
                timeout=30.0,
            )
            if not r.ok:
                errors.append(f"git worktree remove failed: {r.stderr}")

        # Step 2: Delete branch
        r_branch = await _git(
            "branch", "-D", branch,
            cwd=self._project_root,
            timeout=10.0,
        )
        if not r_branch.ok:
            # Branch might already be gone — not a hard error
            logger.debug("Branch deletion: %s", r_branch.stderr)

        alloc.status = WorktreeStatus.DISCARDED
        alloc.released_at = datetime.datetime.utcnow()

        if errors:
            alloc.error = "; ".join(errors)

        logger.info(
            "Worktree discarded: thread=%s branch=%s path=%s",
            thread_id, branch, wt_path,
        )
        return alloc

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def _cleanup_worktree(self, alloc: WorktreeAllocation) -> None:
        """Background task: remove worktree after successful merge."""
        try:
            wt_path = Path(alloc.worktree_path)
            if wt_path.exists():
                r = await _git(
                    "worktree", "remove", str(wt_path),
                    cwd=self._project_root,
                    timeout=30.0,
                )
                if r.ok:
                    logger.info("Worktree cleaned up: %s", wt_path)
                else:
                    logger.warning("Worktree cleanup failed: %s", r.stderr)
        except Exception as e:
            logger.warning("Worktree cleanup error: %s", e)

    # ------------------------------------------------------------------
    # Diff / changed files
    # ------------------------------------------------------------------

    async def get_diff_stat(self, thread_id: str) -> Optional[str]:
        """Return ``git diff --stat`` output for the worktree."""
        alloc = self._allocations.get(thread_id)
        if alloc is None:
            return None
        r = await _git("diff", "--stat", "HEAD", cwd=Path(alloc.worktree_path))
        return r.stdout if r.ok else None

    async def get_changed_files(self, thread_id: str) -> List[str]:
        """Return list of changed file paths in worktree."""
        alloc = self._allocations.get(thread_id)
        if alloc is None:
            return []
        r = await _git(
            "diff", "--name-only", "HEAD",
            cwd=Path(alloc.worktree_path),
        )
        if r.ok and r.stdout:
            return [f for f in r.stdout.split("\n") if f]
        return []

    # ------------------------------------------------------------------
    # Listing
    # ------------------------------------------------------------------

    def list_all(self) -> List[WorktreeAllocation]:
        """Return all tracked worktree allocations."""
        return list(self._allocations.values())

    def list_active(self) -> List[WorktreeAllocation]:
        """Return allocations in non-terminal states."""
        terminal = {
            WorktreeStatus.MERGED,
            WorktreeStatus.DISCARDED,
        }
        return [
            a for a in self._allocations.values()
            if a.status not in terminal
        ]

    def get_active_count(self) -> int:
        """Count worktrees in states that hold a lock on the path."""
        active = {
            WorktreeStatus.CREATING,
            WorktreeStatus.READY,
            WorktreeStatus.DIRTY,
            WorktreeStatus.MERGING,
        }
        return sum(
            1 for a in self._allocations.values()
            if a.status in active
        )

    # ------------------------------------------------------------------
    # Parallel safety
    # ------------------------------------------------------------------

    def is_worktree_in_use(self, thread_id: str) -> bool:
        """Check if a worktree is currently locked by a run."""
        alloc = self._allocations.get(thread_id)
        if alloc is None:
            return False
        return alloc.status in (
            WorktreeStatus.READY,
            WorktreeStatus.DIRTY,
            WorktreeStatus.MERGING,
        )

    # ------------------------------------------------------------------
    # gitignore
    # ------------------------------------------------------------------

    async def _ensure_gitignored(self) -> None:
        """Ensure ``.hermes/worktrees/`` is in .gitignore."""
        gitignore = self._project_root / ".gitignore"
        pattern = ".hermes/worktrees/"

        if gitignore.exists():
            content = gitignore.read_text()
            if pattern in content:
                return

        with open(gitignore, "a") as f:
            f.write(f"\n{pattern}  # Hermes agent worktrees\n")
        logger.debug("Added '%s' to .gitignore", pattern)


# ---------------------------------------------------------------------------
# Convenience factory
# ---------------------------------------------------------------------------

def create_worktree_manager(project_root: Path) -> WorktreeManager:
    """Create a WorktreeManager for the given project root."""
    return WorktreeManager(project_root)
