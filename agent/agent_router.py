"""Agent Router — task-to-agent routing for Hermes 2.8.

Routes user tasks to the appropriate agent based on task_category, required
capabilities, and risk level. Supports pipeline mode and fallback.

Design:
- Default routing maps task_category → capability → routing_rules → agent_id
- Override conditions allow the main agent to deviate from defaults
- Fallback ensures degraded but complete delivery when sub-agents fail
- Router does NOT call agents; it provides a plan that the main agent executes
- Primary source of truth: ~/.hermes/config/agent-registry.json
"""

import json
import logging
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

VALID_RISK_LEVELS = {"low", "medium", "high"}
VALID_ROUTING_MODES = {"self_execute", "single_agent", "pipeline", "review_only"}

# ── Default routing rules ──
# Maps task_category → (mode, capability, reason)

DEFAULT_ROUTES: Dict[str, Dict[str, Any]] = {
    "architecture_review": {
        "mode": "self_execute",
        "capability": None,
        "reason": "架构评审类任务的核心价值在主 Agent 的判断力和对 Hermes 全局的把握",
    },
    "code_analysis": {
        "mode": "pipeline",
        "capability": "file_reading_analysis",
        "reason": "代码分析先由当前可用研究/阅读 agent 收集材料，再由主 Agent 分析判断",
    },
    "brand_strategy": {
        "mode": "self_execute",
        "capability": None,
        "reason": "品牌策略类任务需要主 Agent 的策略判断力",
    },
    "visual_design": {
        "mode": "single_agent",
        "capability": "creative_direction",
        "reason": "视觉设计任务适合分发给图像/PPT Agent",
    },
    "research": {
        "mode": "single_agent",
        "capability": "web_research",
        "reason": "Kimi 已降级，调研默认由 Hermes 内部推理/当前主控能力处理",
    },
    "document": {
        "mode": "pipeline",
        "capability": "file_reading_analysis",
        "reason": "文档类任务先收集素材，再由主 Agent 撰写整合；Kimi 不再是默认素材收集 agent",
    },
    "prompt_design": {
        "mode": "self_execute",
        "capability": None,
        "reason": "提示词设计需要理解整体系统上下文",
    },
    "other": {
        "mode": "self_execute",
        "capability": None,
        "reason": "未分类任务默认主 Agent 自行处理",
    },
}

# ── task_category → required capability mapping ──
# Used when no capability is specified directly in DEFAULT_ROUTES.

TASK_CATEGORY_REQUIRED_CAPABILITY: Dict[str, Optional[str]] = {
    "architecture_review": None,
    "code_analysis": "file_reading_analysis",
    "brand_strategy": "strategy_decision",
    "visual_design": "creative_direction",
    "research": "web_research",
    "document": "file_reading_analysis",
    "prompt_design": "strategy_decision",
    "other": None,
}

# ── Fallback agent capability registry (used only when registry file is unavailable) ──

_FALLBACK_AGENT_CAPABILITIES: Dict[str, Dict[str, Any]] = {
    "kimi": {
        "name": "Kimi (deprecated/manual-only)",
        "capabilities": ["web_search", "file_reading", "information_synthesis", "multi_file_analysis"],
        "use_when": ["用户明确要求 Kimi 且本地仍可用"],
        "constraint": "Kimi CLI 到期后不可作为默认研究路由",
    },
    "claude": {
        "name": "Claude Code",
        "capabilities": ["file_modification", "script_execution", "git_operations", "code_review"],
        "use_when": ["需要改代码", "需要执行脚本", "需要具体文件修改"],
        "constraint": "执行器而非思考器——收到的 prompt 需是明确的修改指令",
    },
    "codex": {
        "name": "Codex CLI",
        "capabilities": ["file_modification", "script_execution", "git_operations", "code_review", "implementation_planning"],
        "use_when": ["需要 Codex 风格代码推理", "代码审查", "Claude Code 的执行备选"],
    },
    "openclaw": {
        "name": "OpenClaw",
        "capabilities": ["desktop_control", "app_operation", "screenshot", "macos_automation"],
        "use_when": ["需要 macOS 桌面控制", "截图", "打开 App、点击、输入"],
        "constraint": "外部桌面 operator，结果需要截图或命令输出确认",
    },
    "hermes-internal": {
        "name": "Hermes 内部推理",
        "capabilities": ["analysis", "decision_making", "creative_planning", "prioritization"],
        "use_when": ["需要策略判断", "需要方案设计", "需要决策"],
    },
}


def _load_agent_registry() -> dict:
    """Load agent registry from the runtime config directory.

    Uses ``get_hermes_home()`` as the single source of truth for path resolution.
    Falls back to a minimal built-in registry if the file is unavailable.
    """
    try:
        from hermes_constants import get_hermes_home
    except Exception:
        def get_hermes_home() -> Path:
            return Path.home() / ".hermes"

    registry_path = get_hermes_home() / "config" / "agent-registry.json"
    try:
        with open(registry_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        logger.warning("Cannot load agent-registry.json (%s), using fallback", exc)
        return {"agents": {}, "routing_rules": {}}


def _get_agents_map(registry: dict) -> dict:
    """Extract the agents map from a loaded registry."""
    return registry.get("agents", {})


def _get_routing_rules(registry: dict) -> dict:
    """Extract routing rules from a loaded registry."""
    return registry.get("routing_rules", {})


@dataclass
class RoutingDecision:
    """Result of the routing decision process."""

    mode: str  # self_execute | single_agent | pipeline | review_only
    agents: List[str] = field(default_factory=list)
    reason: str = ""
    routing_basis: List[str] = field(default_factory=list)
    overrides: List[str] = field(default_factory=list)
    fallback_plan: Optional[str] = None
    risk_level: str = "low"

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["delegation_reason"] = d.get("reason", "")
        return d


class AgentRouter:
    """Routes tasks to agents based on task_category, capabilities, and risk.

    Reads agent capabilities from ~/.hermes/config/agent-registry.json.
    """

    def __init__(self):
        self._registry: Optional[dict] = None
        self._agents_map: Optional[dict] = None
        self._routing_rules: Optional[dict] = None

    def _ensure_registry(self) -> None:
        """Lazy-load the registry on first use."""
        if self._registry is None:
            self._registry = _load_agent_registry()
            self._agents_map = _get_agents_map(self._registry)
            self._routing_rules = _get_routing_rules(self._registry)

    def route(
        self,
        task_category: str,
        user_agent_override: Optional[str] = None,
        required_capabilities: Optional[List[str]] = None,
        risk_level: str = "low",
    ) -> RoutingDecision:
        """Determine the execution plan for a task.

        Args:
            task_category: From TaskCard.compiled_intent.task_category
            user_agent_override: User explicitly said "use X"
            required_capabilities: Capabilities the task requires
            risk_level: "low" | "medium" | "high"

        Returns:
            RoutingDecision with mode, agents, reason, routing_basis, overrides
        """
        self._ensure_registry()

        default = DEFAULT_ROUTES.get(task_category, DEFAULT_ROUTES["other"])
        mode = default["mode"]
        agents: List[str] = []
        reason = default["reason"]
        routing_basis = ["task_category_default"]
        overrides: List[str] = []
        user_override_locked = False

        normalized_risk = (risk_level or "low").strip().lower()
        if normalized_risk not in VALID_RISK_LEVELS:
            logger.warning("Invalid risk_level=%r, falling back to low", risk_level)
            normalized_risk = "low"
            routing_basis.append("invalid_risk_level")
            overrides.append("risk_level_normalized")

        # Resolve default agent from registry routing_rules via capability
        capability = default.get("capability")
        if capability and self._routing_rules:
            routed_agent = self._routing_rules.get(capability)
            if routed_agent and routed_agent in self._agents_map:
                agents = [routed_agent]
            else:
                routing_basis.append("registry_missing_route")

        # Override 1: user explicitly specifies an agent
        if user_agent_override:
            if user_agent_override in self._agents_map:
                mode = "single_agent"
                agents = [user_agent_override]
                reason = f"用户显式指定使用 {user_agent_override}"
                routing_basis.append("user_override")
                overrides.append("user_override")
                user_override_locked = True
            else:
                logger.warning("Unknown agent override: %s", user_agent_override)
                available = list(self._agents_map.keys())
                return RoutingDecision(
                    mode="review_only",
                    agents=[],
                    reason=f"用户指定的 Agent 不存在: {user_agent_override}",
                    routing_basis=routing_basis + ["user_override_unknown"],
                    overrides=overrides + ["user_override_unknown"],
                    fallback_plan=f"请确认可用 agent: {available}",
                    risk_level=normalized_risk,
                )

        # Override 2: required capabilities not covered by default route
        if required_capabilities:
            default_caps = set()
            for a in agents:
                agent_config = self._agents_map.get(a, {})
                caps = agent_config.get("capabilities", [])
                default_caps.update(caps)
            missing = set(required_capabilities) - default_caps
            if missing:
                if user_override_locked:
                    reason += f"; 用户指定 agent 缺少能力 {sorted(missing)}，未自动追加其他 agent"
                    routing_basis.append("required_capability_gap")
                    overrides.append("capability_gap_for_user_override")
                else:
                    added_agents = []
                    remaining = set(missing)
                    while remaining:
                        best_name = None
                        best_cover = set()
                        for name, info in self._agents_map.items():
                            if name in agents or name in added_agents:
                                continue
                            cover = set(info.get("capabilities", [])) & remaining
                            if len(cover) > len(best_cover):
                                best_name = name
                                best_cover = cover
                        if not best_name or not best_cover:
                            logger.warning(
                                "No agent combination covers required capabilities: %s (available: %s)",
                                remaining, list(self._agents_map.keys()),
                            )
                            reason += f"; 未找到覆盖能力 {sorted(remaining)} 的 agent"
                            routing_basis.append("required_capability_uncovered")
                            overrides.append("capability_gap")
                            break
                        added_agents.append(best_name)
                        remaining -= best_cover

                    if added_agents:
                        agents.extend(added_agents)
                        if mode == "self_execute":
                            mode = "single_agent" if len(agents) == 1 else "pipeline"
                        elif mode == "single_agent" and len(agents) > 1:
                            mode = "pipeline"
                        reason += f"; 需要 {sorted(missing)} 能力，增加 {added_agents}"
                        routing_basis.append("required_capability")
                        overrides.append("capability_expansion")

        # Override 3: high risk → force pipeline + review gate
        if normalized_risk == "high":
            mode = "pipeline"
            # Preserve explicit/expanded agents and add a review/research agent if needed.
            if not agents and self._routing_rules:
                research_agent = self._routing_rules.get("web_research")
                if research_agent and research_agent in self._agents_map:
                    agents = [research_agent]
                else:
                    agents = list(self._agents_map.keys())[:1]
            elif self._routing_rules:
                review_agent = self._routing_rules.get("strategy_decision") or self._routing_rules.get("web_research")
                if review_agent and review_agent in self._agents_map and review_agent not in agents:
                    agents.append(review_agent)
            reason += "; 高风险任务，强制走 pipeline + Review Gate"
            routing_basis.append("risk_level")
            overrides.append("risk_escalation")

        if mode not in VALID_ROUTING_MODES:
            logger.warning("Invalid routing mode=%r, falling back to self_execute", mode)
            mode = "self_execute"
            agents = []
            routing_basis.append("invalid_mode")
            overrides.append("mode_normalized")

        if mode in ("single_agent", "pipeline") and not agents:
            logger.warning("Routing mode %s had no agents; falling back to self_execute", mode)
            reason += "; 路由未找到可用 agent，降级为主 Agent 自行处理"
            mode = "self_execute"
            routing_basis.append("empty_agent_fallback")
            overrides.append("empty_agent_fallback")

        if mode == "single_agent" and len(agents) > 1:
            mode = "pipeline"
            routing_basis.append("multi_agent_pipeline")
            overrides.append("single_agent_promoted_to_pipeline")

        # Determine fallback plan
        fallback_plan = self._fallback_for(mode, agents)

        return RoutingDecision(
            mode=mode,
            agents=agents,
            reason=reason,
            routing_basis=routing_basis,
            overrides=overrides,
            fallback_plan=fallback_plan,
            risk_level=normalized_risk,
        )

    # ── Fallback ──

    def _fallback_for(self, mode: str, agents: List[str]) -> str:
        if self._agents_map is None:
            self._ensure_registry()
        if mode == "self_execute":
            return "主 Agent 自行完成"
        if mode == "single_agent" and agents:
            agent_name = self._agents_map.get(agents[0], {}).get("display_name", agents[0]) if self._agents_map else agents[0]
            return f"{agent_name} 失败 → 主 Agent 接管，标记信息不足"
        if mode == "pipeline":
            return "Pipeline 任一步失败 → 主 Agent 接管，Task Card status=partial 或 blocked"
        return "主 Agent 接管"

    # ── Validation ──

    @staticmethod
    def validate_delegation_prompt(agent_name: str, prompt: str) -> List[str]:
        """Validate a delegation prompt for a target agent.

        Returns list of issues (empty = valid).
        """
        issues = []
        normalized = (agent_name or "").replace("_", "-").lower()
        if normalized in {"claude", "claude-code", "codex"}:
            has_specific = bool(
                re.search(r'\.(py|js|ts|json|yaml|yml|md|toml|cfg)\b', prompt)
                or re.search(r'第?\s*\d+\s*[行列个条]', prompt)
                or re.search(r'\b\w+\.\w+\b', prompt)
                or re.search(r'(改为|改成|修改为|设置为|从.*改为)\s*\S', prompt)
            )
            if not has_specific:
                label = "Codex CLI" if normalized == "codex" else "Claude Code"
                if len(prompt) < 30:
                    issues.append(f"{label} prompt 太短，需要具体的文件/函数/行号修改描述")
                else:
                    issues.append(
                        f"{label} prompt 缺少具体修改信息（文件路径、行号、函数名、参数修改等）"
                    )
        elif normalized == "openclaw":
            has_desktop_target = bool(
                re.search(r'(截图|点击|输入|打开|切换|滚动|按|坐标|窗口|屏幕|App|应用|desktop|screenshot|click|type)', prompt, re.I)
            )
            if not has_desktop_target:
                issues.append("OpenClaw prompt 缺少明确桌面动作或目标（如截图、点击、输入、打开 App）")
        elif normalized == "kimi":
            if len(prompt.strip()) < 20:
                issues.append("Kimi 已降级且 prompt 太短；仅在用户明确要求 Kimi 且任务自包含时使用")
        return issues

    # ── Helpers ──

    def get_available_agents(self) -> List[str]:
        self._ensure_registry()
        return list(self._agents_map.keys()) if self._agents_map else []

    def get_agent_info(self, name: str) -> Optional[Dict[str, Any]]:
        self._ensure_registry()
        if self._agents_map:
            return self._agents_map.get(name)
        return _FALLBACK_AGENT_CAPABILITIES.get(name)
