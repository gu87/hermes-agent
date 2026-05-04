# Multi-Agent Upgrade Architecture Decision Record

Date: 2026-05-04
Status: Accepted
Scope: Hermes Sub-Agents system upgrade (Phase 0/A/B/C)

## 1. Runtime vs Source Repository Boundary

### Decision
- `agent-registry.json` stays at `~/.hermes/config/agent-registry.json` as runtime user configuration.
- Source code reads the runtime registry via `hermes_constants.get_hermes_home()`.
- The registry is NOT migrated into the source repository (`~/.hermes/hermes-agent/`).
- `delegate-v27.sh` and `agent-monitor.py` are NOT modified in this upgrade.

### Rationale
- The registry is a user-managed configuration artifact, not source code. It evolves with user needs independently of code releases.
- `delegate-v27.sh` is a stable Chief-of-Staff dispatch script with its own semantics. Changing it risks breaking the existing production dispatch pipeline.
- Hermes has two distinct directories by design: runtime state/config (`~/.hermes/`) and versioned source (`~/.hermes/hermes-agent/`).

### Path Resolution
- Always use `hermes_constants.get_hermes_home() / "config" / "agent-registry.json"` to locate the registry.
- Never hardcode `Path.home() / ".hermes"`.
- Fallback (only for older branches): `Path.home() / ".hermes"`.

## 2. Three Multi-Agent Paradigms

### Paradigm A: `delegate_task` (Primary Enhancement Target)
- In-process subagent spawning via `delegate_task` tool.
- Enhanced with named/profiled subagents via `agent_id` parameter.
- Reads `subagent_profile` from `agent-registry.json`.
- This is the MVP focus (Phase A).

### Paradigm B: Chief of Staff + `delegate-v27.sh`
- External script-based agent dispatch.
- Task Card → delegate-v27.sh → external agent process.
- Future: explicit coordinator/swarm protocol (Phase C prep only).
- NOT modified in Phase A/B.

### Paradigm C: Mixture-of-Agents
- Independent multi-model reasoning.
- Only EventLog/result archiving enhancements touch this paradigm.
- Remains otherwise unchanged.

## 3. MVP Scope Boundaries

### IN SCOPE (Phase 0 + A)
- ADR document
- Registry-backed agent routing (`AgentRouter` reads `agent-registry.json`)
- `delegate_task` `agent_id` parameter with profile resolution
- Desktop security: default-deny for subagents
- MCP toolset inheritance control
- Subagent lifecycle events in EventLog
- Backward compatibility with `role=leaf|orchestrator`

### OUT OF SCOPE (NOT in MVP)
- Worktree isolation
- Running `send_message(subagent_id, message)`
- `delegate-v27.sh` modifications
- New parallel lifecycle modules (`src/harness/*`, `tools/subagents/*`)
- Coordinator/swarm implementation
- Transcript JSONL persistence
- Background auto-upgrade

### Phase B/C are follow-on increments gated on Phase A stability.

## 4. Desktop Security Policy

### Default Policy
- Subagents default-deny the `desktop` toolset.
- `desktop` cannot be obtained via `toolsets=["desktop"]` in the call.
- `desktop` cannot be obtained via parent toolset inheritance.

### Allow Conditions (ALL must be met)
1. `agent_config.capabilities` contains `desktop_control`.
2. `subagent_profile.toolsets` explicitly includes `desktop`.
3. `subagent_profile.blocked_tools` blocks: `terminal`, `send_message`, `memory`, `delegate_task`, and all write-file tools.

### Desktop-Capable Agent Constraints
- A desktop-capable subagent must NOT simultaneously have: `terminal`, `send_message`, `memory`, `delegate_task`.
- This is enforced by the `blocked_tools` requirement in the profile.

## 5. MCP Toolset Inheritance Boundary

### Legacy `role` Path
- Old `role=leaf|orchestrator` path preserves existing `inherit_mcp_toolsets` behavior.
- `_preserve_parent_mcp_toolsets()` continues to work for backward compatibility.

### New `agent_id` Path
- Default: MCP toolsets are NOT inherited from the parent agent.
- MCP toolsets are only granted when EITHER:
  - `subagent_profile.toolsets` explicitly includes a `mcp-*` toolset or its alias.
  - `subagent_profile.inherit_mcp_toolsets` is explicitly `true`.
- `required_mcp_servers` only checks MCP server availability — it does NOT auto-grant MCP tool permissions.

### Rationale
- The existing `_preserve_parent_mcp_toolsets()` adds back all parent MCP toolsets when narrowing child toolsets. For the new `agent_id` profile path, this would bypass registry-intended permission narrowing.

## 6. Future Capability Gates

These capabilities are documented for future phases but NOT implemented in MVP:

| Capability | Gate Condition |
|---|---|
| `isolation="worktree"` | Phase C, after worktree path audit passes |
| `run_in_background` | Phase B, after readonly isolation stable |
| Transcript JSONL | Phase C, after worktree stable |
| Coordinator/swarm | Phase C, after Phase A/B stable |
| `send_message(subagent_id, ...)` | Post-Phase C, requires agent loop redesign |

## 7. EventLog Extension

### Phase A (Implemented)
- `subagent.started`
- `subagent.completed`
- `subagent.failed`
- `subagent.interrupted`

### Phase B (Conditional)
- `subagent.backgrounded`

### Reserved (Future, NOT in MVP acceptance criteria)
- `subagent.send_message`
- `swarm.task_claimed`
- `swarm.task_reassigned`
- `coordinator.notification_received`

## 8. Key Design Principles

1. **Incremental within existing files**: All changes happen inside `delegate_tool.py`, `agent_router.py`, `session_event_log.py`. No new lifecycle modules.
2. **Toolsets can only narrow, never widen**: Effective toolsets = profile ∩ requested ∩ parent, minus globally blocked.
3. **Fail-closed**: Unknown agent_id → error. Missing profile → error. git status uncertain → refuse worktree deletion.
4. **Backward compatible**: Old `role=leaf|orchestrator` calls continue to work unchanged.
5. **Single source of truth**: `agent-registry.json` is the authoritative agent capability source.
