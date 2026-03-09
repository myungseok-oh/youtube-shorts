/**
 * Puppeteer 기반 차트/인포그래픽 이미지 생성기
 * "graph" 타입 뉴스 슬라이드용 — SD 이미지 생성 대체
 *
 * 사용법: node generate_chart.js <input.json> <output_path>
 *
 * input.json 형식:
 * {
 *   "main": "성과급 상한 폐지 vs 6.2% 인상안",
 *   "sub": "보조 설명",
 *   "category": "경제",
 *   "accent": "#ff4444",
 *   "width": 768,
 *   "height": 768
 * }
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node generate_chart.js <input.json> <output_path>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(args[0], 'utf-8'));
const outputPath = args[1];

/* ───────── Chart type detection ───────── */

function detectChartType(main) {
  if (!main) return 'generic';

  const lower = main.toLowerCase();

  // 1. Comparison (VS)
  if (/\bvs\b/i.test(main) || / 대 /i.test(main) || /대비/.test(main) || / vs\./i.test(main)) {
    return 'comparison';
  }

  // 2. Percentage / Number
  if (/%|퍼센트/.test(main)) {
    return 'percentage';
  }

  // 3. Trend — up
  if (/상승|급등|인상|증가|확대|↑|최고|돌파|성장/.test(main)) {
    return 'trend_up';
  }

  // 3. Trend — down
  if (/하락|급락|폐지|감소|축소|↓|최저|삭감|철회|삭제/.test(main)) {
    return 'trend_down';
  }

  // Numbers present → percentage style
  if (/\d+/.test(main)) {
    return 'percentage';
  }

  return 'generic';
}

/* ───────── Extract helpers ───────── */

function extractNumbers(text) {
  const matches = text.match(/[\d,.]+/g);
  if (!matches) return [];
  return matches.map(m => parseFloat(m.replace(/,/g, ''))).filter(n => !isNaN(n));
}

function splitVS(text) {
  // Split on vs, VS, 대, 대비
  const patterns = [/\s+vs\.?\s+/i, /\s+대\s+/, /\s+대비\s+/];
  for (const p of patterns) {
    const parts = text.split(p);
    if (parts.length >= 2) {
      return { left: parts[0].trim(), right: parts.slice(1).join(' ').trim() };
    }
  }
  // Fallback: split in half
  const mid = Math.floor(text.length / 2);
  return { left: text.slice(0, mid).trim(), right: text.slice(mid).trim() };
}

function detectSentiment(text) {
  if (/폐지|철회|삭제|제거|중단|금지|차단/.test(text)) return 'negative';
  if (/인상|증가|확대|성장|상승|강화|도입/.test(text)) return 'positive';
  return 'neutral';
}

/* ───────── Shared CSS ───────── */

function baseCSS(w, h) {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: ${w}px; height: ${h}px;
      font-family: 'Noto Sans KR', 'Segoe UI', sans-serif;
      background: #f8fafc;
      overflow: hidden;
    }
    .canvas {
      width: ${w}px; height: ${h}px;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 64px;
      position: relative;
    }
  `;
}

/* ───────── Chart builders ───────── */

function buildComparison(data, w, h) {
  const { left, right } = splitVS(data.main || '');
  const leftNums = extractNumbers(left);
  const rightNums = extractNumbers(right);
  const leftSent = detectSentiment(left);
  const rightSent = detectSentiment(right);

  let leftH = 55, rightH = 55;
  if (leftNums.length && rightNums.length) {
    const max = Math.max(leftNums[0], rightNums[0]);
    if (max > 0) {
      leftH = Math.max(20, Math.round((leftNums[0] / max) * 75));
      rightH = Math.max(20, Math.round((rightNums[0] / max) * 75));
    }
  } else if (leftSent === 'negative') {
    leftH = 30; rightH = 65;
  } else if (rightSent === 'negative') {
    leftH = 65; rightH = 30;
  }

  const leftColor = leftSent === 'negative' ? '#ef4444' : '#3b82f6';
  const rightColor = rightSent === 'negative' ? '#ef4444' : '#f97316';

  const leftArrow = leftSent === 'negative' ? '&#9660;' : leftSent === 'positive' ? '&#9650;' : '';
  const rightArrow = rightSent === 'negative' ? '&#9660;' : rightSent === 'positive' ? '&#9650;' : '';
  const leftArrowColor = leftSent === 'negative' ? '#ef4444' : '#22c55e';
  const rightArrowColor = rightSent === 'negative' ? '#ef4444' : '#22c55e';

  const barWidth = Math.round((w - 200) / 2 - 40);
  const maxBarH = h - 220;

  return `
    <style>
      ${baseCSS(w, h)}
      .vs-wrap {
        display: flex; align-items: flex-end; justify-content: center;
        gap: 48px; width: 100%; height: ${maxBarH}px;
        padding-bottom: 20px;
      }
      .vs-col {
        display: flex; flex-direction: column; align-items: center;
        justify-content: flex-end; flex: 1; height: 100%;
      }
      .vs-bar {
        width: ${barWidth}px; border-radius: 16px 16px 8px 8px;
        transition: height 0.4s;
      }
      .vs-arrow {
        font-size: 56px; line-height: 1; margin-bottom: 12px;
      }
      .vs-divider {
        width: 4px; height: ${maxBarH - 40}px;
        background: linear-gradient(to bottom, transparent, #e2e8f0, transparent);
        border-radius: 2px; align-self: center;
      }
      .vs-label {
        font-size: 42px; font-weight: 900; color: #94a3b8;
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        letter-spacing: 4px; opacity: 0.18;
      }
      .vs-dot-row {
        display: flex; gap: 8px; margin-top: 24px;
      }
      .vs-dot {
        width: 12px; height: 12px; border-radius: 50%;
      }
    </style>
    <div class="canvas">
      <div class="vs-label">VS</div>
      <div class="vs-wrap">
        <div class="vs-col">
          ${leftArrow ? `<div class="vs-arrow" style="color:${leftArrowColor}">${leftArrow}</div>` : ''}
          <div class="vs-bar" style="height:${leftH}%; background: linear-gradient(to top, ${leftColor}, ${leftColor}dd);"></div>
          <div class="vs-dot-row">
            <div class="vs-dot" style="background:${leftColor}"></div>
            <div class="vs-dot" style="background:${leftColor}88"></div>
          </div>
        </div>
        <div class="vs-divider"></div>
        <div class="vs-col">
          ${rightArrow ? `<div class="vs-arrow" style="color:${rightArrowColor}">${rightArrow}</div>` : ''}
          <div class="vs-bar" style="height:${rightH}%; background: linear-gradient(to top, ${rightColor}, ${rightColor}dd);"></div>
          <div class="vs-dot-row">
            <div class="vs-dot" style="background:${rightColor}"></div>
            <div class="vs-dot" style="background:${rightColor}88"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildPercentage(data, w, h) {
  const nums = extractNumbers(data.main || '');
  let value = nums.length ? nums[0] : 50;
  const isPercent = /%|퍼센트/.test(data.main || '');

  // Clamp display to 0-100 for ring
  const ringVal = isPercent ? Math.min(100, Math.max(0, value)) : Math.min(100, Math.max(0, value));

  const sent = detectSentiment(data.main || '');
  const color = sent === 'negative' ? '#ef4444' : sent === 'positive' ? '#22c55e' : (data.accent || '#3b82f6');

  const ringSize = Math.min(w, h) - 200;
  const strokeW = 36;
  const r = (ringSize - strokeW) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - ringVal / 100);

  return `
    <style>
      ${baseCSS(w, h)}
      .ring-wrap {
        position: relative; display: flex;
        align-items: center; justify-content: center;
      }
      svg { transform: rotate(-90deg); }
      .ring-inner {
        position: absolute; display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        width: ${ringSize - strokeW * 4}px;
        height: ${ringSize - strokeW * 4}px;
        border-radius: 50%;
        background: white;
      }
      .ring-bar-row {
        display: flex; align-items: flex-end; gap: 6px;
        height: 64px;
      }
      .ring-minibar {
        width: 14px; border-radius: 4px 4px 2px 2px;
      }
      .bottom-dots {
        display: flex; gap: 10px; margin-top: 40px;
      }
      .bottom-dot {
        width: 14px; height: 14px; border-radius: 50%;
      }
    </style>
    <div class="canvas">
      <div class="ring-wrap">
        <svg width="${ringSize}" height="${ringSize}">
          <circle cx="${ringSize/2}" cy="${ringSize/2}" r="${r}"
            fill="none" stroke="#e2e8f0" stroke-width="${strokeW}" />
          <circle cx="${ringSize/2}" cy="${ringSize/2}" r="${r}"
            fill="none" stroke="${color}" stroke-width="${strokeW}"
            stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
            stroke-linecap="round" />
        </svg>
        <div class="ring-inner">
          <div class="ring-bar-row">
            ${[35, 55, 80, 95, 70].map((h, i) => `
              <div class="ring-minibar" style="height:${h * ringVal / 100}%;
                background:${color}${i % 2 === 0 ? '' : '99'};"></div>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="bottom-dots">
        <div class="bottom-dot" style="background:${color}"></div>
        <div class="bottom-dot" style="background:${color}66"></div>
        <div class="bottom-dot" style="background:#e2e8f0"></div>
      </div>
    </div>
  `;
}

function buildTrend(data, w, h, direction) {
  const isUp = direction === 'up';
  const color1 = isUp ? '#22c55e' : '#ef4444';
  const color2 = isUp ? '#3b82f6' : '#f97316';
  const arrowChar = isUp ? '&#9650;' : '&#9660;';

  const barCount = 5;
  const heights = [];
  for (let i = 0; i < barCount; i++) {
    if (isUp) {
      heights.push(25 + (i * 15) + Math.round(Math.random() * 5));
    } else {
      heights.push(85 - (i * 15) - Math.round(Math.random() * 5));
    }
  }

  const barAreaW = w - 180;
  const barW = Math.round(barAreaW / barCount - 20);
  const barAreaH = h - 200;
  const barHeightsPx = heights.map(pct => Math.round(barAreaH * pct / 100));

  // 색상 보간 함수
  function lerpColor(i) {
    const t = i / (barCount - 1);
    const r1 = parseInt(color1.slice(1,3),16), g1 = parseInt(color1.slice(3,5),16), b1 = parseInt(color1.slice(5,7),16);
    const r2 = parseInt(color2.slice(1,3),16), g2 = parseInt(color2.slice(3,5),16), b2 = parseInt(color2.slice(5,7),16);
    return `rgb(${Math.round(r1+(r2-r1)*t)},${Math.round(g1+(g2-g1)*t)},${Math.round(b1+(b2-b1)*t)})`;
  }

  const barsHTML = barHeightsPx.map((bh, i) =>
    `<div style="width:${barW}px;height:${bh}px;background:${lerpColor(i)};border-radius:14px 14px 6px 6px;"></div>`
  ).join('');

  return `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
      * { margin:0; padding:0; box-sizing:border-box; }
      html, body { width:${w}px; height:${h}px; background:#f8fafc; overflow:hidden; }
    </style>
    <body>
      <div style="position:absolute;top:40px;right:60px;font-size:120px;color:${color1}44;line-height:1;">${arrowChar}</div>
      <div style="display:flex;align-items:flex-end;justify-content:center;gap:18px;width:${barAreaW}px;height:${barAreaH}px;margin:${Math.round((h - barAreaH - 60) / 2)}px auto 0;">
        ${barsHTML}
      </div>
      <div style="width:${barAreaW+40}px;height:3px;background:#e2e8f0;border-radius:2px;margin:8px auto 0;"></div>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:24px;">
        <div style="width:12px;height:12px;border-radius:50%;background:${color1}"></div>
        <div style="width:12px;height:12px;border-radius:50%;background:${color2}"></div>
        <div style="width:12px;height:12px;border-radius:50%;background:#e2e8f0"></div>
      </div>
    </body>
  `;
}

function buildGeneric(data, w, h) {
  const accent = data.accent || '#6366f1';

  const barCount = 7;
  const barAreaW = w - 160;
  const barW = Math.round(barAreaW / barCount - 14);
  const barAreaH = h - 240;

  // Generate varied bar heights (pixel)
  const heightsPx = [];
  for (let i = 0; i < barCount; i++) {
    const pct = 30 + Math.round(Math.sin(i * 0.9 + 1) * 25) + Math.round(Math.random() * 15);
    heightsPx.push(Math.round(barAreaH * pct / 100));
  }

  return `
    <style>
      ${baseCSS(w, h)}
      .gen-wrap {
        display: flex; align-items: flex-end; justify-content: center;
        gap: 12px; width: ${barAreaW}px; height: ${barAreaH}px;
        position: relative;
      }
      .gen-bar {
        width: ${barW}px; border-radius: 12px 12px 4px 4px;
      }
      .gen-gridline {
        position: absolute; width: 100%; height: 1px;
        background: #f1f5f9; left: 0;
      }
      .gen-baseline {
        width: ${barAreaW + 20}px; height: 3px;
        background: #e2e8f0; border-radius: 2px;
        margin-top: 8px;
      }
      .gen-accent-line {
        position: absolute; top: 60px; right: 50px;
        width: 80px; height: 4px; border-radius: 2px;
        background: ${accent}44;
      }
      .gen-accent-dot {
        position: absolute; top: 56px; right: 40px;
        width: 12px; height: 12px; border-radius: 50%;
        background: ${accent}33;
      }
      .gen-dots {
        display: flex; gap: 10px; margin-top: 28px;
      }
      .gen-dot {
        width: 12px; height: 12px; border-radius: 50%;
      }
    </style>
    <div class="canvas">
      <div class="gen-accent-line"></div>
      <div class="gen-accent-dot"></div>
      <div class="gen-wrap">
        <div class="gen-gridline" style="top:20%"></div>
        <div class="gen-gridline" style="top:40%"></div>
        <div class="gen-gridline" style="top:60%"></div>
        <div class="gen-gridline" style="top:80%"></div>
        ${heightsPx.map((barH, i) => {
          const opacity = 0.5 + (barH / barAreaH) * 0.5;
          return `<div class="gen-bar" style="height:${barH}px;
            background: linear-gradient(to top, ${accent}, ${accent}${Math.round(opacity*255).toString(16).padStart(2,'0')});"></div>`;
        }).join('')}
      </div>
      <div class="gen-baseline"></div>
      <div class="gen-dots">
        <div class="gen-dot" style="background:${accent}"></div>
        <div class="gen-dot" style="background:${accent}66"></div>
        <div class="gen-dot" style="background:#e2e8f0"></div>
      </div>
    </div>
  `;
}

/* ───────── HTML builder ───────── */

function buildChartHTML(data, chartType) {
  const w = data.width || 768;
  const h = data.height || 768;

  switch (chartType) {
    case 'comparison':   return buildComparison(data, w, h);
    case 'percentage':   return buildPercentage(data, w, h);
    case 'trend_up':     return buildTrend(data, w, h, 'up');
    case 'trend_down':   return buildTrend(data, w, h, 'down');
    default:             return buildGeneric(data, w, h);
  }
}

/* ───────── Main ───────── */

async function main() {
  // raw HTML 모드: data.html이 있으면 그대로 렌더링 (Claude 생성 인포그래픽용)
  const html = data.html
    ? data.html
    : buildChartHTML(data, detectChartType(data.main || ''));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: data.width || 768,
    height: data.height || 768,
    deviceScaleFactor: 2
  });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  // Allow font loading
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: outputPath, type: 'png' });
  await browser.close();
  console.log(outputPath);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
