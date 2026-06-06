#!/usr/bin/env python3
"""
CLI subcommands for worktree management.

Usage (via executors.cli):
    python -m executors.cli worktree create <thread_id> [--run-seq N]
    python -m executors.cli worktree status <thread_id>
    python -m executors.cli worktree merge <thread_id>
    python -m executors.cli worktree discard <thread_id> [--force]
    python -m executors.cli worktree list [--all]
    python -m executors.cli worktree diff <thread_id>
    python -m executors.cli worktree files <thread_id>
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Optional

from executors.worktree import WorktreeManager
from executors.types import WorktreeStatus


STATUS_ICONS = {
    WorktreeStatus.NOT_CREATED: "◌",
    WorktreeStatus.CREATING: "◌",
    WorktreeStatus.READY: "✓",
    WorktreeStatus.DIRTY: "●",
    WorktreeStatus.MERGING: "◌",
    WorktreeStatus.MERGED: "✓",
    WorktreeStatus.DISCARDED: "✗",
    WorktreeStatus.FAILED: "✗",
}

STATUS_COLORS = {
    WorktreeStatus.READY: "",        # default
    WorktreeStatus.DIRTY: "orange",
    WorktreeStatus.MERGED: "green",
    WorktreeStatus.FAILED: "red",
    WorktreeStatus.DISCARDED: "grey",
}


def _icon(status: WorktreeStatus) -> str:
    return STATUS_ICONS.get(status, "?")


async def cmd_create(
    mgr: WorktreeManager,
    thread_id: str,
    run_seq: int = 1,
) -> None:
    """Create a worktree for a task thread."""
    print(f"Creating worktree for thread '{thread_id}' (run_seq={run_seq})...")

    alloc = await mgr.create(thread_id, run_seq=run_seq)

    if alloc.status == WorktreeStatus.READY:
        print(f"  {_icon(alloc.status)} Created successfully")
        print(f"  Branch:       {alloc.branch_name}")
        print(f"  Path:         {alloc.worktree_path}")
        print(f"  Base commit:  {alloc.base_commit[:12] if alloc.base_commit else 'N/A'}")
    elif alloc.status == WorktreeStatus.FAILED:
        print(f"  {_icon(alloc.status)} Creation failed")
        print(f"  Error: {alloc.error}")
        sys.exit(1)
    else:
        print(f"  Status: {alloc.status.value}")
        print(f"  Error: {alloc.error}")


async def cmd_status(
    mgr: WorktreeManager,
    thread_id: str,
) -> None:
    """Show detailed status of a worktree."""
    alloc = await mgr.get_status(thread_id)
    if alloc is None:
        print(f"No worktree found for thread: {thread_id}")
        sys.exit(1)

    icon = _icon(alloc.status)
    print(f"{icon} Worktree: {alloc.thread_id}")
    print(f"  Status:       {alloc.status.value}")
    print(f"  Branch:       {alloc.branch_name}")
    print(f"  Path:         {alloc.worktree_path}")
    print(f"  Base commit:  {alloc.base_commit[:12] if alloc.base_commit else 'N/A'}")
    print(f"  Changed files:{alloc.changed_files_count or 0}")
    print(f"  Created:      {alloc.created_at.isoformat() if alloc.created_at else 'N/A'}")
    if alloc.released_at:
        print(f"  Released:     {alloc.released_at.isoformat()}")
    if alloc.merge_commit_sha:
        print(f"  Merge commit: {alloc.merge_commit_sha}")
    if alloc.error:
        print(f"  Error:        {alloc.error}")


async def cmd_merge(
    mgr: WorktreeManager,
    thread_id: str,
    force: bool = False,
) -> None:
    """Merge worktree into main repo.

    Destructive: commits any uncommitted worktree changes (``git add -A``
    + ``git commit``) and merges the branch into the main repo with
    ``git merge --no-ff``. Requires explicit confirmation unless
    ``force=True`` is passed (e.g. via ``--force`` on the CLI).
    """
    print(f"Merging worktree for thread '{thread_id}'...")

    if not force:
        files = await mgr.get_changed_files(thread_id)
        if files:
            print("About to merge the following changes into main:")
            for f in files:
                print(f"    {f}")
        print("\nThis will commit worktree changes and merge into main.")
        try:
            response = input("Confirm merge? [y/N]: ").strip().lower()
            if response not in ("y", "yes"):
                print("Merge cancelled.")
                return
        except (KeyboardInterrupt, EOFError):
            print("\nMerge cancelled.")
            return

    alloc = await mgr.merge(thread_id)

    if alloc.status == WorktreeStatus.MERGED:
        print(f"  {_icon(alloc.status)} Merged successfully")
        print(f"  Merge commit: {alloc.merge_commit_sha}")
    elif alloc.status == WorktreeStatus.FAILED:
        print(f"  {_icon(alloc.status)} Merge failed")
        print(f"  Error: {alloc.error}")
        sys.exit(1)
    else:
        print(f"  Status: {alloc.status.value}")


async def cmd_discard(
    mgr: WorktreeManager,
    thread_id: str,
    force: bool = False,
) -> None:
    """Discard worktree changes."""
    # Show what would be lost
    diff = await mgr.get_diff_stat(thread_id)
    files = await mgr.get_changed_files(thread_id)

    if files:
        print("About to discard the following changes:")
        for f in files:
            print(f"    {f}")

    if diff:
        print(f"\n{diff[:500]}")

    if not force:
        print("\nThis operation cannot be undone.")
        try:
            response = input("Confirm discard? [y/N]: ").strip().lower()
            if response not in ("y", "yes"):
                print("Discard cancelled.")
                return
        except (KeyboardInterrupt, EOFError):
            print("\nDiscard cancelled.")
            return

    print(f"\nDiscarding worktree for thread '{thread_id}'...")
    alloc = await mgr.discard(thread_id)

    if alloc.status == WorktreeStatus.DISCARDED:
        print(f"  {_icon(alloc.status)} Discarded")
    elif alloc.error:
        print(f"  Warning: {alloc.error}")


async def cmd_list(
    mgr: WorktreeManager,
    show_all: bool = False,
) -> None:
    """List all tracked worktrees."""
    allocations = mgr.list_all() if show_all else mgr.list_active()

    if not allocations:
        print("No worktrees found.")
        return

    print(f"{'Thread':<12} {'Status':<14} {'Branch':<32} {'Changed':>8}")
    print("-" * 70)

    for a in allocations:
        icon = _icon(a.status)
        thread_short = a.thread_id[:10]
        branch = a.branch_name[:30]
        changed = str(a.changed_files_count or 0)
        print(
            f"{thread_short:<12} {icon} {a.status.value:<11} "
            f"{branch:<32} {changed:>8}"
        )


async def cmd_diff(
    mgr: WorktreeManager,
    thread_id: str,
) -> None:
    """Show git diff for worktree."""
    diff = await mgr.get_diff_stat(thread_id)
    if diff:
        print(diff)
    else:
        print("No changes detected.")


async def cmd_files(
    mgr: WorktreeManager,
    thread_id: str,
) -> None:
    """List changed files in worktree."""
    files = await mgr.get_changed_files(thread_id)
    if files:
        for f in files:
            print(f"  {f}")
    else:
        print("No changed files.")


# ---------------------------------------------------------------------------
# Entry point for the CLI module
# ---------------------------------------------------------------------------

async def handle_worktree_command(
    project_root: Path,
    args,  # argparse.Namespace
) -> None:
    """Dispatch worktree subcommands."""
    mgr = WorktreeManager(project_root)

    sub = args.worktree_subcommand
    if sub is None:
        print("Usage: python -m executors.cli worktree <command> [...]")
        print("Commands: create, status, merge, discard, list, diff, files")
        sys.exit(1)

    try:
        if sub == "create":
            await cmd_create(mgr, args.thread_id, getattr(args, "run_seq", 1))
        elif sub == "status":
            await cmd_status(mgr, args.thread_id)
        elif sub == "merge":
            await cmd_merge(mgr, args.thread_id, getattr(args, "force", False))
        elif sub == "discard":
            await cmd_discard(mgr, args.thread_id, getattr(args, "force", False))
        elif sub == "list":
            await cmd_list(mgr, getattr(args, "all", False))
        elif sub == "diff":
            await cmd_diff(mgr, args.thread_id)
        elif sub == "files":
            await cmd_files(mgr, args.thread_id)
        else:
            print(f"Unknown worktree command: {sub}")
            sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
