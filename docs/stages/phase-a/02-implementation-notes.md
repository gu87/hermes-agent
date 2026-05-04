# Phase A: Implementation Notes

Date: 2026-05-04

## AgentRouter 改造

### 删除硬编码
- 删除 `AGENT_CAPABILITIES` 作为单一真相来源
- 保留 `_FALLBACK_AGENT_CAPABILITIES` 仅当 registry 文件不可用时使用
- `DEFAULT_ROUTES` 改为使用 `capability` 字段替代直接 `agents` 列表

### 新增函数
- `_load_agent_registry()` — 从 `HERMES_HOME/config/agent-registry.json` 加载
- `_get_agents_map()` — 提取 agents 字典
- `_get_routing_rules()` — 提取 routing_rules
- `TASK_CATEGORY_REQUIRED_CAPABILITY` — task_category → capability 映射

### 路由流程
1. `task_category` → `DEFAULT_ROUTES[cat].capability`
2. `capability` → `routing_rules[capability]` → `agent_id`
3. Override: `user_agent_override` > `required_capabilities` > `risk_level`
4. Fallback: 始终返回 `RoutingDecision`，即使路由失败

### 兼容性
- `RoutingDecision` 字段和 `to_dict()` 行为保持不变
- `validate_delegation_prompt` 保持静态方法接口
- `get_available_agents()` 和 `get_agent_info()` 从 registry 读取

## delegate_tool 改造

### 新增全局常量
- `GLOBAL_SUBAGENT_BLOCKED_TOOLSETS = frozenset({"desktop"})`
- `GLOBAL_SUBAGENT_BLOCKED_TOOLS = frozenset({"send_message", "memory", "execute_code"})`

### 新增 Helper 函数
- `_load_agent_registry()` — 加载 registry JSON
- `_load_subagent_profile(agent_id)` — 返回 (agent_config, subagent_profile)，失败抛 ValueError
- `_desktop_allowed(agent_config, profile)` — 双条件检查
- `_should_inherit_mcp_toolsets_for_profile(profile)` — 检查 inherit_mcp_toolsets
- `_resolve_effective_toolsets(...)` — profile ∩ requested ∩ parent，默认剥离 desktop
- `_resolve_effective_blocked_tools(...)` — DELEGATE + GLOBAL + profile + requested 的并集
- `_check_mcp_server_availability(profile, warnings)` — 可用性检查，不自动授予
- `_try_log_subagent_event(...)` — 安全写入事件，失败不中断

### delegate_task 新增参数
- `agent_id: Optional[str]` — 与 role 互斥
- `blocked_tools: Optional[List[str]]` — 只能增加 profile 的 blocked

### _build_child_agent 新增参数
- `agent_id`, `agent_config`, `profile`, `requested_blocked_tools`
- 当 agent_id 传入时使用 `_resolve_effective_toolsets()` / `_resolve_effective_blocked_tools()`
- 当 agent_id 未传入时使用旧逻辑（完全兼容）

### _run_single_child 事件集成
- 子 Agent 注册后写 `subagent.started`
- 正常完成写 `subagent.completed`
- 失败写 `subagent.failed`
- 中断写 `subagent.interrupted`
- 所有事件写入通过 `_try_log_subagent_event` 包裹，失败不中断

### Result Entry 新增字段
- `subagent_id`, `agent_id`, `role`
- `effective_toolsets`, `blocked_tools`
- `isolation`（Phase A 固定为 "shared" 或从 profile 读取）
- `warnings`

## session_event_log 改造

### 新增事件类型
- `subagent.started` — payload: subagent_id, goal_preview (required)
- `subagent.completed` — payload: subagent_id, status (required)
- `subagent.failed` — payload: subagent_id, error (required)
- `subagent.interrupted` — payload: subagent_id, reason (required)

### 预留事件类型（不在 MVP 验收）
- `subagent.backgrounded`
- `subagent.send_message`
- `swarm.task_claimed`
- `swarm.task_reassigned`
- `coordinator.notification_received`

### 新增工厂方法
- `log_subagent_started(...)`, `log_subagent_completed(...)`
- `log_subagent_failed(...)`, `log_subagent_interrupted(...)`

## agent-registry.json 扩展

### schema_version: 1.0 → 1.1

### 每个 agent 新增 subagent_profile:
```json
{
  "subagent_profile": {
    "model": "default",
    "toolsets": [...],
    "blocked_tools": [...],
    "permission_mode": "ask|read_only",
    "isolation": "shared|readonly",
    "allow_background": false,
    "required_mcp_servers": []
  }
}
```

### 具体 Profile:
- **claude**: toolsets=[file,terminal], blocked=[delegate_task,send_message,memory], permission=ask
- **kimi**: toolsets=[file,web], blocked=[write_file,patch,delegate_task,terminal,...], permission=read_only, isolation=readonly
- **hermes-internal**: toolsets=[file], blocked=[write_file,patch,terminal,delegate_task,...], permission=read_only, isolation=readonly
- **deepseek-worker**: toolsets=[file], blocked=[delegate_task,send_message,memory], permission=ask

## 未实现项（Phase B/C）
- `isolation="worktree"` — 返回错误提示
- `run_in_background` — 参数未添加到 schema
- Transcript JSONL — 未实现
- Coordinator/swarm — 未实现
- `send_message(subagent_id, ...)` — 未实现
