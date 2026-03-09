"""Phase 3 테스트 — 샘플 데이터로 배경 이미지 → 슬라이드 → TTS → 렌더"""
import json
import os
import sqlite3
import sys

# 프로젝트 루트를 path에 추가
sys.path.insert(0, os.path.dirname(__file__))

from pipeline.image_generator import generate_backgrounds
from pipeline.slide_generator import generate_slides
from pipeline.tts_generator import generate_audio
from pipeline.sync_engine import build_timeline, merge_slide_audio
from pipeline.video_renderer import render_segments, concat_segments

# 샘플 script_json
SAMPLE = {
    "brand": "이슈60초",
    "date": "2026.03.05",
    "sentences": [
        {"text": "오늘 주요 뉴스입니다", "slide": 1},
        {"text": "원달러 환율이 급등했습니다", "slide": 2},
        {"text": "장중 1450원을 돌파했는데요", "slide": 2},
        {"text": "미국 금리 인상 우려가 원인입니다", "slide": 3},
        {"text": "한국은행은 긴급 대응에 나섰습니다", "slide": 3},
        {"text": "수출 기업에는 호재라는 분석도", "slide": 4},
        {"text": "반면 수입 물가 상승이 우려됩니다", "slide": 4},
        {"text": "향후 추이를 지켜봐야겠습니다", "slide": 5},
        {"text": "다음 뉴스에서 만나요", "slide": 6},
    ],
    "slides": [
        {
            "category": "속보",
            "main": "원/달러 환율<br><span class=\"hl\">1450원</span> 돌파",
            "sub": "2026년 3월 5일 긴급 뉴스",
            "accent": "#ff4444"
        },
        {
            "category": "환율",
            "main": "장중 <span class=\"hl\">1450원</span><br>돌파 기록",
            "sub": "연중 최고치 경신",
            "accent": "#ff6b35"
        },
        {
            "category": "원인 분석",
            "main": "미국 금리 인상<br>우려 <span class=\"hl\">확산</span>",
            "sub": "한국은행 긴급 대응 착수",
            "accent": "#4488ff"
        },
        {
            "category": "영향",
            "main": "수출 기업 <span class=\"hl\">호재</span><br>수입 물가 <span class=\"hl\">상승</span>",
            "sub": "양면적 효과 분석",
            "accent": "#44bb88"
        },
        {
            "category": "전망",
            "main": "환율 추이<br><span class=\"hl\">주시</span> 필요",
            "sub": "전문가 의견 엇갈려",
            "accent": "#8855cc"
        },
        {
            "category": "",
            "main": "다음 뉴스에서 만나요",
            "sub": "",
            "accent": "#ff6b35"
        },
    ]
}

def main():
    test_dir = os.path.join("output", "_test_phase3")
    image_dir = os.path.join(test_dir, "images")
    audio_dir = os.path.join(test_dir, "audio")
    segment_dir = os.path.join(test_dir, "segments")
    video_dir = os.path.join(test_dir, "video")

    bg_dir = os.path.join(test_dir, "backgrounds")
    for d in [image_dir, audio_dir, segment_dir, video_dir, bg_dir]:
        os.makedirs(d, exist_ok=True)

    # Step 0: CC 라이선스 배경 이미지 크롤링
    print("=== 배경 이미지 검색 (CC 라이선스) ===")
    bg_results = generate_backgrounds(SAMPLE["slides"], bg_dir)
    bg_count = sum(1 for bg in bg_results if bg.get("path"))
    print(f"  다운로드된 배경: {bg_count}/{len(bg_results)}개")

    # Step 1: 슬라이드 생성
    print("\n=== 슬라이드 생성 ===")
    slide_paths = generate_slides(
        SAMPLE["slides"], image_dir,
        date=SAMPLE["date"], brand=SAMPLE["brand"],
        backgrounds=bg_results
    )
    print(f"  생성된 슬라이드: {len(slide_paths)}개")
    for p in slide_paths:
        size_kb = os.path.getsize(p) / 1024
        print(f"  {os.path.basename(p)} ({size_kb:.0f} KB)")

    # Step 2: TTS
    print("\n=== TTS 생성 ===")
    audio_paths = generate_audio(SAMPLE["sentences"], audio_dir)
    print(f"  생성된 오디오: {len(audio_paths)}개")

    # Step 3: 타임라인 + 렌더
    print("\n=== 영상 합성 ===")
    timeline = build_timeline(SAMPLE["sentences"], audio_dir)
    merged = merge_slide_audio(timeline["slide_audio_map"], segment_dir)
    segments = render_segments(timeline["slide_durations"], image_dir, merged, segment_dir)

    final_path = os.path.join(video_dir, "test_phase3.mp4")
    concat_segments(segments, final_path)

    size_mb = os.path.getsize(final_path) / (1024 * 1024)
    print(f"\n=== 완료 ===")
    print(f"  최종 영상: {final_path}")
    print(f"  크기: {size_mb:.1f} MB")
    print(f"  길이: {timeline['total_duration']:.1f}초")


if __name__ == "__main__":
    main()
