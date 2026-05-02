# Sprint 03 — 已知问题

## 1. session scope 未完全实现

- **现状**：`session` scope 已定义且有注入上限（20 条），但无独立的 session 记忆存储。当前所有记忆写入文件（MEMORY.md / USER.md），不区分 session。
- **影响**：标记为 `scope: session` 的记忆不会在会话结束后自动清理。
- **对策**：后续 Sprint 可在 MemoryStore 中添加内存 session 层。

## 2. project scope 依赖 git repo 检测

- **现状**：`scope: project` 的语义是"当前 git repo"，但未实现 git repo 自动检测来区分 project vs global。
- **影响**：project 和 global scope 在当前实现中等效（都从文件读取）。
- **对策**：后续可集成 `git rev-parse --show-toplevel` 检测项目根目录，按路径存储 project 记忆。

## 3. frontmatter 解析不处理嵌套 YAML

- **现状**：使用简单的 `key: value` 行解析，不支持嵌套结构或 YAML 列表。
- **影响**：元数据字段足够简单（都是标量值），当前解析够用。但如果未来需要嵌套元数据，需要升级。
- **对策**：当前够用，后续可切换为 `yaml.safe_load()`。

## 4. 记忆写入策略在 schema description 中

- **现状**：写入策略（用户说"记住"→直接写入、2次同类偏好→建议等）仅作为 tool schema description 的建议文本，不在代码中强制执行。
- **影响**：依赖 Agent 遵循 schema 中的指南，无自动化 enforcement。
- **对策**：这是设计意图——策略是 Agent 行为指南，不是代码约束。

## 5. format_for_system_prompt_scoped 未自动启用

- **现状**：`format_for_system_prompt_scoped()` 已实现，但 `format_for_system_prompt()` 保持原有行为（不分 scope）。调用方需显式使用 scoped 版本。
- **影响**：Scope 过滤需要 prompt_builder 或其他调用方主动切换。
- **对策**：后续可逐步迁移调用方到 scoped 版本。

## 对 Sprint 4 的影响

- Review Gate 已接入 Memory，LLM 检查可自动填充
- Memory 结构化元数据为 Agent Router（Sprint 4）提供偏好参考
- Scope 机制为后续权限管理提供基础
