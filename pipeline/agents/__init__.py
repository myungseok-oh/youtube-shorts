"""채널별 에이전트 라우터

채널 ID로 해당 채널의 에이전트 인스턴스를 반환한다.
agents/ch_XXXX.py 파일이 있으면 로드, 없으면 BaseAgent 반환.
"""
from __future__ import annotations
import importlib
import os

from pipeline.agents.base_agent import BaseAgent

# 채널별 에이전트 캐시 (channel_id → BaseAgent instance)
_agent_cache: dict[str, BaseAgent] = {}


def get_agent(channel_id: str | None = None) -> BaseAgent:
    """채널 ID로 에이전트 인스턴스 반환.

    - channel_id가 None이면 기본 BaseAgent 반환
    - agents/ch_XXXX.py 파일이 있으면 해당 모듈의 Agent 클래스 사용
    - 없으면 BaseAgent 반환
    """
    if not channel_id:
        return BaseAgent()

    if channel_id in _agent_cache:
        return _agent_cache[channel_id]

    # 채널 ID에서 모듈명 생성: ch-0001 → ch_0001
    module_name = channel_id.replace("-", "_")

    try:
        mod = importlib.import_module(f"pipeline.agents.{module_name}")
        agent = mod.Agent()
        _agent_cache[channel_id] = agent
        return agent
    except (ModuleNotFoundError, AttributeError):
        # 채널 전용 에이전트 파일 없음 → 기본 BaseAgent
        agent = BaseAgent()
        _agent_cache[channel_id] = agent
        return agent


def invalidate_cache(channel_id: str | None = None):
    """에이전트 캐시 무효화. 채널 설정 변경 후 호출."""
    if channel_id:
        _agent_cache.pop(channel_id, None)
    else:
        _agent_cache.clear()


def create_channel_agent_file(channel_id: str) -> str | None:
    """새 채널용 에이전트 파일 생성. 이미 존재하면 스킵.

    Returns:
        생성된 파일 경로 또는 None (이미 존재)
    """
    module_name = channel_id.replace("-", "_")
    agents_dir = os.path.dirname(os.path.abspath(__file__))
    file_path = os.path.join(agents_dir, f"{module_name}.py")

    if os.path.isfile(file_path):
        return None  # 이미 존재

    template = f'''"""채널 에이전트: {channel_id}

BaseAgent를 상속하여 이 채널만의 프롬프트/규칙을 오버라이드할 수 있습니다.
수정해도 다른 채널에 영향 없음.

오버라이드 가능 항목:
  - SCRIPT_RULES: 대본 작성 규칙
  - ROUNDUP_RULES: 라운드업 대본 규칙
  - IMAGE_PROMPT_STYLE: 이미지 프롬프트 스타일 지침
  - 모든 public 메서드 (parse_request, generate_all_in_one 등)
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):
    # 채널별 커스텀이 필요하면 아래 상수/메서드를 오버라이드
    # SCRIPT_RULES = """채널 전용 대본 규칙..."""
    # IMAGE_PROMPT_STYLE = """채널 전용 이미지 프롬프트 스타일..."""
    pass
'''

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(template)

    # 캐시 무효화
    invalidate_cache(channel_id)

    return file_path
