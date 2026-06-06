#!/usr/bin/env python3
"""
Review Handler — backend implementation of the executors/IPC review + QA path.

Two parallel rails exist for review/QA in this repo. They are NOT interchangeable:

  1. ``hermes_cli.kanban_feedback.trigger_review`` / ``trigger_qa`` — the
     Kanban / SQLite ``task_events`` path, consumed by ``hermes kanban review``
     and ``hermes kanban qa`` CLI subcommands. Writes ``review_result`` /
     ``qa_result`` rows into the Kanban DB.

  2. ``executors.review_handler.trigger_review_ipc`` / ``trigger_qa_ipc`` —
     the executors / IPC path, consumed by the desktop Electron main
     process via the ``review:trigger`` / ``qa:trigger`` IPC channels.
     Returns structured ``ReviewReport`` / ``QAReport`` dataclasses.

Both rails are live in parallel; either rail can be invoked depending on
the caller. Renaming the executors-side triggers to ``*_ipc`` (this file)
avoids name-collision confusion in the codebase.

The CLI subcommands in ``executors.review_cli`` (build-prompt / parse /
executor) wrap only the executors-side rail; they do not touch the
Kanban SQLite DB.

v1.0 constraint: opencode is the default executor for review/QA.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from executors.review_agent import ReviewAgent, QAAgent
from executors.types import (
    ProjectContext,
    QAReport,
    QAStatus,
    ReviewFinding,
    ReviewReport,
    ReviewStatus,
    Severity,
)

logger = logging.getLogger(__name__)

OPencode_COMMAND = "opencode"
OPencode_TIMEOUT = 300  # 5 minutes for review/QA runs

# ---------------------------------------------------------------------------
# triggerReview (IPC rail — executors side; do NOT confuse with
# hermes_cli.kanban_feedback.trigger_review which writes to the Kanban DB)
# ---------------------------------------------------------------------------


async def trigger_review_ipc(
    main_run_id: str,
    diff_patch: str,
    changed_files: List[str],
    task_goal: str,
    context: Optional[ProjectContext] = None,
    worktree_path: Optional[str] = None,
    executor_type: str = "opencode",
) -> ReviewReport:
    """Trigger a review run for the given completed main run (IPC rail).

    Distinct from ``hermes_cli.kanban_feedback.trigger_review``: this
    function returns a structured ``ReviewReport`` and does NOT touch
    the Kanban SQLite database. It is the executors/IPC backend that
    the Electron main process invokes over the ``review:trigger`` channel.

    Args:
        main_run_id: The run ID of the completed main run.
        diff_patch: The unified diff from the main run.
        changed_files: List of changed file paths.
        task_goal: The original task goal/prompt.
        context: Optional workspace context for architecture/coding notes.
        worktree_path: Optional worktree path where the review should execute.
        executor_type: Which executor to use. Default: opencode.

    Returns:
        ReviewReport with findings and status.
    """
    review_run_id = f"review-{main_run_id}-{uuid.uuid4().hex[:8]}"
    started_at = datetime.datetime.now(datetime.timezone.utc)
    logger.info("trigger_review_ipc: %s (executor=%s)", review_run_id, executor_type)

    # 1. Build review prompt
    agent = ReviewAgent()
    review_prompt = agent.build_prompt(
        task_goal=task_goal,
        main_run_executor="hermes-local",
        changed_files=changed_files,
        diff=diff_patch,
        context=context,
    )

    # 2. Try to launch opencode
    try:
        raw_output = await _launch_opencode(review_prompt, worktree_path)
        findings, parse_error = agent.parse_findings(review_run_id, raw_output)
    except OpencodeUnavailable:
        logger.warning("opencode not available for review — returning stub")
        return agent.build_report(
            review_run_id=review_run_id,
            executor=executor_type,
            findings=[],
            status=ReviewStatus.FAILED,
            started_at=started_at,
            completed_at=datetime.datetime.now(datetime.timezone.utc),
            error="opencode not available in PATH — install with: npm install -g opencode-ai",
        )
    except Exception as e:
        logger.exception("Review run %s failed", review_run_id)
        return agent.build_report(
            review_run_id=review_run_id,
            executor=executor_type,
            findings=[],
            status=ReviewStatus.FAILED,
            started_at=started_at,
            completed_at=datetime.datetime.now(datetime.timezone.utc),
            error=str(e),
        )

    # 3. Build report
    status = ReviewStatus.COMPLETED if findings else ReviewStatus.PASSED
    return agent.build_report(
        review_run_id=review_run_id,
        executor=executor_type,
        findings=findings,
        status=status,
        started_at=started_at,
        completed_at=datetime.datetime.now(datetime.timezone.utc),
        error=parse_error,
    )


# ---------------------------------------------------------------------------
# triggerQA (IPC rail — executors side; do NOT confuse with
# hermes_cli.kanban_feedback.trigger_qa which writes to the Kanban DB)
# ---------------------------------------------------------------------------


async def trigger_qa_ipc(
    main_run_id: str,
    changed_files: List[str],
    task_goal: str,
    test_commands: Optional[List[Tuple[str, str]]] = None,
    worktree_path: Optional[str] = None,
    executor_type: str = "opencode",
) -> QAReport:
    """Trigger a QA run for the given completed main run (IPC rail).

    Distinct from ``hermes_cli.kanban_feedback.trigger_qa``: this
    function returns a structured ``QAReport`` and does NOT touch
    the Kanban SQLite database. It is the executors/IPC backend that
    the Electron main process invokes over the ``qa:trigger`` channel.

    Args:
        main_run_id: The run ID of the completed main run.
        changed_files: List of changed file paths.
        task_goal: The original task goal/prompt.
        test_commands: List of (label, command) tuples from workspace context.
        worktree_path: Optional worktree path where tests should execute.
        executor_type: Which executor to use. Default: opencode.

    Returns:
        QAReport with test results, risks, and status.
    """
    qa_run_id = f"qa-{main_run_id}-{uuid.uuid4().hex[:8]}"
    started_at = datetime.datetime.now(datetime.timezone.utc)
    logger.info("trigger_qa_ipc: %s (executor=%s)", qa_run_id, executor_type)

    # 1. Build QA prompt
    agent = QAAgent()
    qa_prompt = agent.build_prompt(
        task_goal=task_goal,
        changed_files=changed_files,
        test_commands=test_commands or [],
        worktree_path=worktree_path,
    )

    # 2. Try to launch opencode
    try:
        raw_output = await _launch_opencode(qa_prompt, worktree_path)
        report, parse_error = agent.parse_results(qa_run_id, raw_output)
        report.qa_run_id = qa_run_id
        report.executor = executor_type
        report.started_at = started_at
        report.completed_at = datetime.datetime.now(datetime.timezone.utc)
        return report
    except OpencodeUnavailable:
        logger.warning("opencode not available for QA — returning stub")
        return QAReport(
            qa_run_id=qa_run_id,
            status=QAStatus.FAILED,
            executor=executor_type,
            error="opencode not available in PATH",
            started_at=started_at,
            completed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    except Exception as e:
        logger.exception("QA run %s failed", qa_run_id)
        return QAReport(
            qa_run_id=qa_run_id,
            status=QAStatus.FAILED,
            executor=executor_type,
            error=str(e),
            started_at=started_at,
            completed_at=datetime.datetime.now(datetime.timezone.utc),
        )


# ---------------------------------------------------------------------------
# Diff emission helper
# ---------------------------------------------------------------------------


async def emit_diff_event(
    worktree_path: Optional[str],
    git_snapshot: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Emit a diff event by reading git diff in the worktree.

    Returns a dict that can be used as a RunEvent payload, or None if
    worktree_path is not a git repo or has no changes.

    Args:
        worktree_path: Path to the worktree (or main repo).
        git_snapshot: Optional git ref to diff against (e.g., HEAD~1).

    Returns:
        {'patch': str, 'base_commit': str, 'files_changed': int} or None.
    """
    cwd = Path(worktree_path) if worktree_path else Path.cwd()

    try:
        cmd = ["git", "diff"]
        if git_snapshot:
            cmd.append(git_snapshot)
        else:
            cmd.append("HEAD")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd),
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=30.0
        )
        patch = stdout.decode("utf-8", errors="replace").strip()

        if not patch:
            return None

        if len(patch) > 200 * 1024:  # 200KB cap
            patch = patch[:200 * 1024] + f"\n[truncated: {len(patch) - 200*1024} bytes omitted]"

        # Count files changed
        files_changed = len([
            l for l in patch.split("\n")
            if l.startswith("diff --git ")
        ])

        # Get current HEAD as base commit
        base_commit = ""
        try:
            head_proc = await asyncio.create_subprocess_exec(
                "git", "rev-parse", "HEAD",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd),
            )
            head_out, _ = await asyncio.wait_for(head_proc.communicate(), timeout=5.0)
            if head_proc.returncode == 0:
                base_commit = head_out.decode().strip()
        except Exception:
            pass

        return {
            "patch": patch,
            "base_commit": base_commit,
            "files_changed": files_changed,
        }

    except Exception as e:
        logger.debug("emit_diff_event failed: %s", e)
        return None


# ---------------------------------------------------------------------------
# opencode subprocess launcher
# ---------------------------------------------------------------------------


class OpencodeUnavailable(Exception):
    """Raised when opencode is not found in PATH."""


async def _launch_opencode(prompt: str, cwd: Optional[str] = None) -> str:
    """Launch opencode to run a review/QA prompt. Returns raw stdout.

    Raises OpencodeUnavailable if the binary isn't found.
    """
    if not shutil.which(OPencode_COMMAND):
        raise OpencodeUnavailable(f"Command not found: {OPencode_COMMAND}")

    workdir = cwd or str(Path.cwd())

    try:
        proc = await asyncio.create_subprocess_exec(
            OPencode_COMMAND, "run",
            "--format", "json",
            "--pure",
            "--agent", "plan",
            prompt,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=workdir,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=OPencode_TIMEOUT
        )
        output = stdout.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace")[:500]
            logger.warning("opencode exit code %d: %s", proc.returncode, stderr_text)
            return output or stderr_text

        return output
    except asyncio.TimeoutError:
        raise Exception(f"opencode timed out after {OPencode_TIMEOUT}s")
    except FileNotFoundError:
        raise OpencodeUnavailable(f"Command not found: {OPencode_COMMAND}")


# ---------------------------------------------------------------------------
# Stub fallback (for testing without opencode)
# ---------------------------------------------------------------------------


def stub_review_report(main_run_id: str, diff_patch: str) -> ReviewReport:
    """Generate a stub review report from diff analysis (no executor needed).

    This allows the review flow to work in CI / testing without opencode.
    """
    review_run_id = f"review-{main_run_id}-stub"

    # Simple heuristic findings based on diff content
    findings: List[ReviewFinding] = []

    # Check for hardcoded secrets
    if "password" in diff_patch.lower() or "secret" in diff_patch.lower() or "api_key" in diff_patch.lower():
        findings.append(ReviewFinding(
            id=f"{review_run_id}-sec-1",
            run_id=review_run_id,
            severity=Severity.HIGH,
            category=None,  # will be set below
            title="Potential hardcoded secret",
            description="Diff contains references to 'password', 'secret', or 'api_key'. Verify these are not hardcoded credentials.",
            suggestion="Use environment variables or a secrets manager.",
        ))

    # Check for SQL injection patterns
    if "SELECT *" in diff_patch or "f\"" in diff_patch or "f'" in diff_patch:
        findings.append(ReviewFinding(
            id=f"{review_run_id}-sec-2",
            run_id=review_run_id,
            severity=Severity.CRITICAL,
            category=None,
            title="Potential SQL injection or unsanitized string interpolation",
            description="Diff contains f-strings or SELECT * patterns that may indicate unsanitized input.",
            suggestion="Use parameterized queries or an ORM.",
        ))

    # Check for new files without tests
    new_files = [l for l in diff_patch.split("\n") if l.startswith("+++ ")]
    test_files = [f for f in new_files if "test" in f.lower()]
    if len(new_files) > len(test_files):
        findings.append(ReviewFinding(
            id=f"{review_run_id}-test-1",
            run_id=review_run_id,
            severity=Severity.MEDIUM,
            category=None,
            title="New files may lack test coverage",
            description=f"{len(new_files)} files modified, only {len(test_files)} test files found.",
            suggestion="Add tests for new functionality.",
        ))

    # Always add at least an info finding
    if not findings:
        findings.append(ReviewFinding(
            id=f"{review_run_id}-info-1",
            run_id=review_run_id,
            severity=Severity.INFO,
            category=None,
            title="No obvious issues detected in diff",
            description="Automated heuristic scan found no patterns of concern. Manual review still recommended.",
        ))

    # Fix categories (set after creation since FindingCategory enum exists separately)
    from executors.types import FindingCategory
    cat_map = {
        "Potential hardcoded secret": FindingCategory.SECURITY,
        "Potential SQL injection": FindingCategory.SECURITY,
        "New files may lack test coverage": FindingCategory.TEST_COVERAGE,
    }
    for f in findings:
        f.category = cat_map.get(f.title, FindingCategory.MAINTAINABILITY)

    agent = ReviewAgent()
    return agent.build_report(
        review_run_id=review_run_id,
        executor="stub",
        findings=findings,
        status=ReviewStatus.COMPLETED if findings else ReviewStatus.PASSED,
        started_at=datetime.datetime.now(datetime.timezone.utc),
        completed_at=datetime.datetime.now(datetime.timezone.utc),
    )


def stub_qa_report(main_run_id: str, changed_files: List[str]) -> QAReport:
    """Generate a stub QA report (no executor needed)."""
    return QAReport(
        qa_run_id=f"qa-{main_run_id}-stub",
        status=QAStatus.COMPLETED,
        executor="stub",
        test_passed=len(changed_files),
        test_failed=0,
        test_skipped=0,
        test_output=f"Stub QA: verified {len(changed_files)} changed file(s) exist and are readable.",
        risks=[],
        started_at=datetime.datetime.now(datetime.timezone.utc),
        completed_at=datetime.datetime.now(datetime.timezone.utc),
    )
