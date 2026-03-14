/**
 * Puppeteer 기반 YouTube Shorts 썸네일 생성기 (9:16 세로형)
 * 사용법: node generate_thumbnail.js <input.json> <output.png>
 *
 * input.json:
 * {
 *   "title": "영상 제목",
 *   "category": "경제",
 *   "accent": "#ff4444",
 *   "brand": "이슈60초",
 *   "background": "path/to/bg.jpg"  // optional
 * }
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node generate_thumbnail.js <input.json> <output.png>');
  process.exit(1);
}

const inputPath = args[0];
const outputPath = args[1];
const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

const title = data.title || '';
const category = data.category || '';
const accent = data.accent || '#ff6b35';
const brand = data.brand || '이슈60초';
const bgPath = data.background || '';

// 배경 이미지 base64 변환
let bgDataUrl = '';
if (bgPath && fs.existsSync(bgPath)) {
  const ext = path.extname(bgPath).toLowerCase();
  // 영상이면 스킵 (정적 이미지만)
  if (ext !== '.mp4' && ext !== '.gif') {
    const buf = fs.readFileSync(bgPath);
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    bgDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  }
}

function buildHTML() {
  const bgCss = bgDataUrl
    ? `background: url('${bgDataUrl}') center/cover no-repeat;`
    : `background: linear-gradient(170deg, #0b0e1a 0%, #1a1a3e 50%, #2d1b4e 100%);`;

  // 제목 텍스트 크기 자동 조절
  const titleLen = title.length;
  let titleSize = '88px';
  let titleLineHeight = '1.25';
  if (titleLen > 20) { titleSize = '78px'; titleLineHeight = '1.2'; }
  if (titleLen > 35) { titleSize = '68px'; titleLineHeight = '1.2'; }
  if (titleLen > 50) { titleSize = '58px'; titleLineHeight = '1.15'; }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width: 1080px; height: 1920px;
  font-family: 'Noto Sans KR', sans-serif;
  color: #fff; overflow: hidden; position: relative;
  ${bgCss}
}
.overlay {
  position: absolute; top:0; left:0; width:100%; height:100%;
  background: linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.10) 40%, rgba(0,0,0,0.65) 100%);
  z-index: 1;
}
.content {
  position: relative; z-index: 2;
  width: 100%; height: 100%;
  display: flex; flex-direction: column;
  justify-content: flex-end; align-items: flex-start;
  padding: 0 70px 160px;
}
.category {
  display: inline-block;
  padding: 12px 32px;
  background: ${accent};
  border-radius: 8px;
  font-size: 34px; font-weight: 700;
  letter-spacing: 2px;
  margin-bottom: 30px;
  text-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
.title {
  font-size: ${titleSize};
  font-weight: 900;
  line-height: ${titleLineHeight};
  letter-spacing: -1px;
  max-width: 960px;
  text-shadow: 0 4px 16px rgba(0,0,0,0.6);
  word-break: keep-all;
}
.title .hl {
  color: #ffd700;
  background: linear-gradient(transparent 55%, rgba(255,215,0,0.25) 55%);
  padding: 0 4px;
}
.accent-bar {
  width: 80px; height: 6px;
  background: ${accent};
  border-radius: 3px;
  margin-top: 36px;
}
.brand {
  position: absolute; bottom: 60px; right: 60px; z-index: 2;
  font-size: 30px; font-weight: 700;
  color: rgba(255,255,255,0.7);
  letter-spacing: 3px;
}
.glow {
  position: absolute; bottom: -150px; left: -150px;
  width: 600px; height: 600px;
  background: radial-gradient(circle, ${accent}22 0%, transparent 70%);
  z-index: 1;
}
</style></head><body>
  <div class="overlay"></div>
  <div class="glow"></div>
  <div class="content">
    ${category ? `<div class="category">${category}</div>` : ''}
    <div class="title">${title}</div>
    <div class="accent-bar"></div>
  </div>
  <div class="brand">${brand}</div>
</body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.setContent(buildHTML(), { waitUntil: 'networkidle0' });
  await page.screenshot({ path: outputPath, type: 'png' });
  await browser.close();
  console.log(`__RESULT__${outputPath}`);
})();
