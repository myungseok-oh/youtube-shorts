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
  renderSidebar();
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
  renderPreview();
  renderProps();
}

// ─── Preview (Visual Overlay Editor) ───

const CANVAS_W = 360, CANVAS_H = 640;
const REAL_W = 1080, REAL_H = 1920;
const SCALE = CANVAS_W / REAL_W;  // 0.333...

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

  const overlayHtml = `
    <div id="text-overlay-drag" class="text-overlay-drag ${isHidden ? 'overlay-hidden' : ''}"
         style="left:${posX}px; top:${posY}px; opacity:${overlayOpacity}; width:${maxW}px;"
         onmousedown="startOverlayDrag(event)">
      <div class="overlay-main" style="font-size:${mainSize}px;">${mainText}</div>
      ${subText ? `<div class="overlay-sub" style="font-size:${subSize}px;">${subText}</div>` : ""}
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

// ─── Properties Panel ───

function renderProps() {
  const container = document.getElementById("props-content");
  const sl = getSelectedSlide();

  if (!sl) {
    container.innerHTML = `<div class="text-xs text-gray-500">슬라이드를 선택하세요</div>`;
    return;
  }

  const dur = getSlideDuration(sl.num);
  const slideAudio = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
  const hasAnyAudio = slideAudio.length > 0;

  // TTS 설정
  const chCfg = composerData.channel_config || {};
  const curEngine = chCfg.tts_engine || "edge-tts";
  const curVoice = chCfg.tts_voice || "ko-KR-SunHiNeural";

  let html = "";

  const ovr = getOverride(sl.num);
  const isHidden = ovr.hidden === true;

  // ── 슬라이드 정보 ──
  html += `<div class="prop-section prop-section-active">
    <div class="prop-section-title" style="color:#f97316;">슬라이드 ${sl.num}</div>
    <div class="prop-row"><span class="prop-label">타입</span><span class="text-[10px] text-gray-400">${sl.bg_type}</span></div>
    <div class="prop-row"><span class="prop-label">길이</span>
      <input class="prop-input" type="number" value="${dur.toFixed(1)}" min="1" max="30" step="0.5"
             onchange="updateSlideDuration(${sl.num}, +this.value)">
      <span class="text-[9px] text-gray-600 ml-1">초</span>
    </div>
  </div>`;

  // ── 오버레이 편집 ──
  const ovrMain = ovr.main !== undefined ? ovr.main : (sl.main || "").replace(/<[^>]*>/g, "");
  const ovrSub = ovr.sub !== undefined ? ovr.sub : (sl.sub || "").replace(/<[^>]*>/g, "");
  const ovrMainSize = ovr.mainSize || 100;
  const ovrSubSize = ovr.subSize || 52;
  const ovrX = ovr.x !== undefined ? ovr.x : 540;
  const ovrY = ovr.y !== undefined ? ovr.y : 960;

  html += `<div class="prop-section prop-section-active">
    <div class="flex items-center justify-between mb-1">
      <div class="prop-section-title" style="color:#a78bfa; margin-bottom:0;">오버레이</div>
      <label class="flex items-center gap-1 cursor-pointer">
        <input type="checkbox" ${isHidden ? '' : 'checked'} onchange="toggleOverlay(${sl.num}, !this.checked)"
               class="accent-purple-500" style="width:14px;height:14px;">
        <span class="text-[10px] text-gray-400">표시</span>
      </label>
    </div>
    <div style="${isHidden ? 'opacity:0.3;pointer-events:none;' : ''}">
      <div class="prop-row"><span class="prop-label">제목</span>
        <input class="prop-input" value="${_esc(ovrMain)}" onchange="updateOverride(${sl.num}, 'main', this.value)">
      </div>
      <div class="prop-row"><span class="prop-label">부제</span>
        <input class="prop-input" value="${_esc(ovrSub)}" onchange="updateOverride(${sl.num}, 'sub', this.value)">
      </div>
      <div class="prop-row"><span class="prop-label">제목 크기</span>
        <input class="prop-input" type="number" value="${ovrMainSize}" min="20" max="200" step="4"
               onchange="updateOverride(${sl.num}, 'mainSize', +this.value)">
      </div>
      <div class="prop-row"><span class="prop-label">부제 크기</span>
        <input class="prop-input" type="number" value="${ovrSubSize}" min="16" max="120" step="4"
               onchange="updateOverride(${sl.num}, 'subSize', +this.value)">
      </div>
      <div class="prop-row"><span class="prop-label">너비</span>
        <input class="prop-input" type="number" value="${ovr.maxWidth || 1000}" min="200" max="1080" step="20"
               onchange="updateOverride(${sl.num}, 'maxWidth', +this.value)">
      </div>
      <div class="prop-row"><span class="prop-label">X</span>
        <input class="prop-input" type="number" value="${ovrX}" min="0" max="1080"
               onchange="updateOverride(${sl.num}, 'x', +this.value)">
      </div>
      <div class="prop-row"><span class="prop-label">Y</span>
        <input class="prop-input" type="number" value="${ovrY}" min="0" max="1920"
               onchange="updateOverride(${sl.num}, 'y', +this.value)">
      </div>
      <button onclick="resetOverride(${sl.num})" class="w-full px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] mt-1">초기화</button>
    </div>
  </div>`;

  // ── 배경 이미지 ──
  html += `<div class="prop-section prop-section-active">
    <div class="prop-section-title" style="color:#3b82f6;">배경 이미지</div>`;
  if (sl.bg_url) {
    if (sl.bg_url.includes(".mp4") || sl.bg_url.includes(".gif")) {
      html += `<video src="${sl.bg_url}" muted autoplay loop playsinline
                class="rounded mb-2" style="width:100%;max-height:120px;object-fit:cover;"></video>`;
    } else {
      html += `<img src="${sl.bg_url}" class="rounded mb-2" style="width:100%;max-height:120px;object-fit:cover;">`;
    }
  }
  html += `
    <input type="file" accept="image/*,video/mp4" id="bg-upload-input" class="hidden"
           onchange="uploadSlideBg(${sl.num}, this)">
    <button onclick="document.getElementById('bg-upload-input').click()"
      class="w-full px-2 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs transition mb-1">
      ${sl.bg_url ? '이미지 교체' : '이미지 업로드'}
    </button>
  </div>`;

  // ── 나레이션 ──
  html += `<div class="prop-section prop-section-active">
    <div class="prop-section-title" style="color:#10b981;">나레이션</div>`;

  // 문장별 오디오 상태
  const sentences = sl.sentences || [];
  if (sentences.length > 0) {
    html += `<div class="mb-2">`;
    sentences.forEach((sen, si) => {
      const audioInfo = slideAudio.find(a => a.sentence_idx === si);
      const hasA = !!audioInfo;
      html += `<div class="flex items-center gap-1 py-1 border-b border-gray-800">
        <span class="text-[9px] text-gray-600 w-4">${si + 1}</span>
        <span class="flex-1 text-[10px] text-gray-300 truncate" title="${_esc(sen.text)}">${_esc(_truncate(sen.text, 30))}</span>
        ${hasA ? `<button onclick="previewAudio('${audioInfo.path}')" class="text-[10px] text-green-400 hover:text-green-300 flex-shrink-0" title="미리듣기">&#9654; ${audioInfo.duration.toFixed(1)}s</button>` : `<span class="text-[9px] text-gray-600">없음</span>`}
      </div>`;
    });
    html += `</div>`;
  }

  // TTS 생성 UI
  html += `
    <div class="mb-2">
      <label class="text-[10px] text-gray-500 block mb-1">TTS 엔진</label>
      <select id="tts-engine" class="prop-input" style="font-size:10px;">
        <option value="edge-tts" ${curEngine === 'edge-tts' ? 'selected' : ''}>Edge TTS</option>
        <option value="google-cloud" ${curEngine === 'google-cloud' ? 'selected' : ''}>Google Cloud TTS</option>
        <option value="gpt-sovits" ${curEngine === 'gpt-sovits' ? 'selected' : ''}>GPT-SoVITS</option>
      </select>
    </div>
    <div class="flex gap-1">
      <button onclick="generateTTS(${sl.num})" id="btn-gen-tts"
        class="flex-1 px-2 py-1.5 bg-emerald-800 hover:bg-emerald-700 rounded text-xs font-medium transition">
        TTS 생성
      </button>
      <button onclick="generateAllTTS()" id="btn-gen-all-tts"
        class="px-2 py-1.5 bg-emerald-900 hover:bg-emerald-800 rounded text-[10px] transition" title="전체 슬라이드 TTS 생성">
        전체
      </button>
    </div>
    <div class="mt-1">
      <label class="text-[10px] text-gray-500 block mb-1">또는 음성 파일 업로드</label>
      <input type="file" accept="audio/*" id="audio-upload-input" class="hidden"
             onchange="uploadSlideAudio(${sl.num}, this)">
      <button onclick="document.getElementById('audio-upload-input').click()"
        class="w-full px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] transition">
        음성 파일 업로드
      </button>
    </div>
    <div id="tts-status" class="text-[10px] text-gray-500 mt-1"></div>
  </div>`;

  // ── SFX 섹션 ──
  const slideSfx = composeState.sfx_markers.filter(m => m.slide === sl.num);
  html += `<div class="prop-section">
    <div class="prop-section-title" style="color:#f97316;">SFX (${slideSfx.length})</div>
    <div class="text-[10px] text-gray-600">좌측 패널에서 SFX를 타임라인에 드래그하세요</div>
  </div>`;

  // ── BGM ──
  const bgm = composeState.bgm;
  html += `<div class="prop-section">
    <div class="prop-section-title" style="color:#10b981;">BGM</div>`;
  if (bgm) {
    html += `
      <div class="prop-row"><span class="prop-label">파일</span><span class="text-[10px] text-emerald-400 truncate">${_esc(bgm.file)}</span></div>
      <div class="prop-row"><span class="prop-label">볼륨</span><input class="prop-input" type="number" value="${bgm.volume}" min="0" max="1" step="0.01" onchange="updateBgmProp('volume', +this.value)"></div>
      <button onclick="removeBgm()" class="w-full px-2 py-1 bg-red-800 hover:bg-red-700 rounded text-xs mt-1">제거</button>`;
  } else {
    html += `<div class="text-[10px] text-gray-600">좌측 패널에서 BGM을 선택하세요</div>`;
  }
  html += `</div>`;

  container.innerHTML = html;
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

// ─── Sidebar (SFX/BGM) ───

function renderSidebar() {
  const sfxEl = document.getElementById("sfx-list");
  sfxEl.innerHTML = (composerData.sfx_list || []).map(s => `
    <div class="sfx-item" draggable="true"
         ondragstart="onSfxDragStart(event, '${s.file}')"
         title="${s.file} (${s.duration.toFixed(1)}s)">
      <span class="sfx-preview" onclick="previewAudio('${s.path}')">&#9654;</span>
      <span class="flex-1 truncate">${s.file.replace(/\.[^.]+$/, '')}</span>
      <span class="text-gray-600 text-[9px]">${s.duration.toFixed(1)}s</span>
    </div>
  `).join("");

  const bgmEl = document.getElementById("bgm-list");
  bgmEl.innerHTML = (composerData.bgm_list || []).map(s => {
    const isActive = composeState.bgm && composeState.bgm.file === s.file;
    return `
    <div class="sfx-item ${isActive ? 'bgm-active' : ''}" title="${s.file}">
      <span class="sfx-preview" onclick="previewAudio('${s.path}')">&#9654;</span>
      <span class="flex-1 truncate">${s.file.replace(/\.[^.]+$/, '')}</span>
      <button onclick="applyBgm('${_esc(s.file)}', '${_esc(s.path)}', ${s.duration || 0})"
        class="px-1.5 py-0.5 bg-emerald-800 hover:bg-emerald-700 rounded text-[9px] font-medium flex-shrink-0">${isActive ? '적용됨' : '적용'}</button>
    </div>`;
  }).join("");
}

function toggleSection(name) {
  const section = document.querySelector(`.sidebar-section[data-section="${name}"]`);
  if (!section) return;
  const body = section.querySelector(".sidebar-section-body");
  section.classList.toggle("open");
  body.classList.toggle("hidden");
}

function filterSidebar(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll(".sfx-item").forEach(el => {
    const text = (el.textContent || "").toLowerCase();
    el.style.display = !q || text.includes(q) ? "" : "none";
  });
  if (q) {
    document.querySelectorAll(".sidebar-section").forEach(s => {
      s.classList.add("open");
      s.querySelector(".sidebar-section-body").classList.remove("hidden");
    });
  }
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
  renderSidebar();
  renderProps();
}

function removeBgm() {
  composeState.bgm = null;
  _dirty = true;
  renderBgmTrack();
  renderSidebar();
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
