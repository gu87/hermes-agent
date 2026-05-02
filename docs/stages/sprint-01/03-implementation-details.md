# Sprint 01 — 实现细节

## 1. agent/task_card.py

### 文件结构

- **TaskCard** dataclass：结构化任务卡片，schema version 2.8.0
- **CompiledIntent** dataclass：意图补全结果
- **ExecutionPlan** dataclass：执行计划
- **AcceptanceCriteria** dataclass：验收标准
- **save_task_card()**：JSON 序列化 + 写入 `~/.hermes/task_cards/{id}.json`
- **load_task_card()**：从文件读取反序列化
- **get_task_cards_dir()**：返回 task_cards 目录路径

### 关键实现点

- 向前兼容字段 `routing_basis` 和 `fallback_used` 预留给 Sprint 4
- `from_dict()` 容错处理缺失的嵌套对象（默认空对象）
- `create()` 工厂方法自动生成 UUID task_id 和 ISO 时间戳
- `save_task_card()` 自动更新 `updated_at` 和递增 `version`
- 写入失败不静默吞掉异常——让调用方处理

## 2. agent/session_event_log.py

### 文件结构

- **SessionEvent** dataclass：单条事件
- **EventLog** 类：SQLite 事件存储 + 便捷写入方法
- **SPRINT_1_EVENT_TYPES**：7 个事件类型常量
- **REQUIRED_PAYLOAD_KEYS**：每个事件类型的必需 payload 字段

### EventLog 便捷方法

```python
el = EventLog()

# 创建阶段
el.log_task_created(task_id, session_id, task_category, execution_mode)
el.log_status_changed(task_id, session_id, from_status, to_status, reason, actor)
el.log_execution_started(task_id, session_id)

# 完成阶段
el.log_execution_completed(task_id, session_id, result_type, artifact_count, turn_count)
el.log_execution_failed(task_id, session_id, error_type, error_message, retryable)

# 中间阶段
el.log_task_updated(task_id, session_id, updated_fields)
el.log_artifact_created(task_id, session_id, artifact_type, artifact_path)
```

### 关键实现点

- **Append-only**：只做 INSERT，无 UPDATE/DELETE
- **线程安全**：`threading.Lock()` 保护写入
- **SQLite WAL**：`PRAGMA journal_mode=WAL` + `PRAGMA synchronous=NORMAL`
- **独立数据库**：`events.db` 不混用 `state.db`
- **延迟连接**：`_get_conn()` 首次调用时才创建连接和初始化 schema
- **Payload 校验**：写入前检查必需字段，缺失抛 `ValueError`
- **查询方法**：`get_events_for_task()` / `get_events_for_session()` 用于验证和调试

## 3. run_agent.py 修改

### 改动位置 1：Import 添加

文件顶部（第 54 行附近）：
```python
from agent.task_card import TaskCard, save_task_card
from agent.session_event_log import EventLog
```

### 改动位置 2：EventLog 初始化

`AIAgent.__init__()` 中（第 1628 行附近，TodoStore 初始化之后）：
```python
self._event_log = EventLog()
```

### 改动位置 3：TaskCard 创建 + 事件写入

`AIAgent.run_conversation()` 中（第 10116 行附近，`effective_task_id` 设置之后、重试计数器重置之前）：
```python
try:
    task_card = TaskCard.create(
        user_request=persist_user_message or user_message,
        session_id=self.session_id,
    )
    save_task_card(task_card)
    self._current_task_card = task_card
    self._event_log.log_task_created(...)
    self._event_log.log_status_changed(pending→running)
    self._event_log.log_execution_started(...)
except Exception:
    logger.warning(...)
    self._current_task_card = None
```

- 失败不阻断主流程——TaskCard 是增强功能，不能成为单点故障
- 使用 `persist_user_message or user_message` 确保拿到最干净的用户输入

### 改动位置 4：完成/失败事件写入

`AIAgent.run_conversation()` 末尾（第 13540 行附近，`return result` 之前）：
```python
tc = getattr(self, "_current_task_card", None)
if tc is not None:
    try:
        if completed and not interrupted:
            # 成功路径
            el.log_execution_completed(...)
            el.log_status_changed(running→completed)
            tc.status = "completed"
        else:
            # 失败/中断路径
            el.log_execution_failed(...)
            el.log_status_changed(running→failed/partial)
            tc.status = "failed" | "partial"
        tc.result_summary = final_response[:500]
        save_task_card(tc)
    except Exception:
        logger.warning(...)
```

- 同样不阻断主流程
- `result_summary` 截断到 500 字符防止膨胀

## 4. 错误处理策略

| 场景 | 行为 |
|------|------|
| TaskCard 创建失败 | logger.warning，`_current_task_card = None`，主流程继续 |
| EventLog 写入失败 | 异常穿透到 try/except，logger.warning，不阻断 |
| save_task_card 失败 | 异常穿透到 try/except，logger.warning |
| events.db 连接失败 | 延迟连接首次报错，由调用方 try/except 捕获 |
| Payload 校验失败 | `ValueError` 直接抛出（编程错误，不应发生） |

## 5. 测试验证

手动验证项：
- [x] TaskCard.create() 生成正确 UUID 和 ISO 时间戳
- [x] save_task_card() 写入文件 → `~/.hermes/task_cards/{id}.json`
- [x] load_task_card() 可逆读回完整 TaskCard
- [x] EventLog 写入 2 条事件 → `get_events_for_task()` 返回 2 条
- [x] AIAgent 导入成功，`_event_log` 在 `__init__` 中初始化
- [x] `run_conversation` 源码中包含 TaskCard.create、log_task_created、log_execution_completed/failed
