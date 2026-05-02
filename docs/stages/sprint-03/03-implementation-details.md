# Sprint 03 — 实现细节

## 1. tools/memory_tool.py 重构

### 新增数据结构

```python
class MemoryEntry:
    __slots__ = ("body", "type", "scope", "confidence", "source", "last_verified_at")
    # 从 entry_text 解析，body 是去除 frontmatter 后的纯文本
    # raw_text 属性重建完整的 frontmatter + body
```

### 新增函数

- `parse_entry(entry_text) → (metadata: dict, body: str)` — 解析 YAML frontmatter
- `format_entry(metadata, body) → str` — 序列化为 frontmatter + body
- `MemoryEntry(entry_text)` — 包装构造函数

### MemoryStore 新增方法

- `_parse_entries(target) → List[MemoryEntry]` — 批量解析
- `get_entries_for_scope(target, scope, limit) → List[MemoryEntry]` — scope 过滤
- `_render_scope_blocks(target) → str` — 分 scope 渲染
- `format_for_system_prompt_scoped(target) → Optional[str]` — scope 过滤的快照

### 修改的方法

- `add()` — 接受 `metadata` 参数，自动加 frontmatter
- `_success_response()` — 返回中添加 `entries_meta`
- `load_from_disk()` — 保持兼容

### memory_tool() 函数

新增参数：`entry_type`, `scope`, `confidence`, `source`
新增 action: `read`（查看所有条目及元数据）

### MEMORY_SCHEMA

新增属性：`entry_type`, `scope`, `confidence`, `source`
新增 enum 值：action 增加 `read`

## 2. agent/review_gate.py 新增

### populate_llm_checks_from_memory()

```python
def populate_llm_checks_from_memory(llm_checks, memory_entries):
    # user_preference + feedback_rule → matches_user_preferences
    # project_context + working_principle → matches_project_context
    # Returns updated llm_checks with pass=True + evidence
```

### check() 健壮性改进

传入的 `llm_check_results` 现在经过 normalize：确保每条检查有 `id`, `question`, `pass`, `evidence`, `type` 字段。

## 3. agent/review_templates.py 新增

通用模板新增两个 LLM 检查：
- `matches_user_preferences`：是否符合用户（Gu）的已知偏好？
- `matches_project_context`：是否符合当前项目（Hermes）的上下文和规则？

## 4. run_agent.py 修改

Review Gate 调用处（line 13401）新增 memory 集成：
```python
if memory_store is not None:
    mem_entries = memory_store._parse_entries("user")
    llm_results = self._review_gate.populate_llm_checks_from_memory(...)
    ...
review_result = self._review_gate.check(..., llm_check_results=llm_results)
```

## 5. 向后兼容保证

- 旧格式条目（无 frontmatter）→ `parse_entry()` 返回 DEFAULT_METADATA
- `format_entry()` 仅在元数据非默认值时添加 frontmatter
- 现有 `format_for_system_prompt()` 行为不变
- 新方法 `format_for_system_prompt_scoped()` 是可选增强
