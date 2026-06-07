#!/usr/bin/env python3
"""
Gateway-side visible-browser primitive (blocking event-based queue).

Mirrors ``tools/clarify_gateway.py``: the ``visible_browser_*`` tools need to
propose an action to the Desktop Electron app and block the agent thread until
the user approves or denies it.  Same pattern:

  * stores a pending action proposal (with a generated ``proposal_id``),
  * blocks the agent thread on an ``Event``,
  * resolves the wait when the Desktop sends back ``browser.action.respond``,
  * supports timeouts so an abandoned prompt does NOT hang the agent forever.
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


# =========================================================================
# Data model
# =========================================================================

@dataclass
class _VisibleBrowserProposal:
    """One pending visible-browser action proposal."""
    proposal_id: str
    session_key: str
    action_type: str          # "navigate", "click", "type", "snapshot"
    action_params: Dict[str, Any]
    reason: Optional[str]
    event: threading.Event = field(default_factory=threading.Event)
    response: Optional[str] = None   # JSON result string


_lock = threading.RLock()
_proposals: Dict[str, _VisibleBrowserProposal] = {}
_session_index: Dict[str, List[str]] = {}


# =========================================================================
# Public API — agent-thread side
# =========================================================================

def register(
    proposal_id: str,
    session_key: str,
    action_type: str,
    action_params: Dict[str, Any],
    reason: Optional[str] = None,
) -> _VisibleBrowserProposal:
    """Register a pending visible-browser action proposal."""
    entry = _VisibleBrowserProposal(
        proposal_id=proposal_id,
        session_key=session_key,
        action_type=action_type,
        action_params=action_params,
        reason=reason,
    )
    with _lock:
        _proposals[proposal_id] = entry
        _session_index.setdefault(session_key, []).append(proposal_id)
    return entry


def wait_for_response(proposal_id: str, timeout: float) -> Optional[str]:
    """Block on the proposal's event until resolved or timeout fires.

    Polls in 1-second slices so the agent's inactivity heartbeat keeps
    firing.  Returns the resolved JSON result string, or ``None`` on timeout.
    """
    with _lock:
        entry = _proposals.get(proposal_id)
    if entry is None:
        return None

    try:
        from tools.environments.base import touch_activity_if_due
    except Exception:
        touch_activity_if_due = None

    deadline = time.monotonic() + max(timeout, 0.0)
    activity_state = {"last_touch": time.monotonic(), "start": time.monotonic()}
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        if entry.event.wait(timeout=min(1.0, remaining)):
            break
        if touch_activity_if_due is not None:
            touch_activity_if_due(activity_state, "waiting for visible browser approval")

    return entry.response


def resolve(proposal_id: str, result_json: str) -> bool:
    """Unblock the agent thread waiting on ``proposal_id``.

    Returns True if a proposal was found and resolved, False otherwise.
    """
    with _lock:
        entry = _proposals.get(proposal_id)
        if entry is None:
            return False
    entry.response = str(result_json) if result_json is not None else "{}"
    entry.event.set()
    return True


def clear_session(session_key: str) -> int:
    """Resolve and drop every pending proposal for a session.

    Returns the number of proposals cancelled.
    """
    with _lock:
        ids = list(_session_index.pop(session_key, []) or [])
        entries = [_proposals.pop(cid, None) for cid in ids]
    cancelled = 0
    for entry in entries:
        if entry is None:
            continue
        entry.response = _json.dumps({
            "status": "cancelled",
            "message": "Session ended before user responded",
        })
        entry.event.set()
        cancelled += 1
    return cancelled


def handle_respond(proposal_id: str, approved: bool, result: str = "") -> bool:
    """Handle a browser.action.respond call from the Desktop client.

    Can be called from any thread.  Returns True if the proposal was found
    and resolved, False otherwise.
    """
    import json as _json_respond
    response = _json_respond.dumps({
        "approved": approved,
        "result": result or "",
    })
    return resolve(proposal_id, response)


def get_timeout() -> int:
    """Read the visible browser approval timeout (seconds) from config.

    Defaults to 120 (2 minutes) — shorter than clarify because approving
    a browser action should be quick.
    """
    try:
        from hermes_cli.config import load_config
        cfg = load_config() or {}
        agent_cfg = cfg.get("agent", {}) or {}
        return int(agent_cfg.get("visible_browser_timeout", 120))
    except Exception:
        return 120


# =========================================================================
# Notify callbacks (gateway → adapter bridge)
# =========================================================================

import json as _json

_notify_cbs: Dict[str, Callable[[_VisibleBrowserProposal], None]] = {}
# Process-global fallback notify callback — set by gateway/run.py before
# the agent thread runs, so visible_browser tools can push proposals even
# when no per-session WebSocket notify has been registered.
_global_notify_cb: Optional[Callable[[_VisibleBrowserProposal], None]] = None


def register_notify(session_key: str, cb: Callable[[_VisibleBrowserProposal], None]) -> None:
    """Register a per-session notify callback (e.g. from a TUI WebSocket session)."""
    with _lock:
        _notify_cbs[session_key] = cb


def unregister_notify(session_key: str) -> None:
    with _lock:
        _notify_cbs.pop(session_key, None)
    clear_session(session_key)


def get_notify(session_key: str) -> Optional[Callable[[_VisibleBrowserProposal], None]]:
    """Return the notify callback for *session_key*, falling back to the
    process-global callback (set via ``set_notify``) and finally to the
    slash-worker stdout IPC path.
    """
    with _lock:
        cb = _notify_cbs.get(session_key)
    if cb is not None:
        return cb
    if _global_notify_cb is not None:
        return _global_notify_cb
    # Slash-worker fallback: emit proposal on stdout so the gateway parent
    # process can forward it to the Desktop WebSocket.
    if os.environ.get("HERMES_SESSION_KEY"):
        return _make_slash_worker_notify()
    return None


def set_notify(cb: Callable[[_VisibleBrowserProposal], None]) -> None:
    """Register a process-global fallback notify callback.

    This is the hook used by ``gateway/run.py`` — the callback receives
    every visible-browser proposal regardless of session, because the
    gateway runner multiplexes by ``session_key`` inside the callback body.
    """
    global _global_notify_cb
    with _lock:
        _global_notify_cb = cb


# ── Slash-worker stdout IPC fallback ────────────────────────────────────
# When running inside a ``tui_gateway.slash_worker`` subprocess there is no
# WebSocket and no in-process notify callback.  Instead we serialise the
# proposal to stdout as a JSON line with a ``__vb_proposal__`` discriminator;
# the gateway parent reads this line and forwards the proposal to the Desktop
# app.  The response comes back through a temporary file that the gateway
# writes and the slash-worker polls.

_VB_RESPONSE_DIR = os.path.join(tempfile.gettempdir(), "hermes_vb_responses")


def _make_slash_worker_notify() -> Callable[[_VisibleBrowserProposal], None]:
    """Build a notify callback that bridges via stdout + temp-file responses."""

    def _notify_via_stdout(entry: _VisibleBrowserProposal) -> None:
        import json as _json_sw
        os.makedirs(_VB_RESPONSE_DIR, exist_ok=True)
        resp_path = os.path.join(
            _VB_RESPONSE_DIR, f"resp_{entry.proposal_id}.json"
        )
        # Clean any stale response file from a previous run.
        try:
            os.unlink(resp_path)
        except OSError:
            pass
        # Emit proposal on stdout for the gateway parent to pick up.
        payload = _json_sw.dumps({
            "__vb_proposal__": True,
            "proposal_id": entry.proposal_id,
            "session_key": entry.session_key,
            "action_type": entry.action_type,
            "action_params": entry.action_params,
            "reason": entry.reason,
            "response_file": resp_path,
        })
        # Write atomically so the gateway's line reader gets one complete line.
        sys.stdout.write(payload + "\n")
        sys.stdout.flush()

        # Block until the gateway writes the response file or timeout fires.
        deadline = time.monotonic() + float(get_timeout())
        while time.monotonic() < deadline:
            try:
                with open(resp_path, "r") as fh:
                    resp = _json_sw.load(fh)
                entry.response = _json_sw.dumps(resp)
                os.unlink(resp_path)
                entry.event.set()
                return
            except (OSError, ValueError):
                pass
            time.sleep(0.3)
        # Timeout — resolve with a sentinel so the agent doesn't hang forever.
        entry.response = _json_sw.dumps({
            "approved": False,
            "result": "",
            "error": "timeout waiting for Desktop response",
        })
        entry.event.set()

    return _notify_via_stdout


# Public helper so the gateway can clean up stale response files on startup.
def cleanup_slash_worker_responses() -> int:
    """Remove any orphaned visible-browser response files.

    Returns the number of files removed.
    """
    import glob as _glob
    removed = 0
    pattern = os.path.join(_VB_RESPONSE_DIR, "resp_*.json")
    for path in _glob.glob(pattern):
        try:
            os.unlink(path)
            removed += 1
        except OSError:
            pass
    return removed
