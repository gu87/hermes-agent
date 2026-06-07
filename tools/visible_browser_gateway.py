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


def register_notify(session_key: str, cb: Callable[[_VisibleBrowserProposal], None]) -> None:
    with _lock:
        _notify_cbs[session_key] = cb


def unregister_notify(session_key: str) -> None:
    with _lock:
        _notify_cbs.pop(session_key, None)
    clear_session(session_key)


def get_notify(session_key: str) -> Optional[Callable[[_VisibleBrowserProposal], None]]:
    with _lock:
        return _notify_cbs.get(session_key)
