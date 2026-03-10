/**
 * Puppeteer 기반 슬라이드 이미지 생성기
 * 사용법: node generate_slides.js <input.json> <output_dir>
 *
 * input.json 형식:
 * {
 *   "slides": [
 *     { "category": "속보", "main": "...", "sub": "..." },
 *     ...
 *   ],
 *   "backgrounds": [{"path": "bg1.png", "source": "MBC"}, ...],
 *   "date": "2026.03.04",
 *   "brand": "이슈60초",
 *   "layout": "full"  // "full" | "center" | "top" | "bottom"
 * }
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node generate_slides.js <input.json> <output_dir>');
  process.exit(1);
}

const inputPath = args[0];
const outputDir = args[1];

const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const slides = data.slides || [];
const backgrounds = data.backgrounds || [];
const date = data.date || '';
const brand = data.brand || '이슈60초';
const layout = data.layout || 'full';
const total = slides.length;

function bgInfo(index) {
  const bg = backgrounds[index];
  if (!bg) return { css: '', source: '', dataUrl: '' };
  const bgPath = bg.path || '';
  const source = bg.source || '';
  if (!bgPath || !fs.existsSync(bgPath)) return { css: '', source: '', dataUrl: '' };
  const ext = path.extname(bgPath).toLowerCase();
  // MP4/GIF 영상 배경
  if (ext === '.mp4' || ext === '.gif') {
    if (layout === 'full') {
      // full layout: overlay PNG + ffmpeg 합성이므로 dataUrl 불필요
      return { css: '', source, isVideo: true, dataUrl: '' };
    }
    // zoned layout: ffmpeg로 1프레임 추출하여 정적 이미지로 사용
    try {
      const thumbPath = bgPath.replace(/\.[^.]+$/, '_thumb.jpg');
      if (!fs.existsSync(thumbPath)) {
        execSync(`ffmpeg -y -i "${bgPath}" -vframes 1 -q:v 2 "${thumbPath}"`, { stdio: 'pipe' });
      }
      if (fs.existsSync(thumbPath)) {
        const buf = fs.readFileSync(thumbPath);
        const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
        return { css: `url('${dataUrl}')`, source, isVideo: true, dataUrl };
      }
    } catch (e) {
      console.error(`[bgInfo] ffmpeg 프레임 추출 실패: ${e.message}`);
    }
    return { css: '', source, isVideo: true, dataUrl: '' };
  }
  // 정적 이미지: base64 data URL로 임베딩
  const buf = fs.readFileSync(bgPath);
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  return { css: `url('${dataUrl}')`, source, dataUrl };
}

function sourceLabel(source) {
  if (!source) return '';
  return `<div class="source-text">이미지 출처 : ${source}</div>`;
}

function badgeHTML(category, style = '') {
  if (!category) return '';
  const isBreaking = category === '속보' || category === '긴급';
  const cls = isBreaking ? 'badge breaking' : 'badge';
  const s = style ? ` style="${style}"` : '';
  return `<div class="${cls}"${s}>${isBreaking ? category : category}</div>`;
}

function buildHTML(slide, index) {
  const accent = '#ff6b35';
  const bgData = bgInfo(index);
  const progressPct = total > 1 ? ((index + 1) / total * 100).toFixed(1) : 100;

  // Closing slide: same across all layouts
  if (index === total - 1) return buildClosing(slide, accent, bgData.css, progressPct);

  // Overview slide (roundup headline): always full-bg with dark overlay + headline list
  if (slide.bg_type === 'overview') return buildOverview(slide, accent, bgData.css, progressPct, bgData.source);

  // For full layout, use original builders
  if (layout === 'full') {
    if (index === 0) return buildOpening(slide, accent, bgData.css, progressPct, bgData.source);
    return buildContent(slide, accent, bgData.css, progressPct, index, bgData.source);
  }

  // New layouts: center, top, bottom
  if (index === 0) return buildZonedOpening(slide, accent, bgData, progressPct);
  return buildZonedContent(slide, accent, bgData, progressPct, index);
}

// ──── Common styles for FULL layout ────
function commonStyles(accent, bgImg) {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      width: 1080px; height: 1920px;
      font-family: 'Noto Sans KR', sans-serif;
      color: #ffffff; overflow: hidden; position: relative;
      ${bgImg
        ? `background: ${bgImg} center/cover no-repeat;`
        : `background: linear-gradient(170deg, #0b0e1a 0%, #141b2d 40%, #1a2238 100%);`
      }
    }
    .bg-overlay {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: ${bgImg
        ? 'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.10) 40%, rgba(0,0,0,0.35) 100%)'
        : 'transparent'};
      z-index: 1;
    }
    .grain {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      z-index: 2; opacity: 0.06; pointer-events: none;
    }
    .progress-bar {
      position: absolute; bottom: 0; left: 0;
      height: 6px; z-index: 10;
      background: ${accent};
      border-radius: 0 3px 0 0;
    }
    .source-text {
      position: absolute; bottom: 14px; right: 30px; z-index: 10;
      font-size: 20px; color: rgba(255,255,255,0.35);
      font-weight: 400; letter-spacing: 1px;
    }
    .badge {
      display: inline-block;
      padding: 14px 36px;
      background: linear-gradient(170deg, ${accent} 0%, color-mix(in srgb, ${accent} 70%, #000) 100%);
      border: 3px solid rgba(255,255,255,0.5);
      border-radius: 10px;
      font-size: 34px; font-weight: 900;
      letter-spacing: 6px;
      color: #ffffff;
      box-shadow: 0 6px 20px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.25);
      text-shadow: 0 2px 4px rgba(0,0,0,0.4);
    }
    .badge.breaking {
      padding: 20px 48px;
      background: linear-gradient(170deg, #ff3b3b 0%, #cc0000 50%, #990000 100%);
      border: 4px solid rgba(255,255,255,0.7);
      font-size: 46px; letter-spacing: 8px;
      box-shadow: 0 8px 32px rgba(200,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.3);
      transform: perspective(400px) rotateX(2deg);
    }
    .badge.breaking::after {
      content: 'BREAKING NEWS';
      display: block;
      font-size: 16px; letter-spacing: 4px; font-weight: 700;
      margin-top: 6px; padding-top: 8px;
      border-top: 2px solid rgba(255,255,255,0.5);
      color: rgba(255,255,255,0.9);
    }
    .hl {
      color: #ffd700;
      background: linear-gradient(transparent 60%, rgba(255,215,0,0.18) 60%);
      padding: 0 4px;
    }
    .content-wrap {
      position: relative; z-index: 5;
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      justify-content: center; align-items: center;
    }
  `;
}

// ──── Common styles for ZONED layouts (center, top, bottom) ────
function zonedStyles(accent) {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      width: 1080px; height: 1920px;
      font-family: 'Noto Sans KR', sans-serif;
      color: #ffffff; overflow: hidden; position: relative;
      background: #0b0e1a;
    }
    .grain {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      z-index: 2; opacity: 0.06; pointer-events: none;
    }
    .source-text {
      position: absolute; bottom: 14px; right: 30px; z-index: 10;
      font-size: 20px; color: rgba(255,255,255,0.35);
      font-weight: 400; letter-spacing: 1px;
    }
    .badge {
      display: inline-block;
      padding: 14px 36px;
      background: linear-gradient(170deg, #ff4d4d 0%, #cc0000 100%);
      border: 3px solid rgba(255,255,255,0.5);
      border-radius: 10px;
      font-size: 34px; font-weight: 900;
      letter-spacing: 6px;
      color: #ffffff;
      box-shadow: 0 6px 20px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.25);
      text-shadow: 0 2px 4px rgba(0,0,0,0.4);
    }
    .badge.breaking {
      padding: 20px 48px;
      background: linear-gradient(170deg, #ff3b3b 0%, #cc0000 50%, #990000 100%);
      border: 4px solid rgba(255,255,255,0.7);
      font-size: 46px; letter-spacing: 8px;
      box-shadow: 0 8px 32px rgba(200,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.3);
      transform: perspective(400px) rotateX(2deg);
    }
    .badge.breaking::after {
      content: 'BREAKING NEWS';
      display: block;
      font-size: 16px; letter-spacing: 4px; font-weight: 700;
      margin-top: 6px; padding-top: 8px;
      border-top: 2px solid rgba(255,255,255,0.5);
      color: rgba(255,255,255,0.9);
    }
    .hl {
      color: #ffd700;
      background: linear-gradient(transparent 60%, rgba(255,215,0,0.18) 60%);
      padding: 0 4px;
    }
    .image-zone {
      position: relative;
      width: 100%;
      overflow: hidden;
      background: linear-gradient(135deg, #141b2d 0%, #1a2238 100%);
    }
    .image-zone img {
      width: 100%; height: 100%;
      object-fit: cover; display: block;
    }
    .text-zone {
      position: relative; z-index: 5;
      width: 100%;
      display: flex; flex-direction: column;
      justify-content: center; align-items: center;
      padding: 40px 60px;
      background: linear-gradient(180deg, rgba(5,8,20,0.92) 0%, rgba(5,8,20,0.75) 100%);
    }
    .main-text {
      font-size: 72px; font-weight: 900;
      text-align: center; line-height: 1.35;
      padding: 0 20px;
      text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 40px rgba(0,0,0,0.7);
    }
    .sub-text {
      font-size: 44px; color: rgba(255,255,255,0.6);
      text-align: center; font-weight: 400; padding: 0 30px;
      margin-top: 30px;
      text-shadow: 0 2px 8px rgba(0,0,0,0.8);
    }
    .slide-num {
      position: absolute; bottom: 40px; left: 50px; z-index: 10;
      font-size: 26px; font-weight: 700; color: rgba(255,255,255,0.18);
      letter-spacing: 3px;
    }
    .corner-tl, .corner-br {
      position: absolute; width: 50px; height: 50px; z-index: 10;
    }
    .corner-tl {
      top: 30px; left: 30px;
      border-top: 2px solid ${accent}44;
      border-left: 2px solid ${accent}44;
    }
    .corner-br {
      bottom: 30px; right: 30px;
      border-bottom: 2px solid ${accent}44;
      border-right: 2px solid ${accent}44;
    }
  `;
}

function grainSVG() {
  return `<svg class="grain" xmlns="http://www.w3.org/2000/svg">
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/></filter>
    <rect width="100%" height="100%" filter="url(#grain)"/>
  </svg>`;
}

function progressBar(pct) {
  return '';  // 프로그레스바 비활성화
}

// ──── Image zone HTML for zoned layouts ────
function imageZoneHTML(bgData, heightPct) {
  const imgTag = bgData.dataUrl
    ? `<img src="${bgData.dataUrl}" style="width:100%;height:100%;object-fit:cover;">`
    : '';
  return `<div class="image-zone" style="height:${heightPct}%;">${imgTag}</div>`;
}

// ════════════════════════════════════════════════════════════════════
// FULL LAYOUT builders (original code, unchanged)
// ════════════════════════════════════════════════════════════════════

// ──── Opening 슬라이드 ────
function buildOpening(slide, accent, bgImg, progressPct, bgSource) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${commonStyles(accent, bgImg)}
  .top-bar { display: none; }
  .accent-stripe { display: none; }
  .main-text {
    font-size: 110px; font-weight: 900;
    text-align: center; line-height: 1.2;
    padding: 0 60px;
    text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 50px rgba(0,0,0,0.7);
    letter-spacing: -2px;
  }
  .sub-text {
    font-size: 46px; color: rgba(255,255,255,0.65);
    text-align: center; font-weight: 400; padding: 0 100px;
    margin-top: 50px;
    text-shadow: 0 2px 10px rgba(0,0,0,0.9);
  }
  .badge { margin-bottom: 60px; }
</style></head>
<body>
  <div class="bg-overlay"></div>
  ${grainSVG()}
  <div class="top-bar"></div>
  <div class="accent-stripe"></div>
  <div class="content-wrap">
    ${badgeHTML(slide.category)}
    <div class="main-text">${slide.main}</div>
    ${slide.sub ? `<div class="sub-text">${slide.sub}</div>` : ''}
  </div>
  ${sourceLabel(bgSource)}
  ${progressBar(progressPct)}
</body></html>`;
}

// ──── Content 슬라이드 ────
function buildContent(slide, accent, bgImg, progressPct, index, bgSource) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${commonStyles(accent, bgImg)}
  .top-bar { display: none; }
  .divider-top, .divider-bottom {
    width: 120px; height: 2px;
    background: rgba(255,255,255,0.15);
  }
  .divider-top { margin-bottom: 50px; }
  .divider-bottom { margin-top: 50px; }
  .main-text {
    font-size: 76px; font-weight: 900;
    text-align: center; line-height: 1.35;
    padding: 0 80px;
    text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 40px rgba(0,0,0,0.7);
  }
  .sub-text {
    font-size: 44px; color: rgba(255,255,255,0.6);
    text-align: center; font-weight: 400; padding: 0 90px;
    margin-top: 36px;
    text-shadow: 0 2px 8px rgba(0,0,0,0.8);
  }
  .badge { margin-bottom: 24px; }
  .slide-num {
    position: absolute; bottom: 40px; left: 50px; z-index: 10;
    font-size: 26px; font-weight: 700; color: rgba(255,255,255,0.18);
    letter-spacing: 3px;
  }
  .corner-tl, .corner-br {
    position: absolute; width: 50px; height: 50px; z-index: 10;
  }
  .corner-tl {
    top: 30px; left: 30px;
    border-top: 2px solid ${accent}44;
    border-left: 2px solid ${accent}44;
  }
  .corner-br {
    bottom: 30px; right: 30px;
    border-bottom: 2px solid ${accent}44;
    border-right: 2px solid ${accent}44;
  }
</style></head>
<body>
  <div class="bg-overlay"></div>
  ${grainSVG()}
  <div class="top-bar"></div>
  <div class="corner-tl"></div>
  <div class="corner-br"></div>
  <div class="content-wrap">
    ${badgeHTML(slide.category)}
    <div class="divider-top"></div>
    <div class="main-text">${slide.main}</div>
    ${slide.sub ? `<div class="sub-text">${slide.sub}</div>` : ''}
    <div class="divider-bottom"></div>
  </div>
  <div class="slide-num">${String(index).padStart(2, '0')}</div>
  ${sourceLabel(bgSource)}
  ${progressBar(progressPct)}
</body></html>`;
}

// ──── Closing 슬라이드 (shared across all layouts) ────
function buildClosing(slide, accent, bgImg, progressPct) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${commonStyles(accent, bgImg)}
  .brand-text {
    font-size: 110px; font-weight: 900;
    text-align: center; letter-spacing: 8px;
    text-shadow: 0 2px 8px rgba(0,0,0,0.9), 0 4px 40px rgba(0,0,0,0.6);
  }
  .main-text {
    font-size: 46px; font-weight: 400;
    text-align: center; padding: 0 100px;
    color: rgba(255,255,255,0.55);
    margin-top: 40px;
  }
  .bracket-tl, .bracket-tr, .bracket-bl, .bracket-br {
    position: absolute; width: 80px; height: 80px; z-index: 10;
  }
  .bracket-tl {
    top: 50px; left: 50px;
    border-top: 3px solid ${accent};
    border-left: 3px solid ${accent};
  }
  .bracket-tr {
    top: 50px; right: 50px;
    border-top: 3px solid ${accent};
    border-right: 3px solid ${accent};
  }
  .bracket-bl {
    bottom: 50px; left: 50px;
    border-bottom: 3px solid ${accent};
    border-left: 3px solid ${accent};
  }
  .bracket-br {
    bottom: 50px; right: 50px;
    border-bottom: 3px solid ${accent};
    border-right: 3px solid ${accent};
  }
</style></head>
<body>
  <div class="bg-overlay"></div>
  ${grainSVG()}
  <div class="bracket-tl"></div>
  <div class="bracket-tr"></div>
  <div class="bracket-bl"></div>
  <div class="bracket-br"></div>
  <div class="content-wrap">
    <div class="main-text">${slide.main || ''}</div>
  </div>
  ${progressBar(progressPct)}
</body></html>`;
}

// ──── Overview 슬라이드 (라운드업 헤드라인) ────
function buildOverview(slide, accent, bgImg, progressPct, bgSource) {
  // sub에서 헤드라인 항목 파싱: "① 제목1 ② 제목2 ..." 또는 "- 제목1\n- 제목2"
  const sub = slide.sub || '';
  let headlines = [];

  // ① ② ③ ④ ⑤ 패턴 파싱
  const circled = sub.match(/[①②③④⑤⑥⑦⑧⑨⑩]\s*[^①②③④⑤⑥⑦⑧⑨⑩]*/g);
  if (circled && circled.length >= 2) {
    headlines = circled.map(h => h.trim());
  } else {
    // "- " 또는 줄바꿈 기반 파싱
    headlines = sub.split(/[\n·]/).map(h => h.trim()).filter(h => h.length > 0);
  }

  const listHTML = headlines.map((h, i) => {
    const num = String(i + 1).padStart(2, '0');
    // 번호 기호(①②...) 제거 후 텍스트만
    const text = h.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').replace(/^-\s*/, '').replace(/^\d+\.\s*/, '');
    return `<div class="headline-item">
      <span class="headline-num">${num}</span>
      <span class="headline-text">${text}</span>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: 1080px; height: 1920px;
    font-family: 'Noto Sans KR', sans-serif;
    color: #ffffff; overflow: hidden; position: relative;
    ${bgImg
      ? `background: ${bgImg} center/cover no-repeat;`
      : `background: linear-gradient(170deg, #0b0e1a 0%, #141b2d 40%, #1a2238 100%);`
    }
  }
  .bg-overlay {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: ${bgImg
      ? 'linear-gradient(180deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.80) 50%, rgba(0,0,0,0.85) 100%)'
      : 'transparent'};
    z-index: 1;
  }
  .grain {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    z-index: 2; opacity: 0.06; pointer-events: none;
  }
  .content-wrap {
    position: relative; z-index: 5;
    width: 100%; height: 100%;
    display: flex; flex-direction: column;
    padding: 120px 80px 100px;
  }
  /* 상단 배지 */
  .badge {
    display: inline-block;
    padding: 14px 36px;
    background: linear-gradient(170deg, ${accent} 0%, color-mix(in srgb, ${accent} 70%, #000) 100%);
    border: 3px solid rgba(255,255,255,0.5);
    border-radius: 10px;
    font-size: 34px; font-weight: 900;
    letter-spacing: 4px; text-transform: uppercase;
    color: #ffffff;
    align-self: flex-start;
    margin-bottom: 40px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.25);
    text-shadow: 0 2px 4px rgba(0,0,0,0.4);
  }
  /* 타이틀 */
  .title-area {
    margin-bottom: 60px;
  }
  .main-title {
    font-size: 92px; font-weight: 900;
    line-height: 1.25;
    text-shadow: 0 4px 16px rgba(0,0,0,0.95), 0 8px 40px rgba(0,0,0,0.7);
  }
  .hl {
    color: #ffd700;
    background: linear-gradient(transparent 60%, rgba(255,215,0,0.18) 60%);
    padding: 0 4px;
  }
  /* 구분선 */
  .divider {
    width: 160px; height: 4px;
    background: rgba(255,255,255,0.15);
    margin-bottom: 50px;
    border-radius: 2px;
  }
  /* 헤드라인 리스트 */
  .headline-list {
    display: flex; flex-direction: column;
    gap: 28px; flex: 1;
    justify-content: center;
  }
  .headline-item {
    display: flex; align-items: center;
    gap: 24px;
    padding: 28px 36px;
    background: rgba(0,0,0,0.45);
    border-left: 5px solid ${accent};
    border-radius: 0 12px 12px 0;
    backdrop-filter: blur(8px);
  }
  .headline-num {
    font-size: 36px; font-weight: 900;
    color: ${accent};
    min-width: 56px;
    text-align: center;
    text-shadow: 0 2px 6px rgba(0,0,0,0.8);
  }
  .headline-text {
    font-size: 44px; font-weight: 700;
    line-height: 1.35;
    text-shadow: 0 2px 10px rgba(0,0,0,0.9), 0 4px 20px rgba(0,0,0,0.6);
  }
  .source-text {
    position: absolute; bottom: 14px; right: 30px; z-index: 10;
    font-size: 20px; color: rgba(255,255,255,0.35);
    font-weight: 400; letter-spacing: 1px;
  }
  .progress-bar {
    position: absolute; bottom: 0; left: 0;
    height: 6px; z-index: 10;
    background: ${accent};
    border-radius: 0 3px 0 0;
  }
</style></head>
<body>
  <div class="bg-overlay"></div>
  ${grainSVG()}
  <div class="content-wrap">
    ${badgeHTML(slide.category)}
    <div class="title-area">
      <div class="main-title">${slide.main}</div>
    </div>
    <div class="divider"></div>
    <div class="headline-list">
      ${listHTML}
    </div>
  </div>
  ${sourceLabel(bgSource)}
  ${progressBar(progressPct)}
</body></html>`;
}

// ════════════════════════════════════════════════════════════════════
// ZONED LAYOUT builders (center, top, bottom)
// ════════════════════════════════════════════════════════════════════

// ──── Zoned Opening 슬라이드 ────
function buildZonedOpening(slide, accent, bgData, progressPct) {
  const textHTML = `
    ${badgeHTML(slide.category, 'margin-bottom:40px')}
    <div class="main-text" style="font-size:100px;line-height:1.2;letter-spacing:-2px;">${slide.main}</div>
    ${slide.sub ? `<div class="sub-text" style="font-size:44px;">${slide.sub}</div>` : ''}
  `;

  let bodyContent = '';
  if (layout === 'center') {
    bodyContent = `
      <div class="text-zone" style="height:35%;justify-content:flex-end;padding-bottom:20px;">
        ${badgeHTML(slide.category)}
        <div class="main-text" style="font-size:96px;line-height:1.2;letter-spacing:-2px;margin-top:16px;">${slide.main}</div>
      </div>
      ${imageZoneHTML(bgData, 40)}
      <div class="text-zone" style="height:25%;justify-content:flex-start;padding-top:20px;">
        ${slide.sub ? `<div class="sub-text" style="margin-top:0;">${slide.sub}</div>` : ''}
      </div>
    `;
  } else if (layout === 'top') {
    bodyContent = `
      ${imageZoneHTML(bgData, 50)}
      <div class="text-zone" style="height:50%;">
        ${textHTML}
      </div>
    `;
  } else if (layout === 'bottom') {
    bodyContent = `
      <div class="text-zone" style="height:50%;">
        ${textHTML}
      </div>
      ${imageZoneHTML(bgData, 50)}
    `;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${zonedStyles(accent)}
  .main-text { font-size: 84px; }
</style></head>
<body>
  ${grainSVG()}
  ${bodyContent}
  ${sourceLabel(bgData.source)}
</body></html>`;
}

// ──── Zoned Content 슬라이드 ────
function buildZonedContent(slide, accent, bgData, progressPct, index) {
  const textHTML = `
    ${badgeHTML(slide.category, 'margin-bottom:20px')}
    <div class="main-text">${slide.main}</div>
    ${slide.sub ? `<div class="sub-text">${slide.sub}</div>` : ''}
  `;

  let bodyContent = '';
  if (layout === 'center') {
    bodyContent = `
      <div class="text-zone" style="height:25%;justify-content:flex-end;padding-bottom:20px;">
        ${badgeHTML(slide.category)}
        <div class="main-text" style="font-size:68px;">${slide.main}</div>
      </div>
      ${imageZoneHTML(bgData, 50)}
      <div class="text-zone" style="height:25%;justify-content:flex-start;padding-top:20px;">
        ${slide.sub ? `<div class="sub-text" style="margin-top:0;">${slide.sub}</div>` : ''}
      </div>
    `;
  } else if (layout === 'top') {
    bodyContent = `
      ${imageZoneHTML(bgData, 50)}
      <div class="text-zone" style="height:50%;">
        ${textHTML}
      </div>
    `;
  } else if (layout === 'bottom') {
    bodyContent = `
      <div class="text-zone" style="height:50%;">
        ${textHTML}
      </div>
      ${imageZoneHTML(bgData, 50)}
    `;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${zonedStyles(accent)}
</style></head>
<body>
  ${grainSVG()}
  <div class="corner-tl"></div>
  <div class="corner-br"></div>
  ${bodyContent}
  <div class="slide-num">${String(index).padStart(2, '0')}</div>
  ${sourceLabel(bgData.source)}
</body></html>`;
}

// ════════════════════════════════════════════════════════════════════
// Main execution
// ════════════════════════════════════════════════════════════════════

async function main() {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });

  const result = [];
  for (let i = 0; i < slides.length; i++) {
    const html = buildHTML(slides[i], i);
    await page.setContent(html, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 500));
    const outPath = path.join(outputDir, `slide_${i + 1}.png`);
    await page.screenshot({ path: outPath, type: 'png' });
    result.push(outPath);
    console.log(`slide_${i + 1}.png`);

    // 배경이 있으면 투명 배경 오버레이 PNG도 생성 (Ken Burns/영상 합성용)
    const bg = backgrounds[i];
    const bgPath = bg && bg.path ? bg.path : '';
    const bgExt = bgPath ? path.extname(bgPath).toLowerCase() : '';
    const isVideoBg = bgExt === '.mp4' || bgExt === '.gif';

    // 배경 이미지/영상이 있으면 overlay 생성 (Ken Burns / 영상 합성용)
    const needOverlay = bgPath && fs.existsSync(bgPath);

    if (needOverlay) {
      if (layout === 'full') {
        await page.evaluate(() => {
          document.body.style.background = 'transparent';
          const overlay = document.querySelector('.bg-overlay');
          if (overlay) overlay.style.background = 'transparent';
          const grain = document.querySelector('.grain');
          if (grain) grain.style.display = 'none';
        });
      } else {
        // zoned layout: 이미지 영역을 투명하게, 텍스트 영역만 유지
        await page.evaluate(() => {
          document.body.style.background = 'transparent';
          const imgZone = document.querySelector('.image-zone');
          if (imgZone) { imgZone.style.background = 'transparent'; imgZone.innerHTML = ''; }
        });
      }
      await new Promise(r => setTimeout(r, 200));
      const overlayPath = path.join(outputDir, `slide_${i + 1}_overlay.png`);
      await page.screenshot({ path: overlayPath, type: 'png', omitBackground: true });
      console.log(`slide_${i + 1}_overlay.png`);
    }
  }

  await browser.close();
  console.log('__RESULT__' + JSON.stringify(result));
}

main().catch(e => { console.error(e); process.exit(1); });
