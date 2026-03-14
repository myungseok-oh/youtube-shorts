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
  const mainText = _applyHighlights(rawMain, ovr.highlights);
  const subText = _applyHighlights(rawSub, ovr.highlights);
  const mainSize = (ovr.mainSize || 100) * SCALE;
  const subSize = (ovr.subSize || 52) * SCALE;

  // 위치: 실제 좌표를 캔버스 좌표로 변환
  const posX = (ovr.x !== undefined ? ovr.x : REAL_W / 2) * SCALE;
  const posY = (ovr.y !== undefined ? ovr.y : REAL_H / 2) * SCALE;

  const overlayOpacity = isHidden ? 0.2 : 1;
  const maxW = (ovr.maxWidth || 1000) * SCALE;
  const mainColor = ovr.mainColor || '#ffffff';
  const subColor = ovr.subColor || '#d1d5db';
  const fontFamily = ovr.fontFamily || 'Noto Sans KR';
  const bgOpacity = ovr.bgOpacity !== undefined ? ovr.bgOpacity / 100 : 0.4;

  const overlayHtml = `
    <div id="text-overlay-drag" class="text-overlay-drag ${isHidden ? 'overlay-hidden' : ''}"
         style="left:${posX}px; top:${posY}px; opacity:${overlayOpacity}; width:${maxW}px; background:rgba(5,8,20,${bgOpacity}); font-family:'${fontFamily}',sans-serif;"
         onmousedown="startOverlayDrag(event)">
      <div class="overlay-main" style="font-size:${mainSize}px; color:${mainColor};">${mainText}</div>
      ${subText ? `<div class="overlay-sub" style="font-size:${subSize}px; color:${subColor};">${subText}</div>` : ""}
      ${!isHidden ? `<div class="overlay-resize-handle" onmousedown="startOverlayResize(event)"></div>` : ''}
    </div>
  `;

  // 자유 텍스트
  const freeTexts = (composeState.freeTexts || []).filter(ft => ft.slideNum === sl.num);
  let freeTextHtml = "";
  freeTexts.forEach((ft, fi) => {
    const ftIdx = (composeState.freeTexts || []).indexOf(ft);
    const ftX = (ft.x || 540) * SCALE;
    const ftY = (ft.y || 960) * SCALE;
    const ftSize = (ft.size || 48) * SCALE;
    const ftFont = ft.fontFamily || 'Noto Sans KR';
    freeTextHtml += `<div class="free-text-drag" data-ft-idx="${ftIdx}"
      style="left:${ftX}px;top:${ftY}px;font-size:${ftSize}px;color:${ft.color || '#ffffff'};font-family:'${ftFont}',sans-serif;"
      onmousedown="startFreeTextDrag(event, ${ftIdx})">${_esc(ft.text)}</div>`;
  });

  container.innerHTML = `
    <div class="preview-canvas">
      ${bgHtml || '<div class="preview-bg-fallback"></div>'}
      ${overlayHtml}
      ${freeTextHtml}
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

function startOverlayResize(e) {
  e.preventDefault();
  e.stopPropagation();
  const sl = getSelectedSlide();
  if (!sl) return;

  const ovr = getOverride(sl.num);
  const overlay = document.getElementById("text-overlay-drag");
  if (!overlay) return;

  const startX = e.clientX, startY = e.clientY;
  const origW = parseFloat(overlay.style.width) || 300;
  const origMainSize = ovr.mainSize || 100;
  const origSubSize = ovr.subSize || 52;

  function onMove(e2) {
    const dx = e2.clientX - startX;
    const dy = e2.clientY - startY;

    // 너비 조절
    const newW = Math.max(100 * SCALE, origW + dx);
    overlay.style.width = `${newW}px`;
    setOverride(sl.num, "maxWidth", Math.round(newW / SCALE));

    // 높이 방향 → 글자 크기 비례 조절
    if (Math.abs(dy) > 2) {
      const sizeScale = 1 + dy / 300;
      const newMain = Math.round(Math.max(24, Math.min(200, origMainSize * sizeScale)));
      const newSub = Math.round(Math.max(16, Math.min(120, origSubSize * sizeScale)));
      setOverride(sl.num, "mainSize", newMain);
      setOverride(sl.num, "subSize", newSub);

      const mainEl = overlay.querySelector(".overlay-main");
      const subEl = overlay.querySelector(".overlay-sub");
      if (mainEl) mainEl.style.fontSize = `${newMain * SCALE}px`;
      if (subEl) subEl.style.fontSize = `${newSub * SCALE}px`;
    }
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    renderProps();
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

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slide_num: slideNum, tts_engine: engine }),
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

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tts_engine: engine }),  // slide_num 없으면 전체
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

function previewAudio(path) {
  stopAllAudio();
  _playingAudio = new Audio(path);
  _playingAudio.play().catch(() => {});
  _playingAudio.addEventListener("ended", () => { _playingAudio = null; });
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
  _playingAudio.play().catch(() => {});
  _playingAudio.addEventListener("ended", () => {
    _playAudioChain(audioList, idx + 1, onDone);
  });
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

  // BGM 시작
  if (composeState.bgm && composeState.bgm.path) {
    _previewBgm = new Audio(composeState.bgm.path);
    _previewBgm.volume = composeState.bgm.volume || 0.1;
    _previewBgm.loop = true;
    _previewBgm.play().catch(() => {});
  }

  _buildSlideTimeMap();
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
      <button class="audio-play-btn" onclick="previewAudio('${s.path}')">&#9654;</button>
      <span class="flex-1 truncate">${s.file.replace(/\.[^.]+$/, '')}</span>
      <span style="font-size:9px;color:#6b7280;">${s.duration.toFixed(1)}s</span>
    </div>`;
  });
  if ((composerData.sfx_list || []).length === 0) {
    html += `<div style="font-size:10px;color:#4b5563;padding:12px;">data/sfx/ 폴더에 효과음을 추가하세요</div>`;
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
      <button class="audio-play-btn" onclick="previewAudio('${s.path}')">&#9654;</button>
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
      <button onclick="removeBgm()" style="width:100%;padding:5px;background:#3b1c1c;color:#f87171;border:none;border-radius:5px;font-size:10px;cursor:pointer;margin-top:6px;">제거</button>
    </div>`;
  }
  if ((composerData.bgm_list || []).length === 0) {
    html += `<div style="font-size:10px;color:#4b5563;padding:12px;">data/bgm/ 폴더에 배경음을 추가하세요</div>`;
  }
  el.innerHTML = html;
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
  html += `<div class="ctrl-section">
    <div class="ctrl-row"><span class="ctrl-label">제목</span>
      <input class="ctrl-input" value="${_esc(ovrMain)}" onchange="updateOverride(${sl.num}, 'main', this.value)">
    </div>
    <div class="ctrl-row"><span class="ctrl-label">부제</span>
      <input class="ctrl-input" value="${_esc(ovrSub)}" onchange="updateOverride(${sl.num}, 'sub', this.value)">
    </div>
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

  // ── 텍스트 강조 (부분 컬러) ──
  const highlights = ovr.highlights || [];
  html += `<div class="ctrl-section" style="margin-top:12px;padding-top:10px;border-top:1px solid #2a2d38;">
    <div class="comp-tab-subtitle">텍스트 강조</div>
    <div style="font-size:9px;color:#6b7280;margin-bottom:6px;">특정 단어에 색상을 적용합니다</div>`;
  highlights.forEach((h, hi) => {
    html += `<div class="ctrl-row" style="margin-bottom:6px;">
      <input class="ctrl-input" value="${_esc(h.text)}" placeholder="강조할 텍스트"
             onchange="updateHighlight(${sl.num}, ${hi}, 'text', this.value)" style="flex:2;">
      <input type="color" value="${h.color || '#ff6b35'}" style="width:24px;height:20px;border:none;background:none;cursor:pointer;padding:0;"
             onchange="updateHighlight(${sl.num}, ${hi}, 'color', this.value)">
      <button onclick="removeHighlight(${sl.num}, ${hi})" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;">&times;</button>
    </div>`;
  });
  html += `<button onclick="addHighlight(${sl.num})" style="width:100%;padding:4px;background:#2a2d38;color:#818cf8;border:1px dashed #3a3d48;border-radius:4px;font-size:10px;cursor:pointer;">+ 강조 추가</button>
  </div>`;

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
        ${audioInfo ? `<button class="narr-play" onclick="previewAudio('${audioInfo.path}')">&#9654; ${audioInfo.duration.toFixed(1)}s</button>` : `<span style="font-size:8px;color:#f97316;">미생성</span>`}
      </div>`;
    });
  }

  // TTS
  html += `<div class="ctrl-section" style="margin-top:10px;">
    <div class="ctrl-row"><span class="ctrl-label">TTS</span>
      <select id="tts-engine" class="ctrl-input" style="font-size:10px;">
        <option value="edge-tts" ${curEngine === 'edge-tts' ? 'selected' : ''}>Edge TTS</option>
        <option value="google-cloud" ${curEngine === 'google-cloud' ? 'selected' : ''}>Google Cloud</option>
        <option value="gpt-sovits" ${curEngine === 'gpt-sovits' ? 'selected' : ''}>GPT-SoVITS</option>
      </select>
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
}

// ─── SFX Drag & Drop ───

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
    const pct = (m.time / total) * 100;
    const sfxInfo = (composerData.sfx_list || []).find(s => s.file === m.file);
    const sfxDur = sfxInfo ? sfxInfo.duration : 1;
    const widthPct = (sfxDur / total) * 100;
    const name = m.file.replace(/\.[^.]+$/, '');

    const el = document.createElement("div");
    el.className = "sfx-marker";
    el.style.left = `${pct}%`;
    el.style.width = `${Math.max(widthPct, 2)}%`;
    el.title = `${m.file} @ ${m.time.toFixed(1)}s`;
    el.innerHTML = `<span class="sfx-marker-icon">&#128264;</span><span class="sfx-marker-label">${name}</span>`;

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

  const bar = document.createElement("div");
  bar.className = "bgm-bar";
  bar.style.left = `${leftPct}%`;
  bar.style.width = `${Math.max(widthPct, 1)}%`;
  bar.innerHTML = `<span class="bgm-bar-label">${name}</span>`;

  bar.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    removeBgm();
  });

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

// ─── Highlight (부분 텍스트 컬러) ───

function addHighlight(slideNum) {
  const ovr = getOverride(slideNum);
  if (!ovr.highlights) setOverride(slideNum, 'highlights', []);
  composeState.slide_overrides[slideNum].highlights.push({ text: "", color: "#ff6b35" });
  _dirty = true;
  renderTabText();
}

function updateHighlight(slideNum, idx, key, val) {
  const ovr = getOverride(slideNum);
  if (ovr.highlights && ovr.highlights[idx]) {
    ovr.highlights[idx][key] = val;
    _dirty = true;
    renderPreview();
    renderTabText();
  }
}

function removeHighlight(slideNum, idx) {
  const ovr = getOverride(slideNum);
  if (ovr.highlights) {
    ovr.highlights.splice(idx, 1);
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
