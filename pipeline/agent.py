"""Claude Code 에이전트 — 하위 호환 래퍼

기존 코드(runner.py, app.py 등)의 import를 깨지 않으면서
채널별 에이전트(pipeline/agents/)로 위임한다.

사용법:
  # 기존 방식 (하위 호환) — 기본 BaseAgent 사용
  from pipeline.agent import parse_request, generate_all_in_one

  # 새 방식 — 채널별 에이전트 사용
  from pipeline.agents import get_agent
  agent = get_agent("ch-0001")
  agent.generate_all_in_one(...)
"""
from __future__ import annotations

# ── 공통 유틸리티 re-export (기존 import 호환) ──────────────────
from pipeline.agent_common import (  # noqa: F401
    _find_claude_bin, _clean_env, is_claude_active,
    _run_claude, _run_gemini,
    _repair_json, _parse_response, _parse_topics,
    _sync_visual_plan, _normalize_gemini_result,
    _build_visual_plan_from_slides, _build_synopsis_from_script,
    _build_script_schema, _build_roundup_schema,
    _is_specific_topic, _extract_count,
    _estimate_slide_durations, _count_slide_sentences,
    _image_style_instruction, _image_size_instruction,
)

# ── 채널별 에이전트 라우터 ──────────────────
from pipeline.agents import get_agent  # noqa: F401
from pipeline.agents.base_agent import BaseAgent

# 기본 에이전트 인스턴스 (channel_id 없을 때 사용)
_default_agent = BaseAgent()

# ── 기본 상수 re-export (기존 import 호환) ──────────────────
DEFAULT_SCRIPT_RULES = _default_agent.SCRIPT_RULES
DEFAULT_ROUNDUP_RULES = _default_agent.ROUNDUP_RULES
DEFAULT_IMAGE_PROMPT_STYLE = _default_agent.IMAGE_PROMPT_STYLE
SCRIPT_JSON_SCHEMA = _build_script_schema(
    default_script_rules=DEFAULT_SCRIPT_RULES,
    default_roundup_rules=DEFAULT_ROUNDUP_RULES,
)


# ── 하위 호환 함수 래퍼 ──────────────────────────────
# 기존 코드에서 `from pipeline.agent import generate_all_in_one` 형태로
# 사용하는 곳을 깨지 않기 위한 래퍼. channel_id가 없으면 BaseAgent 사용.

def parse_request(request: str, instructions: str = "",
                  trend_context: str = "",
                  recent_topics: list[str] | None = None,
                  skip_web_search: bool = False,
                  channel_id: str | None = None) -> list[str]:
    agent = get_agent(channel_id) if channel_id else _default_agent
    return agent.parse_request(request, instructions, trend_context,
                               recent_topics, skip_web_search)


def generate_script(topic: str, instructions: str, brand: str = "이슈60초",
                    channel_format: str = "single",
                    script_rules: str = "", roundup_rules: str = "",
                    has_outro: bool = False,
                    use_subagent: bool = False,
                    channel_id: str | None = None) -> dict:
    agent = get_agent(channel_id) if channel_id else _default_agent
    return agent.generate_script(topic, instructions, brand,
                                 channel_format, script_rules, roundup_rules,
                                 has_outro, use_subagent)


def generate_synopsis(topic: str, instructions: str, brand: str = "이슈60초",
                      channel_format: str = "single",
                      has_outro: bool = False,
                      use_subagent: bool = False,
                      news_context: str = "",
                      channel_id: str | None = None) -> dict:
    agent = get_agent(channel_id) if channel_id else _default_agent
    return agent.generate_synopsis(topic, instructions, brand,
                                   channel_format, has_outro,
                                   use_subagent, news_context)


def generate_visual_plan(topic: str, synopsis: dict,
                         prompt_style: str = "",
                         layout: str = "full",
                         image_style: str = "mixed",
                         scene_references: str = "",
                         bg_display_mode: str = "zone",
                         bg_media_type: str = "auto",
                         auto_bg_source: str = "",
                         first_slide_single_bg: bool = False,
                         channel_id: str | None = None) -> list[dict]:
    agent = get_agent(channel_id) if channel_id else _default_agent
    return agent.generate_visual_plan(topic, synopsis, prompt_style,
                                      layout, image_style, scene_references,
                                      bg_display_mode, bg_media_type,
                                      auto_bg_source, first_slide_single_bg)


def generate_script_from_plan(topic: str, synopsis: dict,
                              visual_plan: list[dict],
                              instructions: str,
                              brand: str = "이슈60초",
                              channel_format: str = "single",
                              script_rules: str = "",
                              roundup_rules: str = "",
                              has_outro: bool = False,
                              channel_id: str | None = None) -> dict:
    agent = get_agent(channel_id) if channel_id else _default_agent
    return agent.generate_script_from_plan(topic, synopsis, visual_plan,
                                           instructions, brand,
                                           channel_format, script_rules,
                                           roundup_rules, has_outro)


def _validate_with_claude(draft_json: dict, instructions: str, brand: str,
                          topic: str,
                          prompt_style: str = "", layout: str = "full",
                          image_style: str = "mixed", scene_references: str = "",
                          bg_display_mode: str = "zone",
                          bg_media_type: str = "auto",
                          channel_format: str = "single",
                          has_outro: bool = False,
                          script_rules: str = "",
                          roundup_rules: str = "",
                          channel_id: str | None = None) -> dict:
    agent = get_agent(channel_id) if channel_id else _default_agent
    return agent._validate_with_claude(draft_json, instructions, brand, topic,
                                       prompt_style, layout,
                                       image_style, scene_references,
                                       bg_display_mode, bg_media_type,
                                       channel_format, has_outro,
                                       script_rules, roundup_rules)


def generate_all_in_one(topic: str, instructions: str, brand: str = "이슈60초",
                        channel_format: str = "single",
                        has_outro: bool = False,
                        use_subagent: bool = False,
                        prompt_style: str = "",
                        layout: str = "full",
                        image_style: str = "mixed",
                        scene_references: str = "",
                        bg_display_mode: str = "zone",
                        bg_media_type: str = "auto",
                        script_rules: str = "",
                        roundup_rules: str = "",
                        skip_web_search: bool = False,
                        gemini_api_key: str = "",
                        zone_ratio: str = "3:4:3",
                        news_context: str = "",
                        channel_id: str | None = None) -> dict:
    agent = get_agent(channel_id) if channel_id else _default_agent
    return agent.generate_all_in_one(topic, instructions, brand,
                                     channel_format, has_outro,
                                     use_subagent,
                                     prompt_style, layout, image_style,
                                     scene_references, bg_display_mode,
                                     bg_media_type, script_rules,
                                     roundup_rules, skip_web_search,
                                     gemini_api_key, zone_ratio,
                                     news_context)


def generate_image_prompts(topic: str, slides: list[dict],
                           prompt_style: str = "",
                           layout: str = "full",
                           image_style: str = "mixed",
                           scene_references: str = "",
                           bg_display_mode: str = "zone",
                           sentences: list[dict] | None = None,
                           bg_media_type: str = "auto",
                           auto_bg_source: str = "",
                           first_slide_single_bg: bool = False,
                           channel_id: str | None = None) -> list[str]:
    agent = get_agent(channel_id) if channel_id else _default_agent
    return agent.generate_image_prompts(topic, slides, prompt_style,
                                        layout, image_style, scene_references,
                                        bg_display_mode, sentences,
                                        bg_media_type, auto_bg_source,
                                        first_slide_single_bg)
