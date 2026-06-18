#!/usr/bin/env python3
"""
CLI subcommands for review and QA runs.

Usage (via executors.cli):
    python -m executors.cli review build-prompt --goal "..." --diff "..." --executor claude-code
    python -m executors.cli review parse "executor output here"
    python -m executors.cli review executor --available codex,opencode,claude-code

    python -m executors.cli qa build-prompt --goal "..." --test-cmd "pytest" --executor opencode
    python -m executors.cli qa parse '{"test_passed": 10, "test_failed": 2, ...}'
    python -m executors.cli qa executor --available codex,opencode,deepseek-tui
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

from executors.review_agent import ReviewAgent, QAAgent
from executors.types import ReviewStatus, QAStatus


SEVERITY_ICONS = {
    "critical": "●",
    "high": "▲",
    "medium": "■",
    "low": "○",
    "info": "ℹ",
}


async def cmd_review_build_prompt(
    goal: str = "",
    diff: str = "",
    changed_files: str = "",
    executor: str = "claude-code",
    prompt_snapshot: str = "",
) -> None:
    """Build and display a review prompt."""
    agent = ReviewAgent()

    files_list = [f.strip() for f in changed_files.split(",") if f.strip()] if changed_files else []

    prompt = agent.build_prompt(
        task_goal=goal,
        main_run_executor=executor,
        changed_files=files_list,
        diff=diff,
        main_run_prompt_snapshot=prompt_snapshot,
    )

    print(prompt)
    print(f"\n--- Prompt stats ---")
    print(f"Lines: {len(prompt.split(chr(10)))}")
    print(f"Chars: {len(prompt)}")


async def cmd_review_parse(
    review_run_id: str = "review-test-001",
    input_text: str = "",
    input_file: str = "",
) -> None:
    """Parse review findings from executor output."""
    agent = ReviewAgent()

    if input_file:
        text = Path(input_file).read_text()
    else:
        text = input_text or sys.stdin.read()

    if not text.strip():
        print("No input provided (use --input or stdin)", file=sys.stderr)
        sys.exit(1)

    findings, error = agent.parse_findings(review_run_id, text)

    if error:
        print(f"Parse warning: {error}")

    print(f"Findings: {len(findings)}")
    for f in findings:
        icon = SEVERITY_ICONS.get(f.severity.value, "?")
        print(f"\n  {icon} {f.severity.value.upper():8} [{f.category.value}]")
        print(f"  Title:       {f.title}")
        print(f"  File:        {f.file_path or 'N/A'}")
        if f.line_start:
            print(f"  Lines:       {f.line_start}-{f.line_end or '?'}")
        print(f"  Description: {f.description[:200]}")
        if f.suggestion:
            print(f"  Suggestion:  {f.suggestion[:200]}")

    # Build report summary
    report = agent.build_report(
        review_run_id=review_run_id,
        executor="cli",
        findings=findings,
        status=ReviewStatus.COMPLETED if findings else ReviewStatus.PASSED,
    )
    print(f"\n=== Report ===")
    print(f"Status:          {report.status.value}")
    print(f"Total findings:  {report.total_findings}")
    print(f"Critical: {report.critical_count}  High: {report.high_count}  "
          f"Medium: {report.medium_count}  Low: {report.low_count}  Info: {report.info_count}")


async def cmd_review_executor(available: str = "") -> None:
    """Recommend the best review executor."""
    agent = ReviewAgent()
    available_list = [a.strip() for a in available.split(",") if a.strip()]
    eid, reason = agent.recommend_executor(available_list)
    print(f"Recommended: {eid}")
    print(f"Reason:      {reason}")


async def cmd_qa_build_prompt(
    goal: str = "",
    changed_files: str = "",
    test_cmds: str = "",
    worktree_path: str = "",
) -> None:
    """Build and display a QA prompt."""
    agent = QAAgent()

    files_list = [f.strip() for f in changed_files.split(",") if f.strip()] if changed_files else []
    cmd_pairs = []
    if test_cmds:
        for pair in test_cmds.split(";"):
            parts = pair.strip().split(":", 1)
            if len(parts) == 2:
                cmd_pairs.append((parts[0].strip(), parts[1].strip()))
            else:
                cmd_pairs.append((parts[0].strip(), parts[0].strip()))

    prompt = agent.build_prompt(
        task_goal=goal,
        changed_files=files_list,
        test_commands=cmd_pairs,
        worktree_path=worktree_path or None,
    )

    print(prompt)
    print(f"\n--- Prompt stats ---")
    print(f"Lines: {len(prompt.split(chr(10)))}")
    print(f"Chars: {len(prompt)}")


async def cmd_qa_parse(
    qa_run_id: str = "qa-test-001",
    input_text: str = "",
    input_file: str = "",
) -> None:
    """Parse QA results from executor output."""
    agent = QAAgent()

    if input_file:
        text = Path(input_file).read_text()
    else:
        text = input_text or sys.stdin.read()

    if not text.strip():
        print("No input provided", file=sys.stderr)
        sys.exit(1)

    report, error = agent.parse_results(qa_run_id, text)

    if error:
        print(f"Parse warning: {error}")

    print(f"Status:   {report.status.value}")
    print(f"Passed:   {report.test_passed}")
    print(f"Failed:   {report.test_failed}")
    print(f"Skipped:  {report.test_skipped}")
    if report.coverage_delta is not None:
        sign = "+" if report.coverage_delta >= 0 else ""
        print(f"Coverage: {sign}{report.coverage_delta}%")

    if report.risks:
        print(f"\nRisks ({len(report.risks)}):")
        for r in report.risks:
            icon = SEVERITY_ICONS.get(r.severity.value, "?")
            print(f"  {icon} {r.severity.value.upper():8} {r.title}")
            print(f"     {r.description[:120]}")
            if r.affected_areas:
                print(f"     Affected: {', '.join(r.affected_areas[:5])}")

    if report.test_output:
        print(f"\n=== Test Output (first 300 chars) ===")
        print(report.test_output[:300])


async def cmd_qa_executor(available: str = "") -> None:
    """Recommend the best QA executor."""
    agent = QAAgent()
    available_list = [a.strip() for a in available.split(",") if a.strip()]
    eid, reason = agent.recommend_executor(available_list)
    print(f"Recommended: {eid}")
    print(f"Reason:      {reason}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def handle_review_command(args) -> None:
    """Dispatch review subcommands."""
    sub = args.review_subcommand
    if sub is None:
        print("Usage: review {build-prompt|parse|executor} [...]", file=sys.stderr)
        sys.exit(1)

    if sub == "build-prompt":
        await cmd_review_build_prompt(
            goal=getattr(args, "goal", ""),
            diff=getattr(args, "diff", ""),
            changed_files=getattr(args, "changed_files", ""),
            executor=getattr(args, "executor", "claude-code"),
            prompt_snapshot=getattr(args, "prompt_snapshot", ""),
        )
    elif sub == "parse":
        await cmd_review_parse(
            review_run_id=getattr(args, "review_run_id", "review-test-001"),
            input_text=getattr(args, "input", ""),
            input_file=getattr(args, "input_file", ""),
        )
    elif sub == "executor":
        await cmd_review_executor(available=getattr(args, "available", ""))
    else:
        print(f"Unknown review command: {sub}", file=sys.stderr)
        sys.exit(1)


async def handle_qa_command(args) -> None:
    """Dispatch QA subcommands."""
    sub = args.qa_subcommand
    if sub is None:
        print("Usage: qa {build-prompt|parse|executor} [...]", file=sys.stderr)
        sys.exit(1)

    if sub == "build-prompt":
        await cmd_qa_build_prompt(
            goal=getattr(args, "goal", ""),
            changed_files=getattr(args, "changed_files", ""),
            test_cmds=getattr(args, "test_cmds", ""),
            worktree_path=getattr(args, "worktree_path", ""),
        )
    elif sub == "parse":
        await cmd_qa_parse(
            qa_run_id=getattr(args, "qa_run_id", "qa-test-001"),
            input_text=getattr(args, "input", ""),
            input_file=getattr(args, "input_file", ""),
        )
    elif sub == "executor":
        await cmd_qa_executor(available=getattr(args, "available", ""))
    else:
        print(f"Unknown qa command: {sub}", file=sys.stderr)
        sys.exit(1)
