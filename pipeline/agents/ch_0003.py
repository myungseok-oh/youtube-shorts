"""채널 에이전트: ch-0003 (1분 상식)

에버그린 상식/교양 콘텐츠.
채널 지침(DB)에서 컨셉/톤/스타일 관리.
에이전트는 구조적 규칙(슬라이드 수, media 타입 등)만 담당.
"""
from pipeline.agents.base_agent import BaseAgent


class Agent(BaseAgent):

    SCRIPT_RULES = """\
- 이것은 에버그린 상식/교양 콘텐츠이다. 뉴스가 아니므로 news_date는 제작일 기준.
- 모든 슬라이드 media: video 고정
- bg_type: broll (전체 동영상 배경)
- 나머지 대본 규칙, 톤, 슬라이드 구성은 채널 지침을 따른다."""
