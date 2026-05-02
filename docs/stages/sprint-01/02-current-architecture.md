# Sprint 01 — 当前架构

## 架构变更

### 新增模块

```
hermes-agent/
  agent/
    task_card.py          ← TaskCard dataclass + JSON 序列化 + 存储
    session_event_log.py  ← EventLog + SQLite events.db + append-only 写入
```

### 修改模块

```
hermes-agent/
  run_agent.py            ← 集成 TaskCard 创建 + 事件日志写入
```

## 架构图（更新后）

```
User Input (CLI / Gateway)
        │
        ▼
  AIAgent.run_conversation()
        │
        ├─► TaskCard.create()           ← 结构化任务
        │     └─ save_task_card()       ← → ~/.hermes/task_cards/{id}.json
        │
        ├─► EventLog.log_task_created() ← 写入创建事件
        ├─► EventLog.log_status_changed(pending→running)
        ├─► EventLog.log_execution_started()
        │     └─ INSERT INTO events     ← → ~/.hermes/events.db
        │
        ├─► [Agent 执行循环...]
        │     ├─ LLM 调用
        │     ├─ Tool 执行
        │     └─ 对话管理
        │
        └─► 完成 / 失败时：
              ├─ EventLog.log_execution_completed/failed()
              ├─ EventLog.log_status_changed(running→completed/failed)
              └─ save_task_card()       ← 更新状态 + result_summary
```

## TaskCard 数据模型

```
TaskCard
├── schema_version: "2.8.0"
├── task_id: UUID
├── session_id: str
├── created_at / updated_at: ISO timestamp
├── version: int (每次写入递增)
├── raw_user_request: str
├── compiled_intent
│   ├── real_task: str
│   ├── task_category: str (枚举)
│   ├── assumptions: [str]
│   ├── must_keep: [str]
│   ├── must_avoid: [str]
│   └── success_criteria: [str]
├── execution_plan
│   ├── mode: str (枚举)
│   ├── agents: [str]
│   └── delegation_reason: str
├── acceptance_criteria
│   ├── auto_checkable: [str]
│   ├── human_judgment: [str]
│   └── user_preference_check: [str]
├── status: str (枚举)
├── result_summary: str?
├── review_result: dict?
├── routing_basis: [str] (Sprint 4 使用)
└── fallback_used: str? (Sprint 4 使用)
```

## EventLog 数据模型

```
SessionEvent
├── event_id: UUID
├── session_id: str
├── task_id: str
├── type: str (枚举)
├── timestamp: float (Unix time)
├── source: str (model/user/system)
└── payload: dict (类型特定)

events.db schema:
  events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    timestamp REAL NOT NULL,
    source TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )
  + idx_events_task_id
  + idx_events_session_id
  + idx_events_timestamp
```

## 状态流转（当前 Sprint 1）

```
pending ──► running ──► completed
                 │
                 └──► failed
                 └──► partial (interrupted)
```

Sprint 2 将引入 `reviewing` 状态和 Review Gate 阻断机制。

## 存储架构（更新后）

```
~/.hermes/
  state.db               ← sessions + messages (已有)
  events.db              ← 新增：事件日志
  task_cards/            ← 新增：Task Card JSON
    {task_id}.json
  sessions/*.jsonl       ← 会话记录 (已有)
  memories/              ← 记忆文件 (已有)
  config.yaml            ← 全局配置 (已有)
```
