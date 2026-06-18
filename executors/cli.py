#!/usr/bin/env python3
"""
CLI for executor and worktree management.

Usage:
    python -m executors.cli list              # list all registered executors
    python -m executors.cli health            # run health checks on all
    python -m executors.cli health --json     # machine-readable output
    python -m executors.cli info <id>         # show detailed info for one executor

    python -m executors.cli worktree create <thread_id> [--run-seq N]
    python -m executors.cli worktree status <thread_id>
    python -m executors.cli worktree merge <thread_id>
    python -m executors.cli worktree discard <thread_id> [--force]
    python -m executors.cli worktree list [--all]
    python -m executors.cli worktree diff <thread_id>
    python -m executors.cli worktree files <thread_id>

This module also provides ``create_default_registry()``, the canonical
factory function used by the main CLI and UI.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
import datetime
from typing import Optional, Dict

from executors.types import ExecutorId, ExecutorHealthStatus
from executors.registry import ExecutorRegistry, _default_manifests
from executors.health import check_all_executors_health
from executors.hermes_local_adapter import HermesLocalAdapter
from executors.claude_code_adapter import ClaudeCodeAdapter
from executors.codex_adapter import CodexAdapter
from executors.deepseek_tui_adapter import DeepSeekTuiAdapter
from executors.opencode_adapter import OpenCodeAdapter
from executors.worktree_cli import handle_worktree_command
from executors.context_cli import handle_context_command
from executors.review_cli import handle_review_command, handle_qa_command
from executors.inbox_cli import handle_inbox_command
from executors.bridge_cli import handle_bridge_command


# ---------------------------------------------------------------------------
# Registry factory
# ---------------------------------------------------------------------------

def create_default_registry() -> ExecutorRegistry:
    """Create and populate an ExecutorRegistry with all four adapters."""
    registry = ExecutorRegistry()
    manifests = _default_manifests()

    registry.register(manifests["hermes-local"], HermesLocalAdapter())
    registry.register(manifests["claude-code"], ClaudeCodeAdapter())
    registry.register(manifests["codex-cli"], CodexAdapter())
    registry.register(manifests["deepseek-tui"], DeepSeekTuiAdapter())
    registry.register(manifests["opencode"], OpenCodeAdapter())

    return registry


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------

STATUS_ICONS = {
    ExecutorHealthStatus.AVAILABLE: "✅",
    ExecutorHealthStatus.UNAVAILABLE: "❌",
    ExecutorHealthStatus.UNKNOWN: "❓",
}


def _format_health_table(registry: ExecutorRegistry) -> str:
    lines = []
    lines.append(f"{'ID':<16} {'Status':<14} {'Version':<30} {'Error'}")
    lines.append("-" * 100)

    for m in registry.list_executors():
        h = registry.get_health(m.id)
        icon = STATUS_ICONS.get(h.status, "?")
        version = h.version or "-"
        error = h.error or "-"
        if len(error) > 50:
            error = error[:47] + "..."
        lines.append(
            f"{m.id:<16} {icon} {h.status.value:<11} "
            f"{version:<30} {error}"
        )
    return "\n".join(lines)


def _format_health_json(registry: ExecutorRegistry) -> str:
    result = {}
    for m in registry.list_executors():
        h = registry.get_health(m.id)
        result[m.id] = {
            "status": h.status.value,
            "version": h.version,
            "error": h.error,
            "capabilities": {
                "structured_tool_calls": m.capabilities.structured_tool_calls,
                "native_diff_events": m.capabilities.native_diff_events,
                "reasoning_blocks": m.capabilities.reasoning_blocks,
                "review_gate": m.capabilities.review_gate,
                "streaming": m.capabilities.streaming,
            },
            "ui_fidelity": m.ui_fidelity,
            "label": m.label,
            "description": m.description,
        }
    return json.dumps(result, indent=2, ensure_ascii=False)


def _format_executor_info(executor_id: ExecutorId, registry: ExecutorRegistry) -> str:
    try:
        m = registry.get_manifest(executor_id)
    except KeyError:
        return f"Unknown executor: {executor_id}"

    h = registry.get_health(executor_id)
    icon = STATUS_ICONS.get(h.status, "?")

    return "\n".join([
        f"ID:           {m.id}",
        f"Label:        {m.label}",
        f"Description:  {m.description}",
        f"Health:       {icon} {h.status.value}",
        f"Version:      {h.version or 'N/A'}",
        f"Error:        {h.error or 'None'}",
        f"Fidelity:     {m.ui_fidelity}",
        f"Default Model:{m.default_model or 'N/A'}",
        f"Worktree:     {'supported' if m.supports_worktree else 'unsupported'}",
        f"Capabilities:",
        f"  structured_tool_calls: {m.capabilities.structured_tool_calls}",
        f"  native_diff_events:    {m.capabilities.native_diff_events}",
        f"  reasoning_blocks:      {m.capabilities.reasoning_blocks}",
        f"  review_gate:           {m.capabilities.review_gate}",
        f"  streaming:             {m.capabilities.streaming}",
    ])


async def _cmd_list(registry: ExecutorRegistry, json_output: bool) -> None:
    if json_output:
        data = [{"id": m.id, "label": m.label} for m in registry.list_executors()]
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        for m in registry.list_executors():
            h = registry.get_health(m.id)
            icon = STATUS_ICONS.get(h.status, "?")
            print(f"  {icon} {m.id:<16} {m.label:<20} {h.status.value}")


async def _cmd_health(registry: ExecutorRegistry, json_output: bool) -> None:
    print("Running health checks...", flush=True)
    await check_all_executors_health(registry)
    print()
    if json_output:
        print(_format_health_json(registry))
    else:
        print(_format_health_table(registry))


async def _cmd_info(registry: ExecutorRegistry, executor_id: str) -> None:
    await check_all_executors_health(registry)
    print(_format_executor_info(executor_id, registry))


async def _cmd_select(registry: ExecutorRegistry, executor_id: Optional[str]) -> None:
    """Interactive executor selector — show all with health status, let user pick."""
    await check_all_executors_health(registry)

    if executor_id:
        try:
            m = registry.get_manifest(executor_id)
        except KeyError:
            print(f"Unknown executor: {executor_id}", file=sys.stderr)
            print(f"Available: {', '.join(m.id for m in registry.list_executors())}", file=sys.stderr)
            sys.exit(1)

        h = registry.get_health(executor_id)
        icon = STATUS_ICONS.get(h.status, "?")
        print(f"Selected: {icon} {m.id} ({m.label})")

        if h.status != ExecutorHealthStatus.AVAILABLE:
            print(f"\nWARNING: {m.label} is not available.")
            print(f"  Reason: {h.error or 'Unknown'}")
            print(f"  Suggestion: use 'hermes-local' instead.")
            sys.exit(1)

        print(f"  Model: {m.default_model or 'N/A'}")
        print(f"  Status: {h.status.value}")
        print(f"  Version: {h.version or 'N/A'}")
        print(f"  Worktree: {'yes' if m.supports_worktree else 'no'}")
        print("Ready to use.")
    else:
        manifests = registry.list_executors()
        print("Select an executor:\n")
        for i, m in enumerate(manifests, 1):
            h = registry.get_health(m.id)
            icon = STATUS_ICONS.get(h.status, "?")
            if h.status == ExecutorHealthStatus.AVAILABLE:
                tag = ""
            elif h.status == ExecutorHealthStatus.UNAVAILABLE:
                tag = f"  (unavailable: {h.error[:60]})"
            else:
                tag = "  (health unknown)"
            print(f"  {i}. {icon} {m.id:<16} {m.label:<20} [{m.ui_fidelity}]{tag}")
        print(f"\n  {len(manifests) + 1}. Cancel")
        print("\nUse: hermes run --executor <id> ...")
        sys.exit(0)


async def _cmd_route(registry: ExecutorRegistry, args) -> None:
    """Route a task to a recommended executor, with user confirmation."""
    from executors.router import create_default_router
    from executors.types import TaskCreateContext

    await check_all_executors_health(registry)

    # Build context
    available_ids = [m.id for m in registry.list_available()]
    ctx = TaskCreateContext(
        title=args.title,
        goal=args.goal or "",
        available_executors=available_ids,
    )

    router = create_default_router()
    rec = router.route(ctx)

    # Print health overview
    print("Executor Health:")
    for m in registry.list_executors():
        h = registry.get_health(m.id)
        icon = STATUS_ICONS.get(h.status, "?")
        print(f"  {icon} {m.id:<16} ({h.status.value})")

    # Print recommendation
    print(f"\nRouting for: {args.title}")
    if args.goal:
        print(f"  Goal: {args.goal[:120]}")
    print(f"\n  Recommended: {rec.recommended_executor}")
    print(f"  Confidence:   {rec.confidence:.0%}")
    print(f"  Reason:       {rec.reason}")
    if rec.alternatives:
        print(f"  Alternatives: {', '.join(rec.alternatives)}")

    # User override
    if args.executor:
        print(f"\n  User override: {args.executor}")
        rec.recommended_executor = args.executor
        rec.override = True
        rec.source = "manual"
    elif args.accept:
        print(f"\n  Auto-accepted: {args.accept}")
        rec.override = False
    else:
        # Interactive confirmation
        try:
            resp = input(f"\nAccept? [{rec.recommended_executor}/No/manual]: ").strip()
            if not resp or resp.lower() in ("y", "yes", ""):
                print(f"  Accepted: {rec.recommended_executor}")
            elif resp.lower() in ("n", "no"):
                print("  Declined. No executor selected.")
                rec.recommended_executor = ""
                rec.confidence = 0.0
            else:
                # Manual selection
                rec.recommended_executor = resp
                rec.override = True
                rec.source = "manual"
                print(f"  Manual selection: {resp}")
        except (KeyboardInterrupt, EOFError):
            print("\n  Cancelled.")
            return

    # Output final selection as JSON for tooling
    import json
    result = {
        "executor": rec.recommended_executor,
        "confidence": rec.confidence,
        "reason": rec.reason,
        "source": rec.source,
        "override": rec.override,
        "route_timestamp": str(datetime.datetime.utcnow()),
    }
    print(f"\n  Result: {json.dumps(result, indent=2)}")



# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="executors",
        description="Hermes executor and worktree management CLI",
    )
    parser.add_argument(
        "--project-root", "-C",
        default=".",
        help="Project root directory (default: current directory)",
    )
    sub = parser.add_subparsers(dest="command")

    list_p = sub.add_parser("list", help="List all registered executors")
    list_p.add_argument("--json", action="store_true", help="JSON output")

    health_p = sub.add_parser("health", help="Run health checks on all executors")
    health_p.add_argument("--json", action="store_true", help="JSON output")

    info_p = sub.add_parser("info", help="Show detailed info for one executor")
    info_p.add_argument("executor_id", help="Executor ID")

    select_p = sub.add_parser("select", help="Select an executor (interactive or by id)")
    select_p.add_argument("executor_id", nargs="?", help="Executor ID (skip for interactive)")

    # Router subcommand
    route_p = sub.add_parser("route", help="Recommend an executor for a task")
    route_p.add_argument("title", help="Task title")
    route_p.add_argument("--goal", "-g", default="", help="Task goal/description")
    route_p.add_argument("--accept", "-a", help="Auto-accept the recommendation (skip user confirmation)")
    route_p.add_argument("--executor", "-e", help="Override executor selection (user choice)")

    # Worktree subcommands
    wt_p = sub.add_parser("worktree", help="Worktree management")
    wt_sub = wt_p.add_subparsers(dest="worktree_subcommand")

    wt_create = wt_sub.add_parser("create", help="Create a worktree for a thread")
    wt_create.add_argument("thread_id", help="Task thread ID")
    wt_create.add_argument("--run-seq", type=int, default=1, help="Run sequence number (default: 1)")

    wt_status = wt_sub.add_parser("status", help="Show worktree status")
    wt_status.add_argument("thread_id", help="Task thread ID")

    wt_merge = wt_sub.add_parser("merge", help="Merge worktree into main repo")
    wt_merge.add_argument("thread_id", help="Task thread ID")

    wt_discard = wt_sub.add_parser("discard", help="Discard worktree changes")
    wt_discard.add_argument("thread_id", help="Task thread ID")
    wt_discard.add_argument("--force", action="store_true", help="Skip confirmation prompt")

    wt_list = wt_sub.add_parser("list", help="List all worktrees")
    wt_list.add_argument("--all", action="store_true", help="Include released worktrees")

    wt_diff = wt_sub.add_parser("diff", help="Show diff for a worktree")
    wt_diff.add_argument("thread_id", help="Task thread ID")

    wt_files = wt_sub.add_parser("files", help="List changed files in worktree")
    wt_files.add_argument("thread_id", help="Task thread ID")

    # Context subcommands
    ctx_p = sub.add_parser("context", help="Project context management")
    ctx_sub = ctx_p.add_subparsers(dest="context_subcommand")

    ctx_show = ctx_sub.add_parser("show", help="Show project context")
    ctx_show.add_argument("--json", action="store_true", help="JSON output")

    ctx_edit = ctx_sub.add_parser("edit", help="Edit a context field")
    ctx_edit.add_argument("--field", "-f", required=True, choices=["overview","architecture","sprint","conventions"])
    ctx_edit.add_argument("--value", "-v", required=True, help="New value")

    ctx_adr = ctx_sub.add_parser("adr", help="Manage ADR summaries")
    ctx_adr.add_argument("adr_action", choices=["add", "remove"])
    ctx_adr.add_argument("adr_args", nargs="*")

    ctx_cmd = ctx_sub.add_parser("cmd", help="Manage common commands")
    ctx_cmd.add_argument("cmd_action", choices=["add", "remove"])
    ctx_cmd.add_argument("cmd_args", nargs="*")

    ctx_forbidden = ctx_sub.add_parser("forbidden", help="Manage forbidden areas")
    ctx_forbidden.add_argument("forbidden_action", choices=["add", "remove"])
    ctx_forbidden.add_argument("forbidden_args", nargs="*")

    ctx_inj = ctx_sub.add_parser("injection", help="Enable/disable context injection")
    ctx_inj.add_argument("injection_action", choices=["on", "off", "enable", "disable"])

    ctx_preview = ctx_sub.add_parser("preview", help="Preview context injection for an executor")
    ctx_preview.add_argument("executor_id", help="Executor ID")
    ctx_preview.add_argument("--goal", "-g", default="", help="Task goal for full preview")

    # Review subcommands
    rev_p = sub.add_parser("review", help="Review agent commands")
    rev_sub = rev_p.add_subparsers(dest="review_subcommand")

    rev_build = rev_sub.add_parser("build-prompt", help="Build a review prompt")
    rev_build.add_argument("--goal", "-g", default="", help="Task goal")
    rev_build.add_argument("--diff", "-d", default="", help="Git diff output")
    rev_build.add_argument("--changed-files", "-f", default="", help="Comma-separated changed files")
    rev_build.add_argument("--executor", "-e", default="claude-code", help="Main run executor")
    rev_build.add_argument("--prompt-snapshot", "-p", default="", help="Main run prompt snapshot")

    rev_parse = rev_sub.add_parser("parse", help="Parse review findings from output")
    rev_parse.add_argument("--review-run-id", default="review-test-001", help="Review run ID")
    rev_parse.add_argument("--input", "-i", default="", help="Executor output text")
    rev_parse.add_argument("--input-file", default="", help="File containing executor output")

    rev_exec = rev_sub.add_parser("executor", help="Recommend review executor")
    rev_exec.add_argument("--available", "-a", default="", help="Comma-separated available executor IDs")

    # QA subcommands
    qa_p = sub.add_parser("qa", help="QA agent commands")
    qa_sub = qa_p.add_subparsers(dest="qa_subcommand")

    qa_build = qa_sub.add_parser("build-prompt", help="Build a QA prompt")
    qa_build.add_argument("--goal", "-g", default="", help="Task goal")
    qa_build.add_argument("--changed-files", "-f", default="", help="Comma-separated changed files")
    qa_build.add_argument("--test-cmds", "-t", default="", help="Semicolon-separated label:command pairs")
    qa_build.add_argument("--worktree-path", "-w", default="", help="Worktree path")

    qa_parse = qa_sub.add_parser("parse", help="Parse QA results from output")
    qa_parse.add_argument("--qa-run-id", default="qa-test-001", help="QA run ID")
    qa_parse.add_argument("--input", "-i", default="", help="Executor output text")
    qa_parse.add_argument("--input-file", default="", help="File containing executor output")

    qa_exec = qa_sub.add_parser("executor", help="Recommend QA executor")
    qa_exec.add_argument("--available", "-a", default="", help="Comma-separated available executor IDs")

    # Inbox subcommands
    ib_p = sub.add_parser("inbox", help="External inbox management")
    ib_sub = ib_p.add_subparsers(dest="inbox_subcommand")

    ib_add = ib_sub.add_parser("add", help="Add an inbox item")
    ib_add.add_argument("--source", "-s", required=True, choices=[s.value for s in __import__('executors.types', fromlist=['InboxSource']).InboxSource])
    ib_add.add_argument("--title", "-t", required=True, help="Task title")
    ib_add.add_argument("--body", "-b", required=True, help="Task body/prompt")
    ib_add.add_argument("--executor", "-e", default="", help="Suggested executor")
    ib_add.add_argument("--project", "-p", default="", help="Project hint")
    ib_add.add_argument("--priority", default="normal", choices=["high", "normal", "low"])

    ib_list = ib_sub.add_parser("list", help="List inbox items")
    ib_list.add_argument("--status", default="", choices=["", "pending", "confirmed", "rejected", "archived", "expired"])
    ib_list.add_argument("--source", default="")
    ib_list.add_argument("--json", action="store_true")

    ib_show = ib_sub.add_parser("show", help="Show inbox item details")
    ib_show.add_argument("item_id")
    ib_show.add_argument("--json", action="store_true")

    ib_convert = ib_sub.add_parser("convert", help="Convert to task thread")
    ib_convert.add_argument("item_id")
    ib_convert.add_argument("--task-id", required=True, help="Target task thread ID")

    ib_reject = ib_sub.add_parser("reject", help="Reject an inbox item")
    ib_reject.add_argument("item_id")
    ib_reject.add_argument("--reason", "-r", default="", help="Rejection reason")

    ib_archive = ib_sub.add_parser("archive", help="Archive an inbox item")
    ib_archive.add_argument("item_id")

    ib_edit = ib_sub.add_parser("edit", help="Edit task draft")
    ib_edit.add_argument("item_id")
    ib_edit.add_argument("--title", default="")
    ib_edit.add_argument("--prompt", default="")
    ib_edit.add_argument("--executor", default="")
    ib_edit.add_argument("--project", default="")
    ib_edit.add_argument("--priority", default="", choices=["", "high", "normal", "low"])

    ib_summary = ib_sub.add_parser("summary", help="Show inbox summary")

    # Bridge subcommands (v1.0 acceptance path)
    br_p = sub.add_parser("bridge", help="v1.0 bridge acceptance and IPC testing")
    br_sub = br_p.add_subparsers(dest="bridge_subcommand")

    br_accept = br_sub.add_parser("accept", help="Run acceptance tests")
    br_accept.add_argument("--scenario", "-s", default="all", choices=["happy-path", "failed", "all"])

    br_logs = br_sub.add_parser("logs", help="Show aggregated logs")
    br_logs.add_argument("--fixture", "-f", default="happy-path", choices=["happy-path", "failed"])

    br_files = br_sub.add_parser("changed-files", help="Show changed files")
    br_files.add_argument("--fixture", "-f", default="happy-path", choices=["happy-path", "failed"])

    br_diff = br_sub.add_parser("diff", help="Show unified diff")
    br_diff.add_argument("--fixture", "-f", default="happy-path", choices=["happy-path", "failed"])

    br_ipc = br_sub.add_parser("ipc", help="Simulate IPC commands")
    br_ipc_sub = br_ipc.add_subparsers(dest="ipc_action")
    br_ipc_sub.add_parser("trigger-review", help="Simulate triggerReview IPC")
    br_ipc_sub.add_parser("trigger-qa", help="Simulate triggerQA IPC")
    br_ipc_sub.add_parser("continue", help="Simulate continueRun IPC")
    br_ipc_sub.add_parser("retry", help="Simulate retryRun IPC")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    async def run():
        if args.command == "worktree":
            project_root = Path(args.project_root).resolve()
            await handle_worktree_command(project_root, args)
            return

        registry = create_default_registry()
        json_out = getattr(args, "json", False)

        if args.command == "list":
            await _cmd_list(registry, json_out)
        elif args.command == "health":
            await _cmd_health(registry, json_out)
        elif args.command == "info":
            await _cmd_info(registry, args.executor_id)
        elif args.command == "select":
            await _cmd_select(registry, getattr(args, "executor_id", None))
        elif args.command == "route":
            await _cmd_route(registry, args)
        elif args.command == "context":
            project_root = Path(args.project_root).resolve()
            await handle_context_command(project_root, args)
        elif args.command == "review":
            await handle_review_command(args)
        elif args.command == "qa":
            await handle_qa_command(args)
        elif args.command == "inbox":
            project_root = Path(args.project_root).resolve()
            await handle_inbox_command(project_root, args)
        elif args.command == "bridge":
            await handle_bridge_command(args)

    asyncio.run(run())


if __name__ == "__main__":
    main()
