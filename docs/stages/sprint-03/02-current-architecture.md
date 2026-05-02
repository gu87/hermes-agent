# Sprint 03 — 当前架构

## 新增/修改模块

```
hermes-agent/
  tools/
    memory_tool.py       ← 重构：MemoryEntry + parse_entry + format_entry + scope 过滤
  agent/
    review_templates.py  ← 修改：新增 matches_user_preferences / matches_project_context
    review_gate.py       ← 修改：populate_llm_checks_from_memory()
  run_agent.py           ← 修改：Review Gate 调用传入 Memory 数据
```

## 记忆条目存储格式

```
---
type: user_preference
scope: global
confidence: high
source: user
last_verified_at: "2026-05-03T10:00:00Z"
---
用户偏好简洁、直接的表达，不喜欢啰嗦的解释。
§
---
type: feedback_rule
scope: project
confidence: high
source: feedback
---
不要在策略文档中使用要点列表。
```

## Scope 注入流程

```
System Prompt Builder
  → MemoryStore.format_for_system_prompt_scoped()
    → _parse_entries() → List[MemoryEntry]
    → filter by scope
      ├── project: ≤30 entries, sorted by last_verified_at desc
      ├── global: ≤20 entries, sorted by last_verified_at desc
      └── session: ≤20 entries (in-memory, not persisted)
    → _render_scope_blocks()
  → Injected into system prompt
```

## Review Gate + Memory 流程

```
ReviewGate.check()
  → populate_llm_checks_from_memory()
    → matches_user_preferences:
        from user_preference + feedback_rule entries
    → matches_project_context:
        from project_context + working_principle entries
  → LLM checks with memory evidence → pass=True
  → Score improves if previously pending
```
