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

  // 초기 슬라이드 순서: compose_data에 없으면 기본 순서
  if (!composeState.slide_order || composeState.slide_order.length === 0) {
    composeState.slide_order = composerData.slides.map(s => s.num);
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
    block.style.minWidth = "120px";
    block.style.flex = `${Math.max(dur, 1)} 0 0`;

    // 배경 썸네일
    let thumbHtml = "";
    if (hasBg) {
      if (sl.bg_url.includes(".mp4") || sl.bg_url.includes(".gif")) {
        thumbHtml = `<video src="${sl.bg_url}" muted autoplay loop playsinline class="slide-thumb-media"></video>`;
      } else {
        thumbHtml = `<img src="${sl.bg_url}" class="slide-thumb-media" draggable="false">`;
      }
    } else {
      thumbHtml = `<div class="slide-thumb-empty">
        <span class="text-[10px]">이미지 없음</span>
      </div>`;
    }

    const bgTypeBadge = {photo:"📷",broll:"🎬",graph:"📊",logo:"🏢",closing:"🔚"}[sl.bg_type] || "📷";
    const audioIcon = hasAudio ? "🔊" : "🔇";

    block.innerHTML = `
      <div class="slide-thumb">${thumbHtml}</div>
      <div class="slide-info">
        <div class="slide-info-top">
          <span class="slide-num">${bgTypeBadge} ${sl.num}</span>
          <span class="slide-dur">${dur.toFixed(1)}s</span>
        </div>
        <div class="slide-info-bottom">
          <span class="text-[9px]">${audioIcon}</span>
          <span class="slide-main" title="${_esc(sl.main)}">${_esc(_truncate(sl.main, 20))}</span>
        </div>
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

  // 텍스트 오버레이 (드래그 가능)
  const mainText = _esc((ovr.main !== undefined ? ovr.main : sl.main || "").replace(/<[^>]*>/g, ""));
  const subText = _esc((ovr.sub !== undefined ? ovr.sub : sl.sub || "").replace(/<[^>]*>/g, ""));
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

  container.innerHTML = `
    <div class="preview-canvas">
      ${bgHtml || '<div class="preview-bg-fallback"></div>'}
      <div class="preview-dim"></div>
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

function stopAllAudio() {
  if (_playingAudio) {
    _playingAudio.pause();
    _playingAudio.currentTime = 0;
    _playingAudio = null;
  }
}

function playSlideAudio() {
  const sl = getSelectedSlide();
  if (!sl) return;
  const slideAudio = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
  if (slideAudio.length === 0) return;

  stopAllAudio();
  _playSlideAudioSequence(slideAudio, 0);
}

function _playSlideAudioSequence(audioList, idx) {
  if (idx >= audioList.length) {
    document.getElementById("btn-play-slide").innerHTML = "&#9654;";
    return;
  }
  document.getElementById("btn-play-slide").innerHTML = "&#9646;&#9646;";
  _playingAudio = new Audio(audioList[idx].path);
  _playingAudio.play().catch(() => {});
  _playingAudio.addEventListener("ended", () => {
    _playSlideAudioSequence(audioList, idx + 1);
  });
}

function playAllSlides() {
  stopAllAudio();
  const slides = getOrderedSlides();
  _allPlayQueue = [];
  slides.forEach(sl => {
    const slideAudio = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
    slideAudio.forEach(a => _allPlayQueue.push({ ...a, slideNum: sl.num }));
  });
  _allPlayIdx = 0;
  _playNextInQueue();
}

function _playNextInQueue() {
  if (_allPlayIdx >= _allPlayQueue.length) {
    document.getElementById("audio-status").textContent = "재생 완료";
    return;
  }
  const item = _allPlayQueue[_allPlayIdx];
  // 해당 슬라이드 하이라이트
  const slideIdx = composeState.slide_order.indexOf(item.slideNum);
  if (slideIdx >= 0) selectSlide(slideIdx);

  document.getElementById("audio-status").textContent = `재생 중: 슬라이드 ${item.slideNum} (${_allPlayIdx + 1}/${_allPlayQueue.length})`;
  _playingAudio = new Audio(item.path);
  _playingAudio.play().catch(() => {});
  _playingAudio.addEventListener("ended", () => {
    _allPlayIdx++;
    _playNextInQueue();
  });
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
    if (sl.bg_url) {
      const isVideo = sl.bg_url.includes('.mp4') || sl.bg_url.includes('.gif');
      html += `<div class="media-item ${isActive ? 'active' : ''}" onclick="selectSlide(${idx})">
        ${isVideo ? `<video src="${sl.bg_url}" muted autoplay loop playsinline></video>` : `<img src="${sl.bg_url}" draggable="false">`}
        <div class="media-item-badge">${sl.num}</div>
        <div class="media-item-label">${sl.bg_type}</div>
      </div>`;
    } else {
      html += `<div class="media-item ${isActive ? 'active' : ''}" onclick="selectSlide(${idx})" style="display:flex;align-items:center;justify-content:center;">
        <div class="media-item-badge">${sl.num}</div>
        <span style="font-size:9px;color:#6b7280;">없음</span>
      </div>`;
    }
  });
  html += `<div class="media-upload-btn" onclick="document.getElementById('bg-upload-input-tab').click()">+ 이미지 업로드</div>`;
  html += `</div>`;
  html += `<input type="file" accept="image/*,video/mp4" id="bg-upload-input-tab" class="hidden" onchange="uploadCurrentSlideBg(this)">`;
  el.innerHTML = html;
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
        ${audioInfo ? `<button class="narr-play" onclick="previewAudio('${audioInfo.path}')">&#9654; ${audioInfo.duration.toFixed(1)}s</button>` : `<span style="font-size:8px;color:#4b5563;">-</span>`}
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
  if (e.key === " ") { e.preventDefault(); playSlideAudio(); }
  if (e.key === "ArrowLeft" && selectedSlide > 0) selectSlide(selectedSlide - 1);
  if (e.key === "ArrowRight" && selectedSlide < composeState.slide_order.length - 1) selectSlide(selectedSlide + 1);
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveCompose(); }
});

// ─── Init ───
initComposer();
