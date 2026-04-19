"""영상 메타데이터 생성"""
from __future__ import annotations
import json
import os
import re


# 주제 키워드 → 해시태그 매핑
_KEYWORD_TAGS = {
    "경제": ["경제뉴스", "경제", "경제이슈"],
    "환율": ["환율", "원달러", "달러"],
    "코스피": ["코스피", "주식", "증시"],
    "코스닥": ["코스닥", "주식", "증시"],
    "증시": ["증시", "주식"],
    "금리": ["금리", "기준금리", "한은"],
    "부동산": ["부동산", "아파트", "집값"],
    "물가": ["물가", "인플레이션"],
    "국제": ["국제뉴스", "세계뉴스", "글로벌"],
    "미국": ["미국", "미국뉴스"],
    "중국": ["중국", "중국경제"],
    "일본": ["일본", "일본뉴스"],
    "전쟁": ["전쟁", "국제정세"],
    "이란": ["이란", "중동"],
    "우크라이나": ["우크라이나", "러시아"],
    "트럼프": ["트럼프", "미국정치"],
    "AI": ["AI", "인공지능", "테크"],
    "반도체": ["반도체", "삼성전자"],
    "유가": ["유가", "원유", "에너지"],
    "비트코인": ["비트코인", "암호화폐", "코인"],
}

_DEFAULT_TAGS = ["Shorts"]


def _extract_topic_tags(topic: str) -> list[str]:
    """주제에서 관련 해시태그 추출."""
    tags = []
    for keyword, keyword_tags in _KEYWORD_TAGS.items():
        if keyword in topic:
            tags.extend(keyword_tags)
    # 중복 제거, 순서 유지
    seen = set()
    result = []
    for t in tags:
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result


def _parse_channel_hashtags(instructions: str) -> list[str]:
    """채널 지침의 ## 해시태그 섹션에서 고정 해시태그를 파싱.

    예: '## 해시태그\\n#건강상식 #건강정보 #건강팁 #Shorts + 내용 관련 5개'
    → ['건강상식', '건강정보', '건강팁', 'Shorts']
    """
    if not instructions:
        return []
    # ## 해시태그 섹션 찾기
    m = re.search(r'^##\s*해시태그\s*\n(.+?)(?=\n#|\Z)', instructions,
                  re.MULTILINE | re.DOTALL)
    if not m:
        return []
    section = m.group(1).strip()
    # 첫 줄에서 #태그들 추출 ("+ 내용 관련 N개" 이전까지)
    first_line = section.split("\n")[0]
    # "+ " 이후 제거
    if "+" in first_line:
        first_line = first_line[:first_line.index("+")]
    tags = re.findall(r'#([\w가-힣]+)', first_line)
    return tags


def generate_metadata(job_topic: str, script: list[dict],
                      output_dir: str, youtube_title: str = "",
                      brand: str = "이슈60초",
                      hashtags_override: list[str] | None = None,
                      channel_instructions: str = "") -> dict:
    """영상 메타데이터(제목, 설명, 해시태그) 생성.

    Args:
        hashtags_override: AI 생성 해시태그 (script_json의 hashtags).
        channel_instructions: 채널 지침 텍스트. ## 해시태그 섹션 파싱용.

    우선순위: hashtags_override > channel_instructions 해시태그 > 폴백(brand + DEFAULT + topic)
    """
    sentences = [s["text"] for s in script]
    description_body = " ".join(sentences[:3]) + "..."

    if hashtags_override:
        # AI가 생성한 태그 그대로 사용 (# 제거, 중복 제거)
        seen = set()
        all_tags = []
        for t in hashtags_override:
            t = str(t).lstrip("#").strip()
            if t and t not in seen:
                seen.add(t)
                all_tags.append(t)
    elif channel_instructions:
        # 채널 지침에서 해시태그 파싱
        channel_tags = _parse_channel_hashtags(channel_instructions)
        if channel_tags:
            # 주제 키워드 태그도 추가
            topic_tags = _extract_topic_tags(job_topic)
            seen = set()
            all_tags = []
            for t in channel_tags + topic_tags:
                if t not in seen:
                    seen.add(t)
                    all_tags.append(t)
        else:
            topic_tags = _extract_topic_tags(job_topic)
            all_tags = [brand] + _DEFAULT_TAGS + topic_tags
    else:
        topic_tags = _extract_topic_tags(job_topic)
        all_tags = [brand] + _DEFAULT_TAGS + topic_tags

    hashtags = " ".join(f"#{t}" for t in all_tags)

    title = youtube_title[:100] if youtube_title else f"{brand} | {job_topic}"[:100]

    ai_notice = "⚠️ 이 영상은 AI 도구를 활용하여 제작되었습니다. (음성: AI TTS, 이미지: AI 생성, 대본: AI 요약)"

    metadata = {
        "title": title,
        "description": (
            f"{job_topic}\n\n"
            f"{description_body}\n\n"
            f"{hashtags}\n\n"
            f"{ai_notice}"
        ),
        "tags": all_tags,
    }

    meta_path = os.path.join(output_dir, "metadata.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    return metadata
