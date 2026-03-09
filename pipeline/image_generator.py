"""CCL(Creative Commons) 이미지 검색 — Openverse API 활용"""
import os
import re
from pathlib import Path

import requests


# 카테고리 → 영어 키워드 (한국어 검색 결과 부족 시 폴백)
_CATEGORY_EN = {
    "경제": "economy finance stock market",
    "정치": "politics government congress",
    "사회": "society city urban life",
    "국제": "international diplomacy world",
    "문화": "culture art festival",
    "스포츠": "sports stadium athlete",
    "IT": "technology computer digital",
    "과학": "science laboratory research",
    "속보": "breaking news headline",
    "연예": "entertainment celebrity stage",
    "날씨": "weather sky clouds",
    "부동산": "real estate building architecture",
    "주식": "stock market trading chart",
    "환율": "currency exchange rate dollar",
    "교육": "education school university",
    "건강": "health medical hospital",
    "환경": "environment nature green energy",
}

_HEADERS = {
    "User-Agent": "IssueShorts/1.0 (youtube-shorts-generator)",
}

_OPENVERSE_API = "https://api.openverse.org/v1/images/"


def generate_backgrounds(
    slides_data: list[dict],
    output_dir: str,
    api_key: str = "",
) -> list[dict]:
    """슬라이드별 CC 라이선스 이미지 검색 + 다운로드.

    Args:
        slides_data: [{"category": "속보", "main": "...", ...}, ...]
        output_dir: 이미지 저장 디렉토리
        api_key: 미사용 (인터페이스 호환용)

    Returns:
        [{"path": "bg_1.jpg", "source": "작성자 · CC BY"}, ...]
        실패 시 {"path": "", "source": ""}
    """
    os.makedirs(output_dir, exist_ok=True)
    results: list[dict] = []
    used_urls: set[str] = set()

    for i, slide in enumerate(slides_data):
        # Closing 슬라이드(마지막)는 배경 불필요
        if i == len(slides_data) - 1:
            results.append({"path": "", "source": ""})
            print(f"[image_generator] bg_{i + 1}: Closing 슬라이드 스킵")
            continue

        out_path = os.path.join(output_dir, f"bg_{i + 1}.jpg")

        try:
            # 1차: 한국어 키워드로 검색
            keyword = _build_keyword(slide)
            candidates = _search_cc_images(keyword, used_urls)

            # 2차: 결과 부족하면 영어 카테고리 키워드로 재시도
            if not candidates:
                en_keyword = _english_fallback(slide)
                if en_keyword:
                    print(f"[image_generator] bg_{i + 1}: 영어 키워드 재시도 → {en_keyword}")
                    candidates = _search_cc_images(en_keyword, used_urls)

            downloaded = False
            for img_url, source in candidates:
                try:
                    if _download_image(img_url, out_path):
                        used_urls.add(img_url)
                        size_kb = os.path.getsize(out_path) / 1024
                        print(
                            f"[image_generator] bg_{i + 1}.jpg 다운로드 "
                            f"({size_kb:.0f}KB, {source})"
                        )
                        results.append({"path": out_path, "source": source})
                        downloaded = True
                        break
                except Exception:
                    continue

            if not downloaded:
                print(
                    f"[image_generator] 슬라이드 {i + 1}: "
                    "CC 이미지 없음, 기본 배경 사용"
                )
                results.append({"path": "", "source": ""})

        except Exception as e:
            print(f"[image_generator] 슬라이드 {i + 1} 실패: {e}")
            results.append({"path": "", "source": ""})

    return results


def _build_keyword(slide: dict) -> str:
    """슬라이드에서 검색 키워드 구성"""
    main = slide.get("main", "")
    clean = re.sub(r"<[^>]+>", "", main)
    category = slide.get("category", "")

    keyword = f"{category} {clean}".strip() if category else clean
    if len(keyword) > 50:
        keyword = keyword[:50]
    return keyword


def _english_fallback(slide: dict) -> str:
    """카테고리 기반 영어 키워드 폴백"""
    category = slide.get("category", "")
    main = re.sub(r"<[^>]+>", "", slide.get("main", ""))

    # 카테고리 직접 매칭
    if category in _CATEGORY_EN:
        return _CATEGORY_EN[category]

    # main 텍스트에서 키워드 매칭
    for kr, en in _CATEGORY_EN.items():
        if kr in main:
            return en

    return ""


def _search_cc_images(
    keyword: str, used_urls: set, count: int = 5
) -> list[tuple[str, str]]:
    """Openverse API로 CC 라이선스 이미지 검색.

    상업적 이용 + 수정 가능한 이미지만 필터링.
    """
    params = {
        "q": keyword,
        "license_type": "commercial,modification",
        "page_size": min(count * 3, 20),
        "mature": "false",
    }

    resp = requests.get(
        _OPENVERSE_API, params=params, headers=_HEADERS, timeout=15
    )
    resp.raise_for_status()
    data = resp.json()

    results: list[tuple[str, str]] = []
    for item in data.get("results", []):
        img_url = item.get("url", "")
        if not img_url or img_url in used_urls:
            continue

        # 너무 작은 이미지 제외 (배경용이므로 최소 해상도 필요)
        width = item.get("width") or 0
        height = item.get("height") or 0
        if width and height and (width < 400 or height < 300):
            continue

        creator = item.get("creator", "")
        source = item.get("source", "")
        license_code = item.get("license", "by").upper()

        # 출처 텍스트: "작성자 · CC BY" 또는 "Source · CC BY"
        attribution = creator or source or "Unknown"
        if len(attribution) > 25:
            attribution = attribution[:25]
        source_text = f"{attribution} · CC {license_code}"

        results.append((img_url, source_text))
        if len(results) >= count:
            break

    return results


def _download_image(url: str, out_path: str, timeout: int = 20) -> bool:
    """이미지 다운로드. 성공 시 True."""
    resp = requests.get(url, headers=_HEADERS, timeout=timeout, stream=True)
    resp.raise_for_status()

    content = resp.content
    if len(content) < 5 * 1024:  # 5KB 미만이면 유효하지 않을 수 있음
        return False

    Path(out_path).write_bytes(content)
    return True
