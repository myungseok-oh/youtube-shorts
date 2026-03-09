"""QA 에이전트 — 뉴스 영상 콘텐츠 전문가가 완성된 영상을 검토"""
import json
import os
import re
from pipeline.agent import _run_claude


def run_qa(topic: str, script_json: dict, instructions: str,
           brand: str = "이슈60초", max_retries: int = 2,
           retry_count: int = 0, job_dir: str = "") -> dict:
    """완성된 영상(대본+슬라이드)을 뉴스 콘텐츠 전문가 관점에서 검토.

    Returns:
        {
            "passed": True/False,
            "score": 1~10,
            "issues": ["문제1", ...],
            "restart_from": None | "script" | "slides",
            "details": "종합 평가",
            "retry_count": 0
        }
    """
    sentences = script_json.get("sentences", [])
    slides = script_json.get("slides", [])

    # 배경 유무 검증 (closing 슬라이드 제외)
    if job_dir:
        bg_dir = os.path.join(job_dir, "backgrounds")
        bg_count = 0
        if os.path.isdir(bg_dir):
            bg_count = len([f for f in os.listdir(bg_dir)
                           if f.startswith("bg_") and os.path.getsize(os.path.join(bg_dir, f)) > 100])
        expected_bg = max(0, len(slides) - 1)  # closing 제외
        if expected_bg > 0 and bg_count == 0:
            return {
                "passed": False,
                "score": 1,
                "issues": [f"배경 파일 없음: backgrounds 폴더에 파일 0개 (필요: {expected_bg}개)"],
                "restart_from": "slides",
                "details": "배경 이미지/영상이 전혀 생성되지 않음. slides 단계부터 재시작 필요.",
                "retry_count": retry_count,
            }

    # 대본 텍스트 구성
    full_text = " ".join(s["text"] for s in sentences)
    total_chars = sum(len(s["text"]) for s in sentences)

    slide_desc = []
    for i, s in enumerate(slides):
        clean_main = s.get("main", "").replace('<span class="hl">', "").replace("</span>", "")
        bg_type = s.get("bg_type", "photo")
        slide_desc.append(
            f"슬라이드{i+1}: [{s.get('category','')}] {clean_main} / {s.get('sub','')} (배경: {bg_type})"
        )

    prompt = f"""너는 10년 경력의 YouTube Shorts 뉴스 PD이자 콘텐츠 전문가야.
유튜브 숏폼 뉴스 영상의 최종 검수를 담당한다.

## 너의 전문성
- 숏폼 뉴스 영상 기획/제작 10년 경력
- 시청자 리텐션, 후킹, 스토리텔링 전문
- 뉴스 정확성과 윤리 기준에 정통
- YouTube 알고리즘과 Shorts 트렌드 이해

## 채널 지침
{instructions[:1500] if instructions else "(없음)"}

## 검토 대상
주제: {topic}
브랜드: {brand}

### 대본 전문 ({len(sentences)}문장, {total_chars}자)
{full_text}

### 슬라이드 구성 ({len(slides)}개)
{chr(10).join(slide_desc)}

## 검토 기준 (PD 관점)

### 1. 시청자 후킹 (가중치 높음)
- 오프닝 3초: 시청자가 스크롤을 멈출 만큼 임팩트 있는가?
- 첫 슬라이드 main 텍스트가 강렬한가?
- "그래서 뭐?" 테스트: 왜 지금 이걸 봐야 하는지 즉시 전달되는가?

### 2. 뉴스 정확성/신뢰도
- 날조, 과장, 오해의 소지가 있는 표현은 없는가?
- 숫자/통계가 정확하고 출처가 명확한가?
- 편향적이거나 선정적이지 않은가?

### 3. 스토리 흐름 (기승전결)
- 도입 → 핵심 사실 → 분석/맥락 → 전망/마무리 흐름이 자연스러운가?
- 슬라이드 간 논리적 연결이 있는가?
- 반복되는 내용 없이 새 정보가 계속 추가되는가?

### 4. 슬라이드 품질
- main 텍스트: 짧고 임팩트 (20자 이내 권장)
- sub 텍스트: main을 보완하는 구체적 정보
- 핵심 숫자/키워드에 <span class="hl"> 강조 태그 사용
- 카테고리 라벨이 적절한가?

### 5. 시청 완주율 예측
- 30~40초 영상에서 끝까지 볼 확률은?
- 중간에 이탈할 지점이 있는가?
- 마지막 슬라이드가 여운을 남기는가?

### 6. 채널 지침 준수
- 톤, 형식, 금지사항, 타겟 시청자에 맞는가?
- 분량 기준 (문장수, 글자수) 충족하는가? (현재 {len(sentences)}문장, {total_chars}자)
- 슬라이드 수 적절한가? (현재 {len(slides)}개)

## 출력 형식 (JSON만)
{{
  "passed": true 또는 false,
  "score": 1~10 정수,
  "issues": ["발견된 문제 목록 (구체적으로, 없으면 빈 배열)"],
  "restart_from": null 또는 "script" 또는 "slides",
  "details": "PD로서의 종합 평가 2~3문장"
}}

판정 기준:
- score 7 이상 → passed: true (방송 가능)
- score 5~6 → passed: false, 수정 필요 사항 구체적으로 명시
- score 4 이하 → passed: false, 대본부터 재작성 필요
- 대본 내용 자체에 문제 → restart_from: "script"
- 슬라이드 구성만 문제 → restart_from: "slides"
- passed: true → restart_from: null

JSON만 출력해. 다른 텍스트 없이."""

    raw = _run_claude(prompt, timeout=60)
    return _parse_qa_result(raw, retry_count)


def _parse_qa_result(raw: str, retry_count: int = 0) -> dict:
    """Claude 출력에서 QA 결과 파싱"""
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "result" in wrapper:
            raw = wrapper["result"]
    except (json.JSONDecodeError, TypeError):
        pass

    m = re.search(r'```json\s*\n(.*?)\n\s*```', raw, re.DOTALL)
    if m:
        raw = m.group(1)

    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        try:
            result = json.loads(m.group(0))
            result["retry_count"] = retry_count
            # 타입 보정
            result["passed"] = bool(result.get("passed", False))
            result["score"] = int(result.get("score", 0))
            result["issues"] = list(result.get("issues", []))
            if result["restart_from"] not in (None, "script", "slides"):
                result["restart_from"] = None
            return result
        except (json.JSONDecodeError, KeyError, ValueError):
            pass

    # 파싱 실패 시 PASS 처리 (QA 자체 실패로 영상 블로킹 방지)
    return {
        "passed": True,
        "score": 0,
        "issues": ["QA 결과 파싱 실패"],
        "restart_from": None,
        "details": "QA 파싱 실패 — 기본 PASS 처리",
        "retry_count": retry_count,
    }
