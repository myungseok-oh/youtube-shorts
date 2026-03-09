"""Google Trends + YouTube Trending 데이터 수집"""
import logging
import xml.etree.ElementTree as ET

import requests

logger = logging.getLogger(__name__)


def collect_trends(
    sources: list[str] | None = None,
    youtube_api_key: str = "",
) -> dict[str, list[str]]:
    """트렌드 데이터 통합 수집.

    Args:
        sources: ["google_trends", "youtube_trending"] 중 선택
        youtube_api_key: YouTube Data API v3 키

    Returns:
        {"google_trends": [...], "youtube_trending": [...]}
    """
    if not sources:
        return {}

    results = {}

    if "google_trends" in sources:
        try:
            results["google_trends"] = _fetch_google_trends()
        except Exception as e:
            logger.warning("Google Trends 수집 실패: %s", e)
            results["google_trends"] = []

    if "youtube_trending" in sources and youtube_api_key:
        try:
            results["youtube_trending"] = _fetch_youtube_trending(youtube_api_key)
        except Exception as e:
            logger.warning("YouTube Trending 수집 실패: %s", e)
            results["youtube_trending"] = []

    return results


def _fetch_google_trends() -> list[str]:
    """Google Trends RSS 피드로 한국 일일 트렌드 상위 20개 수집.

    pytrends API가 404를 반환하는 문제 회피를 위해 RSS 직접 파싱.
    """
    url = "https://trends.google.co.kr/trending/rss?geo=KR"
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()

    root = ET.fromstring(resp.text)
    keywords = []
    for item in root.iter("item"):
        title = item.findtext("title", "").strip()
        if title:
            keywords.append(title)
        if len(keywords) >= 20:
            break
    return keywords


def _fetch_youtube_trending(api_key: str) -> list[str]:
    """YouTube Data API v3로 한국 인기 동영상 제목 상위 20개 수집.

    REST 직접 호출 — 추가 의존성 없음, 1 unit/call.
    """
    url = "https://www.googleapis.com/youtube/v3/videos"
    params = {
        "part": "snippet",
        "chart": "mostPopular",
        "regionCode": "KR",
        "maxResults": 20,
        "key": api_key,
    }
    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    titles = []
    for item in data.get("items", []):
        title = item.get("snippet", {}).get("title", "")
        if title:
            titles.append(title)
    return titles


def format_trend_context(trends: dict[str, list[str]]) -> str:
    """수집된 트렌드를 Claude 프롬프트용 텍스트로 변환."""
    if not trends:
        return ""

    lines = ["[현재 트렌딩 데이터]"]

    gt = trends.get("google_trends", [])
    if gt:
        lines.append("")
        lines.append("## Google Trends (한국 실시간)")
        for i, kw in enumerate(gt, 1):
            lines.append(f"{i}. {kw}")

    yt = trends.get("youtube_trending", [])
    if yt:
        lines.append("")
        lines.append("## YouTube 인기 동영상 (한국)")
        for i, title in enumerate(yt, 1):
            lines.append(f"{i}. {title}")

    lines.append("")
    lines.append("★ 위 트렌딩 데이터는 지금 실시간으로 수집한 것입니다. 이 키워드와 관련된 오늘자 뉴스를 최우선으로 선정하세요.")
    return "\n".join(lines)
