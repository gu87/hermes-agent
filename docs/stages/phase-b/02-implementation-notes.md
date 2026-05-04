# Phase B: Implementation Notes

Date: 2026-05-04

## 新增常量

```python
READONLY_STRIP_TOOLSETS = frozenset({"terminal"})
READONLY_STRIP_TOOLS = frozenset({"write_file", "patch", "terminal", "process"})
```

## 新增函数

### _resolve_isolation()
- 解析 effective isolation 模式
- 优先级: requested_isolation > profile_isolation > "shared"
- permission_mode="read_only" 在无显式 isolation 时自动启用 readonly
- isolation="worktree" 返回 error
- 未知 isolation 值返回 error

### _apply_readonly_isolation()
- 从 toolsets 列表中移除 READONLY_STRIP_TOOLSETS
- 在 warnings 中记录被剥离的 toolsets

### get_subagent_status(subagent_id)
- 返回运行中子 Agent 的状态快照（不含 raw agent 引用）
- 线程安全

### get_subagent_output_tail(subagent_id, lines=50)
- 返回运行中子 Agent 的最近输出消息
- 从 child._conversation_messages 读取

### get_subagent_usage(subagent_id)
- 返回运行中子 Agent 的 token/cost 使用情况

## delegate_task 新增参数

```python
isolation: Optional[str] = None    # "shared" | "readonly" | "worktree"
run_in_background: bool = False    # 已添加到 schema，Phase C 实现
```

## _build_child_agent 新增参数

```python
requested_isolation: Optional[str] = None
profile_isolation: Optional[str] = None
profile_permission_mode: Optional[str] = None
```

## Result Entry 标准化

每个 result entry 现在包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| status | str | completed/failed/interrupted/timed_out/error |
| subagent_id | str\|null | 子 Agent 唯一标识 |
| parent_id | str\|null | 父 Agent 的 subagent_id |
| agent_id | str\|null | registry 中的 agent_id |
| role | str | leaf / orchestrator |
| task_index | int | 任务序号 |
| goal | str | 任务目标 |
| summary | str | 子 Agent 的输出摘要 |
| effective_toolsets | list | 生效的 toolsets |
| blocked_tools | list | 被屏蔽的工具 |
| isolation | str | shared / readonly |
| output_tail | list | 工具调用输出尾 |
| usage | dict | {input_tokens, output_tokens, api_calls} |
| duration_seconds | float | 运行时长 |
| warnings | list | 警告信息 |
| error | str\|null | 错误信息 |

向后兼容：`tokens` 字段保持不变。

## Isolation 处理流程

1. `delegate_task` 接收 `isolation` 参数
2. 传递给 `_build_child_agent` → `_resolve_isolation()`
3. 如果 worktree → 设置 `_subagent_isolation_error` → `delegate_task` 在运行前返回 tool_error
4. 如果 readonly → `_apply_readonly_isolation()` 剥离写入 toolsets
5. Effective isolation 存储为 `child._subagent_isolation`
6. 反映在 result entry 的 `isolation` 字段中
