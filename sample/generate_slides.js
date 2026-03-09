const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, 'output', 'images');

const slides = [
  {
    category: '속보',
    main: '환율 <span class="hl">1,506원</span> 돌파',
    sub: '17년 만의 최고치 기록',
    accent: '#ff4444',
  },
  {
    category: '원인 분석',
    main: '중동 전쟁 확대',
    sub: '글로벌 안전자산 선호 급증',
    accent: '#ff6b35',
  },
  {
    category: '증시 충격',
    main: '코스피 <span class="hl">-7.49%</span>',
    sub: '코스닥 -7.83% 동반 급락',
    accent: '#ff4444',
  },
  {
    category: '긴급 대응',
    main: '한국은행<br>긴급 회의 소집',
    sub: '금융시장 안정화 총력',
    accent: '#4a90d9',
  },
  {
    category: '전망',
    main: '<span class="hl">1,480원대</span> 등락',
    sub: '불확실성 당분간 지속 전망',
    accent: '#f5a623',
  },
  {
    category: '',
    main: '이슈60초',
    sub: '오늘의 핵심 뉴스 브리핑',
    accent: '#ff6b35',
    isClosing: true,
  },
];

function buildHTML(slide) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: 1080px; height: 1920px;
    background: linear-gradient(170deg, #0b0e1a 0%, #141b2d 40%, #1a2238 100%);
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    font-family: 'Malgun Gothic', 'Segoe UI', sans-serif;
    color: #ffffff; overflow: hidden; position: relative;
  }

  /* top accent bar */
  .top-bar {
    position: absolute; top: 0; left: 0;
    width: 100%; height: 8px;
    background: linear-gradient(90deg, ${slide.accent}, #ffd700);
  }

  /* subtle grid overlay */
  .grid {
    position: absolute; top: 0; left: 0;
    width: 100%; height: 100%;
    background-image:
      linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
    background-size: 60px 60px;
  }

  .date {
    position: absolute; top: 40px; right: 50px;
    font-size: 26px; color: #445566;
    font-weight: 400;
  }

  .category {
    font-size: 34px; color: ${slide.accent};
    letter-spacing: 8px; font-weight: 700;
    margin-bottom: 50px;
    text-transform: uppercase;
    ${!slide.category ? 'display:none;' : ''}
  }

  .main-text {
    font-size: ${slide.isClosing ? '100px' : '78px'};
    font-weight: 800; text-align: center;
    line-height: 1.35; margin-bottom: 40px;
    padding: 0 70px;
    text-shadow: 0 4px 30px rgba(0,0,0,0.6);
  }

  .sub-text {
    font-size: 40px; color: #7788aa;
    text-align: center; font-weight: 400;
    padding: 0 80px;
  }

  .hl { color: #ffd700; }

  .brand {
    position: absolute; bottom: 80px;
    display: flex; align-items: center; gap: 16px;
  }
  .brand-line { width: 40px; height: 3px; background: ${slide.accent}; }
  .brand-text {
    font-size: 26px; color: ${slide.accent};
    letter-spacing: 4px; font-weight: 700;
  }

  /* decorative corner accents */
  .corner-tl, .corner-br {
    position: absolute; width: 60px; height: 60px;
  }
  .corner-tl {
    top: 30px; left: 30px;
    border-top: 3px solid ${slide.accent};
    border-left: 3px solid ${slide.accent};
    opacity: 0.3;
  }
  .corner-br {
    bottom: 30px; right: 30px;
    border-bottom: 3px solid ${slide.accent};
    border-right: 3px solid ${slide.accent};
    opacity: 0.3;
  }
</style></head>
<body>
  <div class="top-bar"></div>
  <div class="grid"></div>
  <div class="corner-tl"></div>
  <div class="corner-br"></div>
  <div class="date">2026.03.04</div>
  <div class="category">${slide.category || ''}</div>
  <div class="main-text">${slide.main}</div>
  <div class="sub-text">${slide.sub}</div>
  ${!slide.isClosing ? '<div class="brand"><div class="brand-line"></div><div class="brand-text">이슈60초</div><div class="brand-line"></div></div>' : ''}
</body></html>`;
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });

  for (let i = 0; i < slides.length; i++) {
    const html = buildHTML(slides[i]);
    await page.setContent(html, { waitUntil: 'load' });
    // wait a bit for fonts
    await new Promise(r => setTimeout(r, 300));
    const outPath = path.join(OUTPUT_DIR, `slide_${i + 1}.png`);
    await page.screenshot({ path: outPath, type: 'png' });
    console.log(`slide_${i + 1}.png`);
  }

  await browser.close();
  console.log('DONE');
}

main().catch(e => { console.error(e); process.exit(1); });
