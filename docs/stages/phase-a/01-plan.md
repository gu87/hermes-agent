# Phase A: Registry 打通与安全修复 — 执行计划

Date: 2026-05-04
Status: 已完成

## 目标

1. 消除 AgentRouter 与 agent-registry.json 的双真相
2. 给 delegate_task 增加 agent_id，从 registry 读取子 Agent profile
3. 实现工具权限"只能收窄，不能扩大"
4. 默认阻止子 Agent 继承 desktop 工具
5. 增加子 Agent 生命周期事件
6. 保持旧调用完全兼容

## 修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `agent/agent_router.py` | 源码 | 删除硬编码 AGENT_CAPABILITIES，改为从 registry 读取 |
| `tools/delegate_tool.py` | 源码 | 增加 agent_id、profile 解析、工具收窄、desktop 安全 |
| `agent/session_event_log.py` | 源码 | 增加 subagent.started/completed/failed/interrupted 事件 |
| `~/.hermes/config/agent-registry.json` | 运行态 | 为每个 agent 增加 subagent_profile |
| `tests/tools/test_delegate_phase_a.py` | 测试 | Phase A 专项测试 |
| `tests/agent/test_agent_router.py` | 测试 | AgentRouter registry 测试 |
| `tests/agent/test_session_event_log.py` | 测试 | EventLog 子 Agent 事件测试 |

## 不改的文件

- `delegate-v27.sh` — 未修改，不受影响
- `agent-monitor.py` — 未修改
- `src/harness/*` — 不新建
- `tools/subagents/*` — 不新建

## registry.json 备份

- 备份路径: `~/.hermes/config/agent-registry.json.backup-20260504-123119`
- 修改内容: 为 claude、kimi、hermes-internal、deepseek-worker 增加了 `subagent_profile` 字段
- schema_version: 1.0 → 1.1

## 关键实现决策

1. **工具收窄**: profile ∩ requested ∩ parent，desktop 默认剥离
2. **desktop 双条件**: capabilities 含 desktop_control + profile.toolsets 含 desktop
3. **MCP 默认不继承**: agent_id 路径只有 profile 显式包含 mcp-* 或 inherit_mcp_toolsets=true 才允许
4. **required_mcp_servers**: 只做可用性检查，不自动授予工具权限
5. **agent_id / role 互斥**: 同时传入返回 tool error
6. **事件写入不中断主任务**: EventLog 写入失败只记录 logger warning
