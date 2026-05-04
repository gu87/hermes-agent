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
        "reason": "代码分析需先由 Kimi 搜集代码/文档，再由主 Agent 分析判断",
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
        "reason": "调研类任务适合 K2-thinking 的长上下文搜索能力",
    },
    "document": {
        "mode": "pipeline",
        "capability": "file_reading_analysis",
        "reason": "文档类任务先由 Kimi 收集素材，再主 Agent 撰写整合",
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
        "name": "Kimi (K2-thinking)",
        "capabilities": ["web_search", "file_reading", "information_synthesis", "multi_file_analysis"],
        "use_when": ["需要搜索网页", "需要读长文", "需要整理信息", "需要调研"],
    },
    "claude": {
        "name": "Claude Code",
        "capabilities": ["file_modification", "script_execution", "git_operations", "code_review"],
        "use_when": ["需要改代码", "需要执行脚本", "需要具体文件修改"],
        "constraint": "执行器而非思考器——收到的 prompt 需是明确的修改指令",
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
            else:
                logger.warning("Unknown agent override: %s", user_agent_override)

        # Override 2: required capabilities not covered by default route
        if required_capabilities:
            default_caps = set()
            for a in agents:
                agent_config = self._agents_map.get(a, {})
                caps = agent_config.get("capabilities", [])
                default_caps.update(caps)
            missing = set(required_capabilities) - default_caps
            if missing and mode != "self_execute":
                matched = False
                for name, info in self._agents_map.items():
                    if name in agents:
                        continue
                    agent_caps = set(info.get("capabilities", []))
                    if missing.issubset(agent_caps):
                        agents.append(name)
                        reason += f"; 需要 {missing} 能力，增加 {name}"
                        routing_basis.append("required_capability")
                        overrides.append("capability_expansion")
                        matched = True
                        break
                if not matched:
                    logger.warning(
                        "No single agent covers all required capabilities: %s (available: %s)",
                        missing, list(self._agents_map.keys()),
                    )

        # Override 3: high risk → force pipeline + review gate
        if risk_level == "high" and mode == "self_execute":
            mode = "pipeline"
            # Try to route via web_research capability
            if self._routing_rules:
                research_agent = self._routing_rules.get("web_research")
                if research_agent and research_agent in self._agents_map:
                    agents = [research_agent]
                else:
                    agents = list(self._agents_map.keys())[:1]
            reason += "; 高风险任务，强制走 pipeline + Review Gate"
            routing_basis.append("risk_level")
            overrides.append("risk_escalation")

        # Determine fallback plan
        fallback_plan = self._fallback_for(mode, agents)

        return RoutingDecision(
            mode=mode,
            agents=agents,
            reason=reason,
            routing_basis=routing_basis,
            overrides=overrides,
            fallback_plan=fallback_plan,
            risk_level=risk_level,
        )

    # ── Fallback ──

    def _fallback_for(self, mode: str, agents: List[str]) -> str:
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
        if agent_name == "claude" or agent_name == "claude_code":
            has_specific = bool(
                re.search(r'\.(py|js|ts|json|yaml|yml|md|toml|cfg)\b', prompt)
                or re.search(r'第?\s*\d+\s*[行列个条]', prompt)
                or re.search(r'\b\w+\.\w+\b', prompt)
                or re.search(r'(改为|改成|修改为|设置为|从.*改为)\s*\S', prompt)
            )
            if not has_specific:
                if len(prompt) < 30:
                    issues.append("Claude Code prompt 太短，需要具体的文件/函数/行号修改描述")
                else:
                    issues.append(
                        "Claude Code prompt 缺少具体修改信息（文件路径、行号、函数名、参数修改等）"
                    )
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
