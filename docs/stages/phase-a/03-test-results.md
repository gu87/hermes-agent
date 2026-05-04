# Phase A: Test Results

Date: 2026-05-04
Status: 全部通过

## 测试运行命令

```bash
cd ~/.hermes/hermes-agent
python -m pytest \
  tests/tools/test_delegate_phase_a.py \
  tests/agent/test_agent_router.py \
  tests/agent/test_session_event_log.py \
  tests/tools/test_delegate_toolset_scope.py \
  -v -c /dev/null
```

## 结果摘要

| 测试文件 | 测试数 | 通过 | 失败 |
|---|---|---|---|
| `test_delegate_phase_a.py` | 26 | 26 | 0 |
| `test_agent_router.py` | 17 | 17 | 0 |
| `test_session_event_log.py` | 7 | 7 | 0 |
| `test_delegate_toolset_scope.py` (旧) | 5 | 5 | 0 |
| **合计** | **55** | **55** | **0** |

## 覆盖的测试场景

### Registry / Profile
- `_load_subagent_profile("kimi")` 能读取 registry
- `_load_subagent_profile("claude")` 能读取 registry
- 不存在的 agent_id 返回 ValueError
- agent 缺少 subagent_profile 返回 ValueError

### Desktop 安全
- desktop 双条件满足时放行
- 缺少 desktop_control capability 时拒绝
- profile 不含 desktop 时拒绝
- kimi (无 desktop_control) 即使请求 desktop 也拿不到
- desktop-capable agent 配置正确包含了 blocked_tools 约束

### 工具收窄
- profile ∩ parent：子 Agent 不能获得父 Agent 没有的工具
- profile ∩ requested ∩ parent：调用时 toolsets 只能进一步缩小
- parent 限制了工具的传递
- 不在 profile 内的工具无法通过 requested 获得

### MCP 继承
- agent_id 路径默认不继承父 Agent MCP toolsets
- `inherit_mcp_toolsets=true` 时才继承
- `inherit_mcp_toolsets="true"` (字符串) 不生效
- profile 显式包含 mcp-* 时才获得 MCP toolsets

### required_mcp_servers
- 空列表不产生警告
- 不可用的 MCP server 产生警告但不动态授予工具

### Blocked Tools
- DELEGATE_BLOCKED_TOOLS 始终包含
- GLOBAL_SUBAGENT_BLOCKED_TOOLS 始终包含
- profile.blocked_tools 合并进来
- 调用时 blocked_tools 只能增加

### AgentRouter
- self_execute 类别无 agent 路由
- research 通过 web_research → kimi 路由
- 未知类别 fallback 到 self_execute
- user_agent_override 有效 agent 生效
- user_agent_override 未知 agent 不崩溃
- 高风险任务强制 pipeline
- RoutingDecision.to_dict() 向后兼容
- get_available_agents() 从 registry 读取
- get_agent_info() 从 registry 读取
- required_capabilities 扩展 agent 列表
- TASK_CATEGORY_REQUIRED_CAPABILITY 完整覆盖所有 DEFAULT_ROUTES

### EventLog
- subagent.started/completed/failed/interrupted 事件常量定义正确
- 预留事件常量存在
- log_subagent_started 写入正确 payload
- log_subagent_completed 写入正确 payload
- log_subagent_failed 写入正确 payload
- log_subagent_interrupted 写入正确 payload
- 事件持久化并可读取

### 回归
- 旧 `test_delegate_toolset_scope.py` 全部通过
- delegate-v27.sh 未修改
