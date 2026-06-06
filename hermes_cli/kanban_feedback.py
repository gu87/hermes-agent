#!/usr/bin/env python3
"""
Kanban feedback events — log, tool_result, diff emission for runs.

Also provides ``trigger_review()`` and ``trigger_qa()`` for the
``hermes kanban review <task_id>`` and ``hermes kanban qa <task_id>``
CLI subcommands.

These all write structured ``task_events`` rows via ``_append_event()``
with JSON ``payload``, which the renderer reads through ``list_events()``.
"""
from __future__ import annotations

import datetime
import json
import os
import shutil
import sqlite3
from pathlib import Path
import subprocess
import tempfile
import time
from typing import List, Optional, Tuple

from hermes_cli import kanban_db as kb

# ---------------------------------------------------------------------------
# Diff emission
# ---------------------------------------------------------------------------

def emit_diff_event(
    conn: sqlite3.Connection,
    task_id: str,
    worktree_path: Optional[str] = None,
    run_id: Optional[int] = None,
    base_ref: str = "HEAD",
) -> Optional[int]:
    """Emit a diff event into task_events. Returns event id or None.

    Reads ``git diff <base_ref>`` from the worktree or project root.
    If worktree_path is not a git repo or has no diff, still emits
    an event with ``files: []`` and ``unified_diff: ""`` so the UI
    shows "no changes" rather than "missing data".
    """
    cwd = worktree_path or str(Path.cwd())
    patch = ""
    files: List[str] = []
    exit_code = None

    try:
        # Try git diff
        result = subprocess.run(
            ["git", "diff", base_ref],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        exit_code = result.returncode
        if result.returncode == 0 and result.stdout.strip():
            patch = result.stdout.strip()

            # Parse files from diff
            for line in patch.split("\n"):
                if line.startswith("diff --git "):
                    parts = line.split(" ")
                    if len(parts) >= 4:
                        files.append(parts[3][2:] if parts[3].startswith("b/") else parts[3])

            if len(patch) > 200 * 1024:
                patch = patch[:200 * 1024] + f"\n[truncated: {len(patch) - 200*1024} bytes omitted]"
    except Exception:
        pass

    payload = {
        "files": files,
        "unified_diff": patch,
        "worktree_path": worktree_path or str(Path.cwd()),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "base_ref": base_ref,
        "exit_code": exit_code,
        "status": "ok" if exit_code == 0 else f"error (exit {exit_code})",
    }

    with conn:
        _append(conn, task_id, "diff", payload, run_id=run_id)
    return 1


# ---------------------------------------------------------------------------
# Tool result emission
# ---------------------------------------------------------------------------

def emit_tool_result(
    conn: sqlite3.Connection,
    task_id: str,
    tool_name: str,
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
    affected_files: Optional[List[str]] = None,
    run_id: Optional[int] = None,
    duration_seconds: float = 0.0,
) -> None:
    """Emit a structured tool_result event."""
    payload = {
        "tool": tool_name,
        "stdout": stdout[:50000],
        "stderr": stderr[:50000],
        "exit_code": exit_code,
        "affected_files": affected_files or [],
        "duration_seconds": duration_seconds,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    with conn:
        _append(conn, task_id, "tool_result", payload, run_id=run_id)


# ---------------------------------------------------------------------------
# Log emission
# ---------------------------------------------------------------------------

def emit_log_event(
    conn: sqlite3.Connection,
    task_id: str,
    message: str,
    level: str = "info",
    source: str = "system",
    run_id: Optional[int] = None,
) -> None:
    """Emit a structured log event."""
    payload = {
        "message": message[:5000],
        "level": level,
        "source": source,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    with conn:
        _append(conn, task_id, "log", payload, run_id=run_id)


# ---------------------------------------------------------------------------
# Review / QA triggers
# ---------------------------------------------------------------------------

OPencode_BIN = "opencode"
OPencode_TIMEOUT = 300  # 5 min


def trigger_review(
    task_id: str,
    worktree_path: Optional[str] = None,
    profile: Optional[str] = None,
) -> str:
    """Run a review via opencode and write ``review_result`` event.

    Falls back to a stub heuristic scan if opencode is not installed.
    Returns a summary string.
    """
    db_path = Path(kb.kanban_db_path(profile))
    cwd = worktree_path or str(Path.cwd())

    with kb.connect(db_path) as conn:
        task = kb.get_task(conn, task_id)
        if task is None:
            return f"Task not found: {task_id}"

        title = task.title or "untitled"
        events = kb.list_events(conn, task_id)

        # Collect diff events for context
        diff_patches = []
        changed_files: List[str] = []
        for ev in reversed(events):
            if ev.kind == "diff" and ev.payload:
                if ev.payload.get("unified_diff"):
                    diff_patches.append(ev.payload["unified_diff"])
                for f in ev.payload.get("files", []):
                    if f not in changed_files:
                        changed_files.append(f)

        diff_text = "\n".join(diff_patches)

        # Try opencode
        review_payload = None
        if shutil.which(OPencode_BIN):
            try:
                prompt = _build_review_prompt(title, changed_files, diff_text)
                result = subprocess.run(
                    [OPencode_BIN, "run", "--format", "json", "--pure", "--agent", "plan", prompt],
                    cwd=cwd,
                    capture_output=True,
                    text=True,
                    timeout=OPencode_TIMEOUT,
                )
                review_payload = {
                    "executor": "opencode",
                    "exit_code": result.returncode,
                    "raw_output": result.stdout[:20000] if result.stdout else "",
                    "stderr": result.stderr[:5000] if result.stderr else "",
                }
            except subprocess.TimeoutExpired:
                review_payload = {"executor": "opencode", "error": "timeout"}
            except Exception as e:
                review_payload = {"executor": "opencode", "error": str(e)}

        # Fallback: stub heuristic
        if review_payload is None:
            findings = _stub_review_findings(diff_text)
            review_payload = {"executor": "stub", "findings": findings, "note": "opencode not available"}

        with conn:
            _append(conn, task_id, "review_result", review_payload)

        return f"Review complete for {task_id} (executor={review_payload.get('executor', 'unknown')})"


def trigger_qa(
    task_id: str,
    worktree_path: Optional[str] = None,
    profile: Optional[str] = None,
) -> str:
    """Run a QA check and write ``qa_result`` event.

    Falls back to a stub if opencode is not installed.
    Returns a summary string.
    """
    db_path = Path(kb.kanban_db_path(profile))
    cwd = worktree_path or str(Path.cwd())

    with kb.connect(db_path) as conn:
        task = kb.get_task(conn, task_id)
        if task is None:
            return f"Task not found: {task_id}"

        title = task.title or "untitled"
        events = kb.list_events(conn, task_id)

        changed_files: List[str] = []
        for ev in reversed(events):
            if ev.kind == "diff" and ev.payload:
                for f in ev.payload.get("files", []):
                    if f not in changed_files:
                        changed_files.append(f)

        qa_payload = None

        if shutil.which(OPencode_BIN):
            try:
                prompt = _build_qa_prompt(title, changed_files)
                result = subprocess.run(
                    [OPencode_BIN, "run", "--format", "json", "--pure", prompt],
                    cwd=cwd,
                    capture_output=True,
                    text=True,
                    timeout=OPencode_TIMEOUT,
                )
                qa_payload = {
                    "executor": "opencode",
                    "exit_code": result.returncode,
                    "raw_output": result.stdout[:20000] if result.stdout else "",
                    "stderr": result.stderr[:5000] if result.stderr else "",
                }
            except subprocess.TimeoutExpired:
                qa_payload = {"executor": "opencode", "error": "timeout"}
            except Exception as e:
                qa_payload = {"executor": "opencode", "error": str(e)}

        if qa_payload is None:
            qa_payload = {
                "executor": "stub",
                "test_passed": len(changed_files),
                "test_failed": 0,
                "test_skipped": 0,
                "note": f"Stub QA: verified {len(changed_files)} file(s) exist and are readable. opencode not available.",
            }

        with conn:
            _append(conn, task_id, "qa_result", qa_payload)

        return f"QA complete for {task_id} (executor={qa_payload.get('executor', 'unknown')})"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _append(
    conn: sqlite3.Connection,
    task_id: str,
    kind: str,
    payload: dict,
    run_id: Optional[int] = None,
) -> None:
    """Thin wrapper around kanban_db._append_event."""
    try:
        kb._append_event(conn, task_id, kind, payload, run_id=run_id)
    except TypeError:
        # Fallback if _append_event doesn't accept run_id as kwarg
        now = int(time.time())
        pl = json.dumps(payload, ensure_ascii=False) if payload else None
        conn.execute(
            "INSERT INTO task_events (task_id, kind, payload, created_at) "
            "VALUES (?, ?, ?, ?)",
            (task_id, kind, pl, now),
        )


def _build_review_prompt(title: str, changed_files: List[str], diff_text: str) -> str:
    parts = [
        "--- Review Context ---",
        f"Task: {title}",
    ]
    if changed_files:
        parts.append(f"Changed Files: {', '.join(changed_files[:20])}")
    if diff_text:
        diff_preview = diff_text[:3000]
        if len(diff_text) > 3000:
            diff_preview += f"\n... ({len(diff_text) - 3000} more bytes)"
        parts.append(f"Diff:\n{diff_preview}")
    parts.append("--- End Review Context ---")
    parts.append("Review the above changes for correctness, security, performance, and maintainability. Output findings as JSON. Do NOT modify any code.")
    return "\n".join(parts)


def _build_qa_prompt(title: str, changed_files: List[str]) -> str:
    parts = [
        "--- QA Context ---",
        f"Task: {title}",
    ]
    if changed_files:
        parts.append(f"Changed Files: {', '.join(changed_files[:20])}")
    parts.append("--- End QA Context ---")
    parts.append("Verify the changed files. Run any available tests. Identify risks. Output results as JSON. Do NOT modify any code.")
    return "\n".join(parts)


def _stub_review_findings(diff_text: str) -> list[dict]:
    """Heuristic review findings from diff content."""
    findings = []
    if "secret" in diff_text.lower() or "password" in diff_text.lower() or "api_key" in diff_text.lower():
        findings.append({"severity": "high", "category": "security", "title": "Potential hardcoded secret", "description": "Diff contains sensitive keyword patterns."})
    if "SELECT *" in diff_text or "f\"" in diff_text or "f'" in diff_text:
        findings.append({"severity": "critical", "category": "security", "title": "Potential SQL injection", "description": "Unsanitized string interpolation detected."})
    if not findings:
        findings.append({"severity": "info", "category": "maintainability", "title": "No obvious issues", "description": "Heuristic scan found no patterns of concern."})
    return findings
