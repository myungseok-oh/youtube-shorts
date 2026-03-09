"""
이슈60초 - 샘플 영상 제작 스크립트
주제: 원/달러 환율 1,506원 돌파 (2026.03.04)
"""
import os
import json
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
AUDIO_DIR = os.path.join(OUTPUT_DIR, "audio")
IMAGE_DIR = os.path.join(OUTPUT_DIR, "images")
VIDEO_DIR = os.path.join(OUTPUT_DIR, "video")
SEGMENT_DIR = os.path.join(OUTPUT_DIR, "segments")

FFMPEG = r"C:\Users\msoh\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.0.1-full_build\bin\ffmpeg.exe"
FFPROBE = r"C:\Users\msoh\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.0.1-full_build\bin\ffprobe.exe"

# 대본 데이터: text=TTS용 텍스트, slide=매핑할 슬라이드 번호
SCRIPT = [
    {"text": "원 달러 환율이 1506원을 돌파했습니다.", "slide": 1},
    {"text": "17년 만에 처음으로 1500원대에 진입한 것입니다.", "slide": 1},
    {"text": "중동 지역 전쟁 확대가 직접적 원인입니다.", "slide": 2},
    {"text": "코스피는 7.49% 급락하며 5358에 마감했습니다.", "slide": 3},
    {"text": "코스닥도 7.83% 하락했습니다.", "slide": 3},
    {"text": "한국은행은 긴급 회의를 소집해 대응에 나섰습니다.", "slide": 4},
    {"text": "환율은 당분간 1480원대에서 등락할 전망입니다.", "slide": 5},
    {"text": "이슈 60초였습니다.", "slide": 6},
]


def ensure_dirs():
    for d in [AUDIO_DIR, IMAGE_DIR, VIDEO_DIR, SEGMENT_DIR]:
        os.makedirs(d, exist_ok=True)


def step1_generate_tts():
    """gTTS로 문장별 음성 파일 생성"""
    print("\n=== Step 1: TTS 음성 생성 ===")
    from gtts import gTTS

    for i, item in enumerate(SCRIPT):
        out_path = os.path.join(AUDIO_DIR, f"audio_{i+1}.mp3")
        if os.path.exists(out_path):
            print(f"  [skip] audio_{i+1}.mp3 (이미 존재)")
            continue
        tts = gTTS(text=item["text"], lang="ko", slow=False)
        tts.save(out_path)
        print(f"  audio_{i+1}.mp3 -> {item['text'][:30]}...")
    print("  TTS 생성 완료!")


def get_audio_duration(filepath):
    """ffprobe로 오디오 파일 길이(초) 측정"""
    result = subprocess.run(
        [FFPROBE, "-v", "quiet", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", filepath],
        capture_output=True, text=True
    )
    return float(result.stdout.strip())


def step2_generate_slides():
    """Node.js Puppeteer로 슬라이드 이미지 생성"""
    print("\n=== Step 2: 슬라이드 이미지 생성 ===")
    slide_script = os.path.join(BASE_DIR, "generate_slides.js")
    result = subprocess.run(
        ["node", slide_script],
        capture_output=True, text=True, cwd=BASE_DIR
    )
    print(result.stdout)
    if result.returncode != 0:
        print(f"ERROR: {result.stderr}")
        sys.exit(1)
    print("  슬라이드 생성 완료!")


def step3_compose_video():
    """ffmpeg로 이미지+음성 합성하여 최종 영상 제작"""
    print("\n=== Step 3: 영상 합성 ===")

    # 1) 각 문장 오디오의 길이 측정
    durations = []
    for i in range(len(SCRIPT)):
        audio_path = os.path.join(AUDIO_DIR, f"audio_{i+1}.mp3")
        dur = get_audio_duration(audio_path)
        durations.append(dur)
        print(f"  audio_{i+1}.mp3 = {dur:.2f}초")

    # 2) 슬라이드별 표시 시간 계산 (같은 slide 번호의 오디오 합산)
    slide_durations = {}
    for i, item in enumerate(SCRIPT):
        s = item["slide"]
        slide_durations[s] = slide_durations.get(s, 0) + durations[i]

    print("\n  슬라이드별 표시 시간:")
    total = 0
    for s in sorted(slide_durations.keys()):
        print(f"    slide_{s}: {slide_durations[s]:.2f}초")
        total += slide_durations[s]
    print(f"    총 길이: {total:.1f}초")

    # 3) 슬라이드별 오디오 파일 합치기 (같은 슬라이드에 매핑된 문장들)
    slide_audio_files = {}
    for i, item in enumerate(SCRIPT):
        s = item["slide"]
        if s not in slide_audio_files:
            slide_audio_files[s] = []
        slide_audio_files[s].append(os.path.join(AUDIO_DIR, f"audio_{i+1}.mp3"))

    # 각 슬라이드의 오디오를 하나로 합침
    for s in sorted(slide_audio_files.keys()):
        merged_path = os.path.join(SEGMENT_DIR, f"slide_audio_{s}.mp3")
        files = slide_audio_files[s]
        if len(files) == 1:
            # 파일이 하나면 복사
            import shutil
            shutil.copy2(files[0], merged_path)
        else:
            # 여러 파일 concat
            list_file = os.path.join(SEGMENT_DIR, f"concat_list_{s}.txt")
            with open(list_file, "w", encoding="utf-8") as f:
                for fp in files:
                    f.write(f"file '{fp}'\n")
            subprocess.run([
                FFMPEG, "-y", "-f", "concat", "-safe", "0",
                "-i", list_file, "-c", "copy", merged_path
            ], capture_output=True)

    # 4) 각 슬라이드 세그먼트 영상 생성
    print("\n  세그먼트 영상 생성:")
    segment_files = []
    for s in sorted(slide_durations.keys()):
        img_path = os.path.join(IMAGE_DIR, f"slide_{s}.png")
        audio_path = os.path.join(SEGMENT_DIR, f"slide_audio_{s}.mp3")
        seg_path = os.path.join(SEGMENT_DIR, f"segment_{s}.mp4")
        segment_files.append(seg_path)

        dur = slide_durations[s]
        subprocess.run([
            FFMPEG, "-y",
            "-loop", "1", "-i", img_path,
            "-i", audio_path,
            "-c:v", "libx264", "-tune", "stillimage",
            "-c:a", "aac", "-b:a", "192k",
            "-pix_fmt", "yuv420p",
            "-shortest",
            "-t", str(dur + 0.1),  # 약간의 여유
            seg_path
        ], capture_output=True)
        print(f"    segment_{s}.mp4 ({dur:.2f}초)")

    # 5) 세그먼트 합치기
    print("\n  최종 영상 합성:")
    concat_file = os.path.join(SEGMENT_DIR, "concat_final.txt")
    with open(concat_file, "w", encoding="utf-8") as f:
        for seg in segment_files:
            f.write(f"file '{seg}'\n")

    final_output = os.path.join(VIDEO_DIR, "sample_output.mp4")
    subprocess.run([
        FFMPEG, "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-c:v", "libx264",
        "-c:a", "aac",
        "-movflags", "+faststart",
        final_output
    ], capture_output=True)

    if os.path.exists(final_output):
        size_mb = os.path.getsize(final_output) / (1024 * 1024)
        print(f"\n  완성! {final_output}")
        print(f"  파일 크기: {size_mb:.1f} MB")
        print(f"  총 길이: {total:.1f}초")
    else:
        print("\n  ERROR: 영상 생성 실패!")
        sys.exit(1)


def main():
    ensure_dirs()
    step1_generate_tts()
    step2_generate_slides()
    step3_compose_video()
    print("\n=== 샘플 영상 제작 완료! ===")


if __name__ == "__main__":
    main()
