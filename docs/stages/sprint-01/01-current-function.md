# Sprint 01 — 当前功能

## 新增能力

### 1. Task Card（任务卡片）

每个用户请求进入后，系统自动创建结构化任务卡片，包含：

- **任务身份**：`task_id`（UUID）、`schema_version`（2.8.0）、`session_id`
- **意图理解**：`compiled_intent.real_task`、`task_category`、`assumptions`、`must_keep`、`must_avoid`、`success_criteria`
- **执行计划**：`execution_plan.mode`（self_execute/single_agent/pipeline/review_only）、`agents`、`delegation_reason`
- **验收标准**：`acceptance_criteria.auto_checkable`、`human_judgment`、`user_preference_check`
- **状态快照**：`status`（pending/running/reviewing/completed/failed/blocked/partial）、`result_summary`、`review_result`
- **版本控制**：每次写入递增 `version`，防止并发覆盖

存储路径：`~/.hermes/task_cards/{task_id}.json`

### 2. Event Log（事件日志）

独立的 SQLite 数据库 `~/.hermes/events.db`，append-only 写入，记录 Task 生命周期事件：

| 事件类型 | 触发时机 | 必需 payload 字段 |
|---------|---------|------------------|
| `task_created` | Task Card 创建 | task_category, execution_mode |
| `task_updated` | Task Card 字段更新 | updated_fields |
| `status_changed` | 状态流转 | from_status, to_status, actor |
| `execution_started` | 开始执行 | — |
| `execution_completed` | 执行完成 | result_type |
| `execution_failed` | 执行失败 | error_type, error_message, retryable |
| `artifact_created` | 产出物创建 | artifact_type, artifact_path |

### 3. 集成的端到端流程

```
用户输入
  → TaskCard.create()         ← 结构化任务定义
  → save_task_card()          ← 持久化到磁盘
  → log_task_created()        ← 记录创建事件
  → log_status_changed(pending→running)
  → log_execution_started()
  → [Agent 执行任务...]
  → log_execution_completed() / log_execution_failed()
  → log_status_changed(running→completed/failed)
  → save_task_card()          ← 更新最终状态和结果
```

## 已有能力（继承 Sprint 0）

同 Sprint 00 审计报告中的 9 大类能力，本轮未做删减。
