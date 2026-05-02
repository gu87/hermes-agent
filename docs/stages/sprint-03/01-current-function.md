# Sprint 03 — 当前功能

## 新增能力

### 1. 结构化记忆元数据

每条记忆条目现在支持 YAML frontmatter 元数据：

| 字段 | 可选值 | 默认 |
|------|--------|------|
| `type` | user_preference / project_context / feedback_rule / working_principle / memory | memory |
| `scope` | global / project / session | global |
| `confidence` | high / medium / low | medium |
| `source` | user / inferred / feedback | inferred |
| `last_verified_at` | ISO timestamp | 空（写入时自动填充） |

### 2. 向后兼容

旧格式条目（无 frontmatter）自动获得默认元数据：`type=memory, scope=global, confidence=medium, source=inferred`。

### 3. Scope 注入过滤

系统提示注入时按 scope 分层过滤：
- `global`：最多 20 条，跨项目始终生效
- `project`：最多 30 条，当前 git repo 生效
- `session`：最多 20 条，当前会话生效
- 按 `last_verified_at` 倒序，超限时取最近 N 条

### 4. Review Gate 接入 Memory

- `matches_user_preferences`：自动从 type=user_preference/feedback_rule 的记忆填充
- `matches_project_context`：自动从 type=project_context/working_principle 的记忆填充
- 有记忆时的 LLM 检查自动标记为通过

## 已有能力（继承 Sprint 0-2）

- Sprint 0：9 大类已有能力
- Sprint 1：Task Card + Minimal Event Log
- Sprint 2：Review Gate + 静态审查模板
