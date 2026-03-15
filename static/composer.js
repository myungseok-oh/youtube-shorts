/* ─── Composer JS — 프리프로덕션 영상 편집기 ─── */

let composerData = null;
let composeState = { slide_order: [], slide_durations: {}, sfx_markers: [], bgm: null };
let selectedSlide = -1;     // 선택된 슬라이드 인덱스 (0-based in slide_order)
let _dirty = false;
let _playingAudio = null;
let _allPlayQueue = [];
let _allPlayIdx = 0;

// ─── Init ───

async function initComposer() {
  const r = await fetch(`/api/jobs/${JOB_ID}/composer`);
  composerData = await r.json();
  composeState = composerData.compose_data || { slide_order: [], slide_durations: {}, sfx_markers: [], bgm: null };

  // 초기 슬라이드 순서: compose_data에 없으면 기본 순서 (빈 closing 제외)
  if (!composeState.slide_order || composeState.slide_order.length === 0) {
    composeState.slide_order = composerData.slides
      .filter(s => !(s.bg_type === "closing" && (!s.sentences || s.sentences.length === 0) && !s.bg_url))
      .map(s => s.num);
  }
  composeState.sfx_markers = composeState.sfx_markers || [];
  composeState.bgm = composeState.bgm || null;
  composeState.slide_overrides = composeState.slide_overrides || {};

  renderTimeline();
  renderTabMedia();
  renderTabSfx();
  renderTabBgm();
  if (composeState.slide_order.length > 0) {
    selectSlide(0);
  }
  setupSfxDrop();
}

// ─── Timeline ───

function renderTimeline() {
  const track = document.getElementById("slide-track");
  track.innerHTML = "";

  const slides = getOrderedSlides();
  const totalDur = getTotalDuration();

  slides.forEach((sl, idx) => {
    const dur = getSlideDuration(sl.num);
    const hasAudio = sl.audio_files && sl.audio_files.length > 0;
    const hasBg = !!sl.bg_url;

    const block = document.createElement("div");
    block.className = `slide-block ${idx === selectedSlide ? 'active' : ''}`;
    block.draggable = true;
    block.dataset.idx = idx;
    block.dataset.slideNum = sl.num;
    const totalDurAll = getTotalDuration() || 1;
    const pct = (dur / totalDurAll) * 100;
    block.style.width = `${pct}%`;
    block.style.minWidth = "40px";
    block.style.flexShrink = "0";
    block.style.flexGrow = "0";

    // 프레임 스트립: 배경 이미지를 반복 배치
    let framesHtml = "";
    if (hasBg && !sl.bg_url.includes(".mp4") && !sl.bg_url.includes(".gif")) {
      // 정적 이미지: background-image repeat로 프레임 스트립
      framesHtml = `<div class="slide-frames" style="background-image:url('${sl.bg_url}');"></div>`;
    } else if (hasBg) {
      // 영상: 단일 썸네일
      framesHtml = `<div class="slide-frames"><video src="${sl.bg_url}" muted playsinline style="height:100%;opacity:0.7;"></video></div>`;
    } else {
      framesHtml = `<div class="slide-frames slide-frames-empty"></div>`;
    }

    const bgTypeBadge = {photo:"📷",broll:"🎬",graph:"📊",logo:"🏢",closing:"🔚"}[sl.bg_type] || "📷";

    block.innerHTML = `
      ${framesHtml}
      <div class="slide-block-label">
        <span>${bgTypeBadge} ${sl.num}</span>
        <span>${dur.toFixed(1)}s</span>
      </div>
    `;

    // 클릭 → 선택
    block.addEventListener("click", () => selectSlide(idx));

    // 드래그 & 드롭 (순서 변경)
    block.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("slide_idx", String(idx));
      block.classList.add("dragging");
    });
    block.addEventListener("dragend", () => block.classList.remove("dragging"));
    block.addEventListener("dragover", (e) => {
      e.preventDefault();
      block.classList.add("drag-over");
    });
    block.addEventListener("dragleave", () => block.classList.remove("drag-over"));
    block.addEventListener("drop", (e) => {
      e.preventDefault();
      block.classList.remove("drag-over");
      const fromIdx = parseInt(e.dataTransfer.getData("slide_idx"));
      if (isNaN(fromIdx) || fromIdx === idx) return;
      // 순서 변경
      const order = [...composeState.slide_order];
      const [moved] = order.splice(fromIdx, 1);
      order.splice(idx, 0, moved);
      composeState.slide_order = order;
      _dirty = true;
      // 선택 유지
      selectedSlide = idx;
      renderTimeline();
      renderPreview();
    });

    track.appendChild(block);
  });

  renderSfxMarkers();
  renderBgmTrack();
  renderRuler();
  updatePlayhead();
}

function renderRuler() {
  const ruler = document.getElementById("timeline-ruler");
  if (!ruler) return;
  const total = getTotalDuration() || 1;
  const interval = total <= 10 ? 1 : total <= 30 ? 2 : total <= 60 ? 5 : 10;
  let html = "";
  for (let s = 0; s <= total; s += interval) {
    const pct = (s / total) * 100;
    html += `<span class="ruler-mark" style="left:${pct}%;">${_fmtDur(s)}</span>`;
  }
  ruler.innerHTML = html;
}

let _playheadPos = 0;
let _isDraggingPlayhead = false;

function updatePlayhead() {
  const ph = document.getElementById("timeline-playhead");
  if (!ph) return;
  ph.style.left = (_playheadPos * 100) + "%";
}

function onTimelineMouseDown(e) {
  const trackArea = document.getElementById("timeline-tracks");
  if (!trackArea) return;
  const rect = trackArea.getBoundingClientRect();

  function posFromEvent(ev) {
    return Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  }

  _playheadPos = posFromEvent(e);
  updatePlayhead();
  _isDraggingPlayhead = true;

  // 재생 중이면 해당 시간으로 이동
  if (_previewing) {
    const total = getTotalDuration() || 1;
    _previewStartTime = performance.now() - _playheadPos * total * 1000;
    _previewAudioPlayed = new Set();
    _previewSlideIdx = -1;
    if (_playingAudio) { _playingAudio.pause(); _playingAudio = null; }
  }

  function onMove(ev) {
    _playheadPos = posFromEvent(ev);
    updatePlayhead();
    if (_previewing) {
      const total = getTotalDuration() || 1;
      _previewStartTime = performance.now() - _playheadPos * total * 1000;
      _previewAudioPlayed = new Set();
      _previewSlideIdx = -1;
      if (_playingAudio) { _playingAudio.pause(); _playingAudio = null; }
    }
    // 비 재생 중이면 해당 슬라이드 선택
    if (!_previewing) {
      const total = getTotalDuration() || 1;
      const t = _playheadPos * total;
      _buildSlideTimeMap();
      for (let i = 0; i < _slideTimeMap.length; i++) {
        if (t >= _slideTimeMap[i].start && t < _slideTimeMap[i].end) {
          const slideIdx = composeState.slide_order.indexOf(_slideTimeMap[i].num);
          if (slideIdx >= 0 && slideIdx !== selectedSlide) selectSlide(slideIdx);
          break;
        }
      }
    }
  }

  function onUp() {
    _isDraggingPlayhead = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function selectSlide(idx) {
  selectedSlide = idx;
  document.querySelectorAll(".slide-block").forEach((el, i) => {
    el.classList.toggle("active", i === idx);
  });
  // 미디어 탭 하이라이트 갱신
  document.querySelectorAll(".media-item").forEach((el, i) => {
    el.classList.toggle("active", i === idx);
  });
  renderPreview();
  // 활성 탭 갱신
  if (_activeTab === 'text') renderTabText();
  if (_activeTab === 'narration') renderTabNarration();
}

// ─── Preview (Visual Overlay Editor) ───

const CANVAS_W = 225, CANVAS_H = 400;
const REAL_W = 1080, REAL_H = 1920;
const SCALE = CANVAS_W / REAL_W;  // ~0.208

function getOverride(slideNum) {
  return composeState.slide_overrides[slideNum] || {};
}

function setOverride(slideNum, key, val) {
  if (!composeState.slide_overrides[slideNum]) composeState.slide_overrides[slideNum] = {};
  composeState.slide_overrides[slideNum][key] = val;
  _dirty = true;
}

function renderPreview() {
  const container = document.getElementById("slide-preview");
  const sl = getSelectedSlide();
  if (!sl) {
    container.innerHTML = `<span class="text-gray-600 text-sm">슬라이드를 선택하세요</span>`;
    return;
  }

  const ovr = getOverride(sl.num);
  const isHidden = ovr.hidden === true;

  // 배경
  let bgHtml = "";
  if (sl.bg_url) {
    if (sl.bg_url.includes(".mp4") || sl.bg_url.includes(".gif")) {
      bgHtml = `<video src="${sl.bg_url}" muted autoplay loop playsinline class="preview-bg"></video>`;
    } else {
      bgHtml = `<img src="${sl.bg_url}" class="preview-bg" draggable="false">`;
    }
  }

  // 텍스트 오버레이 (드래그 가능) — 강조 적용
  const rawMain = (ovr.main !== undefined ? ovr.main : sl.main || "").replace(/<[^>]*>/g, "");
  const rawSub = (ovr.sub !== undefined ? ovr.sub : sl.sub || "").replace(/<[^>]*>/g, "");
  // 리치 텍스트(HTML 컬러)가 있으면 사용, 없으면 레거시 하이라이트
  const mainText = ovr.richMain || _applyHighlights(rawMain, ovr.mainHighlights || ovr.highlights);
  const subText = ovr.richSub || _applyHighlights(rawSub, ovr.subHighlights);
  const mainSize = (ovr.mainSize || 100) * SCALE;
  const subSize = (ovr.subSize || 52) * SCALE;

  // 채널 레이아웃에 따른 텍스트 위치 결정
  const chCfg = composerData.channel_config || {};
  const slideLayout = chCfg.slide_layout || "full";
  const zoneRatio = (chCfg.slide_zone_ratio || "3:4:3").split(":").map(Number);
  const zoneTotal = zoneRatio[0] + zoneRatio[1] + zoneRatio[2];
  const topZonePct = zoneRatio[0] / zoneTotal;
  const midZonePct = zoneRatio[1] / zoneTotal;

  let posX, posY, subPosX, subPosY, useZoned = false;
  const isZonedLayout = (slideLayout === "center" || slideLayout === "top" || slideLayout === "bottom");
  console.log("[renderPreview] layout:", slideLayout, "zoneRatio:", zoneRatio, "isZoned:", isZonedLayout, "ovr:", JSON.stringify({x:ovr.x, y:ovr.y}));
  if (isZonedLayout) {
    // Zoned 레이아웃: 메인 상단, 서브 하단 분리 배치
    useZoned = true;
    const botZonePct = zoneRatio[2] / zoneTotal;
    // 실제 캔버스 높이 기반 계산 (CSS aspect-ratio로 동적)
    const canvasEl = document.querySelector(".preview-canvas") || container;
    const realCanvasH = canvasEl.clientHeight || (REAL_H * SCALE);
    const realCanvasW = canvasEl.clientWidth || (REAL_W * SCALE);
    const scaleY = realCanvasH / REAL_H;
    const scaleX = realCanvasW / REAL_W;

    // 메인 텍스트: 수동 위치 우선
    posX = (ovr.x !== undefined ? ovr.x : REAL_W / 2) * scaleX;

    // 서브 텍스트: 수동 위치(subX/subY) 우선
    subPosX = (ovr.subX !== undefined ? ovr.subX : REAL_W / 2) * scaleX;

    const topZoneEndPx = realCanvasH * topZonePct;
    const midZoneEndPx = realCanvasH * (topZonePct + midZonePct);

    if (slideLayout === "center") {
      posY = ovr.y !== undefined ? ovr.y * scaleY : topZoneEndPx * 0.5;
      subPosY = ovr.subY !== undefined ? ovr.subY * scaleY : midZoneEndPx;
    } else if (slideLayout === "top") {
      const botStart = midZoneEndPx;
      const botH = realCanvasH * botZonePct;
      posY = ovr.y !== undefined ? ovr.y * scaleY : botStart + botH * 0.3;
      subPosY = ovr.subY !== undefined ? ovr.subY * scaleY : botStart + botH * 0.65;
    } else { // bottom
      posY = ovr.y !== undefined ? ovr.y * scaleY : topZoneEndPx * 0.3;
      subPosY = ovr.subY !== undefined ? ovr.subY * scaleY : topZoneEndPx * 0.65;
    }
  } else {
    // full 레이아웃: 기존 동작
    posX = (ovr.x !== undefined ? ovr.x : REAL_W / 2) * SCALE;
    posY = (ovr.y !== undefined ? ovr.y : REAL_H / 2) * SCALE;
  }

  const overlayOpacity = isHidden ? 0.2 : 1;
  const maxW = (ovr.maxWidth || 1000) * SCALE;
  const mainColor = ovr.mainColor || '#ffffff';
  const subColor = ovr.subColor || '#d1d5db';
  const fontFamily = ovr.fontFamily || 'Noto Sans KR';
  const bgOpacity = ovr.bgOpacity !== undefined ? ovr.bgOpacity / 100 : 0.4;

  const ovrRot = ovr.rotation || 0;
  const resizeHandles = !isHidden ? `
        <div class="el-rotate" onmousedown="startOverlayRotate(event)">↻</div>
        <div class="el-resize el-r-tl" onmousedown="startOverlayResize(event, 'tl')"></div>
        <div class="el-resize el-r-tr" onmousedown="startOverlayResize(event, 'tr')"></div>
        <div class="el-resize el-r-bl" onmousedown="startOverlayResize(event, 'bl')"></div>
        <div class="el-resize el-r-br" onmousedown="startOverlayResize(event, 'br')"></div>
  ` : '';

  let overlayHtml;
  if (useZoned && subText) {
    // Zoned 레이아웃: 메인/서브 분리 배치
    overlayHtml = `
      <div id="text-overlay-drag" class="comp-element-box ${isHidden ? 'overlay-hidden' : ''}"
           style="left:${posX}px; top:${posY}px; opacity:${overlayOpacity}; width:${maxW}px; background:rgba(5,8,20,${bgOpacity}); font-family:'${fontFamily}',sans-serif; z-index:20; transform:translate(-50%,-50%) rotate(${ovrRot}deg); text-align:center; padding:8px 12px;"
           onmousedown="startOverlayDrag(event)">
        <div class="overlay-main" style="font-size:${mainSize}px; color:${mainColor};">${mainText}</div>
        ${resizeHandles}
      </div>
      <div id="sub-overlay-drag" class="comp-element-box ${isHidden ? 'overlay-hidden' : ''}"
           style="left:${subPosX}px; top:${subPosY}px; opacity:${overlayOpacity}; width:${maxW}px; background:rgba(5,8,20,${bgOpacity * 0.7}); font-family:'${fontFamily}',sans-serif; z-index:19; transform:translate(-50%,0); text-align:center; padding:6px 10px;"
           onmousedown="startSubOverlayDrag(event)">
        <div class="overlay-sub" style="font-size:${subSize}px; color:${subColor};">${subText}</div>
      </div>
    `;
  } else {
    // full 레이아웃 또는 서브 텍스트 없음: 기존 동작
    overlayHtml = `
      <div id="text-overlay-drag" class="comp-element-box ${isHidden ? 'overlay-hidden' : ''}"
           style="left:${posX}px; top:${posY}px; opacity:${overlayOpacity}; width:${maxW}px; background:rgba(5,8,20,${bgOpacity}); font-family:'${fontFamily}',sans-serif; z-index:20; transform:translate(-50%,-50%) rotate(${ovrRot}deg); text-align:center;"
           onmousedown="startOverlayDrag(event)">
        <div class="overlay-main" style="font-size:${mainSize}px; color:${mainColor};">${mainText}</div>
        ${subText ? `<div class="overlay-sub" style="font-size:${subSize}px; color:${subColor};">${subText}</div>` : ""}
        ${resizeHandles}
      </div>
    `;
  }

  // 자유 텍스트 (회전 + 4코너 리사이즈)
  const freeTexts = (composeState.freeTexts || []).filter(ft => ft.slideNum === sl.num);
  let freeTextHtml = "";
  freeTexts.forEach((ft) => {
    const ftIdx = (composeState.freeTexts || []).indexOf(ft);
    const ftX = (ft.x || 540) * SCALE;
    const ftY = (ft.y || 960) * SCALE;
    const ftSize = (ft.size || 48) * SCALE;
    const ftFont = ft.fontFamily || 'Noto Sans KR';
    const ftRot = ft.rotation || 0;
    freeTextHtml += `<div class="comp-element-box" data-ft-idx="${ftIdx}"
      style="left:${ftX}px;top:${ftY}px;font-size:${ftSize}px;color:${ft.color || '#ffffff'};font-family:'${ftFont}',sans-serif;transform:translate(-50%,-50%) rotate(${ftRot}deg);"
      onmousedown="startFreeTextDrag(event, ${ftIdx})">${_esc(ft.text)}
      <div class="el-rotate" onmousedown="startElementRotate(event, 'freeText', ${ftIdx})">↻</div>
      <div class="el-resize el-r-tl" onmousedown="startFreeTextResize(event, ${ftIdx}, 'tl')"></div>
      <div class="el-resize el-r-tr" onmousedown="startFreeTextResize(event, ${ftIdx}, 'tr')"></div>
      <div class="el-resize el-r-bl" onmousedown="startFreeTextResize(event, ${ftIdx}, 'bl')"></div>
      <div class="el-resize el-r-br" onmousedown="startFreeTextResize(event, ${ftIdx}, 'br')"></div>
    </div>`;
  });

  // 요소 (말풍선/이미지)
  const elements = (composeState.elements || []).filter(e => e.slideNum === sl.num);
  let elemHtml = "";
  elements.forEach((elem) => {
    const eIdx = composeState.elements.indexOf(elem);
    const eX = (elem.x || 540) * SCALE;
    const eY = (elem.y || 500) * SCALE;
    const eW = (elem.width || 300) * SCALE;
    const eH = (elem.height || 250) * SCALE;
    const eRot = elem.rotation || 0;

    let inner = "";
    if (elem.type === "bubble") {
      const bSvg = BUBBLE_SVGS[elem.bubbleIdx]?.svg || '';
      const fillSvg = bSvg.replace(/fill="white"/g, `fill="${elem.fillColor || '#ffffff'}"`);
      inner = `<svg viewBox="0 0 100 95" width="100%" height="100%" style="position:absolute;inset:0;">${fillSvg}</svg>`;
      if (elem.text) {
        inner += `<div style="position:absolute;inset:10%;display:flex;align-items:center;justify-content:center;text-align:center;font-size:${(elem.textSize||36)*SCALE}px;color:${elem.textColor||'#000'};font-weight:700;word-break:keep-all;line-height:1.2;z-index:2;">${_esc(elem.text)}</div>`;
      }
    } else if (elem.type === "image") {
      inner = `<img src="${elem.dataUrl}" style="width:100%;height:100%;object-fit:contain;" draggable="false">`;
    }

    elemHtml += `<div class="comp-element-box" data-el-idx="${eIdx}"
      style="left:${eX}px;top:${eY}px;width:${eW}px;height:${eH}px;transform:translate(-50%,-50%) rotate(${eRot}deg);"
      onmousedown="startElementDrag(event, ${eIdx})">
      ${inner}
      <div class="el-rotate" onmousedown="startElementRotate(event, 'element', ${eIdx})">↻</div>
      <div class="el-resize el-r-tl" onmousedown="startElementResize(event, ${eIdx}, 'tl')"></div>
      <div class="el-resize el-r-tr" onmousedown="startElementResize(event, ${eIdx}, 'tr')"></div>
      <div class="el-resize el-r-bl" onmousedown="startElementResize(event, ${eIdx}, 'bl')"></div>
      <div class="el-resize el-r-br" onmousedown="startElementResize(event, ${eIdx}, 'br')"></div>
    </div>`;
  });

  // Zone 가이드라인 (center/top/bottom 레이아웃) — % 단위로 정확한 비율
  let zoneGuideHtml = "";
  // 세로 중앙 가이드 (항상 표시)
  zoneGuideHtml = `<div class="zone-guide-center"></div>`;
  if (isZonedLayout) {
    const topPct = (topZonePct * 100).toFixed(1);
    const midPct = (midZonePct * 100).toFixed(1);
    const botPct = ((zoneRatio[2] / zoneTotal) * 100).toFixed(1);
    zoneGuideHtml += `
      <div class="zone-guide zone-top" style="height:${topPct}%;" title="상단 텍스트 영역 (${zoneRatio[0]})"></div>
      <div class="zone-guide zone-mid" style="top:${topPct}%;height:${midPct}%;" title="이미지 영역 (${zoneRatio[1]})"></div>
      <div class="zone-guide zone-bot" style="top:${(parseFloat(topPct)+parseFloat(midPct)).toFixed(1)}%;height:${botPct}%;" title="하단 텍스트 영역 (${zoneRatio[2]})"></div>
    `;
  }

  container.innerHTML = `
    <div class="preview-canvas">
      ${bgHtml || '<div class="preview-bg-fallback"></div>'}
      ${zoneGuideHtml}
      ${elemHtml}
      ${freeTextHtml}
      ${overlayHtml}
      <div class="preview-slide-num">${sl.num}/${composerData.slides.length}</div>
      ${isHidden ? '<div class="preview-hidden-badge">오버레이 숨김</div>' : ''}
    </div>
  `;
}

function startOverlayDrag(e) {
  e.preventDefault();
  const sl = getSelectedSlide();
  if (!sl) return;

  const ovr = getOverride(sl.num);
  if (ovr.hidden) return;

  const overlay = document.getElementById("text-overlay-drag");
  if (!overlay) return;

  const startX = e.clientX, startY = e.clientY;
  const origLeft = parseFloat(overlay.style.left) || 0;
  const origTop = parseFloat(overlay.style.top) || 0;

  function onMove(e2) {
    const dx = e2.clientX - startX;
    const dy = e2.clientY - startY;
    const newLeft = origLeft + dx;
    const newTop = origTop + dy;
    overlay.style.left = `${newLeft}px`;
    overlay.style.top = `${newTop}px`;

    // 실제 좌표로 변환하여 저장
    setOverride(sl.num, "x", Math.round(newLeft / SCALE));
    setOverride(sl.num, "y", Math.round(newTop / SCALE));
    renderProps();
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startSubOverlayDrag(e) {
  e.preventDefault();
  const sl = getSelectedSlide();
  if (!sl) return;
  const ovr = getOverride(sl.num);
  if (ovr.hidden) return;

  const subEl = document.getElementById("sub-overlay-drag");
  if (!subEl) return;

  const startX = e.clientX, startY = e.clientY;
  const origLeft = parseFloat(subEl.style.left) || 0;
  const origTop = parseFloat(subEl.style.top) || 0;

  function onMove(e2) {
    const dx = e2.clientX - startX;
    const dy = e2.clientY - startY;
    subEl.style.left = `${origLeft + dx}px`;
    subEl.style.top = `${origTop + dy}px`;
    // 서브 위치는 subX/subY로 별도 저장
    setOverride(sl.num, "subX", Math.round((origLeft + dx) / SCALE));
    setOverride(sl.num, "subY", Math.round((origTop + dy) / SCALE));
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startOverlayRotate(e) {
  e.preventDefault();
  e.stopPropagation();
  const sl = getSelectedSlide();
  if (!sl) return;
  const overlay = document.getElementById("text-overlay-drag");
  if (!overlay) return;
  const rect = overlay.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const ovr = getOverride(sl.num);
  const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
  const origRot = ovr.rotation || 0;

  function onMove(e2) {
    const angle = Math.atan2(e2.clientY - cy, e2.clientX - cx) * 180 / Math.PI;
    const newRot = Math.round(origRot + angle - startAngle);
    setOverride(sl.num, "rotation", newRot);
    overlay.style.transform = `translate(-50%,-50%) rotate(${newRot}deg)`;
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    renderPreview();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startOverlayResize(e, corner) {
  e.preventDefault();
  e.stopPropagation();
  const sl = getSelectedSlide();
  if (!sl) return;
  const ovr = getOverride(sl.num);
  const overlay = document.getElementById("text-overlay-drag");
  if (!overlay) return;

  const rot = (ovr.rotation || 0) * Math.PI / 180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const startX = e.clientX, startY = e.clientY;
  const origW = ovr.maxWidth || 1000;
  const origMainSize = ovr.mainSize || 100;
  const origSubSize = ovr.subSize || 52;

  function onMove(e2) {
    // 마우스 이동량을 로컬 좌표계(회전 해제)로 변환
    const dx = (e2.clientX - startX) / SCALE;
    const dy = (e2.clientY - startY) / SCALE;
    const localDx = dx * cosR + dy * sinR;
    const localDy = -dx * sinR + dy * cosR;

    // 코너 방향에 따라 부호 결정
    const sx = corner.includes('r') ? 1 : -1;
    const sy = corner.includes('b') ? 1 : -1;

    // 가로: maxWidth 조절
    const scaleX = Math.max(0.2, (origW + sx * localDx * 2) / origW);
    const newW = Math.max(200, Math.round(origW * scaleX));
    setOverride(sl.num, "maxWidth", newW);
    overlay.style.width = `${newW * SCALE}px`;

    // 세로: fontSize 조절
    const scaleY = Math.max(0.2, 1 + sy * localDy * 2 / (origMainSize * 4));
    const newMain = Math.round(Math.max(24, Math.min(200, origMainSize * scaleY)));
    const newSub = Math.round(Math.max(16, Math.min(120, origSubSize * scaleY)));
    setOverride(sl.num, "mainSize", newMain);
    setOverride(sl.num, "subSize", newSub);

    const mainEl = overlay.querySelector(".overlay-main");
    const subEl = overlay.querySelector(".overlay-sub");
    if (mainEl) mainEl.style.fontSize = `${newMain * SCALE}px`;
    if (subEl) subEl.style.fontSize = `${newSub * SCALE}px`;
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    renderPreview();
    if (_activeTab === 'text') renderTabText();
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// renderProps → 활성 탭 갱신으로 대체
function renderProps() {
  if (_activeTab === 'text') renderTabText();
  if (_activeTab === 'narration') renderTabNarration();
  if (_activeTab === 'media') renderTabMedia();
}

// ─── Slide Duration ───

// TTS 생성 후 슬라이드 duration을 오디오 총 길이에 맞춰 자동 갱신
function _autoUpdateDurations() {
  if (!composerData.slide_audio) return;
  for (const num of composeState.slide_order) {
    const audios = composerData.slide_audio[num];
    if (!audios || audios.length === 0) continue;
    const totalAudioDur = audios.reduce((sum, a) => sum + (a.duration || 0), 0);
    if (totalAudioDur > 0) {
      // 오디오 길이 + 0.3초 여유
      const newDur = Math.round((totalAudioDur + 0.3) * 10) / 10;
      if (!composeState.slide_durations) composeState.slide_durations = {};
      composeState.slide_durations[num] = newDur;
      _dirty = true;
    }
  }
}

function getSlideDuration(slideNum) {
  if (composeState.slide_durations && composeState.slide_durations[slideNum]) {
    return composeState.slide_durations[slideNum];
  }
  const sl = composerData.slides.find(s => s.num === slideNum);
  return sl ? sl.duration : 3.0;
}

function updateSlideDuration(slideNum, dur) {
  if (!composeState.slide_durations) composeState.slide_durations = {};
  composeState.slide_durations[slideNum] = Math.max(1, dur);
  _dirty = true;
  renderTimeline();
  renderProps();
}

function getTotalDuration() {
  return getOrderedSlides().reduce((sum, sl) => sum + getSlideDuration(sl.num), 0);
}

// ─── Background Upload ───

async function uploadSlideBg(slideNum, input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file);

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/backgrounds/${slideNum}`, {
      method: "POST",
      body: formData,
    });
    if (r.ok) {
      // 데이터 새로고침
      await refreshData();
      renderTimeline();
      renderPreview();
      renderProps();
    }
  } catch (e) {
    console.error("배경 업로드 실패:", e);
  }
}

// ─── TTS Generation ───

async function generateTTS(slideNum) {
  const btn = document.getElementById("btn-gen-tts");
  const status = document.getElementById("tts-status");
  if (btn) { btn.textContent = "생성 중..."; btn.disabled = true; }
  if (status) status.textContent = "TTS 생성 중...";

  const engine = document.getElementById("tts-engine")?.value || "edge-tts";
  const voice = document.getElementById("tts-voice")?.value || "";

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slide_num: slideNum, tts_engine: engine, tts_voice: voice }),
    });
    const data = await r.json();
    if (data.ok) {
      if (status) status.textContent = `생성 완료 (${data.count}개 문장)`;
      await refreshData();
      _autoUpdateDurations();
      renderTimeline();
      renderProps();
    } else {
      if (status) status.textContent = `실패: ${data.error || "알 수 없는 오류"}`;
    }
  } catch (e) {
    if (status) status.textContent = `오류: ${e.message}`;
  } finally {
    if (btn) { btn.textContent = "TTS 생성"; btn.disabled = false; }
  }
}

async function generateAllTTS() {
  const btn = document.getElementById("btn-gen-all-tts");
  const status = document.getElementById("tts-status");
  if (btn) { btn.textContent = "..."; btn.disabled = true; }
  if (status) status.textContent = "전체 TTS 생성 중...";

  const engine = document.getElementById("tts-engine")?.value || "edge-tts";
  const voice = document.getElementById("tts-voice")?.value || "";

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tts_engine: engine, tts_voice: voice }),  // slide_num 없으면 전체
    });
    const data = await r.json();
    if (data.ok) {
      if (status) status.textContent = `전체 생성 완료 (${data.count}개 문장)`;
      await refreshData();
      _autoUpdateDurations();
      renderTimeline();
      renderProps();
    } else {
      if (status) status.textContent = `실패: ${data.error || ""}`;
    }
  } catch (e) {
    if (status) status.textContent = `오류: ${e.message}`;
  } finally {
    if (btn) { btn.textContent = "전체"; btn.disabled = false; }
  }
}

// ─── Audio Upload per Slide ───

async function uploadSlideAudio(slideNum, input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById("tts-status");
  if (status) status.textContent = "업로드 중...";

  const formData = new FormData();
  formData.append("file", file);

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/audio/${slideNum}`, {
      method: "POST",
      body: formData,
    });
    if (r.ok) {
      if (status) status.textContent = "업로드 완료";
      await refreshData();
      renderTimeline();
      renderProps();
    }
  } catch (e) {
    if (status) status.textContent = `오류: ${e.message}`;
  }
}

// ─── Audio Playback ───

let _previewAudioPath = null;

function previewAudio(path, btnEl) {
  // 같은 파일 재클릭 → 정지
  if (_playingAudio && _previewAudioPath === path && !_playingAudio.paused) {
    _playingAudio.pause();
    _playingAudio.currentTime = 0;
    _playingAudio = null;
    _previewAudioPath = null;
    if (btnEl) btnEl.textContent = '▶';
    return;
  }
  // 다른 파일 또는 새로 재생
  if (_playingAudio) { _playingAudio.pause(); _playingAudio = null; }
  _previewAudioPath = path;
  _playingAudio = new Audio(path);
  _playingAudio.volume = (composeState.narr_volume !== undefined ? composeState.narr_volume : 100) / 100;
  _playingAudio.play().catch(() => {});
  if (btnEl) btnEl.textContent = '■';
  _playingAudio.addEventListener("ended", () => {
    _playingAudio = null;
    _previewAudioPath = null;
    if (btnEl) btnEl.textContent = '▶';
  });
}

let _previewing = false;
let _previewSlideIdx = 0;
let _previewAudioIdx = 0;
let _previewStartTime = 0;
let _previewBgm = null;
let _previewTimer = null;

function stopAllAudio() {
  if (_playingAudio) {
    _playingAudio.pause();
    _playingAudio.currentTime = 0;
    _playingAudio = null;
  }
  if (_previewBgm) {
    _previewBgm.pause();
    _previewBgm = null;
  }
  // SFX 오디오 정리
  if (_sfxAudios) { _sfxAudios.forEach(a => { a.pause(); }); _sfxAudios = []; }
  _sfxFired = new Set();
  if (_previewTimer) {
    cancelAnimationFrame(_previewTimer);
    _previewTimer = null;
  }
  _previewing = false;
  const pb = document.getElementById("btn-play") || document.getElementById("btn-play-slide");
  if (pb) pb.innerHTML = "&#9654;";
}

// ▶ 버튼: 재생/정지 토글
async function togglePreview() {
  if (_previewing) { stopAllAudio(); return; }
  await playAllSlides();
}

// (legacy) 현재 슬라이드만 미리듣기
async function playSlideAudio() {
  if (_previewing) { stopAllAudio(); return; }
  const sl = getSelectedSlide();
  if (!sl) return;

  let slideAudio = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];

  // 오디오 없으면 해당 슬라이드만 TTS 생성
  if (slideAudio.length === 0) {
    const statusEl = document.getElementById("audio-status");
    if (statusEl) statusEl.textContent = `슬라이드 ${sl.num} TTS 생성 중...`;
    try {
      const engine = document.getElementById("tts-engine")?.value || "edge-tts";
      const r = await fetch(`/api/jobs/${JOB_ID}/composer/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slide_num: sl.num, tts_engine: engine }),
      });
      const data = await r.json();
      if (!data.ok) {
        if (statusEl) statusEl.textContent = `TTS 실패: ${data.error || ''}`;
        return;
      }
      await refreshData();
      if (_activeTab === 'narration') renderTabNarration();
      slideAudio = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
      if (slideAudio.length === 0) {
        if (statusEl) statusEl.textContent = "오디오 생성 실패";
        return;
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = `오류: ${e.message}`;
      return;
    }
  }

  stopAllAudio();
  document.getElementById("btn-play-slide").innerHTML = "&#9646;&#9646;";
  _previewing = true;

  // 해당 슬라이드 시작 위치로 플레이헤드 설정 + 틱 시작
  _buildSlideTimeMap();
  _previewStartTime = performance.now();
  _previewSlideIdx = -1;
  _previewAudioPlayed = new Set();

  // 이 슬라이드의 시작 시점으로 오프셋
  const slideIdx = composeState.slide_order.indexOf(sl.num);
  let slideStart = 0;
  for (let i = 0; i < slideIdx && i < _slideTimeMap.length; i++) {
    slideStart += getSlideDuration(_slideTimeMap[i].num);
  }
  _previewStartTime = performance.now() - slideStart * 1000;

  _playAudioChain(slideAudio, 0, () => { stopAllAudio(); });
  _previewTick();
}

function _playAudioChain(audioList, idx, onDone) {
  if (!_previewing || idx >= audioList.length) { if (onDone) onDone(); return; }
  _playingAudio = new Audio(audioList[idx].path);
  _playingAudio.volume = (composeState.narr_volume !== undefined ? composeState.narr_volume : 100) / 100;
  _playingAudio.play().catch(() => {});
  _playingAudio.addEventListener("ended", () => {
    _playAudioChain(audioList, idx + 1, onDone);
  });
}

function updateNarrVolume(val) {
  composeState.narr_volume = val;
  _dirty = true;
  const label = document.getElementById("narr-vol-val");
  if (label) label.textContent = val + "%";
  // 현재 재생 중인 나레이션에도 즉시 적용
  if (_playingAudio) _playingAudio.volume = val / 100;
}

// 전체 미리보기: 슬라이드 순서대로 배경+오버레이+나레이션 재생
// 전체 미리보기: 시간 기반 단일 루프
async function playAllSlides() {
  if (_previewing) { stopAllAudio(); return; }

  // 오디오 파일 존재 여부 확인
  const hasAnyAudio = _checkAllHaveAudio();
  if (!hasAnyAudio) {
    // TTS 미생성 → 자동 생성 후 재생
    const statusEl = document.getElementById("audio-status");
    if (statusEl) statusEl.textContent = "TTS 생성 중...";
    const playBtn = document.querySelector('[onclick="playAllSlides()"]');
    if (playBtn) { playBtn.textContent = "TTS 생성 중..."; playBtn.disabled = true; }

    try {
      const engine = document.getElementById("tts-engine")?.value || "edge-tts";
      const r = await fetch(`/api/jobs/${JOB_ID}/composer/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tts_engine: engine }),
      });
      const data = await r.json();
      if (!data.ok) {
        if (statusEl) statusEl.textContent = `TTS 실패: ${data.error || ''}`;
        if (playBtn) { playBtn.textContent = "▶ 전체 미리듣기"; playBtn.disabled = false; }
        return;
      }
      // 데이터 새로고침 + 슬라이드 duration 오디오 길이에 맞춤
      await refreshData();
      _autoUpdateDurations();
      if (statusEl) statusEl.textContent = `TTS 생성 완료 (${data.count}문장) — 재생 시작`;
    } catch (e) {
      if (statusEl) statusEl.textContent = `오류: ${e.message}`;
      if (playBtn) { playBtn.textContent = "▶ 전체 미리듣기"; playBtn.disabled = false; }
      return;
    }
    if (playBtn) { playBtn.textContent = "▶ 전체 미리듣기"; playBtn.disabled = false; }
    // 나레이션 탭 갱신
    if (_activeTab === 'narration') renderTabNarration();
    renderTimeline();
  }

  stopAllAudio();
  _previewing = true;
  _previewStartTime = performance.now();
  _previewSlideIdx = -1;
  _previewAudioPlayed = new Set();

  const pb2 = document.getElementById("btn-play") || document.getElementById("btn-play-slide");
  if (pb2) pb2.innerHTML = "&#9646;&#9646;";

  _sfxFired = new Set();
  _buildSlideTimeMap();
  _syncBgm(0);
  _previewTick();
}

function _checkAllHaveAudio() {
  if (!composerData.slide_audio) return false;
  // 문장이 있는 슬라이드만 오디오 필요
  let needCount = 0;
  let haveCount = 0;
  for (const num of composeState.slide_order) {
    const sl = composerData.slides.find(s => s.num === num);
    if (!sl || !sl.sentences || sl.sentences.length === 0) continue;
    needCount++;
    const audios = composerData.slide_audio[num];
    if (audios && audios.length > 0) haveCount++;
  }
  return needCount > 0 && haveCount >= needCount;
}

let _slideTimeMap = [];  // [{num, start, end, audioFiles}, ...]
let _previewAudioPlayed = new Set();

function _buildSlideTimeMap() {
  _slideTimeMap = [];
  const slides = getOrderedSlides();
  let t = 0;
  slides.forEach(sl => {
    const dur = getSlideDuration(sl.num);
    const audioFiles = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
    _slideTimeMap.push({ num: sl.num, start: t, end: t + dur, audioFiles });
    t += dur;
  });
}

let _sfxFired = new Set();
let _sfxAudios = [];

function _syncBgm(elapsed) {
  const bgm = composeState.bgm;
  if (!bgm || !bgm.path) {
    if (_previewBgm) { _previewBgm.pause(); _previewBgm = null; }
    return;
  }
  const inRange = elapsed >= bgm.start_time && elapsed < bgm.end_time;
  if (inRange) {
    if (!_previewBgm) {
      _previewBgm = new Audio(bgm.path);
      _previewBgm.loop = true;
    }
    _previewBgm.volume = bgm.volume || 0.1;
    // 페이드인
    const fi = bgm.fade_in || 0;
    if (fi > 0 && elapsed - bgm.start_time < fi) {
      _previewBgm.volume = (bgm.volume || 0.1) * ((elapsed - bgm.start_time) / fi);
    }
    // 페이드아웃
    const fo = bgm.fade_out || 0;
    if (fo > 0 && bgm.end_time - elapsed < fo) {
      _previewBgm.volume = (bgm.volume || 0.1) * ((bgm.end_time - elapsed) / fo);
    }
    const bgmOffset = elapsed - bgm.start_time;
    // 오디오 위치가 크게 벗어났으면 보정
    if (_previewBgm.paused || Math.abs(_previewBgm.currentTime - bgmOffset) > 1) {
      _previewBgm.currentTime = bgmOffset % (_previewBgm.duration || 999);
    }
    if (_previewBgm.paused) _previewBgm.play().catch(() => {});
  } else {
    if (_previewBgm && !_previewBgm.paused) _previewBgm.pause();
  }
}

function _triggerSfx(elapsed) {
  (composeState.sfx_markers || []).forEach(m => {
    if (_sfxFired.has(m.id)) return;
    if (elapsed >= m.time && elapsed < m.time + 0.3) {
      _sfxFired.add(m.id);
      const sfxInfo = (composerData.sfx_list || []).find(s => s.file === m.file);
      if (sfxInfo) {
        const a = new Audio(sfxInfo.path);
        const vol = m.volume || 0.8;
        const fi = m.fade_in || 0;
        const fo = m.fade_out || 0;
        a.volume = fi > 0 ? 0 : vol;
        a.play().catch(() => {});
        // 페이드인
        if (fi > 0) {
          const steps = Math.ceil(fi * 20);
          let step = 0;
          const fadeTimer = setInterval(() => {
            step++;
            a.volume = Math.min(vol, vol * (step / steps));
            if (step >= steps) clearInterval(fadeTimer);
          }, fi * 1000 / steps);
        }
        // 페이드아웃
        if (fo > 0 && sfxInfo.duration) {
          const foStart = (sfxInfo.duration - fo) * 1000;
          if (foStart > 0) {
            setTimeout(() => {
              const steps = Math.ceil(fo * 20);
              let step = 0;
              const curVol = a.volume;
              const fadeTimer = setInterval(() => {
                step++;
                a.volume = Math.max(0, curVol * (1 - step / steps));
                if (step >= steps) clearInterval(fadeTimer);
              }, fo * 1000 / steps);
            }, foStart);
          }
        }
        _sfxAudios.push(a);
      }
    }
  });
}

function _previewTick() {
  if (!_previewing) return;

  try {
    const now = performance.now();
    const elapsed = (now - _previewStartTime) / 1000;
    const total = getTotalDuration() || 1;

    // 종료
    if (elapsed >= total) {
      stopAllAudio();
      const s = document.getElementById("audio-status");
      if (s) s.textContent = "미리보기 완료";
      _playheadPos = 1;
      updatePlayhead();
      return;
    }

    // 현재 슬라이드 결정
    let curSlideIdx = 0;
    for (let i = 0; i < _slideTimeMap.length; i++) {
      if (elapsed >= _slideTimeMap[i].start && elapsed < _slideTimeMap[i].end) {
        curSlideIdx = i;
        break;
      }
      if (i === _slideTimeMap.length - 1) curSlideIdx = i;
    }

    // 슬라이드 전환 시 미리보기 갱신 + 오디오 재생
    if (curSlideIdx !== _previewSlideIdx) {
      _previewSlideIdx = curSlideIdx;
      const map = _slideTimeMap[curSlideIdx];
      if (map) {
        const slideOrderIdx = composeState.slide_order.indexOf(map.num);
        if (slideOrderIdx >= 0) {
          selectedSlide = slideOrderIdx;
          document.querySelectorAll(".slide-block").forEach((el, i) => el.classList.toggle("active", i === slideOrderIdx));
          renderPreview();
        }

        // 나레이션 재생
        const slideKey = `slide_${curSlideIdx}`;
        if (!_previewAudioPlayed.has(slideKey)) {
          _previewAudioPlayed.add(slideKey);
          if (map.audioFiles && map.audioFiles.length > 0) {
            if (_playingAudio) { _playingAudio.pause(); _playingAudio = null; }
            _playAudioChain(map.audioFiles, 0, () => {});
          }
        }
      }
    }

    // 플레이헤드 위치 (퍼센트)
    _playheadPos = elapsed / total;
    updatePlayhead();

    // BGM + SFX 동기화
    _syncBgm(elapsed);
    _triggerSfx(elapsed);

    // 상태 표시
    const statusEl = document.getElementById("audio-status");
    if (statusEl) {
      statusEl.textContent = `${_fmtDur(elapsed)} / ${_fmtDur(total)} — 슬라이드 ${curSlideIdx + 1}/${_slideTimeMap.length}`;
    }
  } catch (err) {
    console.error("[composer] previewTick error:", err);
  }

  // 에러가 나도 루프 유지
  _previewTimer = requestAnimationFrame(_previewTick);
}

function _fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ─── Tab System ───

let _activeTab = 'media';

function switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.comp-icon-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.comp-tab-content').forEach(el => el.classList.toggle('active', el.id === `tab-${tab}`));
  if (tab === 'text') renderTabText();
  if (tab === 'narration') renderTabNarration();
  if (tab === 'bgm') renderTabBgm();
  if (tab === 'sfx') renderTabSfx();
  if (tab === 'media') renderTabMedia();
  if (tab === 'elements') renderTabElements();
  if (tab === 'transition') renderTabTransition();
}

// ─── Tab: Media ───

function renderTabMedia() {
  const el = document.getElementById("tab-media");
  const slides = getOrderedSlides();
  let html = `<div class="comp-tab-title">배경 이미지</div>`;
  html += `<div class="media-grid">`;
  slides.forEach((sl, idx) => {
    const isActive = idx === selectedSlide;
    const isClosing = sl.bg_type === "closing";
    // closing + 문장 없음 + 배경 없음 → 숨김
    if (isClosing && (!sl.sentences || sl.sentences.length === 0) && !sl.bg_url) return;

    if (sl.bg_url) {
      const isVideo = sl.bg_url.includes('.mp4') || sl.bg_url.includes('.gif');
      html += `<div class="media-item ${isActive ? 'active' : ''}" onclick="selectSlide(${idx})">
        ${isVideo ? `<video src="${sl.bg_url}" muted autoplay loop playsinline></video>` : `<img src="${sl.bg_url}" draggable="false">`}
        <div class="media-item-badge">${sl.num}</div>
        <div class="media-item-label">${sl.bg_type}</div>
        <button class="media-item-delete" onclick="event.stopPropagation(); removeSlide(${idx})" title="삭제">&times;</button>
      </div>`;
    } else {
      html += `<div class="media-item ${isActive ? 'active' : ''}" onclick="selectSlide(${idx})" style="display:flex;align-items:center;justify-content:center;">
        <div class="media-item-badge">${sl.num}</div>
        <span style="font-size:9px;color:#6b7280;">없음</span>
        <button class="media-item-delete" onclick="event.stopPropagation(); removeSlide(${idx})" title="삭제">&times;</button>
      </div>`;
    }
  });
  html += `<div class="media-upload-btn" onclick="document.getElementById('bg-upload-input-tab').click()">+ 이미지 업로드</div>`;
  html += `</div>`;
  html += `<input type="file" accept="image/*,video/mp4" id="bg-upload-input-tab" class="hidden" onchange="uploadCurrentSlideBg(this)">`;
  el.innerHTML = html;
}

function removeSlide(idx) {
  if (composeState.slide_order.length <= 1) return;
  composeState.slide_order.splice(idx, 1);
  _dirty = true;
  if (selectedSlide >= composeState.slide_order.length) selectedSlide = composeState.slide_order.length - 1;
  renderTimeline();
  renderTabMedia();
  renderPreview();
}

function uploadCurrentSlideBg(input) {
  const sl = getSelectedSlide();
  if (sl) uploadSlideBg(sl.num, input);
}

// ─── Tab: SFX (효과음) ───

function renderTabSfx() {
  const el = document.getElementById("tab-sfx");
  let html = `<div class="comp-tab-title">효과음</div>`;
  html += `<div class="comp-tab-subtitle">타임라인에 드래그하세요</div>`;
  (composerData.sfx_list || []).forEach(s => {
    html += `<div class="audio-item" draggable="true" ondragstart="onSfxDragStart(event, '${s.file}')">
      <button class="audio-play-btn" onclick="previewAudio('${s.path}', this)">&#9654;</button>
      <span class="flex-1 truncate">${s.file.replace(/\.[^.]+$/, '')}</span>
      <span style="font-size:9px;color:#6b7280;">${s.duration.toFixed(1)}s</span>
    </div>`;
  });
  if ((composerData.sfx_list || []).length === 0) {
    html += `<div style="font-size:10px;color:#4b5563;padding:12px;">data/sfx/ 폴더에 효과음을 추가하세요</div>`;
  }

  // 배치된 SFX 마커 목록
  const markers = composeState.sfx_markers || [];
  if (markers.length > 0) {
    html += `<div class="comp-tab-subtitle" style="margin-top:14px;">배치된 효과음 (${markers.length})</div>`;
    markers.forEach((m, mi) => {
      const name = m.file.replace(/\.[^.]+$/, '');
      html += `<div style="background:#22242e;border-radius:6px;padding:6px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:10px;color:#818cf8;font-weight:600;">${name}</span>
          <button onclick="removeSfxMarker(${mi})" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;">&times;</button>
        </div>
        <div class="ctrl-grid-2">
          <div class="ctrl-row"><span class="ctrl-label">시점</span>
            <input class="ctrl-input" type="number" value="${m.time}" min="0" step="0.1"
                   onchange="updateSfxMarker(${mi}, 'time', +this.value)">
          </div>
          <div class="ctrl-row"><span class="ctrl-label">볼륨</span>
            <input class="ctrl-input" type="number" value="${m.volume || 0.8}" min="0" max="1" step="0.05"
                   onchange="updateSfxMarker(${mi}, 'volume', +this.value)">
          </div>
          <div class="ctrl-row"><span class="ctrl-label">길이</span>
            <input class="ctrl-input" type="number" value="${m.duration || ''}" min="0.1" step="0.1" placeholder="원본"
                   onchange="updateSfxMarker(${mi}, 'duration', +this.value || undefined)">
          </div>
          <div class="ctrl-row"><span class="ctrl-label">페이드인</span>
            <input class="ctrl-input" type="number" value="${m.fade_in || 0}" min="0" max="5" step="0.1"
                   onchange="updateSfxMarker(${mi}, 'fade_in', +this.value)">
          </div>
          <div class="ctrl-row"><span class="ctrl-label">페이드아웃</span>
            <input class="ctrl-input" type="number" value="${m.fade_out || 0}" min="0" max="5" step="0.1"
                   onchange="updateSfxMarker(${mi}, 'fade_out', +this.value)">
          </div>
        </div>
      </div>`;
    });
  }

  el.innerHTML = html;
}

// ─── Tab: BGM (배경음) ───

function renderTabBgm() {
  const el = document.getElementById("tab-bgm");
  let html = `<div class="comp-tab-title">배경 음악</div>`;
  (composerData.bgm_list || []).forEach(s => {
    const isActive = composeState.bgm && composeState.bgm.file === s.file;
    html += `<div class="audio-item ${isActive ? 'bgm-active' : ''}">
      <button class="audio-play-btn" onclick="previewAudio('${s.path}', this)">&#9654;</button>
      <span class="flex-1 truncate">${s.file.replace(/\.[^.]+$/, '')}</span>
      <span style="font-size:9px;color:#6b7280;">${s.duration ? (s.duration > 60 ? Math.floor(s.duration/60)+'m' : s.duration.toFixed(0)+'s') : ''}</span>
      <button class="audio-apply-btn ${isActive ? 'applied' : ''}" onclick="applyBgm('${_esc(s.file)}', '${_esc(s.path)}', ${s.duration || 0})">${isActive ? '적용됨' : '적용'}</button>
    </div>`;
  });
  if (composeState.bgm) {
    html += `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #2a2d38;">
      <div style="font-size:10px;color:#34d399;margin-bottom:6px;">적용됨: ${_esc(composeState.bgm.file)}</div>
      <div class="ctrl-row"><span class="ctrl-label">볼륨</span>
        <input class="ctrl-input" type="range" min="0" max="0.5" step="0.01" value="${composeState.bgm.volume}"
               oninput="updateBgmProp('volume', +this.value); this.nextElementSibling.textContent=Math.round(this.value*100)+'%';"
               style="flex:1;accent-color:#34d399;">
        <span style="font-size:9px;color:#6b7280;width:28px;text-align:right;">${Math.round(composeState.bgm.volume * 100)}%</span>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">시작</span>
        <input class="ctrl-input" type="number" value="${composeState.bgm.start_time}" min="0" step="0.5"
               onchange="updateBgmProp('start_time', +this.value)">
        <span style="font-size:8px;color:#6b7280;">초</span>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">종료</span>
        <input class="ctrl-input" type="number" value="${composeState.bgm.end_time}" min="0" step="0.5"
               onchange="updateBgmProp('end_time', +this.value)">
        <span style="font-size:8px;color:#6b7280;">초</span>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">페이드인</span>
        <input class="ctrl-input" type="number" value="${composeState.bgm.fade_in || 0}" min="0" max="10" step="0.5"
               onchange="updateBgmProp('fade_in', +this.value)">
        <span style="font-size:8px;color:#6b7280;">초</span>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">페이드아웃</span>
        <input class="ctrl-input" type="number" value="${composeState.bgm.fade_out || 0}" min="0" max="10" step="0.5"
               onchange="updateBgmProp('fade_out', +this.value)">
        <span style="font-size:8px;color:#6b7280;">초</span>
      </div>
      <button onclick="removeBgm()" style="width:100%;padding:5px;background:#3b1c1c;color:#f87171;border:none;border-radius:5px;font-size:10px;cursor:pointer;margin-top:6px;">제거</button>
    </div>`;
  }
  if ((composerData.bgm_list || []).length === 0) {
    html += `<div style="font-size:10px;color:#4b5563;padding:12px;">data/bgm/ 폴더에 배경음을 추가하세요</div>`;
  }
  el.innerHTML = html;
}

// ─── Tab: Elements (요소 — 말풍선/이미지) ───

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

function renderTabElements() {
  const el = document.getElementById("tab-elements");
  const sl = getSelectedSlide();
  let html = `<div class="comp-tab-title">요소</div>`;

  // 말풍선
  html += `<div class="comp-tab-subtitle">말풍선</div>`;
  html += `<div class="elements-grid">`;
  BUBBLE_SVGS.forEach((b, i) => {
    html += `<div class="element-item" onclick="addBubbleElement(${i})" title="${b.name}">
      <svg viewBox="0 0 100 95" width="100%" height="100%">${b.svg}</svg>
    </div>`;
  });
  html += `</div>`;

  // 현재 슬라이드의 요소 목록
  const elems = (composeState.elements || []).filter(e => e.slideNum === (sl ? sl.num : -1));
  if (elems.length > 0) {
    html += `<div class="comp-tab-subtitle" style="margin-top:12px;">배치된 요소 (${elems.length})</div>`;
    elems.forEach(elem => {
      const eIdx = composeState.elements.indexOf(elem);
      html += `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #22242e;">
        <svg viewBox="0 0 100 95" width="24" height="24" style="flex-shrink:0;"><rect width="100" height="95" rx="4" fill="#2a2d38"/>${BUBBLE_SVGS[elem.bubbleIdx]?.svg || ''}</svg>
        <span style="flex:1;font-size:9px;color:#d1d5db;">${elem.name || '말풍선'}</span>
        <button onclick="removeElement(${eIdx})" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;">&times;</button>
      </div>`;
    });
  }

  // 이미지 업로드
  html += `<div class="comp-tab-subtitle" style="margin-top:12px;">이미지 요소</div>`;
  html += `<input type="file" accept="image/*" id="element-img-upload" class="hidden" onchange="addImageElement(this)">`;
  html += `<button onclick="document.getElementById('element-img-upload').click()" style="width:100%;padding:6px;background:#2a2d38;color:#9ca3af;border:1px dashed #3a3d48;border-radius:6px;font-size:10px;cursor:pointer;">+ 이미지 추가</button>`;

  el.innerHTML = html;
}

function addBubbleElement(bubbleIdx) {
  const sl = getSelectedSlide();
  if (!sl) return;
  if (!composeState.elements) composeState.elements = [];
  composeState.elements.push({
    id: `el_${Date.now()}`,
    type: "bubble",
    slideNum: sl.num,
    bubbleIdx,
    name: BUBBLE_SVGS[bubbleIdx]?.name || "말풍선",
    x: 540, y: 500,
    width: 400, height: 300,
    rotation: 0,
    text: "",
    textSize: 36,
    textColor: "#000000",
    fillColor: "#ffffff",
  });
  _dirty = true;
  renderPreview();
  renderTabElements();
}

function addImageElement(input) {
  // 이미지 파일을 data URL로 변환하여 요소로 추가
  const file = input.files[0];
  if (!file) return;
  const sl = getSelectedSlide();
  if (!sl) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    if (!composeState.elements) composeState.elements = [];
    composeState.elements.push({
      id: `el_${Date.now()}`,
      type: "image",
      slideNum: sl.num,
      name: file.name,
      x: 540, y: 960,
      width: 300, height: 300,
      rotation: 0,
      dataUrl: e.target.result,
    });
    _dirty = true;
    renderPreview();
    renderTabElements();
  };
  reader.readAsDataURL(file);
  input.value = "";
}

function removeElement(idx) {
  if (composeState.elements) {
    composeState.elements.splice(idx, 1);
    _dirty = true;
    renderPreview();
    renderTabElements();
  }
}

// ─── Tab: Text (Overlay) ───

function renderTabText() {
  const el = document.getElementById("tab-text");
  const sl = getSelectedSlide();
  if (!sl) { el.innerHTML = `<div class="text-xs text-gray-600" style="padding:20px;">슬라이드를 선택하세요</div>`; return; }

  const ovr = getOverride(sl.num);
  const isHidden = ovr.hidden === true;
  const ovrMain = ovr.main !== undefined ? ovr.main : (sl.main || "").replace(/<[^>]*>/g, "");
  const ovrSub = ovr.sub !== undefined ? ovr.sub : (sl.sub || "").replace(/<[^>]*>/g, "");

  let html = `<div class="comp-tab-title">오버레이 편집 <span style="color:#6b7280;font-weight:400;">슬라이드 ${sl.num}</span></div>`;
  html += `<div class="ctrl-section">
    <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;cursor:pointer;">
      <input type="checkbox" ${isHidden ? '' : 'checked'} onchange="toggleOverlay(${sl.num}, !this.checked)"
             style="accent-color:#6366f1;width:14px;height:14px;">
      <span style="font-size:11px;color:#d1d5db;">오버레이 표시</span>
    </label>
  </div>`;

  html += `<div style="${isHidden ? 'opacity:0.3;pointer-events:none;' : ''}">`;
  // 제목/부제: richMain/richSub에 HTML(색상 span 포함) 저장, 없으면 plain text
  const richMain = ovr.richMain || _esc(ovrMain);
  const richSub = ovr.richSub || _esc(ovrSub);
  html += `<div class="ctrl-section">
    <div style="font-size:9px;color:#6b7280;margin-bottom:4px;">텍스트 선택 후 서식 적용</div>
    <div class="rich-toolbar" style="display:flex;gap:4px;margin-bottom:6px;align-items:center;flex-wrap:wrap;">
      <div style="display:flex;gap:2px;">
        ${['#ffffff','#ffd700','#ff6b35','#ff4444','#4fc3f7','#66bb6a','#c084fc'].map(c =>
          `<div onmousedown="event.preventDefault()" onclick="applyTextColor('${c}')" style="width:16px;height:16px;border-radius:2px;background:${c};cursor:pointer;border:1px solid #444;" title="${c}"></div>`
        ).join('')}
        <input type="color" id="custom-text-color" style="width:16px;height:16px;border:none;background:none;cursor:pointer;padding:0;" onmousedown="event.preventDefault()" onchange="applyTextColor(this.value)" title="커스텀">
        <div onmousedown="event.preventDefault()" onclick="removeTextStyle()" style="width:16px;height:16px;border-radius:2px;background:linear-gradient(135deg,#333 45%,#f44 50%,#333 55%);cursor:pointer;border:1px solid #444;" title="서식 초기화"></div>
      </div>
      <span style="color:#3a3d48;">|</span>
      <select id="rich-font-sel" onmousedown="event.preventDefault()" onchange="applyTextFont(this.value)" style="font-size:9px;background:#2a2d38;color:#ccc;border:1px solid #3a3d48;border-radius:3px;padding:1px 2px;max-width:90px;">
        <option value="">폰트</option>
        ${['Noto Sans KR','Black Han Sans','Jua','Do Hyeon','Gothic A1','Nanum Gothic','Gaegu'].map(f =>
          `<option value="${f}">${f}</option>`
        ).join('')}
      </select>
      <select id="rich-size-sel" onmousedown="event.preventDefault()" onchange="applyTextSize(this.value)" style="font-size:9px;background:#2a2d38;color:#ccc;border:1px solid #3a3d48;border-radius:3px;padding:1px 2px;width:42px;">
        <option value="">크기</option>
        ${[60,70,80,90,100,110,120,140,160].map(s => `<option value="${s}%">${s}%</option>`).join('')}
      </select>
      <span onmousedown="event.preventDefault()" onclick="applyTextBold()" style="cursor:pointer;font-weight:900;color:#ccc;font-size:12px;padding:0 3px;" title="굵게">B</span>
    </div>
    <div style="font-size:9px;color:#f59e0b;margin-bottom:2px;">제목</div>
    <div id="rich-main-edit" class="rich-text-edit" contenteditable="true"
         data-slide="${sl.num}" data-field="main"
         oninput="onRichTextInput(${sl.num}, 'main')">${richMain}</div>
    <div style="font-size:9px;color:#60a5fa;margin-top:6px;margin-bottom:2px;">부제</div>
    <div id="rich-sub-edit" class="rich-text-edit" contenteditable="true"
         data-slide="${sl.num}" data-field="sub"
         oninput="onRichTextInput(${sl.num}, 'sub')">${richSub}</div>
  </div>`;

  html += `<div class="ctrl-section">
    <div class="comp-tab-subtitle">크기 / 위치</div>
    <div class="ctrl-grid-2">
      <div class="ctrl-row"><span class="ctrl-label">제목</span><input class="ctrl-input" type="number" value="${ovr.mainSize || 100}" min="20" max="200" step="4" onchange="updateOverride(${sl.num}, 'mainSize', +this.value)"></div>
      <div class="ctrl-row"><span class="ctrl-label">부제</span><input class="ctrl-input" type="number" value="${ovr.subSize || 52}" min="16" max="120" step="4" onchange="updateOverride(${sl.num}, 'subSize', +this.value)"></div>
      <div class="ctrl-row"><span class="ctrl-label">너비</span><input class="ctrl-input" type="number" value="${ovr.maxWidth || 1000}" min="200" max="1080" step="20" onchange="updateOverride(${sl.num}, 'maxWidth', +this.value)"></div>
      <div class="ctrl-row"><span class="ctrl-label">X</span><input class="ctrl-input" type="number" value="${ovr.x !== undefined ? ovr.x : 540}" min="0" max="1080" onchange="updateOverride(${sl.num}, 'x', +this.value)"></div>
      <div class="ctrl-row"><span class="ctrl-label">Y</span><input class="ctrl-input" type="number" value="${ovr.y !== undefined ? ovr.y : 960}" min="0" max="1920" onchange="updateOverride(${sl.num}, 'y', +this.value)"></div>
    </div>
  </div>`;

  html += `<div class="ctrl-section">
    <div class="comp-tab-subtitle">스타일</div>
    <div class="ctrl-grid-2">
      <div class="ctrl-row"><span class="ctrl-label">제목색</span>
        <input type="color" value="${ovr.mainColor || '#ffffff'}" style="width:28px;height:20px;border:none;background:none;cursor:pointer;padding:0;" onchange="updateOverride(${sl.num}, 'mainColor', this.value)">
      </div>
      <div class="ctrl-row"><span class="ctrl-label">부제색</span>
        <input type="color" value="${ovr.subColor || '#d1d5db'}" style="width:28px;height:20px;border:none;background:none;cursor:pointer;padding:0;" onchange="updateOverride(${sl.num}, 'subColor', this.value)">
      </div>
    </div>
    <div class="ctrl-row"><span class="ctrl-label">폰트</span>
      <select class="ctrl-input" style="font-size:10px;" onchange="updateOverride(${sl.num}, 'fontFamily', this.value)">
        ${['Noto Sans KR','Black Han Sans','Jua','Do Hyeon','Gothic A1','Nanum Gothic','Nanum Myeongjo','Gaegu'].map(f =>
          `<option value="${f}" ${(ovr.fontFamily || 'Noto Sans KR') === f ? 'selected' : ''}>${f}</option>`
        ).join('')}
      </select>
    </div>
    <div class="ctrl-row"><span class="ctrl-label">배경</span>
      <input type="range" min="0" max="100" step="5" value="${ovr.bgOpacity !== undefined ? ovr.bgOpacity : 40}"
             oninput="updateOverride(${sl.num}, 'bgOpacity', +this.value); this.nextElementSibling.textContent=this.value+'%';"
             style="flex:1;accent-color:#6366f1;">
      <span style="font-size:9px;color:#6b7280;width:28px;text-align:right;">${ovr.bgOpacity !== undefined ? ovr.bgOpacity : 40}%</span>
    </div>
  </div>`;
  html += `<button onclick="resetOverride(${sl.num})" style="width:100%;padding:5px;background:#2a2d38;color:#9ca3af;border:none;border-radius:5px;font-size:10px;cursor:pointer;">초기화</button>`;
  html += `</div>`;

  // 텍스트 컬러: 새 방식 (리치 텍스트)으로 대체됨 — 위 contenteditable 섹션에서 처리

  // ── 자유 텍스트 ──
  const freeTexts = (composeState.freeTexts || []).filter(ft => ft.slideNum === sl.num);
  html += `<div class="ctrl-section" style="margin-top:12px;padding-top:10px;border-top:1px solid #2a2d38;">
    <div class="comp-tab-subtitle">자유 텍스트</div>`;
  freeTexts.forEach((ft, fi) => {
    const ftIdx = (composeState.freeTexts || []).indexOf(ft);
    html += `<div style="background:#22242e;border-radius:6px;padding:6px;margin-bottom:6px;">
      <div class="ctrl-row"><span class="ctrl-label">텍스트</span>
        <input class="ctrl-input" value="${_esc(ft.text)}" onchange="updateFreeText(${ftIdx}, 'text', this.value)">
      </div>
      <div class="ctrl-grid-2">
        <div class="ctrl-row"><span class="ctrl-label">크기</span>
          <input class="ctrl-input" type="number" value="${ft.size || 48}" min="12" max="200" step="4"
                 onchange="updateFreeText(${ftIdx}, 'size', +this.value)">
        </div>
        <div class="ctrl-row"><span class="ctrl-label">색상</span>
          <input type="color" value="${ft.color || '#ffffff'}" style="width:24px;height:20px;border:none;background:none;cursor:pointer;padding:0;"
                 onchange="updateFreeText(${ftIdx}, 'color', this.value)">
        </div>
        <div class="ctrl-row"><span class="ctrl-label">X</span>
          <input class="ctrl-input" type="number" value="${ft.x || 540}" min="0" max="1080"
                 onchange="updateFreeText(${ftIdx}, 'x', +this.value)">
        </div>
        <div class="ctrl-row"><span class="ctrl-label">Y</span>
          <input class="ctrl-input" type="number" value="${ft.y || 960}" min="0" max="1920"
                 onchange="updateFreeText(${ftIdx}, 'y', +this.value)">
        </div>
      </div>
      <button onclick="removeFreeText(${ftIdx})" style="width:100%;padding:3px;background:#3b1c1c;color:#f87171;border:none;border-radius:4px;font-size:9px;cursor:pointer;margin-top:4px;">삭제</button>
    </div>`;
  });
  html += `<button onclick="addFreeText(${sl.num})" style="width:100%;padding:5px;background:#2a2d38;color:#34d399;border:1px dashed #3a3d48;border-radius:4px;font-size:10px;cursor:pointer;">+ 텍스트 추가</button>
  </div>`;

  el.innerHTML = html;
}

// ─── Tab: Transition (전환 효과) ───

let _transitionList = null;  // 캐시
async function renderTabTransition() {
  const el = document.getElementById("tab-transition");
  if (!el) return;

  // 전환 효과 목록 로드
  if (!_transitionList) {
    try {
      const res = await fetch("/api/transitions");
      _transitionList = await res.json();
    } catch (e) {
      el.innerHTML = `<div class="text-xs text-red-400">전환 효과 목록 로드 실패</div>`;
      return;
    }
  }

  const chCfg = composerData.channel_config || {};
  // compose_data에서 전환 설정 로드 (채널 기본값 폴백)
  const tr = composeState.transition || {};
  const currentEffect = tr.effect || chCfg.crossfade_transition || "fade";
  const currentDur = tr.duration !== undefined ? tr.duration : (chCfg.crossfade_duration ?? 0.5);

  let html = `<div class="comp-tab-subtitle" style="margin-bottom:8px;">슬라이드 전환 효과</div>`;

  // 미리보기 영상
  html += `<video id="transition-preview-video" class="w-full rounded mb-3" style="max-height:100px;background:#000;" loop muted playsinline></video>`;

  // 효과 그리드
  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:10px;">`;
  _transitionList.forEach(t => {
    const isActive = t.id === currentEffect;
    html += `<button onclick="selectTransition('${t.id}')"
      class="text-left px-2 py-1.5 rounded text-xs transition-all ${isActive ? 'bg-indigo-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}"
      style="border:1px solid ${isActive ? '#6366f1' : '#333'};">
      <div class="font-medium">${t.label}</div>
      <div style="font-size:9px;opacity:0.7;">${t.desc}</div>
    </button>`;
  });
  html += `</div>`;

  // 크로스페이드 길이
  html += `<div class="ctrl-section">
    <div class="ctrl-row">
      <span class="ctrl-label">길이</span>
      <input type="range" min="0" max="1.5" step="0.1" value="${currentDur}"
             oninput="updateTransitionDur(+this.value); this.nextElementSibling.textContent=this.value+'초';"
             style="flex:1;accent-color:#6366f1;">
      <span style="font-size:10px;color:#9ca3af;width:30px;text-align:right;">${currentDur}초</span>
    </div>
    <div style="font-size:9px;color:#6b7280;margin-top:2px;">0 = 하드컷, 0.3~0.7 권장</div>
  </div>`;

  // 적용 범위
  html += `<div class="ctrl-section" style="margin-top:8px;">
    <div style="font-size:9px;color:#6b7280;">이 설정은 영상 렌더링 시 적용됩니다.</div>
  </div>`;

  el.innerHTML = html;

  // 현재 효과 미리보기 자동 재생
  _playTransitionPreview(currentEffect, currentDur);
}

function selectTransition(effect) {
  if (!composeState.transition) composeState.transition = {};
  composeState.transition.effect = effect;
  _dirty = true;
  renderTabTransition();
}

function updateTransitionDur(dur) {
  if (!composeState.transition) composeState.transition = {};
  composeState.transition.duration = dur;
  _dirty = true;
  // 미리보기 갱신
  const effect = composeState.transition.effect || (composerData.channel_config || {}).crossfade_transition || "fade";
  _playTransitionPreview(effect, dur);
}

function _playTransitionPreview(effect, dur) {
  const video = document.getElementById("transition-preview-video");
  if (!video) return;
  if (dur <= 0) {
    video.style.display = "none";
    return;
  }
  video.style.display = "";

  // 선택된 슬라이드와 다음 슬라이드 인덱스
  const sl = getSelectedSlide();
  const allSlides = composerData.slides || [];
  const order = composeState.slide_order && composeState.slide_order.length > 0
    ? composeState.slide_order : allSlides.map(s => s.num);
  let fromIdx = 1, toIdx = 2;
  if (sl) {
    const pos = order.indexOf(sl.num);
    fromIdx = sl.num;
    // 다음 슬라이드 (마지막이면 이전 슬라이드)
    if (pos >= 0 && pos < order.length - 1) {
      toIdx = order[pos + 1];
    } else if (pos > 0) {
      toIdx = order[pos - 1];
    } else {
      toIdx = fromIdx;
    }
  }

  // 항상 작업별 API 사용 (이미지 없으면 서버에서 컬러 블록 폴백)
  const src = `/api/jobs/${JOB_ID}/transition-preview?effect=${effect}&duration=${dur}&slide_from=${fromIdx}&slide_to=${toIdx}&t=${Date.now()}`;

  video.src = src;
  video.load();
  video.play().catch(() => {});
}


// ─── Tab: Narration ───

function renderTabNarration() {
  const el = document.getElementById("tab-narration");
  const sl = getSelectedSlide();
  if (!sl) { el.innerHTML = `<div class="text-xs text-gray-600" style="padding:20px;">슬라이드를 선택하세요</div>`; return; }

  const slideAudio = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
  const sentences = sl.sentences || [];
  const chCfg = composerData.channel_config || {};
  const curEngine = chCfg.tts_engine || "edge-tts";
  const dur = getSlideDuration(sl.num);

  let html = `<div class="comp-tab-title">나레이션 <span style="color:#6b7280;font-weight:400;">슬라이드 ${sl.num}</span></div>`;

  // 슬라이드 길이
  html += `<div class="ctrl-row" style="margin-bottom:8px;"><span class="ctrl-label">길이</span>
    <input class="ctrl-input" type="number" value="${dur.toFixed(1)}" min="1" max="30" step="0.5" onchange="updateSlideDuration(${sl.num}, +this.value)">
    <span style="font-size:9px;color:#6b7280;">초</span>
  </div>`;

  // 문장 리스트
  if (sentences.length > 0) {
    html += `<div class="comp-tab-subtitle">문장 (${sentences.length})</div>`;
    sentences.forEach((sen, si) => {
      const audioInfo = slideAudio.find(a => a.sentence_idx === si);
      html += `<div class="narr-sentence">
        <span class="narr-idx">${si + 1}</span>
        <span class="narr-text" title="${_esc(sen.text)}">${_esc(sen.text)}</span>
        ${audioInfo ? `<button class="narr-play" onclick="previewAudio('${audioInfo.path}', this)">&#9654; ${audioInfo.duration.toFixed(1)}s</button>` : `<span style="font-size:8px;color:#f97316;">미생성</span>`}
      </div>`;
    });
  }

  // TTS
  const curVoice = chCfg.tts_voice || chCfg.google_voice || "";
  const voiceMap = composerData.tts_voices || {};

  html += `<div class="ctrl-section" style="margin-top:10px;">
    <div class="ctrl-row"><span class="ctrl-label">TTS</span>
      <select id="tts-engine" class="ctrl-input" style="font-size:10px;" onchange="_updateVoiceSelect()">
        <option value="edge-tts" ${curEngine === 'edge-tts' ? 'selected' : ''}>Edge TTS</option>
        <option value="google-cloud" ${curEngine === 'google-cloud' ? 'selected' : ''}>Google Cloud</option>
        <option value="gpt-sovits" ${curEngine === 'gpt-sovits' ? 'selected' : ''}>GPT-SoVITS</option>
      </select>
    </div>
    <div class="ctrl-row" id="voice-row" style="margin-top:4px;"><span class="ctrl-label">음성</span>
      <select id="tts-voice" class="ctrl-input" style="font-size:10px;"></select>
    </div>
    <div class="ctrl-row" style="margin-top:4px;"><span class="ctrl-label">볼륨</span>
      <input type="range" min="0" max="100" value="${(composeState.narr_volume !== undefined ? composeState.narr_volume : 100)}"
        style="flex:1;accent-color:#34d399;" oninput="updateNarrVolume(+this.value)" title="나레이션 볼륨">
      <span id="narr-vol-val" style="font-size:9px;color:#9ca3af;width:28px;text-align:right;">${(composeState.narr_volume !== undefined ? composeState.narr_volume : 100)}%</span>
    </div>
    <div style="display:flex;gap:4px;margin-top:4px;">
      <button onclick="generateTTS(${sl.num})" id="btn-gen-tts"
        style="flex:1;padding:6px;background:#065f46;color:#34d399;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">TTS 생성</button>
      <button onclick="generateAllTTS()" id="btn-gen-all-tts"
        style="padding:6px 10px;background:#064e3b;color:#6ee7b7;border:none;border-radius:5px;font-size:10px;cursor:pointer;">전체</button>
    </div>
  </div>`;

  // 음성 업로드
  html += `<div style="margin-top:6px;">
    <input type="file" accept="audio/*" id="audio-upload-input" class="hidden" onchange="uploadSlideAudio(${sl.num}, this)">
    <button onclick="document.getElementById('audio-upload-input').click()"
      style="width:100%;padding:5px;background:#2a2d38;color:#9ca3af;border:none;border-radius:5px;font-size:10px;cursor:pointer;">음성 파일 업로드</button>
  </div>`;
  html += `<div id="tts-status" style="font-size:9px;color:#6b7280;margin-top:4px;"></div>`;

  el.innerHTML = html;
  _updateVoiceSelect();
}

const _FALLBACK_VOICES = {
  "edge-tts": {
    "ko-KR-SunHiNeural": "\uC120\uD788 (\uC5EC\uC131)",
    "ko-KR-HyunsuNeural": "\uD604\uC218 (\uB0A8\uC131)",
    "ko-KR-HyunsuMultilingualNeural": "\uD604\uC218 \uBA40\uD2F0\uB9C1\uAD00 (\uB0A8\uC131)",
    "ko-KR-InJoonNeural": "\uC778\uC900 (\uB0A8\uC131)",
  },
  "google-cloud": {
    "ko-KR-Wavenet-A": "Wavenet A (\uC5EC\uC131)",
    "ko-KR-Wavenet-B": "Wavenet B (\uC5EC\uC131)",
    "ko-KR-Wavenet-C": "Wavenet C (\uB0A8\uC131)",
    "ko-KR-Wavenet-D": "Wavenet D (\uB0A8\uC131)",
    "ko-KR-Neural2-A": "Neural2 A (\uC5EC\uC131)",
    "ko-KR-Neural2-B": "Neural2 B (\uC5EC\uC131)",
    "ko-KR-Neural2-C": "Neural2 C (\uB0A8\uC131)",
  },
};

function _updateVoiceSelect() {
  const engineSel = document.getElementById("tts-engine");
  const voiceSel = document.getElementById("tts-voice");
  const voiceRow = document.getElementById("voice-row");
  if (!engineSel || !voiceSel) return;

  const engine = engineSel.value;
  const serverVoices = composerData.tts_voices || {};
  const voices = serverVoices[engine] || _FALLBACK_VOICES[engine] || {};
  const chCfg = composerData.channel_config || {};

  // GPT-SoVITS → 참조 음성 목록 로드
  if (engine === "gpt-sovits") {
    voiceRow.style.display = "";
    _loadSovitsVoices(voiceSel, chCfg.sovits_ref_voice || "");
    return;
  }
  voiceRow.style.display = "";

  // 채널 기본 음성
  const defaultVoice = engine === "google-cloud"
    ? (chCfg.google_voice || "ko-KR-Wavenet-A")
    : (chCfg.tts_voice || "ko-KR-SunHiNeural");

  let opts = "";
  for (const [key, label] of Object.entries(voices)) {
    opts += `<option value="${key}" ${key === defaultVoice ? 'selected' : ''}>${label}</option>`;
  }
  voiceSel.innerHTML = opts;
}

async function _loadSovitsVoices(selectEl, defaultRef) {
  try {
    const res = await fetch("/api/ref-voices");
    const voices = await res.json();
    let opts = '<option value="">-- \uC120\uD0DD\uD558\uC138\uC694 --</option>';
    for (const v of voices) {
      opts += `<option value="${v.filename}" ${v.filename === defaultRef ? 'selected' : ''}>${v.name} (${v.size_kb} KB)</option>`;
    }
    selectEl.innerHTML = opts;
  } catch {}
}

// ─── SFX Drag & Drop ───

function updateSfxMarker(idx, key, val) {
  if (composeState.sfx_markers && composeState.sfx_markers[idx]) {
    composeState.sfx_markers[idx][key] = val;
    _dirty = true;
    renderSfxMarkers();
  }
}

function removeSfxMarker(idx) {
  if (composeState.sfx_markers) {
    composeState.sfx_markers.splice(idx, 1);
    _dirty = true;
    renderSfxMarkers();
    renderTabSfx();
  }
}

function onSfxDragStart(e, filename) {
  e.dataTransfer.setData("sfx_file", filename);
}

function setupSfxDrop() {
  const sfxTrack = document.getElementById("timeline-sfx");
  const timeline = document.getElementById("timeline");

  function handleDrop(e) {
    e.preventDefault();
    sfxTrack.classList.remove("sfx-drag-hover");
    const file = e.dataTransfer.getData("sfx_file");
    if (!file) return;

    const total = getTotalDuration();
    const rect = sfxTrack.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * total;

    composeState.sfx_markers.push({
      id: `s_${Date.now()}`,
      file,
      time: Math.round(time * 10) / 10,
      volume: 0.8,
    });
    _dirty = true;
    renderSfxMarkers();
  }

  timeline.addEventListener("dragover", e => {
    if (e.dataTransfer.types.includes("sfx_file")) {
      e.preventDefault();
      sfxTrack.classList.add("sfx-drag-hover");
    }
  });
  timeline.addEventListener("dragleave", e => {
    if (!timeline.contains(e.relatedTarget)) {
      sfxTrack.classList.remove("sfx-drag-hover");
    }
  });
  timeline.addEventListener("drop", handleDrop);
}

function renderSfxMarkers() {
  const container = document.getElementById("sfx-markers");
  const total = getTotalDuration() || 1;
  container.innerHTML = "";

  composeState.sfx_markers.forEach(m => {
    const sfxInfo = (composerData.sfx_list || []).find(s => s.file === m.file);
    const sfxFullDur = sfxInfo ? sfxInfo.duration : 1;
    // 커스텀 duration 지원 (기본: 원본 길이)
    const sfxDur = m.duration !== undefined ? m.duration : sfxFullDur;
    const pct = (m.time / total) * 100;
    const widthPct = (sfxDur / total) * 100;
    const name = m.file.replace(/\.[^.]+$/, '');

    const el = document.createElement("div");
    el.className = "sfx-marker";
    el.style.left = `${pct}%`;
    el.style.width = `${Math.max(widthPct, 2)}%`;
    el.title = `${m.file} @ ${m.time.toFixed(1)}s (${sfxDur.toFixed(1)}s)`;
    el.innerHTML = `
      <div class="sfx-handle sfx-handle-l"></div>
      <span class="sfx-marker-icon">&#128264;</span>
      <span class="sfx-marker-label">${name}</span>
      <div class="sfx-handle sfx-handle-r"></div>
    `;

    const trackArea = document.getElementById("timeline-tracks");

    // 좌측 핸들 → 시작 시점 조절
    el.querySelector(".sfx-handle-l").addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const rect = trackArea.getBoundingClientRect();
      const origTime = m.time;
      const origDur = sfxDur;
      function onMove(e2) {
        const newPct = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
        const newTime = newPct * total;
        if (newTime < origTime + origDur - 0.2) {
          const delta = newTime - origTime;
          m.time = Math.round(newTime * 10) / 10;
          m.duration = Math.round(Math.max(0.2, origDur - delta) * 10) / 10;
          _dirty = true;
          renderSfxMarkers();
        }
      }
      function onUp() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); renderTabSfx(); }
      document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    });

    // 우측 핸들 → 길이 조절
    el.querySelector(".sfx-handle-r").addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const rect = trackArea.getBoundingClientRect();
      function onMove(e2) {
        const endPct = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
        const endTime = endPct * total;
        const newDur = endTime - m.time;
        if (newDur >= 0.2) {
          m.duration = Math.round(newDur * 10) / 10;
          _dirty = true;
          renderSfxMarkers();
        }
      }
      function onUp() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); renderTabSfx(); }
      document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    });

    // 중앙 드래그 이동
    el.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("sfx-handle")) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = trackArea.getBoundingClientRect();
      function onMove(e2) {
        const pctNew = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
        m.time = Math.round(pctNew * total * 10) / 10;
        el.style.left = `${(m.time / total) * 100}%`;
        _dirty = true;
      }
      function onUp() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // 더블클릭 삭제
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      composeState.sfx_markers = composeState.sfx_markers.filter(x => x.id !== m.id);
      _dirty = true;
      renderSfxMarkers();
    });

    container.appendChild(el);
  });
}

// ─── BGM ───

function applyBgm(file, path, duration) {
  const total = getTotalDuration() || 1;
  composeState.bgm = {
    file, path,
    start_time: 0,
    end_time: Math.min(duration, total),
    volume: 0.1,
    fade_in: 1.0,
    fade_out: 2.0,
  };
  _dirty = true;
  renderBgmTrack();
  renderTabBgm();
  renderProps();
}

function removeBgm() {
  composeState.bgm = null;
  _dirty = true;
  renderBgmTrack();
  renderTabBgm();
  renderProps();
}

function updateBgmProp(key, val) {
  if (!composeState.bgm) return;
  composeState.bgm[key] = val;
  _dirty = true;
  renderBgmTrack();
}

function renderBgmTrack() {
  const container = document.getElementById("bgm-bar-container");
  if (!container) return;
  container.innerHTML = "";

  const bgm = composeState.bgm;
  if (!bgm) return;

  const total = getTotalDuration() || 1;
  const leftPct = (bgm.start_time / total) * 100;
  const widthPct = ((bgm.end_time - bgm.start_time) / total) * 100;
  const name = bgm.file.replace(/\.[^.]+$/, '');
  const fadeInPct = ((bgm.fade_in || 0) / (bgm.end_time - bgm.start_time || 1)) * 100;
  const fadeOutPct = ((bgm.fade_out || 0) / (bgm.end_time - bgm.start_time || 1)) * 100;

  const bar = document.createElement("div");
  bar.className = "bgm-bar";
  bar.style.left = `${leftPct}%`;
  bar.style.width = `${Math.max(widthPct, 1)}%`;
  bar.innerHTML = `
    <div class="bgm-fade bgm-fade-in" style="width:${Math.min(fadeInPct, 50)}%"></div>
    <div class="bgm-fade bgm-fade-out" style="width:${Math.min(fadeOutPct, 50)}%"></div>
    <div class="bgm-handle bgm-handle-l"></div>
    <span class="bgm-bar-label">${name}</span>
    <div class="bgm-handle bgm-handle-r"></div>
  `;

  const trackArea = document.getElementById("timeline-tracks");

  // 바 전체 드래그 이동
  bar.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("bgm-handle")) return;
    e.preventDefault(); e.stopPropagation();
    const rect = trackArea.getBoundingClientRect();
    const dur = bgm.end_time - bgm.start_time;
    const startPct = (e.clientX - rect.left) / rect.width;
    const origStart = bgm.start_time;
    function onMove(e2) {
      const pctNow = (e2.clientX - rect.left) / rect.width;
      const delta = (pctNow - startPct) * total;
      let ns = Math.max(0, Math.min(total - dur, origStart + delta));
      bgm.start_time = Math.round(ns * 10) / 10;
      bgm.end_time = Math.round((ns + dur) * 10) / 10;
      _dirty = true;
      renderBgmTrack();
    }
    function onUp() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); renderTabBgm(); }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 좌측 핸들 → start_time
  bar.querySelector(".bgm-handle-l").addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const rect = trackArea.getBoundingClientRect();
    function onMove(e2) {
      const pct = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
      const t = pct * total;
      if (t < bgm.end_time - 0.5) { bgm.start_time = Math.round(t * 10) / 10; _dirty = true; renderBgmTrack(); }
    }
    function onUp() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); renderTabBgm(); }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 우측 핸들 → end_time
  bar.querySelector(".bgm-handle-r").addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const rect = trackArea.getBoundingClientRect();
    function onMove(e2) {
      const pct = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
      const t = pct * total;
      if (t > bgm.start_time + 0.5) { bgm.end_time = Math.round(t * 10) / 10; _dirty = true; renderBgmTrack(); }
    }
    function onUp() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); renderTabBgm(); }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 더블클릭 삭제
  bar.addEventListener("dblclick", (e) => { e.stopPropagation(); removeBgm(); });

  container.appendChild(bar);
}

// ─── Save & Render ───

async function saveCompose() {
  const r = await fetch(`/api/jobs/${JOB_ID}/composer/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(composeState),
  });
  if (r.ok) {
    _dirty = false;
    const btn = document.getElementById("btn-save");
    btn.textContent = "저장됨";
    setTimeout(() => { btn.textContent = "저장"; }, 1500);
  }
}

async function startRender() {
  // 먼저 저장
  await saveCompose();

  const btn = document.getElementById("btn-render");
  btn.textContent = "렌더링 시작 중...";
  btn.disabled = true;

  const engine = document.getElementById("tts-engine")?.value || "edge-tts";

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tts_engine: engine }),
    });
    if (r.ok) {
      btn.textContent = "렌더링 시작됨!";
      setTimeout(() => {
        // 대시보드로 이동
        window.location.href = "/";
      }, 1500);
    } else {
      const err = await r.json();
      btn.textContent = "실패";
      alert(err.detail || "렌더링 시작 실패");
      setTimeout(() => { btn.textContent = "렌더링 시작"; btn.disabled = false; }, 2000);
    }
  } catch (e) {
    btn.textContent = "오류";
    setTimeout(() => { btn.textContent = "렌더링 시작"; btn.disabled = false; }, 2000);
  }
}

// ─── Rich Text Color (텍스트 선택 → 컬러 적용) ───

let _lastRichTarget = null;  // 마지막으로 선택한 contenteditable 요소

function applyTextColor(color) {
  // contenteditable 안에서 선택된 텍스트에 컬러 적용
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  // 선택이 rich-text-edit 안에 있는지 확인
  const editEl = range.startContainer.parentElement?.closest(".rich-text-edit")
              || range.startContainer.closest?.(".rich-text-edit");
  if (!editEl) return;

  const span = document.createElement("span");
  span.style.color = color;
  range.surroundContents(span);
  sel.removeAllRanges();

  // 저장
  const slideNum = +editEl.dataset.slide;
  const field = editEl.dataset.field;
  _saveRichText(slideNum, field, editEl);
}

function applyTextFont(fontFamily) {
  if (!fontFamily) return;
  _wrapSelection(span => { span.style.fontFamily = `'${fontFamily}', sans-serif`; });
  document.getElementById("rich-font-sel").value = "";
}

function applyTextSize(size) {
  if (!size) return;
  _wrapSelection(span => { span.style.fontSize = size; });
  document.getElementById("rich-size-sel").value = "";
}

function applyTextBold() {
  _wrapSelection(span => {
    span.style.fontWeight = span.style.fontWeight === "900" ? "normal" : "900";
  });
}

function removeTextStyle() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  const editEl = _findRichEdit(range);
  if (!editEl) return;

  // 선택 범위 내 모든 span 제거 (plain text로)
  const fragment = range.extractContents();
  const text = fragment.textContent;
  range.insertNode(document.createTextNode(text));
  sel.removeAllRanges();

  const slideNum = +editEl.dataset.slide;
  _saveRichText(slideNum, editEl.dataset.field, editEl);
}

function _findRichEdit(range) {
  let node = range.startContainer;
  if (node.nodeType === 3) node = node.parentElement;
  return node?.closest?.(".rich-text-edit");
}

function _wrapSelection(styleFn) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  const editEl = _findRichEdit(range);
  if (!editEl) return;

  // 이미 span 안에 있으면 기존 span에 스타일 적용
  let node = range.startContainer;
  if (node.nodeType === 3) node = node.parentElement;
  const existingSpan = (node.tagName === "SPAN" && node.parentElement?.classList?.contains("rich-text-edit"))
    ? node : null;

  if (existingSpan && range.toString() === existingSpan.textContent) {
    // 전체 span이 선택된 경우 — 기존 span에 스타일 추가
    styleFn(existingSpan);
  } else {
    // 새 span으로 감싸기
    const span = document.createElement("span");
    styleFn(span);
    try {
      range.surroundContents(span);
    } catch (e) {
      // 복잡한 선택 (여러 노드 걸침) — extractContents 방식
      const fragment = range.extractContents();
      span.appendChild(fragment);
      range.insertNode(span);
    }
  }
  sel.removeAllRanges();

  const slideNum = +editEl.dataset.slide;
  _saveRichText(slideNum, editEl.dataset.field, editEl);
}

function onRichTextInput(slideNum, field) {
  const editEl = document.getElementById(field === 'sub' ? 'rich-sub-edit' : 'rich-main-edit');
  if (!editEl) return;
  _saveRichText(slideNum, field, editEl);
}

function _saveRichText(slideNum, field, editEl) {
  const html = editEl.innerHTML;
  const plainText = editEl.textContent;

  if (field === 'main') {
    setOverride(slideNum, 'richMain', html);
    setOverride(slideNum, 'main', plainText);
  } else {
    setOverride(slideNum, 'richSub', html);
    setOverride(slideNum, 'sub', plainText);
  }
  _dirty = true;
  renderPreview();
}


// ─── Legacy Highlight (하위 호환) ───

function addHighlight(slideNum, target = 'main') {
  const ovr = getOverride(slideNum);
  const field = target === 'sub' ? 'subHighlights' : 'mainHighlights';
  if (!ovr[field]) setOverride(slideNum, field, []);
  const defaultColor = target === 'sub' ? '#4fc3f7' : '#ff6b35';
  composeState.slide_overrides[slideNum][field].push({ text: "", color: defaultColor });
  _dirty = true;
  renderTabText();
}

function updateHighlight(slideNum, idx, key, val, target = 'main') {
  const ovr = getOverride(slideNum);
  const field = target === 'sub' ? 'subHighlights' : 'mainHighlights';
  // 하위 호환: 기존 highlights → mainHighlights로 마이그레이션
  if (!ovr[field] && ovr.highlights && target === 'main') {
    ovr.mainHighlights = ovr.highlights;
    delete ovr.highlights;
  }
  if (ovr[field] && ovr[field][idx]) {
    ovr[field][idx][key] = val;
    _dirty = true;
    renderPreview();
    renderTabText();
  }
}

function removeHighlight(slideNum, idx, target = 'main') {
  const ovr = getOverride(slideNum);
  const field = target === 'sub' ? 'subHighlights' : 'mainHighlights';
  if (!ovr[field] && ovr.highlights && target === 'main') {
    ovr.mainHighlights = ovr.highlights;
    delete ovr.highlights;
  }
  if (ovr[field]) {
    ovr[field].splice(idx, 1);
    _dirty = true;
    renderPreview();
    renderTabText();
  }
}

function _applyHighlights(text, highlights) {
  if (!highlights || highlights.length === 0) return _esc(text);
  let result = _esc(text);
  highlights.forEach(h => {
    if (!h.text) return;
    const escaped = _esc(h.text);
    const re = new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    result = result.replace(re, `<span style="color:${h.color}">${escaped}</span>`);
  });
  return result;
}

// ─── Free Text (자유 텍스트) ───

function addFreeText(slideNum) {
  if (!composeState.freeTexts) composeState.freeTexts = [];
  composeState.freeTexts.push({
    id: `ft_${Date.now()}`,
    slideNum,
    text: "텍스트",
    x: 540, y: 1400,
    size: 48,
    color: "#ffffff",
    fontFamily: "Noto Sans KR",
  });
  _dirty = true;
  renderPreview();
  renderTabText();
}

function updateFreeText(idx, key, val) {
  if (composeState.freeTexts && composeState.freeTexts[idx]) {
    composeState.freeTexts[idx][key] = val;
    _dirty = true;
    renderPreview();
  }
}

function removeFreeText(idx) {
  if (composeState.freeTexts) {
    composeState.freeTexts.splice(idx, 1);
    _dirty = true;
    renderPreview();
    renderTabText();
  }
}

// ─── Element Drag / Rotate / Resize ───

function startElementDrag(e, idx) {
  e.preventDefault();
  const elem = composeState.elements[idx];
  if (!elem) return;
  const el = e.currentTarget;
  const startX = e.clientX, startY = e.clientY;
  const origX = elem.x, origY = elem.y;
  function onMove(e2) {
    elem.x = Math.round(origX + (e2.clientX - startX) / SCALE);
    elem.y = Math.round(origY + (e2.clientY - startY) / SCALE);
    el.style.left = `${elem.x * SCALE}px`;
    el.style.top = `${elem.y * SCALE}px`;
    _dirty = true;
  }
  function onUp() { document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp); }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startElementRotate(e, type, idx) {
  e.preventDefault();
  e.stopPropagation();
  const box = e.target.parentElement;
  const rect = box.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
  let obj;
  if (type === 'element') obj = composeState.elements[idx];
  else if (type === 'freeText') obj = composeState.freeTexts[idx];
  if (!obj) return;
  const origRot = obj.rotation || 0;
  function onMove(e2) {
    const angle = Math.atan2(e2.clientY - cy, e2.clientX - cx) * 180 / Math.PI;
    obj.rotation = Math.round(origRot + angle - startAngle);
    box.style.transform = `translate(-50%,-50%) rotate(${obj.rotation}deg)`;
    _dirty = true;
  }
  function onUp() { document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp); renderPreview(); }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startElementResize(e, idx, corner) {
  e.preventDefault();
  e.stopPropagation();
  const elem = composeState.elements[idx];
  if (!elem) return;

  const origW = elem.width || 300, origH = elem.height || 250;
  const origX = elem.x || 540, origY = elem.y || 500;
  const rot = (elem.rotation || 0) * Math.PI / 180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const startMX = e.clientX, startMY = e.clientY;

  // 코너 방향: r=+1, l=-1 / b=+1, t=-1
  const sx = corner.includes('r') ? 1 : -1;
  const sy = corner.includes('b') ? 1 : -1;

  function onMove(e2) {
    // 마우스 이동량 → 데이터 좌표 변환
    const dx = (e2.clientX - startMX) / SCALE;
    const dy = (e2.clientY - startMY) / SCALE;

    // 로컬 좌표로 변환 (회전 보정)
    const localDx = dx * cosR + dy * sinR;
    const localDy = -dx * sinR + dy * cosR;

    const newW = Math.max(50, Math.round(origW + sx * localDx));
    const newH = Math.max(50, Math.round(origH + sy * localDy));
    const dW = newW - origW, dH = newH - origH;

    // 중심 이동: 앵커(반대 코너) 고정을 위해 변화량의 절반만큼 이동
    const shiftLX = sx * dW / 2, shiftLY = sy * dH / 2;
    elem.x = Math.round(origX + (shiftLX * cosR - shiftLY * sinR));
    elem.y = Math.round(origY + (shiftLX * sinR + shiftLY * cosR));
    elem.width = newW;
    elem.height = newH;

    _dirty = true;
    renderPreview();
  }
  function onUp() { document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp); }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ─── Free Text Drag ───

function startFreeTextDrag(e, ftIdx) {
  e.preventDefault();
  e.stopPropagation();
  const ft = composeState.freeTexts[ftIdx];
  if (!ft) return;
  const el = e.currentTarget;
  const startX = e.clientX, startY = e.clientY;
  const origLeft = parseFloat(el.style.left), origTop = parseFloat(el.style.top);

  function onMove(e2) {
    const newLeft = origLeft + (e2.clientX - startX);
    const newTop = origTop + (e2.clientY - startY);
    el.style.left = `${newLeft}px`;
    el.style.top = `${newTop}px`;
    ft.x = Math.round(newLeft / SCALE);
    ft.y = Math.round(newTop / SCALE);
    _dirty = true;
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (_activeTab === 'text') renderTabText();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startFreeTextResize(e, ftIdx, corner) {
  e.preventDefault();
  e.stopPropagation();
  const ft = composeState.freeTexts[ftIdx];
  if (!ft) return;

  const rot = (ft.rotation || 0) * Math.PI / 180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const startX = e.clientX, startY = e.clientY;
  const origSize = ft.size || 48;

  // 코너 방향
  const sy = corner.includes('b') ? 1 : -1;

  function onMove(e2) {
    const dx = (e2.clientX - startX) / SCALE;
    const dy = (e2.clientY - startY) / SCALE;
    // 로컬 좌표로 변환 (회전 보정)
    const localDy = -dx * sinR + dy * cosR;
    // 세로 이동량으로 폰트 크기 조절
    const scaleY = Math.max(0.25, 1 + sy * localDy / (origSize * 2));
    ft.size = Math.max(12, Math.min(200, Math.round(origSize * scaleY)));
    _dirty = true;
    renderPreview();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (_activeTab === 'text') renderTabText();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ─── Overlay Controls ───

function updateOverride(slideNum, key, val) {
  setOverride(slideNum, key, val);
  renderPreview();
  renderProps();
}

function toggleOverlay(slideNum, hidden) {
  setOverride(slideNum, "hidden", hidden);
  renderPreview();
  renderProps();
}

function resetOverride(slideNum) {
  delete composeState.slide_overrides[slideNum];
  _dirty = true;
  renderPreview();
  renderProps();
}

// ─── Data Refresh ───

async function refreshData() {
  const r = await fetch(`/api/jobs/${JOB_ID}/composer`);
  composerData = await r.json();
}

// ─── Helpers ───

function getOrderedSlides() {
  return composeState.slide_order
    .map(num => composerData.slides.find(s => s.num === num))
    .filter(Boolean);
}

function getSelectedSlide() {
  if (selectedSlide < 0 || selectedSlide >= composeState.slide_order.length) return null;
  const num = composeState.slide_order[selectedSlide];
  return composerData.slides.find(s => s.num === num) || null;
}

function _esc(s) {
  return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.substring(0, max) + "..." : s;
}

// ─── Keyboard ───

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
  if (e.key === " ") { e.preventDefault(); togglePreview(); }
  if (e.key === "ArrowLeft" && selectedSlide > 0) selectSlide(selectedSlide - 1);
  if (e.key === "ArrowRight" && selectedSlide < composeState.slide_order.length - 1) selectSlide(selectedSlide + 1);
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveCompose(); }
});

// ─── Init ───
initComposer();
