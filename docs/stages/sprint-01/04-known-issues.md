# Sprint 01 — 已知问题

## 1. 本 Sprint 限制

### 1.1 TaskCard 尚未自动补全 compiled_intent

- **现状**：`TaskCard.create()` 将 `real_task` 设为原始用户输入，`task_category` 固定为 `"other"`，`assumptions`/`must_keep`/`must_avoid`/`success_criteria` 为空列表。
- **原因**：意图补全（Intent Harness）不在 Sprint 1 范围。
- **影响**：TaskCard 当前只有结构，没有智能填充。后续 Sprint 可由 LLM 调用或主 Agent 推理填充。
- **对策**：主 Agent 在后续迭代中填充 compiled_intent 字段后调用 `save_task_card()`。

### 1.2 Event Log 只记录生命周期事件

- **现状**：Sprint 1 仅实现 7 种事件类型（task_created/updated/status_changed/execution_started/completed/failed/artifact_created）。
- **不做**：intent_inferred、dispatch_decision、quality_check、user_feedback、memory_candidate、tool_call/tool_result。
- **原因**：按工程方案，"Sprint 1 只做这些事件类型（只保证状态流转可追溯）"。
- **对策**：Sprint 5 扩展为完整决策日志。

### 1.3 TaskCard 未在子 Agent 传播

- **现状**：当主 Agent 使用 delegate_tool 生成子 Agent 时，TaskCard 不会传递给子 Agent。
- **影响**：子 Agent 任务无法在同一个 TaskCard 上下文中追踪。
- **对策**：Sprint 4（Agent Router / Pipeline）解决子任务关联。

### 1.4 events.db 不做事件压缩和跨 session 聚合

- **现状**：纯 append-only，无过期删除，无聚合查询。
- **影响**：长期运行后 events.db 可能持续增长。
- **对策**：Sprint 5 可考虑按时间清理策略；当前体量足够小。

## 2. 与工程方案的已知差异

### 2.1 payload 字段差异

工程方案中 `task_created` 的必需 payload 是 `["task_category", "raw_user_request_preview", "execution_mode"]`。实现中 `raw_user_request_preview` 不在必需列表中（保留为可选），以避免过于冗长的校验失败。该字段仍然在 `log_task_created()` 调用中传入。

### 2.2 Task Card 文件路径

工程方案指定 `~/.hermes/task_cards/{task_id}.json`。实现完全一致。

### 2.3 events.db 表结构与方案一致

`events` 表 schema 与工程方案中的 CREATE TABLE 语句完全一致，包括三个索引。

## 3. 遗留的 Sprint 0 已知问题

- run_agent.py 13,800+ 行，修改需持续谨慎
- 两套方案文档差异，以工程方案为准
- firecrawl/context MCP 仍未接入（Sprint 2 待定）

## 4. 对 Sprint 2 的影响

### 前置依赖确认

Sprint 2（Review Gate）需要：
- Task Card 结构 → ✅ Sprint 1 已提供
- Task Card 的 `review_result` 字段 → ✅ 已预留
- 状态流转 `pending → running → reviewing → completed` → ⚠️ 当前只有 `pending → running → completed`，Sprint 2 需新增 `reviewing` 状态

### 风险提示

- Sprint 2 需要在 `run_conversation()` 中插入 Review Gate 检查点（在 `execution_completed` 之前）
- Review Gate 的 `rule_checks` 需要读取 Task Card 字段，当前 TaskCard 结构已满足
- blocking 规则中的 `quality_score < 70 && revision_count < 1` 需要 Review Gate 实现后才生效
