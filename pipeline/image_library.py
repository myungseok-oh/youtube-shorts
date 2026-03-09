"""이미지 라이브러리 — 카테고리/키워드 기반 이미지 관리 + 자동 매칭"""
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

from pipeline import config

LIBRARY_DIR = os.path.join(config.root_dir(), "data", "image_library")
INDEX_PATH = os.path.join(LIBRARY_DIR, "index.json")


def _ensure_dirs():
    os.makedirs(LIBRARY_DIR, exist_ok=True)


def _load_index() -> list[dict]:
    _ensure_dirs()
    if os.path.exists(INDEX_PATH):
        with open(INDEX_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def _save_index(index: list[dict]):
    _ensure_dirs()
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)


def _next_id(index: list[dict]) -> str:
    max_n = 0
    for item in index:
        try:
            n = int(item["id"].split("_")[1])
            if n > max_n:
                max_n = n
        except (IndexError, ValueError):
            pass
    return f"img_{max_n + 1:04d}"


def _extract_keywords(text: str) -> list[str]:
    """텍스트에서 키워드 추출 (HTML 태그 제거, 짧은 단어 제외)"""
    clean = re.sub(r"<[^>]+>", "", text)
    clean = re.sub(r"[,.\-·!?'\"()%]", " ", clean)
    words = clean.split()
    # 2글자 이상, 숫자 포함 단어도 유지 (1,500원 등)
    keywords = []
    for w in words:
        w = w.strip()
        if len(w) >= 2 and w not in ("입니다", "했습니다", "있습니다", "됩니다"):
            keywords.append(w)
    return keywords[:10]  # 최대 10개


def _sanitize_category(category: str) -> str:
    """카테고리 폴더명으로 안전하게 변환"""
    clean = category.strip()
    if not clean:
        clean = "기타"
    # 파일시스템에 안전한 문자만
    clean = re.sub(r'[<>:"/\\|?*]', "", clean)
    return clean


# ─── Public API ───

def register_image(
    src_path: str,
    category: str,
    main_text: str = "",
    sub_text: str = "",
    topic: str = "",
) -> dict:
    """이미지를 라이브러리에 등록.

    Args:
        src_path: 원본 이미지 경로
        category: 슬라이드 카테고리 (경제, 국제, ...)
        main_text: 슬라이드 메인 텍스트
        sub_text: 슬라이드 서브 텍스트
        topic: 원래 작업 주제

    Returns:
        등록된 이미지 메타데이터
    """
    if not os.path.exists(src_path):
        return None

    index = _load_index()
    img_id = _next_id(index)

    cat_dir = _sanitize_category(category)
    ext = Path(src_path).suffix or ".jpg"
    rel_path = os.path.join(cat_dir, f"{img_id}{ext}")
    abs_path = os.path.join(LIBRARY_DIR, rel_path)

    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    shutil.copy2(src_path, abs_path)

    # 키워드 추출
    keywords = _extract_keywords(f"{category} {main_text} {sub_text}")

    entry = {
        "id": img_id,
        "path": rel_path,
        "category": category,
        "keywords": keywords,
        "original_topic": topic,
        "original_main": re.sub(r"<[^>]+>", "", main_text)[:50],
        "created_at": datetime.now().strftime("%Y-%m-%d"),
    }

    index.append(entry)
    _save_index(index)
    return entry


def get_library() -> list[dict]:
    """라이브러리 전체 목록"""
    return _load_index()


def get_library_stats() -> dict:
    """카테고리별 이미지 수"""
    index = _load_index()
    stats = {}
    for item in index:
        cat = item.get("category", "기타")
        stats[cat] = stats.get(cat, 0) + 1
    return {"total": len(index), "categories": stats}


def match_slides(slides_data: list[dict]) -> list[dict]:
    """슬라이드별로 라이브러리에서 최적 이미지 매칭.

    Args:
        slides_data: [{"category": "경제", "main": "환율 1500원 돌파", ...}, ...]

    Returns:
        [{"index": 1, "matched": True, "image": {...}, "score": 5}, ...]
        마지막 슬라이드(closing)는 매칭 스킵.
    """
    index = _load_index()
    results = []
    used_ids = set()

    for i, slide in enumerate(slides_data):
        # 마지막 슬라이드(closing)는 스킵
        if i == len(slides_data) - 1:
            results.append({
                "index": i + 1,
                "matched": False,
                "image": None,
                "score": 0,
                "reason": "closing",
            })
            continue

        category = slide.get("category", "")
        main_text = re.sub(r"<[^>]+>", "", slide.get("main", ""))
        sub_text = slide.get("sub", "")
        slide_keywords = _extract_keywords(f"{category} {main_text} {sub_text}")

        best_match = None
        best_score = 0

        for item in index:
            if item["id"] in used_ids:
                continue

            score = _calc_score(category, slide_keywords, item)
            if score > best_score:
                best_score = score
                best_match = item

        if best_match and best_score >= 2:
            used_ids.add(best_match["id"])
            # 절대 경로 추가
            best_match_copy = {**best_match}
            best_match_copy["abs_path"] = os.path.join(LIBRARY_DIR, best_match["path"])
            results.append({
                "index": i + 1,
                "matched": True,
                "image": best_match_copy,
                "score": best_score,
                "reason": f"score={best_score}",
            })
        else:
            results.append({
                "index": i + 1,
                "matched": False,
                "image": None,
                "score": best_score,
                "reason": "no_match",
            })

    return results


def apply_matches(job_id: str, matches: list[dict]) -> list[dict]:
    """매칭 결과를 job의 backgrounds 폴더에 복사.

    Returns:
        복사된 파일 목록
    """
    bg_dir = os.path.join(config.output_dir(), job_id, "backgrounds")
    os.makedirs(bg_dir, exist_ok=True)

    applied = []
    for m in matches:
        if not m.get("matched") or not m.get("image"):
            continue

        idx = m["index"]
        src = m["image"].get("abs_path", "")
        if not src or not os.path.exists(src):
            src = os.path.join(LIBRARY_DIR, m["image"]["path"])

        if not os.path.exists(src):
            continue

        ext = Path(src).suffix or ".jpg"
        dst = os.path.join(bg_dir, f"bg_{idx}{ext}")

        # 기존 파일 제거
        for e in ["jpg", "jpeg", "png", "webp"]:
            old = os.path.join(bg_dir, f"bg_{idx}.{e}")
            if os.path.exists(old):
                os.remove(old)

        shutil.copy2(src, dst)
        applied.append({"index": idx, "filename": f"bg_{idx}{ext}",
                        "from_library": m["image"]["id"]})

    return applied


def _calc_score(slide_category: str, slide_keywords: list[str],
                lib_item: dict) -> int:
    """매칭 점수 계산.

    - 카테고리 일치: +3
    - 키워드 겹침: 겹치는 키워드 수 * 1
    """
    score = 0

    # 카테고리 매칭
    item_cat = lib_item.get("category", "")
    if slide_category and item_cat and slide_category == item_cat:
        score += 3

    # 키워드 겹침
    item_keywords = set(lib_item.get("keywords", []))
    slide_kw_set = set(slide_keywords)
    overlap = item_keywords & slide_kw_set
    score += len(overlap)

    return score
