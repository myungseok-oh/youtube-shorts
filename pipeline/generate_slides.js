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
const compElements = data.elements || [];      // Composer 요소 (bubble/image/emotion)
const compFreeTexts = data.freeTexts || [];    // Composer 자유 텍스트
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
const _mainTextEnabled = data.mainTextEnabled !== false;  // 기본 true
const _subTextEnabled = data.subTextEnabled !== false;    // 기본 true
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

// ──── Composer 요소 SVG 데이터 ────
const BUBBLE_SVGS = [
  { name:"둥근말풍선", svg:`<path d="M50,5C25,5,5,22,5,43c0,13,8,24,20,31l-5,16,18-12c4,1,8,1,12,1,25,0,45-17,45-38S75,5,50,5Z" fill="white"/>` },
  { name:"구름말풍선", svg:`<path d="M25,70c-3,8-10,14-10,14s12-2,18-6c5,2,11,3,17,3c22,0,40-15,40-33S72,15,50,15S10,30,10,48c0,9,5,17,15,22Z" fill="white"/><circle cx="12" cy="78" r="4" fill="white"/><circle cx="6" cy="86" r="2.5" fill="white"/>` },
  { name:"사각말풍선", svg:`<rect x="5" y="5" width="90" height="60" rx="8" fill="white"/><polygon points="20,65 30,65 15,85" fill="white"/>` },
  { name:"둥근사각", svg:`<rect x="5" y="10" width="90" height="55" rx="20" fill="white"/><polygon points="50,65 60,65 55,80" fill="white"/>` },
  { name:"생각풍선", svg:`<ellipse cx="50" cy="38" rx="40" ry="28" fill="white"/><ellipse cx="28" cy="30" rx="18" ry="14" fill="white"/><ellipse cx="72" cy="32" rx="16" ry="12" fill="white"/><ellipse cx="50" cy="18" rx="22" ry="12" fill="white"/><circle cx="22" cy="72" r="6" fill="white"/><circle cx="14" cy="82" r="4" fill="white"/><circle cx="8" cy="88" r="2.5" fill="white"/>` },
  { name:"외침풍선", svg:`<polygon points="50,2 58,28 95,28 64,46 75,78 50,56 25,78 36,46 5,28 42,28" fill="white"/>` },
  { name:"타원말풍선", svg:`<ellipse cx="50" cy="40" rx="44" ry="32" fill="white"/><polygon points="35,68 45,68 25,90" fill="white"/>` },
  { name:"물결말풍선", svg:`<path d="M15,15 Q5,15 5,25 Q5,60 5,60 Q5,70 15,70 L25,70 L15,88 L35,70 L85,70 Q95,70 95,60 L95,25 Q95,15 85,15Z" fill="white" stroke="none"/>` },
  { name:"우측말풍선", svg:`<rect x="5" y="5" width="90" height="60" rx="12" fill="white"/><polygon points="75,65 85,65 88,82" fill="white"/>` },
];

const EMOTION_SVGS = [
  { name:"빙글빙글", svg:`<circle cx="50" cy="50" r="40" fill="none" stroke="#333" stroke-width="1.8"/><circle cx="50" cy="50" r="32" fill="none" stroke="#555" stroke-width="1.4"/><g><path d="M50,4 L52,8 L56,10 L52,12 L50,16 L48,12 L44,10 L48,8Z" fill="#fff" stroke="#333" stroke-width="0.8"/><path d="M90,44 L88,48 L90,52 L86,50 L82,52 L84,48 L82,44 L86,46Z" fill="#FFD700" stroke="#333" stroke-width="0.8"/><path d="M50,84 L52,88 L56,90 L52,92 L50,96 L48,92 L44,90 L48,88Z" fill="#fff" stroke="#333" stroke-width="0.8"/><path d="M10,44 L12,48 L10,52 L14,50 L18,52 L16,48 L18,44 L14,46Z" fill="#4FC3F7" stroke="#333" stroke-width="0.8"/></g>` },
  { name:"반짝반짝", svg:`<polygon points="50,5 58,38 95,38 65,58 75,92 50,70 25,92 35,58 5,38 42,38" fill="#FFD700" opacity="0.9"/><polygon points="50,25 54,43 72,43 57,53 62,70 50,60 38,70 43,53 28,43 46,43" fill="#FFF3B0"/>` },
  { name:"한숨", svg:`<ellipse cx="30" cy="50" rx="22" ry="14" fill="#B0C4DE" opacity="0.7"/><ellipse cx="60" cy="35" rx="18" ry="11" fill="#B0C4DE" opacity="0.5"/><ellipse cx="80" cy="55" rx="14" ry="9" fill="#B0C4DE" opacity="0.4"/><path d="M15,50 Q5,40 20,35" fill="none" stroke="#B0C4DE" stroke-width="3" stroke-linecap="round" opacity="0.6"/>` },
  { name:"하트", svg:`<path d="M50,85 C20,65 5,45 5,30 A20,20,0,0,1,50,25 A20,20,0,0,1,95,30 C95,45 80,65 50,85Z" fill="#FF4D6D"/>` },
  { name:"분노", svg:`<g fill="#FF3333"><path d="M25,20 L50,30 L40,5 L50,30 L75,20 L50,30 L50,30Z" opacity="0.9"/><path d="M75,80 L50,70 L60,95 L50,70 L25,80 L50,70Z" opacity="0.9"/><path d="M20,75 L30,50 L5,60 L30,50 L20,25 L30,50Z" opacity="0.7"/><path d="M80,25 L70,50 L95,40 L70,50 L80,75 L70,50Z" opacity="0.7"/></g>` },
  { name:"당황", svg:`<path d="M40,15 Q42,50 35,85" fill="none" stroke="#4FC3F7" stroke-width="5" stroke-linecap="round" opacity="0.8"/><ellipse cx="37" cy="90" rx="5" ry="4" fill="#4FC3F7" opacity="0.6"/><path d="M65,25 Q67,55 62,75" fill="none" stroke="#4FC3F7" stroke-width="4" stroke-linecap="round" opacity="0.6"/><ellipse cx="61" cy="80" rx="4" ry="3" fill="#4FC3F7" opacity="0.4"/>` },
  { name:"물음표", svg:`<text x="50" y="72" text-anchor="middle" font-size="70" font-weight="900" fill="#FFB300" stroke="#E65100" stroke-width="2">?</text>` },
  { name:"느낌표", svg:`<text x="50" y="72" text-anchor="middle" font-size="70" font-weight="900" fill="#FF5252" stroke="#B71C1C" stroke-width="2">!</text>` },
  { name:"음표", svg:`<text x="28" y="60" font-size="50" fill="#AB47BC">♪</text><text x="58" y="45" font-size="38" fill="#AB47BC" opacity="0.7">♫</text>` },
  { name:"전구", svg:`<ellipse cx="50" cy="40" rx="24" ry="26" fill="#FFEE58" stroke="#FBC02D" stroke-width="2"/><rect x="40" y="64" width="20" height="8" rx="2" fill="#FBC02D"/><rect x="42" y="72" width="16" height="4" rx="2" fill="#F9A825"/><line x1="50" y1="10" x2="50" y2="2" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/><line x1="78" y1="20" x2="84" y2="14" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/><line x1="22" y1="20" x2="16" y2="14" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/><line x1="85" y1="42" x2="92" y2="42" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/><line x1="15" y1="42" x2="8" y2="42" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/>` },
  { name:"졸림", svg:`<text x="20" y="55" font-size="30" font-weight="900" fill="#78909C" opacity="0.5">z</text><text x="42" y="40" font-size="40" font-weight="900" fill="#78909C" opacity="0.7">z</text><text x="65" y="25" font-size="50" font-weight="900" fill="#78909C" opacity="0.9">Z</text>` },
  { name:"폭발", svg:`<polygon points="50,2 62,30 95,15 72,42 98,58 68,60 75,92 50,72 25,92 32,60 2,58 28,42 5,15 38,30" fill="#FF9800" stroke="#E65100" stroke-width="1.5"/><circle cx="50" cy="50" r="15" fill="#FFEB3B"/>` },
];

function _escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Composer 요소(말풍선/이미지/감정표현) + 자유텍스트를 HTML로 생성
 * 1080×1920 절대 좌표계, z-index: 20
 */
function buildElementsHtml(slideNum) {
  const elems = compElements.filter(e => e.slideNum === slideNum);
  const fts = compFreeTexts.filter(ft => ft.slideNum === slideNum);
  if (elems.length === 0 && fts.length === 0) return '';

  let html = '';

  // 요소 (bubble / image / emotion)
  elems.forEach(elem => {
    const x = elem.x || 540;
    const y = elem.y || 960;
    const w = elem.width || 300;
    const h = elem.height || 250;
    const rot = elem.rotation || 0;
    const flipX = elem.flipX ? ' scaleX(-1)' : '';

    let inner = '';
    if (elem.type === 'bubble') {
      const bDef = BUBBLE_SVGS[elem.bubbleIdx];
      if (bDef) {
        let svgContent = bDef.svg;
        // fillColor 적용
        if (elem.fillColor) {
          svgContent = svgContent.replace(/fill="white"/g, `fill="${elem.fillColor}"`);
        }
        // strokeColor 적용
        if (elem.strokeColor) {
          svgContent = svgContent.replace(/stroke="none"/g, `stroke="${elem.strokeColor}" stroke-width="${elem.strokeWidth || 2}"`);
          svgContent = svgContent.replace(/(<(?:path|rect|ellipse|polygon|circle)\b)(?![^>]*\bstroke=)/g,
            `$1 stroke="${elem.strokeColor}" stroke-width="${elem.strokeWidth || 2}"`);
        }
        inner = `<svg viewBox="0 0 100 95" width="100%" height="100%" style="position:absolute;inset:0;">${svgContent}</svg>`;
        if (elem.text) {
          const flipTxt = elem.flipX ? 'transform:scaleX(-1);' : '';
          inner += `<div style="position:absolute;inset:10%;display:flex;align-items:center;justify-content:center;text-align:center;font-size:${elem.textSize || 36}px;color:${elem.textColor || '#000'};font-weight:700;word-break:keep-all;line-height:1.2;z-index:2;${flipTxt}">${_escHtml(elem.text).replace(/\n/g, '<br>')}</div>`;
        }
      }
    } else if (elem.type === 'image' && elem.dataUrl) {
      inner = `<img src="${elem.dataUrl}" style="width:100%;height:100%;object-fit:contain;">`;
    } else if (elem.type === 'emotion') {
      const eDef = EMOTION_SVGS[elem.emotionIdx];
      if (eDef) {
        inner = `<svg viewBox="0 0 100 100" width="100%" height="100%" style="position:absolute;inset:0;">${eDef.svg}</svg>`;
      }
    }

    if (inner) {
      html += `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:translate(-50%,-50%) rotate(${rot}deg)${flipX};z-index:20;pointer-events:none;">${inner}</div>\n`;
    }
  });

  // 자유 텍스트
  fts.forEach(ft => {
    const x = ft.x || 540;
    const y = ft.y || 960;
    const size = ft.size || 48;
    const color = ft.color || '#ffffff';
    const font = ft.fontFamily || 'Noto Sans KR';
    const rot = ft.rotation || 0;
    const text = _escHtml(ft.text).replace(/\n/g, '<br>');
    html += `<div style="position:absolute;left:${x}px;top:${y}px;font-size:${size}px;color:${color};font-family:'${font}',sans-serif;font-weight:700;transform:translate(-50%,-50%) rotate(${rot}deg);z-index:20;white-space:nowrap;text-shadow:0 2px 8px rgba(0,0,0,0.8);pointer-events:none;">${text}</div>\n`;
  });

  return html;
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

  let baseHtml;

  // hidden 오버라이드: 텍스트 없이 배경만 렌더 (오버레이 제거)
  if (ovr.hidden) {
    baseHtml = buildHiddenOverlay(s, bgData.css, progressPct);
  }
  // Closing slide: only if explicitly marked as closing (bg_type empty/closing)
  // Content slides with bg_type (photo, graph, broll, etc.) are rendered normally
  else if (index === total - 1 && (!s.bg_type || s.bg_type === 'closing')) {
    baseHtml = buildClosing(s, accent, bgData.css, progressPct);
  }
  // Overview slide (roundup headline): always full-bg with dark overlay + headline list
  else if (s.bg_type === 'overview') {
    baseHtml = buildOverview(s, accent, bgData.css, progressPct, bgData.source);
  }
  // 위치/크기 오버라이드가 있으면 커스텀 렌더링
  else if (ovr.x !== undefined || ovr.y !== undefined || ovr.mainSize || ovr.subSize) {
    baseHtml = buildCustomContent(s, accent, bgData.css, progressPct, index, bgData.source, ovr);
  }
  // For full layout, use original builders
  else if (layout === 'full') {
    baseHtml = index === 0
      ? buildOpening(s, accent, bgData.css, progressPct, bgData.source)
      : buildContent(s, accent, bgData.css, progressPct, index, bgData.source);
  }
  // Fullscreen mode: full-bg image with semi-transparent text zones
  // top/bottom 레이아웃은 이미지가 특정 영역에만 표시되어야 하므로 zoned 방식 사용
  else if (bgDisplayMode === 'fullscreen' && (layout === 'full' || layout === 'center')) {
    baseHtml = index === 0
      ? buildFullscreenOpening(s, accent, bgData, progressPct)
      : buildFullscreenContent(s, accent, bgData, progressPct, index);
  }
  // Zone mode (default): image in designated zone
  else {
    baseHtml = index === 0
      ? buildZonedOpening(s, accent, bgData, progressPct)
      : buildZonedContent(s, accent, bgData, progressPct, index);
  }

  // Composer 요소/자유텍스트 삽입
  const elemHtml = buildElementsHtml(slideNum);
  if (elemHtml) {
    // </body></html> 바로 앞에 삽입
    baseHtml = baseHtml.replace('</body>', elemHtml + '</body>');
  }

  return baseHtml;
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

  // 메인/서브 텍스트 온오프 전처리
  if (!_mainTextEnabled || !_subTextEnabled) {
    slides.forEach(sl => {
      if (!_mainTextEnabled) sl.main = '';
      if (!_subTextEnabled) sl.sub = '';
    });
  }

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

// ════════════════════════════════════════════════════════════════════
// Intro Overview — 헤드라인 누적 등장 인트로
// ════════════════════════════════════════════════════════════════════
async function runIntroOverview(d, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const introBg = d.introBg || '';
  const headlines = (d.headlines || []).slice(0, 12);  // 안전 상한 12
  const dateLabel = d.dateLabel || '';
  const title = d.title || '오늘의 헤드라인';
  const accent = d.accentColor || '#ff6b35';
  const hl = d.hlColor || '#ffd700';

  // 카드 개수에 따라 자동 크기 조정 (글자 잘림/넘침 방지)
  // n<=5: 큰 카드, 6~7: 중간, 8~9: 작게, 10+: 더 작게
  const _n = headlines.length;
  let _cardPadV, _cardPadH, _cardGap, _numSize, _textSize, _numMinW, _titleSize, _topPad, _botPad;
  if (_n <= 5) {
    _cardPadV = 22; _cardPadH = 30; _cardGap = 22;
    _numSize = 60; _textSize = 48; _numMinW = 88;
    _titleSize = 92; _topPad = 220; _botPad = 200;
  } else if (_n <= 7) {
    _cardPadV = 16; _cardPadH = 26; _cardGap = 16;
    _numSize = 48; _textSize = 42; _numMinW = 72;
    _titleSize = 80; _topPad = 180; _botPad = 140;
  } else if (_n <= 9) {
    _cardPadV = 12; _cardPadH = 22; _cardGap = 12;
    _numSize = 40; _textSize = 36; _numMinW = 62;
    _titleSize = 72; _topPad = 160; _botPad = 110;
  } else {
    _cardPadV = 9; _cardPadH = 18; _cardGap = 9;
    _numSize = 34; _textSize = 30; _numMinW = 54;
    _titleSize = 64; _topPad = 140; _botPad = 90;
  }

  // 배경 이미지를 base64 data URL로 변환 (file:/// 차단 회피)
  let bgUrl = '';
  if (introBg && fs.existsSync(introBg)) {
    const buf = fs.readFileSync(introBg);
    const ext = path.extname(introBg).toLowerCase().slice(1) || 'jpeg';
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    bgUrl = `data:image/${mime};base64,${buf.toString('base64')}`;
  }

  // 헤드라인 카드 N개 (모두 .visible 토글로 등장 제어)
  const cardsHTML = headlines.map((text, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `<div class="hl-card" data-idx="${i}">
      <div class="hl-num">${num}</div>
      <div class="hl-text">${text}</div>
    </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: 1080px; height: 1920px;
    font-family: 'Noto Sans KR', sans-serif;
    color: #ffffff; overflow: hidden; position: relative;
    word-break: keep-all; overflow-wrap: break-word;
    ${bgUrl ? `background: url('${bgUrl}') center/cover no-repeat;` : 'background: linear-gradient(170deg, #0b0e1a 0%, #141b2d 50%, #1a2238 100%);'}
  }
  .bg-overlay {
    position: absolute; inset: 0;
    background: linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.65) 50%, rgba(0,0,0,0.85) 100%);
    z-index: 1;
  }
  .wrap {
    position: relative; z-index: 5;
    width: 100%; height: 100%;
    display: flex; flex-direction: column;
    padding: ${_topPad}px 80px ${_botPad}px;
  }
  .header {
    display: flex; flex-direction: column; align-items: flex-start;
    margin-bottom: ${_n <= 5 ? 60 : 36}px;
  }
  .date-badge {
    display: inline-block;
    padding: 14px 28px;
    background: ${accent};
    color: #fff;
    font-size: ${_n <= 5 ? 36 : 30}px; font-weight: 900;
    letter-spacing: 1px;
    border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.5);
    margin-bottom: 24px;
  }
  .title {
    font-size: ${_titleSize}px; font-weight: 900;
    color: #fff;
    line-height: 1.1;
    letter-spacing: -2px;
    text-shadow: 0 4px 24px rgba(0,0,0,0.8);
  }
  .accent-line {
    width: 96px; height: 8px;
    background: ${accent};
    margin-top: 28px;
    border-radius: 4px;
  }
  .cards {
    display: flex; flex-direction: column;
    gap: ${_cardGap}px;
    flex: 1;
    justify-content: flex-start;
  }
  .hl-card {
    display: flex; align-items: center;
    gap: ${Math.max(16, _cardPadH - 6)}px;
    padding: ${_cardPadV}px ${_cardPadH}px;
    background: rgba(15,18,30,0.78);
    border-left: 6px solid ${accent};
    border-radius: 0 14px 14px 0;
    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
    /* 초기 숨김: opacity + 살짝 아래로 + 작게 */
    opacity: 0;
    transform: translateY(40px) scale(0.94);
    transition: none;
  }
  .hl-card.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  .hl-card.pop {
    /* 막 등장한 카드: 잠깐 강조 (큰 그림자 + accent 글로우) */
    box-shadow: 0 0 0 4px ${accent}55, 0 14px 50px rgba(0,0,0,0.6);
  }
  .hl-num {
    font-size: ${_numSize}px; font-weight: 900;
    color: ${accent};
    min-width: ${_numMinW}px;
    text-align: center;
    text-shadow: 0 2px 8px rgba(0,0,0,0.7);
    letter-spacing: -2px;
  }
  .hl-text {
    font-size: ${_textSize}px; font-weight: 800;
    color: #fff;
    line-height: 1.25;
    text-shadow: 0 2px 12px rgba(0,0,0,0.95);
    flex: 1;
  }
</style></head>
<body>
  <div class="bg-overlay"></div>
  <div class="wrap">
    <div class="header">
      ${dateLabel ? `<div class="date-badge">${dateLabel}</div>` : ''}
      <div class="title">${title}</div>
      <div class="accent-line"></div>
    </div>
    <div class="cards">
      ${cardsHTML}
    </div>
  </div>
</body></html>`;

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.setContent(html, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 400));

  // stage_0 ~ stage_N : i번째 카드까지 visible
  const result = [];
  const n = headlines.length;
  for (let i = 0; i <= n; i++) {
    await page.evaluate((idx) => {
      document.querySelectorAll('.hl-card').forEach((el, k) => {
        el.classList.toggle('visible', k < idx);
        // 가장 최근 등장한 카드만 pop 강조 (과한 강조 방지)
        el.classList.toggle('pop', k === idx - 1);
      });
    }, i);
    await new Promise(r => setTimeout(r, 60));
    const out = path.join(outDir, `stage_${i}.png`);
    await page.screenshot({ path: out, type: 'png' });
    result.push(out);
    console.log(`stage_${i}.png`);
  }

  await browser.close();
  console.log('__RESULT__' + JSON.stringify(result));
}

// ─── 엔트리 분기 ───
if (data.mode === 'intro-overview') {
  runIntroOverview(data, outputDir).catch(e => { console.error(e); process.exit(1); });
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}
