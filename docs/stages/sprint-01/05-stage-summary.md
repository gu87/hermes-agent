# Sprint 01 阶段总结

## 1. 本阶段目标

建立 Hermes 2.8 的基础骨架：Task Card（结构化任务定义）+ Minimal Event Log（生命周期可追溯）。

## 2. 本阶段完成内容

- ✅ 新增 `agent/task_card.py`：TaskCard dataclass + JSON 序列化 + 磁盘存储
- ✅ 新增 `agent/session_event_log.py`：EventLog + SQLite events.db + 7 种事件类型
- ✅ 修改 `run_agent.py`：3 处集成点（import、TaskCard 创建、完成事件写入）
- ✅ 手动测试验证：TaskCard 创建/保存/加载、EventLog 写入/查询
- ✅ 编译验证：AIAgent 导入成功、集成代码存在于正确方法中
- ✅ 基线测试：12,094 passed（无新增失败）

## 3. 当前功能

```
用户输入
  → TaskCard.create()         ← 结构化任务定义
  → save_task_card()          ← 持久化到 ~/.hermes/task_cards/{id}.json
  → log_task_created()        ← 记录创建事件
  → log_status_changed(pending→running)
  → log_execution_started()
  → [Agent 执行...]
  → 完成时:
    → log_execution_completed() / log_execution_failed()
    → log_status_changed(running→completed/failed/partial)
    → save_task_card()        ← 更新最终状态
```

## 4. 当前架构

新增 2 个 agent 模块 + 修改 1 个核心文件：

```
hermes-agent/
  agent/
    task_card.py           ← 新增：TaskCard + CompiledIntent + ExecutionPlan + AcceptanceCriteria
    session_event_log.py   ← 新增：SessionEvent + EventLog + SQLite events.db
  run_agent.py             ← 修改：3 处集成点
```

## 5. 关键实现细节

- **TaskCard**：7 个顶层字段 + 3 个嵌套 dataclass，JSON 序列化，文件存储
- **EventLog**：SQLite WAL 模式，append-only，thread-safe，7 种事件类型
- **events.db**：独立于 state.db，`events` 表 + 3 个索引
- **错误隔离**：TaskCard/EventLog 失败不阻断主对话流程
- **版本控制**：TaskCard 每次写入递增 version，updated_at 刷新

## 6. 新增/修改文件

| 文件 | 改动类型 | 行数（约） |
|------|---------|-----------|
| `agent/task_card.py` | **新增** | 168 |
| `agent/session_event_log.py` | **新增** | 269 |
| `run_agent.py` | **修改** | +46 |

## 7. 已知问题

1. TaskCard 的 compiled_intent 尚不智能填充（需后续 LLM 推理）
2. Event Log 只有生命周期事件，无决策事件（Sprint 5 扩展）
3. TaskCard 未传播给子 Agent（Sprint 4 解决）
4. events.db 无压缩/清理机制（Sprint 5 考虑）

## 8. 下一阶段 (Sprint 2) 建议

**目标**：Review Gate + 静态审查模板

**关键任务**：
1. 新增 `agent/review_gate.py`：ReviewGate 类 + rule-based 检查 + 阻断规则
2. 新增 `agent/review_templates.py`：按 task_category 硬编码审查模板
3. 修改 `run_agent.py`：在 execution_completed 之前插入 ReviewGate.check()
4. 新增 `reviewing` 状态到状态流转中

**风险**：
- 需要在 `run_conversation()` 中找到正确的检查点插入位置
- Review Gate 阻断规则（特别是 70 分阈值 + revision_count < 1）需要仔细测试

## 9. 验收结果

- [x] `~/.hermes/task_cards/{task_id}.json` 存在且格式正确
- [x] `~/.hermes/events.db` 中有 `task_created` 事件
- [x] 任务状态变化 → 有 `status_changed` 事件，payload 含 from_status/to_status/reason/actor
- [x] TaskCard JSON schema 包含 compiled_intent、execution_plan、acceptance_criteria
- [x] Event payload 必需字段校验生效

## 10. Git 提交说明

```bash
git add .
git commit -m "feat: add Task Card and Minimal Event Log (Sprint 1)"
```
