# Phase B: Test Results

Date: 2026-05-04
Status: 全部通过

## 测试运行命令

```bash
cd ~/.hermes/hermes-agent
python -m pytest \
  tests/tools/test_delegate_phase_b.py \
  tests/tools/test_delegate.py \
  tests/tools/test_delegate_toolset_scope.py \
  tests/tools/test_delegate_phase_a.py \
  tests/agent/test_agent_router.py \
  tests/agent/test_session_event_log.py \
  -v -c /dev/null
```

## 结果摘要

| 测试文件 | 测试数 | 通过 | 失败 |
|---|---|---|---|
| `test_delegate_phase_b.py` (新增) | 23 | 23 | 0 |
| `test_delegate.py` (回归) | ~120 | ~120 | 0 |
| `test_delegate_toolset_scope.py` (回归) | 5 | 5 | 0 |
| `test_delegate_phase_a.py` (回归) | 26 | 26 | 0 |
| `test_agent_router.py` (回归) | 17 | 17 | 0 |
| `test_session_event_log.py` (回归) | 7 | 7 | 0 |
| **合计** | **198** | **198** | **0** |

## 覆盖的测试场景

### Isolation 解析
- 默认 shared
- 显式 readonly
- 显式 shared 覆盖 read_only permission
- worktree 返回未实现错误
- read_only permission 自动启用 readonly（无显式 isolation 时）
- 未知 isolation 值返回错误
- profile isolation 作为 fallback

### Readonly 剥离
- terminal toolset 被移除
- file/web/browser/vision 保留
- 空 toolsets 不报错
- 仅 terminal 时返回空列表
- 常量定义正确

### 标准 Result Entry
- MagicMock 值被 sanitize 为 None/空值
- 标准字段列表完整定义

### 状态接口
- get_subagent_status 不存在的 ID 返回 None
- get_subagent_status 返回正确快照（不含 agent 引用）
- get_subagent_output_tail 不存在的 ID 返回 None
- get_subagent_usage 不存在的 ID 返回 None
- interrupt_subagent 不存在的 ID 返回 False
- interrupt_subagent 找到时调用 agent.interrupt()

### 回归
- 所有 Phase A 测试通过
- 所有旧 delegate 测试通过
- delegate-v27.sh 未修改
