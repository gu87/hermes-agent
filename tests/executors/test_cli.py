#!/usr/bin/env python3
"""
Tests for executors/cli.py (Commit D2 — top-level CLI integration).

Scope:
  - Importing executors.cli has no side effects (no subprocess, no
    hermes_cli.* leakage, no real binary lookup)
  - create_default_registry() wires all 5 adapters without invoking
    any real binary
  - The 5 formatters (_format_health_table, _format_health_json,
    _format_executor_info, _cmd_list, _cmd_health) render correctly
  - _cmd_select with unknown id exits 1; with unavailable executor
    exits 1
  - _cmd_route (with --accept) uses the router and prints the
    recommendation without reading from stdin
  - main() delegates to the correct handle_*_command for each top-level
    subcommand (worktree, context, review, qa, inbox, bridge)
  - main() delegates to _cmd_* for list, health, info, select, route
  - main() with no subcommand exits 1 and prints help
  - main() with --help exits 0
  - destructive subcommands (worktree discard --force) preserve the
    force flag in the args namespace passed to the handler
  - Missing external binaries (claude-code/codex/opencode absent) do
    not crash; _cmd_health reports UNAVAILABLE and the CLI exits 0
  - Python-level -m executors.cli --help works end-to-end

Strictly no subprocess execution of real CLI tools (claude-code,
codex, opencode, deepseek-tui), no model calls, no worktree creation,
no real-repo writes, no hermes_cli.* imports.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
import os
import shutil
import subprocess
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import executors.cli as cli
from executors.cli import (
    STATUS_ICONS,
    _cmd_health,
    _cmd_info,
    _cmd_list,
    _cmd_route,
    _cmd_select,
    _format_executor_info,
    _format_health_json,
    _format_health_table,
    create_default_registry,
    main,
)
from executors.registry import ExecutorRegistry
from executors.types import (
    ExecutorCapabilities,
    ExecutorHealthResult,
    ExecutorHealthStatus,
    ExecutorManifest,
    RouterRecommendation,
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
# Factory helpers
# ---------------------------------------------------------------------------


def _make_manifest(
    id: str = "test-exec",
    label: str = "Test Executor",
    description: str = "Test description",
    ui_fidelity: str = "full",
    supports_worktree: bool = True,
    default_model: str = "test-model",
    capabilities: ExecutorCapabilities = None,
) -> ExecutorManifest:
    if capabilities is None:
        capabilities = ExecutorCapabilities(
            structured_tool_calls=True,
            native_diff_events=True,
            reasoning_blocks=True,
            review_gate=True,
            streaming="realtime",
        )
    return ExecutorManifest(
        id=id,
        label=label,
        description=description,
        ui_fidelity=ui_fidelity,
        supports_worktree=supports_worktree,
        default_model=default_model,
        capabilities=capabilities,
    )


def _make_health(
    id: str = "test-exec",
    status: ExecutorHealthStatus = ExecutorHealthStatus.AVAILABLE,
    version: str = "1.0.0",
    error: str = None,
) -> ExecutorHealthResult:
    return ExecutorHealthResult(
        executor_id=id,
        status=status,
        version=version,
        error=error,
    )


def _build_registry(
    specs: List[Dict[str, Any]] = None,
    health_overrides: Dict[str, ExecutorHealthResult] = None,
) -> ExecutorRegistry:
    """Build a registry from manifest specs and optional health overrides."""
    if specs is None:
        specs = [
            {"id": "a", "label": "Alpha"},
            {"id": "b", "label": "Beta", "supports_worktree": False},
        ]
    reg = ExecutorRegistry()
    for spec in specs:
        m = _make_manifest(**spec)
        reg.register(m, MagicMock())
    if health_overrides:
        for eid, h in health_overrides.items():
            reg.set_health(h)
    return reg


# ---------------------------------------------------------------------------
# 1. Import side effects
# ---------------------------------------------------------------------------


class TestImportSideEffects:
    def test_importing_cli_does_not_invoke_shutil_which(self, monkeypatch):
        """Importing executors.cli must not call shutil.which on any binary."""
        called_with: List[str] = []
        orig_which = shutil.which

        def spy(cmd, *a, **kw):
            called_with.append(cmd)
            return orig_which(cmd, *a, **kw)

        monkeypatch.setattr(shutil, "which", spy)

        for mod in list(sys.modules):
            if mod == "executors.cli" or mod.startswith("executors.cli."):
                del sys.modules[mod]
        importlib.import_module("executors.cli")

        assert called_with == [], (
            f"shutil.which was called at import time: {called_with[:5]}"
        )

    def test_importing_cli_does_not_load_hermes_cli(self, monkeypatch):
        """Importing executors.cli must not pull in any hermes_cli.* module.

        We use a diff-based check: snapshot sys.modules BEFORE the re-import,
        re-import, then assert the *delta* contains no hermes_cli.* entries.
        Absolute checks are unreliable because other test files in the same
        pytest process may have already imported hermes_cli.* modules.
        """
        for mod in list(sys.modules):
            if mod == "executors.cli" or mod.startswith("executors.cli."):
                del sys.modules[mod]
        before = set(sys.modules)
        importlib.import_module("executors.cli")
        added = set(sys.modules) - before

        leaked = [m for m in added if m.startswith("hermes_cli")]
        assert leaked == [], f"hermes_cli modules were imported: {leaked}"

    def test_importing_cli_does_not_spawn_subprocess(self, monkeypatch):
        """Importing executors.cli must not call asyncio.create_subprocess_exec."""
        called: List[tuple] = []
        orig_create = asyncio.create_subprocess_exec

        async def spy(*a, **kw):
            called.append((a, kw))
            return await orig_create(*a, **kw)

        monkeypatch.setattr(asyncio, "create_subprocess_exec", spy)

        for mod in list(sys.modules):
            if mod == "executors.cli" or mod.startswith("executors.cli."):
                del sys.modules[mod]
        importlib.import_module("executors.cli")

        assert called == [], (
            f"subprocess spawned at import time: {called[:1]}"
        )

    def test_create_default_registry_does_not_invoke_which(self, monkeypatch):
        """create_default_registry() must not look up any binary on disk."""
        called_with: List[str] = []
        orig_which = shutil.which

        def spy(cmd, *a, **kw):
            called_with.append(cmd)
            return orig_which(cmd, *a, **kw)

        monkeypatch.setattr(shutil, "which", spy)
        create_default_registry()
        assert called_with == []


# ---------------------------------------------------------------------------
# 2. Formatters
# ---------------------------------------------------------------------------


class TestFormatters:
    def test_health_table_contains_all_ids_and_icons(self):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE, version="1.0"),
                "b": _make_health(id="b", status=ExecutorHealthStatus.UNAVAILABLE, error="binary missing"),
            },
        )
        out = _format_health_table(reg)
        assert "a" in out
        assert "b" in out
        assert STATUS_ICONS[ExecutorHealthStatus.AVAILABLE] in out
        assert STATUS_ICONS[ExecutorHealthStatus.UNAVAILABLE] in out
        assert "binary missing" in out

    def test_health_table_truncates_long_error(self):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.UNAVAILABLE, error="x" * 200),
            },
        )
        out = _format_health_table(reg)
        # The 50-char cap is "..." suffix
        assert "..." in out
        # And the full 200-char error must not be present
        assert "x" * 200 not in out

    def test_health_json_includes_capabilities_block(self):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE, version="2.0"),
            },
        )
        out = _format_health_json(reg)
        data = json.loads(out)
        assert "a" in data
        assert data["a"]["status"] == "available"
        assert data["a"]["version"] == "2.0"
        # capabilities nested
        caps = data["a"]["capabilities"]
        assert caps["structured_tool_calls"] is True
        assert caps["streaming"] == "realtime"
        assert "ui_fidelity" in data["a"]
        assert "label" in data["a"]
        assert "description" in data["a"]

    def test_health_json_handles_all_executors(self):
        reg = _build_registry()
        out = _format_health_json(reg)
        data = json.loads(out)
        assert set(data.keys()) == {"a", "b"}

    def test_executor_info_known_id(self):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE, version="1.0"),
            },
        )
        out = _format_executor_info("a", reg)
        assert "ID:           a" in out
        assert "Label:        Alpha" in out
        assert "Description:  Test description" in out
        assert "Version:      1.0" in out
        assert "Worktree:     supported" in out
        # Capabilities block
        assert "structured_tool_calls: True" in out
        assert "streaming:             realtime" in out

    def test_executor_info_unknown_id_returns_message(self):
        reg = _build_registry()
        out = _format_executor_info("nope", reg)
        assert out == "Unknown executor: nope"

    def test_executor_info_worktree_unsupported(self):
        reg = _build_registry(
            health_overrides={
                "b": _make_health(id="b", status=ExecutorHealthStatus.UNAVAILABLE, error="no"),
            },
        )
        out = _format_executor_info("b", reg)
        assert "Worktree:     unsupported" in out
        assert STATUS_ICONS[ExecutorHealthStatus.UNAVAILABLE] in out


# ---------------------------------------------------------------------------
# 3. _cmd_list
# ---------------------------------------------------------------------------


class TestCmdList:
    def test_list_text_format(self, capsys):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE),
                "b": _make_health(id="b", status=ExecutorHealthStatus.UNAVAILABLE, error="x"),
            },
        )
        _run(_cmd_list(reg, json_output=False))
        out = capsys.readouterr().out
        assert "a" in out
        assert "b" in out
        assert STATUS_ICONS[ExecutorHealthStatus.AVAILABLE] in out
        assert STATUS_ICONS[ExecutorHealthStatus.UNAVAILABLE] in out

    def test_list_json_format_is_parseable(self, capsys):
        reg = _build_registry()
        _run(_cmd_list(reg, json_output=True))
        out = capsys.readouterr().out
        data = json.loads(out)
        ids = {e["id"] for e in data}
        labels = {e["label"] for e in data}
        assert ids == {"a", "b"}
        assert labels == {"Alpha", "Beta"}


# ---------------------------------------------------------------------------
# 4. _cmd_health
# ---------------------------------------------------------------------------


class TestCmdHealth:
    def test_health_runs_and_prints_table(self, capsys, monkeypatch):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE, version="1.0"),
            },
        )

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        _run(_cmd_health(reg, json_output=False))
        out = capsys.readouterr().out
        assert "Running health checks" in out
        assert "a" in out
        assert "available" in out
        assert "1.0" in out

    def test_health_runs_and_prints_json(self, capsys, monkeypatch):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE, version="1.0"),
                "b": _make_health(id="b", status=ExecutorHealthStatus.UNAVAILABLE, error="x"),
            },
        )

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        _run(_cmd_health(reg, json_output=True))
        out = capsys.readouterr().out
        # `_cmd_health` prints a "Running health checks..." line and a blank
        # line BEFORE the JSON. Strip the prefix before parsing.
        json_part = out.split("\n\n", 1)[-1]
        data = json.loads(json_part)
        assert data["a"]["status"] == "available"
        assert data["b"]["status"] == "unavailable"

    def test_health_does_not_crash_when_all_binaries_missing(self, capsys, monkeypatch):
        """All-executors-unavailable path: must still print cleanly."""
        specs = [
            {"id": "claude-code", "label": "Claude Code"},
            {"id": "codex-cli", "label": "Codex"},
            {"id": "opencode", "label": "OpenCode"},
            {"id": "deepseek-tui", "label": "DeepSeek"},
        ]
        reg = _build_registry(
            specs=specs,
            health_overrides={
                eid: _make_health(
                    id=eid,
                    status=ExecutorHealthStatus.UNAVAILABLE,
                    error=f"{eid} not found",
                )
                for eid in ("claude-code", "codex-cli", "opencode", "deepseek-tui")
            },
        )

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        # Should not raise
        _run(_cmd_health(reg, json_output=False))
        out = capsys.readouterr().out
        assert "claude-code" in out
        assert "codex-cli" in out
        assert "not found" in out


# ---------------------------------------------------------------------------
# 5. _cmd_info
# ---------------------------------------------------------------------------


class TestCmdInfo:
    def test_info_known_id(self, capsys, monkeypatch):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE, version="1.0"),
            },
        )

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        _run(_cmd_info(reg, "a"))
        out = capsys.readouterr().out
        assert "ID:           a" in out

    def test_info_unknown_id_prints_message(self, capsys, monkeypatch):
        reg = _build_registry()

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        _run(_cmd_info(reg, "nope"))
        out = capsys.readouterr().out
        assert "Unknown executor" in out
        assert "nope" in out


# ---------------------------------------------------------------------------
# 6. _cmd_select
# ---------------------------------------------------------------------------


class TestCmdSelect:
    def test_select_with_known_available_id(self, capsys, monkeypatch):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE, version="1.0"),
            },
        )

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        _run(_cmd_select(reg, "a"))
        out = capsys.readouterr().out
        assert "Selected: " in out
        assert "a" in out
        assert "Alpha" in out
        assert "Ready to use." in out

    def test_select_with_unknown_id_exits_1(self, capsys, monkeypatch):
        reg = _build_registry()

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        with pytest.raises(SystemExit) as exc_info:
            _run(_cmd_select(reg, "nope"))
        assert exc_info.value.code == 1
        err = capsys.readouterr().err
        assert "Unknown executor" in err
        assert "nope" in err

    def test_select_with_unavailable_id_exits_1(self, capsys, monkeypatch):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.UNAVAILABLE, error="no binary"),
            },
        )

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        with pytest.raises(SystemExit) as exc_info:
            _run(_cmd_select(reg, "a"))
        assert exc_info.value.code == 1
        out = capsys.readouterr().out
        assert "WARNING" in out
        assert "not available" in out
        assert "hermes-local" in out  # suggestion

    def test_select_without_id_prints_list(self, capsys, monkeypatch):
        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE),
                "b": _make_health(id="b", status=ExecutorHealthStatus.UNAVAILABLE, error="missing"),
            },
        )

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

        with pytest.raises(SystemExit) as exc_info:
            _run(_cmd_select(reg, None))
        assert exc_info.value.code == 0
        out = capsys.readouterr().out
        assert "Select an executor" in out
        assert "a" in out
        assert "b" in out
        assert "Cancel" in out


# ---------------------------------------------------------------------------
# 7. _cmd_route
# ---------------------------------------------------------------------------


class TestCmdRoute:
    def _fake_router(self, monkeypatch, rec: RouterRecommendation):
        from executors import router as router_mod
        from executors.types import TaskCreateContext
        from executors.cli import _cmd_route as _route

        class FakeRouter:
            def route(self, ctx: TaskCreateContext):
                return rec

        def fake_create_default_router():
            return FakeRouter()

        # Patch on the cli module — _cmd_route does a local import
        # `from executors.router import create_default_router`, so we
        # patch the source module.
        monkeypatch.setattr(router_mod, "create_default_router", fake_create_default_router)

        async def fake_check(registry):
            return None
        monkeypatch.setattr(cli, "check_all_executors_health", fake_check)

    def _args(self, **overrides) -> argparse.Namespace:
        base = dict(
            title="Fix bug",
            goal="make tests pass",
            accept="claude-code",
            executor=None,
        )
        base.update(overrides)
        return argparse.Namespace(**base)

    def test_route_with_accept_uses_recommendation(self, capsys, monkeypatch):
        rec = RouterRecommendation(
            recommended_executor="claude-code",
            confidence=0.85,
            reason="matches keywords",
            alternatives=("opencode",),
            source="keyword",
            override=False,
        )
        self._fake_router(monkeypatch, rec)

        reg = _build_registry(
            health_overrides={
                "a": _make_health(id="a", status=ExecutorHealthStatus.AVAILABLE),
            },
        )
        _run(_cmd_route(reg, self._args()))
        out = capsys.readouterr().out
        assert "Recommended: claude-code" in out
        assert "Confidence:   85%" in out
        assert "Auto-accepted: claude-code" in out
        assert "matches keywords" in out

    def test_route_with_user_override(self, capsys, monkeypatch):
        rec = RouterRecommendation(
            recommended_executor="claude-code",
            confidence=0.5,
            reason="default",
            alternatives=(),
            source="keyword",
            override=False,
        )
        self._fake_router(monkeypatch, rec)

        reg = _build_registry()
        _run(_cmd_route(reg, self._args(executor="opencode")))
        out = capsys.readouterr().out
        assert "User override: opencode" in out
        assert "opencode" in out

    def test_route_does_not_read_stdin_when_accept_set(self, capsys, monkeypatch):
        """Critical: --accept path must not call input() (would block in CI)."""
        rec = RouterRecommendation(
            recommended_executor="claude-code",
            confidence=0.5,
            reason="x",
            alternatives=(),
            source="keyword",
            override=False,
        )
        self._fake_router(monkeypatch, rec)

        reg = _build_registry()

        def explode(*a, **kw):
            raise AssertionError("input() should not be called when --accept is set")

        monkeypatch.setattr("builtins.input", explode)
        _run(_cmd_route(reg, self._args()))
        # If we got here, input() was not called.


# ---------------------------------------------------------------------------
# 8. main() entry point — delegation tests
# ---------------------------------------------------------------------------


class TestMainDelegation:
    """main() must dispatch each top-level command to the correct handler."""

    def _mock_handlers(self, monkeypatch):
        """Replace all handle_*_command with AsyncMocks, return them by name."""
        handles = {
            "worktree": AsyncMock(),
            "context": AsyncMock(),
            "review": AsyncMock(),
            "qa": AsyncMock(),
            "inbox": AsyncMock(),
            "bridge": AsyncMock(),
        }
        monkeypatch.setattr(cli, "handle_worktree_command", handles["worktree"])
        monkeypatch.setattr(cli, "handle_context_command", handles["context"])
        monkeypatch.setattr(cli, "handle_review_command", handles["review"])
        monkeypatch.setattr(cli, "handle_qa_command", handles["qa"])
        monkeypatch.setattr(cli, "handle_inbox_command", handles["inbox"])
        monkeypatch.setattr(cli, "handle_bridge_command", handles["bridge"])
        return handles

    def test_main_no_args_exits_1_and_prints_help(self, monkeypatch, capsys):
        self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", ["executors"])
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 1
        out = capsys.readouterr().out
        # The default argparse usage text starts with "usage:"
        assert "usage" in out.lower() or "executors" in out

    def test_main_worktree_delegates(self, monkeypatch):
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", ["executors", "worktree", "list"])
        main()
        handles["worktree"].assert_awaited_once()
        # Worktree handler takes (project_root: Path, args)
        call_args = handles["worktree"].call_args
        project_root, args = call_args.args
        assert isinstance(project_root, Path)
        assert args.command == "worktree"
        assert args.worktree_subcommand == "list"

    def test_main_worktree_resolves_project_root(self, monkeypatch, tmp_path):
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", [
            "executors", "--project-root", str(tmp_path), "worktree", "list",
        ])
        main()
        project_root, _ = handles["worktree"].call_args.args
        assert project_root == tmp_path.resolve()

    def test_main_worktree_discard_preserves_force_flag(self, monkeypatch):
        """The --force gate must flow through to the handler untouched."""
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", [
            "executors", "worktree", "discard", "t-1234abcd", "--force",
        ])
        main()
        _, args = handles["worktree"].call_args.args
        assert args.worktree_subcommand == "discard"
        assert args.thread_id == "t-1234abcd"
        assert args.force is True

    def test_main_worktree_discard_without_force(self, monkeypatch):
        """--force defaults to False; handler is responsible for the gate."""
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", [
            "executors", "worktree", "discard", "t-1234abcd",
        ])
        main()
        _, args = handles["worktree"].call_args.args
        assert args.force is False

    def test_main_context_delegates(self, monkeypatch, tmp_path):
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", [
            "executors", "--project-root", str(tmp_path),
            "context", "show",
        ])
        main()
        handles["context"].assert_awaited_once()
        project_root, args = handles["context"].call_args.args
        assert project_root == tmp_path.resolve()
        assert args.context_subcommand == "show"

    def test_main_review_delegates(self, monkeypatch):
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", [
            "executors", "review", "parse", "--input", "[]",
        ])
        main()
        handles["review"].assert_awaited_once()
        args = handles["review"].call_args.args[0]
        assert args.command == "review"
        assert args.review_subcommand == "parse"
        assert args.input == "[]"

    def test_main_qa_delegates(self, monkeypatch):
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", [
            "executors", "qa", "build-prompt", "--goal", "test goal",
        ])
        main()
        handles["qa"].assert_awaited_once()
        args = handles["qa"].call_args.args[0]
        assert args.command == "qa"
        assert args.qa_subcommand == "build-prompt"
        assert args.goal == "test goal"

    def test_main_inbox_delegates(self, monkeypatch, tmp_path):
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", [
            "executors", "--project-root", str(tmp_path),
            "inbox", "list",
        ])
        main()
        handles["inbox"].assert_awaited_once()
        project_root, args = handles["inbox"].call_args.args
        assert project_root == tmp_path.resolve()
        assert args.inbox_subcommand == "list"

    def test_main_bridge_delegates(self, monkeypatch):
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", [
            "executors", "bridge", "accept", "--scenario", "happy-path",
        ])
        main()
        handles["bridge"].assert_awaited_once()
        args = handles["bridge"].call_args.args[0]
        assert args.command == "bridge"
        assert args.bridge_subcommand == "accept"
        assert args.scenario == "happy-path"

    def test_main_list_does_not_invoke_handlers(self, monkeypatch, capsys):
        """The `list` subcommand should NOT touch worktree/context/etc."""
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", ["executors", "list"])
        main()
        for h in handles.values():
            h.assert_not_awaited()
        out = capsys.readouterr().out
        # The default registry has these 5 executors
        for eid in ("hermes-local", "claude-code", "codex-cli",
                    "deepseek-tui", "opencode"):
            assert eid in out, f"list output missing '{eid}'"

    def test_main_health_does_not_invoke_handlers(self, monkeypatch, capsys):
        """The `health` subcommand is its own path; no delegation."""
        handles = self._mock_handlers(monkeypatch)
        monkeypatch.setattr(sys, "argv", ["executors", "health", "--json"])
        main()
        for h in handles.values():
            h.assert_not_awaited()
        out = capsys.readouterr().out
        # `_cmd_health` prefixes output with "Running health checks..." + a
        # blank line, then the JSON object. Strip the prefix.
        json_part = out.split("\n\n", 1)[-1]
        data = json.loads(json_part)
        assert isinstance(data, dict)
        assert len(data) >= 1
        # The default registry's 5 executors should all be in the health map
        for eid in ("hermes-local", "claude-code", "codex-cli",
                    "deepseek-tui", "opencode"):
            assert eid in data, f"health output missing '{eid}'"


# ---------------------------------------------------------------------------
# 9. Integration: python -m executors.cli --help (hermetic end-to-end)
# ---------------------------------------------------------------------------


class TestCliHelp:
    def test_python_m_executors_cli_help_exits_0(self):
        """Subprocess invocation of --help must succeed."""
        result = subprocess.run(
            [sys.executable, "-m", "executors.cli", "--help"],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        # argparse help lists top-level subcommands
        out = result.stdout + result.stderr
        for cmd in ("worktree", "context", "review", "qa", "inbox", "bridge",
                    "list", "health", "info", "select", "route"):
            assert cmd in out, f"--help output missing subcommand '{cmd}'"

    def test_python_m_executors_cli_worktree_help_exits_0(self):
        result = subprocess.run(
            [sys.executable, "-m", "executors.cli", "worktree", "--help"],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        out = result.stdout + result.stderr
        for sub in ("create", "status", "merge", "discard", "list", "diff", "files"):
            assert sub in out, f"worktree --help missing '{sub}'"

    def test_python_m_executors_cli_bridge_help_exits_0(self):
        result = subprocess.run(
            [sys.executable, "-m", "executors.cli", "bridge", "--help"],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        out = result.stdout + result.stderr
        for sub in ("accept", "logs", "changed-files", "diff", "ipc"):
            assert sub in out, f"bridge --help missing '{sub}'"


# ---------------------------------------------------------------------------
# 10. Real-world resilience: no external binaries → list/health still work
# ---------------------------------------------------------------------------


class TestMissingBinariesDoNotCrash:
    """Even when every external binary is missing, the CLI surfaces a clean
    UNAVAILABLE state instead of raising."""

    def test_create_default_registry_when_no_binaries_present(
        self, monkeypatch, capsys,
    ):
        # Force shutil.which to return None for every binary the adapters probe
        def no_binary(name, *a, **kw):
            return None
        monkeypatch.setattr(shutil, "which", no_binary)

        reg = create_default_registry()
        # All 5 manifests are still registered
        ids = [m.id for m in reg.list_executors()]
        assert set(ids) == {
            "hermes-local", "claude-code", "codex-cli",
            "deepseek-tui", "opencode",
        }

    def test_list_when_no_binaries_present(self, monkeypatch, capsys):
        monkeypatch.setattr(shutil, "which", lambda *a, **kw: None)
        reg = create_default_registry()
        # No health checks run; default is UNKNOWN. Should still print.
        _run(_cmd_list(reg, json_output=False))
        out = capsys.readouterr().out
        for eid in ("hermes-local", "claude-code", "codex-cli",
                    "deepseek-tui", "opencode"):
            assert eid in out

    def test_main_list_when_no_binaries_present(self, monkeypatch, capsys):
        monkeypatch.setattr(shutil, "which", lambda *a, **kw: None)
        monkeypatch.setattr(sys, "argv", ["executors", "list"])
        # Must not raise
        main()
        out = capsys.readouterr().out
        assert "hermes-local" in out


# ---------------------------------------------------------------------------
# 11. Boundary guards
# ---------------------------------------------------------------------------


class TestBoundaryGuards:
    def test_cli_does_not_import_kanban_feedback(self):
        src = Path(cli.__file__).read_text()
        assert "kanban_feedback" not in src
        assert "hermes_cli" not in src

    def test_cli_does_not_import_uncommitted_modules(self):
        """D2 must only import modules committed in A/B/C1/C2/D1a/D1b."""
        committed = {
            "executors.types", "executors.registry", "executors.health",
            "executors.hermes_local_adapter", "executors.claude_code_adapter",
            "executors.codex_adapter", "executors.deepseek_tui_adapter",
            "executors.opencode_adapter",
            "executors.worktree_cli", "executors.context_cli",
            "executors.review_cli", "executors.inbox_cli", "executors.bridge_cli",
            "executors.router",  # used inside _cmd_route via local import
        }
        # Parse the source for `from executors.X import` and `import executors.X`
        import re
        src = Path(cli.__file__).read_text()
        for pattern in (
            r"^from executors\.(\w+) import",
            r"^import executors\.(\w+)",
        ):
            for match in re.finditer(pattern, src, re.MULTILINE):
                mod = f"executors.{match.group(1)}"
                assert mod in committed, (
                    f"cli.py imports uncommitted module: {mod}"
                )

    def test_cli_does_not_import_worktree(self):
        """D2 must NOT import executors.worktree directly — only via worktree_cli."""
        src = Path(cli.__file__).read_text()
        # Allow the argparse help text but not an actual import statement
        import re
        for line in src.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            # Reject any import of worktree directly
            assert not re.match(
                r"^(?:from|import)\s+executors\.worktree(?:\s|$)",
                stripped,
            ), f"cli.py must not import executors.worktree: {stripped!r}"

    def test_cli_does_not_import_subprocess_at_top_level(self):
        """No real subprocess calls at import; subprocess is only inside
        adapter methods, not the CLI module itself."""
        src = Path(cli.__file__).read_text()
        assert "import subprocess" not in src
        assert "from subprocess" not in src
        assert "asyncio.create_subprocess_exec" not in src

    def test_cli_does_not_import_asyncio_subprocess(self):
        """Even via re-export: no subprocess at the CLI level."""
        import ast
        tree = ast.parse(Path(cli.__file__).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert "subprocess" not in alias.name
            if isinstance(node, ast.ImportFrom):
                if node.module:
                    assert "subprocess" not in node.module
