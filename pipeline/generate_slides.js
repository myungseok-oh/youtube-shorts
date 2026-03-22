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
const bgDisplayMode = data.bgDisplayMode || 'zone';
const skipOverlay = data.skipOverlay || false;
const slideOverrides = data.slideOverrides || {};  // {1: {main, sub, x, y, mainSize, subSize, hidden}, ...}
const total = slides.length;

// 상:중:하 비율 (center/top/bottom 레이아웃 전용)
const _zoneRatioRaw = data.zoneRatio || '';  // "1.5:7:1.5", "2:6:2" 등
const _zoneRatioParts = _zoneRatioRaw.split(':').map(Number).filter(n => !isNaN(n) && n >= 0);
const zoneRatio = _zoneRatioParts.length === 3 ? _zoneRatioParts : [3, 4, 3]; // 기본값
const _zrTotal = zoneRatio[0] + zoneRatio[1] + zoneRatio[2];
const zoneTopPct = (zoneRatio[0] / _zrTotal * 100).toFixed(1);
const zoneMidPct = (zoneRatio[1] / _zrTotal * 100).toFixed(1);
const zoneBotPct = (zoneRatio[2] / _zrTotal * 100).toFixed(1);

// 메인/서브 텍스트 zone 배치 (center 레이아웃 전용)
// "top" = 상단 zone, "bottom" = 하단 zone
const mainZone = data.mainZone || 'top';
const subZone = data.subZone || 'bottom';

// 텍스트 영역 배경 불투명도 (0~10, 기본 4)
const _textBgVal = data.textBg != null ? Number(data.textBg) : 4;
const textBgOpacity = Math.max(0, Math.min(1, _textBgVal / 10));

// 서브 텍스트 크기 (0이면 기본 56px)
const _subTextSize = data.subTextSize || 0;

// 채널별 스타일 파라미터
const _accentColor = data.accentColor || '';
const _hlColor = data.hlColor || '#ffd700';
const _bgGradRaw = data.bgGradient || '';
const _bgGrad = _bgGradRaw.split(',').map(s => s.trim()).filter(Boolean);
const bgGrad0 = _bgGrad[0] || '#0b0e1a';
const bgGrad1 = _bgGrad[1] || '#141b2d';
const bgGrad2 = _bgGrad[2] || '#1a2238';
const _mainTextSize = data.mainTextSize || 0;
const _badgeSize = data.badgeSize || 0;
const _showBadge = data.showBadge !== false;      // 기본 true, false면 뱃지 숨김
const _showSlideNum = data.showSlideNum || false;  // 기본 false, 라운드업만 true

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
  if (!category || !_showBadge) return '';
  const isBreaking = category === '속보' || category === '긴급';
  const cls = isBreaking ? 'badge breaking' : 'badge';
  const s = style ? ` style="${style}"` : '';
  return `<div class="${cls}"${s}>${isBreaking ? category : category}</div>`;
}

function buildHTML(slide, index) {
  const slideNum = index + 1;
  const ovr = slideOverrides[slideNum] || {};

  // 오버라이드가 있으면 slide 복사 후 적용
  const s = { ...slide };
  if (ovr.main !== undefined) s.main = ovr.main;
  if (ovr.sub !== undefined) s.sub = ovr.sub;

  const accent = _accentColor || s.accent || '#ff6b35';
  const bgData = bgInfo(index);
  const progressPct = total > 1 ? ((slideNum) / total * 100).toFixed(1) : 100;

  // hidden 오버라이드: 텍스트 없이 배경만 렌더 (오버레이 제거)
  if (ovr.hidden) {
    return buildHiddenOverlay(s, bgData.css, progressPct);
  }

  // Closing slide: only if explicitly marked as closing (bg_type empty/closing)
  // Content slides with bg_type (photo, graph, broll, etc.) are rendered normally
  const isClosing = index === total - 1 && (!s.bg_type || s.bg_type === 'closing');
  if (isClosing) return buildClosing(s, accent, bgData.css, progressPct);

  // Overview slide (roundup headline): always full-bg with dark overlay + headline list
  if (s.bg_type === 'overview') return buildOverview(s, accent, bgData.css, progressPct, bgData.source);

  // 위치/크기 오버라이드가 있으면 커스텀 렌더링
  if (ovr.x !== undefined || ovr.y !== undefined || ovr.mainSize || ovr.subSize) {
    return buildCustomContent(s, accent, bgData.css, progressPct, index, bgData.source, ovr);
  }

  // For full layout, use original builders
  if (layout === 'full') {
    if (index === 0) return buildOpening(s, accent, bgData.css, progressPct, bgData.source);
    return buildContent(s, accent, bgData.css, progressPct, index, bgData.source);
  }

  // Fullscreen mode: full-bg image with semi-transparent text zones
  // top/bottom 레이아웃은 이미지가 특정 영역에만 표시되어야 하므로 zoned 방식 사용
  if (bgDisplayMode === 'fullscreen' && (layout === 'full' || layout === 'center')) {
    if (index === 0) return buildFullscreenOpening(s, accent, bgData, progressPct);
    return buildFullscreenContent(s, accent, bgData, progressPct, index);
  }

  // Zone mode (default): image in designated zone
  if (index === 0) return buildZonedOpening(s, accent, bgData, progressPct);
  return buildZonedContent(s, accent, bgData, progressPct, index);
}

// ──── Hidden overlay (배경만, 텍스트 없음) ────
function buildHiddenOverlay(slide, bgImg, progressPct) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: 1080px; height: 1920px;
    font-family: 'Noto Sans KR', sans-serif;
    overflow: hidden; position: relative;
    ${bgImg ? `background: ${bgImg} center/cover no-repeat;` : `background: ${bgGrad0};`}
  }
</style></head>
<body></body></html>`;
}

// ──── Custom position/size content (오버라이드 적용) ────
function buildCustomContent(slide, accent, bgImg, progressPct, index, bgSource, ovr) {
  const mainSize = ovr.mainSize || 100;
  const subSize = ovr.subSize || 52;
  const posX = ovr.x !== undefined ? ovr.x : 540;
  const posY = ovr.y !== undefined ? ovr.y : 960;
  const maxW = ovr.maxWidth || 1000;
  const mainColor = ovr.mainColor || '#ffffff';
  const subColor = ovr.subColor || 'rgba(255,255,255,0.92)';
  const fontFam = ovr.fontFamily || 'Noto Sans KR';
  const bgOp = ovr.bgOpacity !== undefined ? ovr.bgOpacity / 100 : textBgOpacity;

  // 커스텀 폰트용 Google Fonts import
  const fontImports = [
    'Noto+Sans+KR:wght@400;700;900',
    'Black+Han+Sans',
    'Jua',
    'Do+Hyeon',
    'Gothic+A1:wght@400;700;900',
    'Nanum+Gothic:wght@400;700',
    'Nanum+Myeongjo:wght@400;700',
    'Gaegu:wght@400;700',
  ].map(f => `@import url('https://fonts.googleapis.com/css2?family=${f}&display=swap');`).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${fontImports}
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: 1080px; height: 1920px;
    font-family: '${fontFam}', 'Noto Sans KR', sans-serif;
    color: #ffffff; overflow: hidden; position: relative;
    word-break: keep-all; overflow-wrap: break-word;
    ${bgImg
      ? `background: ${bgImg} center/cover no-repeat;`
      : `background: linear-gradient(170deg, ${bgGrad0} 0%, ${bgGrad1} 40%, ${bgGrad2} 100%);`
    }
  }
  .bg-overlay {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: ${bgImg
      ? 'linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.03) 40%, rgba(0,0,0,0.15) 100%)'
      : 'transparent'};
    z-index: 1;
  }
  .content-wrap {
    position: absolute;
    left: ${posX}px; top: ${posY}px;
    transform: translate(-50%, -50%);
    z-index: 5;
    display: flex; flex-direction: column; align-items: center;
    max-width: ${maxW}px;
  }
  .text-bg {
    background: rgba(5, 8, 20, ${bgOp});
    border-radius: 16px;
    padding: 30px 40px;
  }
  .main-text {
    font-size: ${mainSize}px; font-weight: 900;
    color: ${mainColor};
    text-align: center; line-height: 1.25;
    text-shadow: 0 4px 16px rgba(0,0,0,0.95), 0 8px 40px rgba(0,0,0,0.7);
  }
  .sub-text {
    font-size: ${subSize}px; color: ${subColor};
    text-align: center; font-weight: 700;
    margin-top: 30px;
    text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 30px rgba(0,0,0,0.7);
  }
  .slide-num {
    position: absolute; bottom: 40px; left: 50px; z-index: 10;
    font-size: 26px; font-weight: 700; color: rgba(255,255,255,0.18);
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
  .grain {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    z-index: 2; opacity: 0.06; pointer-events: none;
  }
</style></head>
<body>
  <div class="bg-overlay"></div>
  ${grainSVG()}
  <div class="content-wrap">
    <div class="text-bg">
      <div class="main-text">${slide.main}</div>
      ${slide.sub ? `<div class="sub-text">${slide.sub}</div>` : ''}
    </div>
  </div>
  ${_showSlideNum ? `<div class="slide-num">${String(index).padStart(2, '0')}</div>` : ''}
  ${sourceLabel(bgSource)}
  ${progressBar(progressPct)}
</body></html>`;
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
      word-break: keep-all; overflow-wrap: break-word;
      ${bgImg
        ? `background: ${bgImg} center/cover no-repeat;`
        : `background: linear-gradient(170deg, ${bgGrad0} 0%, ${bgGrad1} 40%, ${bgGrad2} 100%);`
      }
    }
    .bg-overlay {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: ${bgImg
        ? 'linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.03) 40%, rgba(0,0,0,0.15) 100%)'
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
      font-size: ${_badgeSize || 34}px; font-weight: 900;
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
      color: ${_hlColor};
      background: linear-gradient(transparent 60%, ${_hlColor}2E 60%);
      padding: 0 4px;
    }
    .content-wrap {
      position: relative; z-index: 5;
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      justify-content: center; align-items: center;
    }
    .text-bg {
      background: rgba(5,8,20,0.40);
      border-radius: 20px;
      padding: 40px 50px;
      max-width: 95%;
      display: flex; flex-direction: column;
      align-items: center;
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
      word-break: keep-all; overflow-wrap: break-word;
      background: ${bgGrad0};
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
      font-size: ${_badgeSize || 34}px; font-weight: 900;
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
      color: ${_hlColor};
      background: linear-gradient(transparent 60%, ${_hlColor}2E 60%);
      padding: 0 4px;
    }
    .image-zone {
      position: relative;
      width: 100%;
      overflow: hidden;
      background: linear-gradient(135deg, ${bgGrad1} 0%, ${bgGrad2} 100%);
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
      background: rgba(5,8,20,${textBgOpacity});
    }
    .text-zone-top {
      justify-content: flex-end !important; padding-bottom: 30px;
      border-bottom: 2px solid rgba(255,255,255,0.12);
    }
    .text-zone-bot {
      justify-content: flex-start !important; padding-top: 16px !important;
      border-top: 2px solid rgba(255,255,255,0.12);
    }
    .main-text {
      font-size: ${_mainTextSize || 100}px; font-weight: 900;
      text-align: center; line-height: 1.25;
      padding: 0 20px;
      text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 40px rgba(0,0,0,0.7);
    }
    .sub-text {
      font-size: ${_subTextSize || 56}px; color: rgba(255,255,255,0.92);
      text-align: center; font-weight: 700; padding: 0 30px;
      margin-top: 30px;
      text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 30px rgba(0,0,0,0.7);
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

// ──── Common styles for FULLSCREEN ZONED layouts ────
function fullscreenZonedStyles(accent, bgImg) {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      width: 1080px; height: 1920px;
      font-family: 'Noto Sans KR', sans-serif;
      color: #ffffff; overflow: hidden; position: relative;
      word-break: keep-all; overflow-wrap: break-word;
      ${bgImg
        ? `background: ${bgImg} center/cover no-repeat;`
        : `background: linear-gradient(170deg, ${bgGrad0} 0%, ${bgGrad1} 40%, ${bgGrad2} 100%);`
      }
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
      font-size: ${_badgeSize || 34}px; font-weight: 900;
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
      color: ${_hlColor};
      background: linear-gradient(transparent 60%, ${_hlColor}2E 60%);
      padding: 0 4px;
    }
    .text-zone {
      position: relative; z-index: 5;
      width: 100%;
      display: flex; flex-direction: column;
      justify-content: center; align-items: center;
      padding: 40px 60px;
      background: linear-gradient(180deg, rgba(5,8,20,0.40) 0%, rgba(5,8,20,0.20) 100%);
      backdrop-filter: blur(4px);
    }
    .text-zone-top {
      justify-content: flex-end !important; padding-bottom: 30px;
    }
    .text-zone-bot {
      justify-content: flex-start !important; padding-top: 16px !important;
    }
    .main-text {
      font-size: ${_mainTextSize || 100}px; font-weight: 900;
      text-align: center; line-height: 1.25;
      padding: 0 20px;
      text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 40px rgba(0,0,0,0.7);
    }
    .sub-text {
      font-size: ${_subTextSize || 56}px; color: rgba(255,255,255,0.92);
      text-align: center; font-weight: 700; padding: 0 30px;
      margin-top: 30px;
      text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 30px rgba(0,0,0,0.7);
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

// ──── Image zone HTML for zoned layouts ────
function imageZoneHTML(bgData, heightPct) {
  // 모든 레이아웃에서 cover 사용 (9:16 이미지 대응, 좌우 빈 공간 방지)
  const fit = 'cover';
  const pos = layout === 'bottom' ? 'top' : layout === 'top' ? 'bottom' : 'center';
  const imgTag = bgData.dataUrl
    ? `<img src="${bgData.dataUrl}" style="width:100%;height:100%;object-fit:${fit};object-position:${pos};">`
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
    font-size: ${_mainTextSize ? _mainTextSize + 10 : 110}px; font-weight: 900;
    text-align: center; line-height: 1.25;
    padding: 0 50px;
    text-shadow: 0 4px 16px rgba(0,0,0,0.95), 0 8px 50px rgba(0,0,0,0.7);
    letter-spacing: -3px;
  }
  .sub-text {
    font-size: ${_subTextSize || 56}px; color: rgba(255,255,255,0.92);
    text-align: center; font-weight: 700; padding: 0 60px;
    margin-top: 40px;
    text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 30px rgba(0,0,0,0.7);
  }
  .badge { margin-bottom: 60px; }
</style></head>
<body>
  <div class="bg-overlay"></div>
  ${grainSVG()}
  <div class="top-bar"></div>
  <div class="accent-stripe"></div>
  <div class="content-wrap">
    <div class="text-bg">
      <div class="main-text">${slide.main}</div>
      ${slide.sub ? `<div class="sub-text">${slide.sub}</div>` : ''}
    </div>
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
    font-size: ${_mainTextSize || 100}px; font-weight: 900;
    text-align: center; line-height: 1.25;
    padding: 0 50px;
    text-shadow: 0 4px 16px rgba(0,0,0,0.95), 0 8px 40px rgba(0,0,0,0.7);
  }
  .sub-text {
    font-size: ${_subTextSize || 52}px; color: rgba(255,255,255,0.92);
    text-align: center; font-weight: 700; padding: 0 50px;
    margin-top: 30px;
    text-shadow: 0 3px 12px rgba(0,0,0,0.95), 0 6px 30px rgba(0,0,0,0.7);
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
    <div class="text-bg">
      <div class="main-text">${slide.main}</div>
      ${slide.sub ? `<div class="sub-text">${slide.sub}</div>` : ''}
    </div>
  </div>
  ${_showSlideNum ? `<div class="slide-num">${String(index).padStart(2, '0')}</div>` : ''}
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
    font-size: ${_mainTextSize ? _mainTextSize + 10 : 110}px; font-weight: 900;
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
    // (1) (2) (3) ... 패턴 파싱
    const paren = sub.match(/\(\d+\)\s*[^(]*/g);
    if (paren && paren.length >= 2) {
      headlines = paren.map(h => h.trim());
    } else {
      // "- " 또는 줄바꿈 기반 파싱
      headlines = sub.split(/[\n·]/).map(h => h.trim()).filter(h => h.length > 0);
    }
  }

  const listHTML = headlines.map((h, i) => {
    const num = String(i + 1).padStart(2, '0');
    // 번호 기호(①②..., (1)...) 제거 후 텍스트만
    const text = h.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').replace(/^\(\d+\)\s*/, '').replace(/^-\s*/, '').replace(/^\d+\.\s*/, '');
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
      : `background: linear-gradient(170deg, ${bgGrad0} 0%, ${bgGrad1} 40%, ${bgGrad2} 100%);`
    }
  }
  .bg-overlay {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: ${bgImg
      ? (layout === 'full'
        ? 'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.10) 40%, rgba(0,0,0,0.65) 100%)'
        : layout === 'top'
        ? 'linear-gradient(180deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.15) 50%, rgba(0,0,0,0.60) 100%)'
        : 'linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.25) 40%, rgba(0,0,0,0.10) 100%)')
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
    ${layout === 'full' ? 'justify-content: flex-end; padding: 0 70px 140px;'
    : layout === 'top' ? `justify-content: flex-end; padding: 0 70px ${zoneTopPct === '0.0' ? '40' : '60'}px;`
    : layout === 'bottom' ? ''
    : 'justify-content: center; padding: 0 70px;'}
  }
  .ov-spacer {
    height: ${layout === 'bottom' ? zoneTopPct : layout === 'top' ? (parseFloat(zoneTopPct) + parseFloat(zoneMidPct)).toFixed(1) : '0'}%;
    ${layout === 'full' || layout === 'center' ? 'display: none;' : ''}
  }
  .ov-content {
    ${layout === 'bottom' ? `height: ${(parseFloat(zoneMidPct) + parseFloat(zoneBotPct)).toFixed(1)}%;` : ''}
    ${layout === 'top' ? `height: ${zoneBotPct}%;` : ''}
    display: flex; flex-direction: column;
    justify-content: flex-start;
    padding: ${layout === 'full' ? '0' : '40px 70px 0'};
  }
  /* 카테고리 배지 */
  .badge {
    display: inline-block;
    padding: 12px 32px;
    background: ${accent};
    border-radius: 8px;
    font-size: ${_badgeSize || 34}px; font-weight: 700;
    letter-spacing: 2px;
    color: #ffffff;
    align-self: flex-start;
    margin-bottom: 30px;
    text-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
  /* 타이틀 */
  .main-title {
    font-size: 88px; font-weight: 900;
    line-height: 1.2;
    color: #ffffff;
    max-width: 960px;
    word-break: keep-all;
    text-shadow: 0 4px 16px rgba(0,0,0,0.6);
    margin-bottom: 36px;
  }
  .hl {
    color: ${_hlColor};
    background: linear-gradient(transparent 55%, ${_hlColor}40 55%);
    padding: 0 4px;
  }
  /* 구분선 */
  .accent-bar {
    width: 80px; height: 6px;
    background: ${accent};
    border-radius: 3px;
    margin-bottom: 40px;
  }
  /* 헤드라인 리스트 */
  .headline-list {
    display: flex; flex-direction: column;
    gap: 20px;
  }
  .headline-item {
    display: flex; align-items: center;
    gap: 20px;
    padding: 20px 28px;
    background: rgba(0,0,0,0.55);
    border-left: 5px solid ${accent};
    border-radius: 0 10px 10px 0;
  }
  .headline-num {
    font-size: 32px; font-weight: 900;
    color: ${accent};
    min-width: 48px;
    text-align: center;
    text-shadow: 0 2px 6px rgba(0,0,0,0.8);
  }
  .headline-text {
    font-size: ${_subTextSize || 40}px; font-weight: 700;
    line-height: 1.3;
    color: #ffffff;
    text-shadow: 0 2px 8px rgba(0,0,0,0.9);
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
    <div class="ov-spacer"></div>
    <div class="ov-content">
      ${badgeHTML(slide.category)}
      <div class="main-title">${slide.main}</div>
      <div class="accent-bar"></div>
      <div class="headline-list">
        ${listHTML}
      </div>
    </div>
  </div>
  ${sourceLabel(bgSource)}
  ${progressBar(progressPct)}
</body></html>`;
}

// ════════════════════════════════════════════════════════════════════
// FULLSCREEN ZONED builders (full-bg image + semi-transparent text zones)
// ════════════════════════════════════════════════════════════════════

// ──── Fullscreen Opening 슬라이드 ────
function buildFullscreenOpening(slide, accent, bgData, progressPct) {
  const bgImg = bgData.css;
  const textHTML = `
    <div class="main-text" style="font-size:${_mainTextSize ? _mainTextSize + 20 : 120}px;line-height:1.2;letter-spacing:-2px;">${slide.main}</div>
    ${slide.sub ? `<div class="sub-text" style="font-size:44px;">${slide.sub}</div>` : ''}
  `;

  let bodyContent = '';
  if (layout === 'center') {
    bodyContent = `
      <div class="text-zone" style="height:${zoneTopPct}%;justify-content:center;padding-bottom:20px;">
        <div class="main-text" style="font-size:${_mainTextSize ? _mainTextSize + 20 : 120}px;line-height:1.2;letter-spacing:-2px;">${slide.main}</div>
      </div>
      <div style="height:${zoneMidPct}%;"></div>
      <div class="text-zone" style="height:${zoneBotPct}%;justify-content:center;padding-top:20px;">
        ${slide.sub ? `<div class="sub-text" style="margin-top:0;">${slide.sub}</div>` : ''}
      </div>
    `;
  } else if (layout === 'top') {
    const imgPct = parseFloat(zoneTopPct) + parseFloat(zoneMidPct);
    bodyContent = `
      <div style="height:${imgPct}%;"></div>
      <div class="text-zone" style="height:${zoneBotPct}%;">
        ${textHTML}
      </div>
    `;
  } else if (layout === 'bottom') {
    const imgPct = parseFloat(zoneMidPct) + parseFloat(zoneBotPct);
    bodyContent = `
      <div class="text-zone" style="height:${zoneTopPct}%;">
        ${textHTML}
      </div>
      <div style="height:${imgPct}%;"></div>
    `;
  } else {
    // full layout (기본) — 전체 배경 위에 중앙 텍스트
    bodyContent = `
      <div class="text-zone" style="height:100%;justify-content:center;">
        ${badgeHTML(slide.category)}
        ${textHTML}
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${fullscreenZonedStyles(accent, bgImg)}
  .main-text { font-size: 84px; }
</style></head>
<body>
  ${grainSVG()}
  ${bodyContent}
  ${sourceLabel(bgData.source)}
</body></html>`;
}

// ──── Fullscreen Content 슬라이드 ────
function buildFullscreenContent(slide, accent, bgData, progressPct, index) {
  const bgImg = bgData.css;
  const textHTML = `
    <div class="main-text">${slide.main}</div>
    ${slide.sub ? `<div class="sub-text">${slide.sub}</div>` : ''}
  `;

  let bodyContent = '';
  if (layout === 'center') {
    bodyContent = `
      <div class="text-zone" style="height:${zoneTopPct}%;justify-content:center;padding-bottom:20px;">
        <div class="main-text" style="font-size:${_mainTextSize || 100}px;">${slide.main}</div>
      </div>
      <div style="height:${zoneMidPct}%;"></div>
      <div class="text-zone" style="height:${zoneBotPct}%;justify-content:center;padding-top:20px;">
        ${slide.sub ? `<div class="sub-text" style="margin-top:0;">${slide.sub}</div>` : ''}
      </div>
    `;
  } else if (layout === 'top') {
    bodyContent = `
      <div style="height:50%;"></div>
      <div class="text-zone" style="height:50%;">
        ${textHTML}
      </div>
    `;
  } else if (layout === 'bottom') {
    bodyContent = `
      <div class="text-zone" style="height:50%;">
        ${textHTML}
      </div>
      <div style="height:50%;"></div>
    `;
  } else {
    // full layout (기본) — 전체 배경 위에 중앙 텍스트
    bodyContent = `
      <div class="text-zone" style="height:100%;justify-content:center;">
        ${badgeHTML(slide.category)}
        ${textHTML}
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${fullscreenZonedStyles(accent, bgImg)}
</style></head>
<body>
  ${grainSVG()}
  <div class="corner-tl"></div>
  <div class="corner-br"></div>
  ${bodyContent}
  ${_showSlideNum ? `<div class="slide-num">${String(index).padStart(2, '0')}</div>` : ''}
  ${sourceLabel(bgData.source)}
</body></html>`;
}

// ════════════════════════════════════════════════════════════════════
// ZONED LAYOUT builders (center, top, bottom)
// ════════════════════════════════════════════════════════════════════

// ──── Zoned Opening 슬라이드 ────
function buildZonedOpening(slide, accent, bgData, progressPct) {
  const textHTML = `
    <div class="main-text" style="font-size:${_mainTextSize ? _mainTextSize + 20 : 120}px;line-height:1.2;letter-spacing:-2px;">${slide.main}</div>
    ${slide.sub ? `<div class="sub-text" style="font-size:44px;">${slide.sub}</div>` : ''}
  `;

  let bodyContent = '';
  if (layout === 'center') {
    bodyContent = _buildCenterZoned(bgData,
      `<div class="main-text" style="font-size:${_mainTextSize ? _mainTextSize + 20 : 120}px;line-height:1.2;letter-spacing:-2px;">${slide.main}</div>`,
      slide.sub ? `<div class="sub-text" style="margin-top:0;">${slide.sub}</div>` : '');
  } else if (layout === 'top') {
    const imgPct = parseFloat(zoneTopPct) + parseFloat(zoneMidPct);
    bodyContent = `
      ${imageZoneHTML(bgData, imgPct)}
      <div class="text-zone text-zone-bot" style="height:${zoneBotPct}%;">
        ${textHTML}
      </div>
    `;
  } else if (layout === 'bottom') {
    const imgPct = parseFloat(zoneMidPct) + parseFloat(zoneBotPct);
    bodyContent = `
      <div class="text-zone text-zone-top" style="height:${zoneTopPct}%;">
        ${textHTML}
      </div>
      ${imageZoneHTML(bgData, imgPct)}
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
    <div class="main-text">${slide.main}</div>
    ${slide.sub ? `<div class="sub-text">${slide.sub}</div>` : ''}
  `;

  let bodyContent = '';
  if (layout === 'center') {
    bodyContent = _buildCenterZoned(bgData,
      `<div class="main-text" style="font-size:${_mainTextSize || 100}px;">${slide.main}</div>`,
      slide.sub ? `<div class="sub-text" style="margin-top:0;">${slide.sub}</div>` : '');
  } else if (layout === 'top') {
    const imgPct = parseFloat(zoneTopPct) + parseFloat(zoneMidPct);
    bodyContent = `
      ${imageZoneHTML(bgData, imgPct)}
      <div class="text-zone text-zone-bot" style="height:${zoneBotPct}%;">
        ${textHTML}
      </div>
    `;
  } else if (layout === 'bottom') {
    const imgPct = parseFloat(zoneMidPct) + parseFloat(zoneBotPct);
    bodyContent = `
      <div class="text-zone text-zone-top" style="height:${zoneTopPct}%;">
        ${textHTML}
      </div>
      ${imageZoneHTML(bgData, imgPct)}
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
  ${_showSlideNum ? `<div class="slide-num">${String(index).padStart(2, '0')}</div>` : ''}
  ${sourceLabel(bgData.source)}
</body></html>`;
}

// ──── Center zone 배치 헬퍼 (mainZone/subZone 지원) ────
function _buildCenterZoned(bgData, mainHTML, subHTML) {
  const topTexts = [];
  const botTexts = [];
  if (mainZone === 'top') topTexts.push(mainHTML);
  else botTexts.push(mainHTML);
  if (subHTML) {
    if (subZone === 'top') topTexts.push(subHTML);
    else botTexts.push(subHTML);
  }
  return `
    <div class="text-zone text-zone-top" style="height:${zoneTopPct}%;">
      ${topTexts.join('\n')}
    </div>
    ${imageZoneHTML(bgData, parseFloat(zoneMidPct))}
    <div class="text-zone text-zone-bot" style="height:${zoneBotPct}%;">
      ${botTexts.join('\n')}
    </div>
  `;
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
    const needOverlay = !skipOverlay && bgPath && fs.existsSync(bgPath);

    if (needOverlay) {
      if (layout === 'full' || bgDisplayMode === 'fullscreen') {
        // full-screen background: body 배경만 투명, 어두운 오버레이는 유지 (텍스트 가독성)
        await page.evaluate(() => {
          document.body.style.background = 'transparent';
          // .bg-overlay는 유지 — 밝은 배경에서 텍스트 가독성 확보
          const grain = document.querySelector('.grain');
          if (grain) grain.style.display = 'none';
        });
      } else {
        // zoned layout: 이미지 영역을 투명하게, 텍스트 영역만 유지
        await page.evaluate(() => {
          document.body.style.background = 'transparent';
          const imgZone = document.querySelector('.image-zone');
          if (imgZone) { imgZone.style.background = 'transparent'; imgZone.innerHTML = ''; imgZone.style.border = 'none'; }
          const grain = document.querySelector('.grain');
          if (grain) grain.style.display = 'none';
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
