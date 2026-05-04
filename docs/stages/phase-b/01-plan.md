# Phase B: Readonly Isolation、标准结果、后台只读接口 — 执行计划

Date: 2026-05-04
Status: 已完成

## 目标

1. 实现 `readonly` isolation，强制剥离写入工具
2. 统一 `delegate_task` result entry
3. 实现后台子 Agent 的只读状态接口
4. `isolation="worktree"` 返回明确未实现错误

## 修改文件

| 文件 | 说明 |
|---|---|
| `tools/delegate_tool.py` | 增加 isolation 参数、readonly 工具剥离、标准 result entry、status/output 接口 |
| `tests/tools/test_delegate_phase_b.py` | Phase B 专项测试（23 个） |
| `docs/stages/phase-b/*` | 本文档 |

## 未实现（延期到 Phase C）

- `run_in_background`: 自动后台化。原因：需要独立的长期后台 executor 和线程模型改造，风险较高。当前只添加了 schema 参数，返回标识"计划 Phase C 实现"。显式后台可在 Phase C 与 worktree 一起实现。
- `send_message(subagent_id, message)`: 不在 Phase B 范围。

## 关键实现决策

1. **readonly 剥离**: 移除 `terminal` toolset，并从其他 toolsets 中标记 `write_file`、`patch` 等为 blocked
2. **read_only 自动 readonly**: 仅在没有显式 isolation 参数时自动启用
3. **worktree 错误**: 返回明确的 tool error，不静默降级
4. **result entry 标准化**: 所有必要字段现在都在返回结果中
