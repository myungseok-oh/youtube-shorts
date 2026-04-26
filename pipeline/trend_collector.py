"""Google Trends + YouTube Trending 데이터 수집"""
from __future__ import annotations
import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

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


_GOOGLE_NEWS_CATEGORIES = {
    "": "",
    "BUSINESS": "BUSINESS",
    "TECHNOLOGY": "TECHNOLOGY",
    "NATION": "NATION",
    "ENTERTAINMENT": "ENTERTAINMENT",
    "SPORTS": "SPORTS",
    "SCIENCE": "SCIENCE",
    "HEALTH": "HEALTH",
}


def _fetch_google_news(category: str = "", max_age_hours: int = 24) -> list[dict]:
    """Google News RSS 피드로 한국 뉴스 수집 (날짜 필터 적용).

    Args:
        category: "" (종합), "BUSINESS", "TECHNOLOGY", "NATION"
        max_age_hours: 이 시간 이내 기사만 반환 (기본 24시간)

    Returns:
        [{"title": "...", "source": "...", "link": "...", "pub_date": "..."}]
    """
    if category and category in _GOOGLE_NEWS_CATEGORIES:
        url = f"https://news.google.com/rss/headlines/section/topic/{category}?hl=ko&gl=KR&ceid=KR:ko"
    else:
        url = "https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko"

    resp = requests.get(url, timeout=10)
    resp.raise_for_status()

    now_utc = datetime.now(timezone.utc)
    cutoff = now_utc - timedelta(hours=max_age_hours)

    root = ET.fromstring(resp.text)
    items = []
    skipped = 0
    for item in root.iter("item"):
        raw_title = item.findtext("title", "").strip()
        if not raw_title:
            continue
        # Google News <title> 형식: "뉴스 제목 - 출처"
        if " - " in raw_title:
            title, source = raw_title.rsplit(" - ", 1)
        else:
            title, source = raw_title, ""
        link = item.findtext("link", "").strip()
        pub_date = item.findtext("pubDate", "").strip()

        # pubDate 파싱 → 날짜 필터링
        if pub_date:
            try:
                pub_dt = parsedate_to_datetime(pub_date)
                if pub_dt < cutoff:
                    skipped += 1
                    continue
            except Exception:
                pass  # 파싱 실패 시 포함 (안전하게)

        items.append({
            "title": title.strip(),
            "source": source.strip(),
            "link": link,
            "pub_date": pub_date,
        })
        if len(items) >= 20:
            break

    if skipped:
        logger.info("Google News: %d건 날짜 필터로 제외 (%dh 이내만 수집)", skipped, max_age_hours)
    return items


def collect_news(
    sources: list[str] | None = None,
    youtube_api_key: str = "",
    category: str = "",
) -> dict:
    """뉴스 탐색용 통합 수집.

    Args:
        sources: ["google_news", "google_trends", "youtube_trending"]
        youtube_api_key: YouTube Data API v3 키
        category: Google News 카테고리 ("", "BUSINESS", "TECHNOLOGY", "NATION")

    Returns:
        {"google_news": [...], "google_trends": [...], "youtube_trending": [...]}
    """
    if not sources:
        sources = ["google_news", "google_trends"]

    results = {}

    if "google_news" in sources:
        try:
            results["google_news"] = _fetch_google_news(category)
        except Exception as e:
            logger.warning("Google News 수집 실패: %s", e)
            results["google_news"] = []

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


# ── 한국 주요 언론사 RSS ──────────────────────────────────

_KR_NEWS_FEEDS = [
    ("연합뉴스", "https://www.yna.co.kr/rss/news.xml"),
    ("조선일보", "https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml"),
    ("한겨레", "https://www.hani.co.kr/rss/"),
    ("경향신문", "https://www.khan.co.kr/rss/rssdata/total_news.xml"),
    ("매일경제", "https://www.mk.co.kr/rss/40300001/"),
    ("전자신문", "https://rss.etnews.com/Section901.xml"),
]


def _fetch_kr_news(max_age_hours: int = 12) -> list[dict]:
    """한국 주요 언론사 RSS에서 최신 뉴스 수집.

    Returns:
        [{"title": "...", "source": "...", "link": "...", "pub_date": "..."}]
    """
    now_utc = datetime.now(timezone.utc)
    cutoff = now_utc - timedelta(hours=max_age_hours)
    all_items = []

    for source_name, url in _KR_NEWS_FEEDS:
        try:
            resp = requests.get(url, timeout=8, headers={
                "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"
            })
            resp.raise_for_status()
            root = ET.fromstring(resp.text)

            count = 0
            for item in root.iter("item"):
                raw_title = item.findtext("title", "").strip()
                if not raw_title:
                    continue
                link = item.findtext("link", "").strip()
                pub_date = item.findtext("pubDate", "").strip()

                # 날짜 필터
                if pub_date:
                    try:
                        pub_dt = parsedate_to_datetime(pub_date)
                        if pub_dt < cutoff:
                            continue
                    except Exception:
                        pass

                all_items.append({
                    "title": raw_title,
                    "source": source_name,
                    "link": link,
                    "pub_date": pub_date,
                })
                count += 1
                if count >= 20:
                    break
        except Exception as e:
            logger.warning("%s RSS 수집 실패: %s", source_name, e)

    return all_items


# ── 오늘자 뉴스 통합 수집 ──────────────────────────────────

def fetch_today_news(max_age_hours: int = 12,
                     sections: list[str] | None = None) -> list[dict]:
    """Google News + 네이버 뉴스 RSS에서 오늘자 뉴스 통합 수집.

    Args:
        max_age_hours: 기사 최대 노후도(시간)
        sections: 섹션 필터. None이면 전체. 예: ["종합"], ["경제", "IT과학"]

    Returns:
        [{"title": "...", "source": "...", "section": "...", "pub_date": "..."}]
        중복 제거 후 최대 50건.
    """
    all_items = []

    section_map = {
        "": "종합", "BUSINESS": "경제", "TECHNOLOGY": "IT과학",
        "NATION": "정치", "ENTERTAINMENT": "연예", "SPORTS": "스포츠",
    }
    # 필터된 카테고리만 수집
    cats_to_fetch = [c for c, s in section_map.items()
                     if not sections or s in sections]

    # Google News — 카테고리별 수집
    for cat in cats_to_fetch:
        try:
            items = _fetch_google_news(category=cat, max_age_hours=max_age_hours)
            for item in items:
                item["section"] = section_map.get(cat, "종합")
            all_items.extend(items)
        except Exception as e:
            logger.warning("Google News(%s) 수집 실패: %s", cat, e)

    # 한국 언론사 RSS — 종합 섹션에 포함 (필터 없거나 "종합" 포함 시)
    if not sections or "종합" in sections:
        try:
            kr_items = _fetch_kr_news(max_age_hours=max_age_hours)
            for item in kr_items:
                item["section"] = "종합"
            all_items.extend(kr_items)
        except Exception as e:
            logger.warning("한국 언론사 뉴스 수집 실패: %s", e)

    # 중복 제거 (제목 유사도 기반)
    seen_titles = set()
    unique_items = []
    for item in all_items:
        # 제목에서 공백/특수문자 제거 후 앞 20자로 비교
        _key = "".join(item["title"].split())[:20]
        if _key in seen_titles:
            continue
        seen_titles.add(_key)
        unique_items.append(item)
        if len(unique_items) >= 50:
            break

    logger.info("오늘자 뉴스 수집 완료: %d건 (Google+네이버)", len(unique_items))
    return unique_items


def format_today_news(items: list[dict]) -> str:
    """수집된 오늘자 뉴스를 프롬프트용 텍스트로 변환."""
    if not items:
        return ""

    now = datetime.now()
    now_str = now.strftime("%Y-%m-%d %H시")

    lines = [f"[오늘자 뉴스 헤드라인 — {now_str} 수집]"]
    lines.append("")

    # 섹션별 그룹핑
    sections: dict[str, list[dict]] = {}
    for item in items:
        sec = item.get("section", "종합")
        sections.setdefault(sec, []).append(item)

    idx = 1
    for sec_name, sec_items in sections.items():
        lines.append(f"## {sec_name}")
        for item in sec_items[:8]:  # 섹션당 최대 8건
            source = item.get("source", "")
            source_str = f" — {source}" if source else ""
            lines.append(f"{idx}. {item['title']}{source_str}")
            idx += 1
        lines.append("")

    lines.append("★ 위 뉴스는 실시간 RSS에서 수집한 오늘자 헤드라인이다.")
    lines.append("  이 목록에서 주제와 관련된 기사를 우선 참조하라.")
    lines.append("  목록에 없는 뉴스를 사용하지 마라.")
    lines.append("  각 뉴스의 구체 수치/팩트는 헤드라인 기반으로 작성하라.")

    return "\n".join(lines)
