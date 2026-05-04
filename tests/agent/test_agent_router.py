"""Tests for AgentRouter — registry-backed routing (Phase A)."""

import json
import os
from pathlib import Path

import pytest

from agent.agent_router import (
    AgentRouter,
    _load_agent_registry,
    _get_agents_map,
    _get_routing_rules,
    TASK_CATEGORY_REQUIRED_CAPABILITY,
)


def _write_test_registry(hermes_home: Path) -> Path:
    """Write a minimal test agent-registry.json for router tests."""
    config_dir = hermes_home / "config"
    config_dir.mkdir(exist_ok=True)
    registry = {
        "schema_version": "1.0",
        "agents": {
            "kimi": {
                "id": "kimi",
                "type": "researcher",
                "capabilities": ["web_search", "file_reading"],
            },
            "claude": {
                "id": "claude",
                "type": "file_executor",
                "capabilities": ["file_modification", "script_execution", "system_operations"],
            },
            "hermes-internal": {
                "id": "hermes-internal",
                "type": "analyst",
                "capabilities": ["analysis", "decision_making", "creative_planning"],
            },
            "deepseek-worker": {
                "id": "deepseek-worker",
                "type": "persistent_worker",
                "capabilities": ["background_execution", "file_operations"],
            },
        },
        "routing_rules": {
            "web_research": "kimi",
            "file_reading_analysis": "kimi",
            "file_modification": "claude",
            "script_execution": "claude",
            "strategy_decision": "hermes-internal",
            "creative_direction": "hermes-internal",
        },
    }
    path = config_dir / "agent-registry.json"
    path.write_text(json.dumps(registry))
    return path


@pytest.fixture
def hermetic_registry(_hermetic_environment):
    """Hermetic env with a test registry written to HERMES_HOME/config/."""
    hermes_home = Path(os.environ["HERMES_HOME"])
    _write_test_registry(hermes_home)
    yield hermes_home


class TestRegistryLoading:

    def test_load_registry_returns_dict(self, hermetic_registry):
        registry = _load_agent_registry()
        assert isinstance(registry, dict)
        assert "agents" in registry
        assert "routing_rules" in registry

    def test_get_agents_map(self):
        registry = {"agents": {"kimi": {"id": "kimi"}}, "routing_rules": {}}
        agents = _get_agents_map(registry)
        assert "kimi" in agents

    def test_get_routing_rules(self):
        registry = {"agents": {}, "routing_rules": {"web_research": "kimi"}}
        rules = _get_routing_rules(registry)
        assert rules["web_research"] == "kimi"


class TestRouting:

    def test_route_self_execute_category(self, hermetic_registry):
        router = AgentRouter()
        decision = router.route("architecture_review")
        assert decision.mode == "self_execute"
        assert decision.agents == []

    def test_route_research_uses_registry(self, hermetic_registry):
        router = AgentRouter()
        decision = router.route("research")
        assert decision.mode == "single_agent"
        assert "kimi" in decision.agents

    def test_route_unknown_category_self_execute(self, hermetic_registry):
        router = AgentRouter()
        decision = router.route("nonexistent_category")
        assert decision.mode == "self_execute"

    def test_user_override_valid_agent(self, hermetic_registry):
        router = AgentRouter()
        decision = router.route("research", user_agent_override="claude")
        assert decision.mode == "single_agent"
        assert decision.agents == ["claude"]
        assert "user_override" in decision.routing_basis

    def test_user_override_unknown_agent(self, hermetic_registry):
        router = AgentRouter()
        decision = router.route("research", user_agent_override="nonexistent")
        # Falls back to default routing — kimi for research
        assert decision.mode == "single_agent"
        assert "kimi" in decision.agents

    def test_high_risk_escalation(self, hermetic_registry):
        router = AgentRouter()
        decision = router.route("architecture_review", risk_level="high")
        assert decision.mode == "pipeline"
        assert "risk_level" in decision.routing_basis

    def test_routing_decision_to_dict(self, hermetic_registry):
        router = AgentRouter()
        decision = router.route("document")
        d = decision.to_dict()
        assert "mode" in d
        assert "agents" in d
        assert "delegation_reason" in d

    def test_get_available_agents(self, hermetic_registry):
        router = AgentRouter()
        agents = router.get_available_agents()
        assert "kimi" in agents
        assert "claude" in agents

    def test_get_agent_info(self, hermetic_registry):
        router = AgentRouter()
        info = router.get_agent_info("kimi")
        assert info is not None
        assert info.get("id") == "kimi"

    def test_get_agent_info_unknown(self, hermetic_registry):
        router = AgentRouter()
        info = router.get_agent_info("nonexistent")
        assert info is None

    def test_required_capabilities_expand_agents(self, hermetic_registry):
        router = AgentRouter()
        decision = router.route(
            "research",
            required_capabilities=["system_operations"],
        )
        # system_operations is in claude's capabilities
        assert "claude" in decision.agents

    def test_registry_missing_route(self, hermetic_registry):
        """visual_design: capability creative_direction maps to hermes-internal, should work."""
        router = AgentRouter()
        decision = router.route("visual_design")
        # creative_direction → hermes-internal exists in routing_rules
        assert "hermes-internal" in decision.agents

    def test_task_category_required_capability_complete(self):
        from agent.agent_router import DEFAULT_ROUTES
        for cat in DEFAULT_ROUTES:
            assert cat in TASK_CATEGORY_REQUIRED_CAPABILITY, \
                f"Missing capability mapping for {cat}"
