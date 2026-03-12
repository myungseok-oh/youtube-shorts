/* ─── Editor JS ─── */

let editorData = null;       // from /api/jobs/{id}/editor
let editState = { text_overlays: [], sfx_markers: [] };
let currentSegIdx = 0;
let selectedOverlay = null;
let _dirty = false;

// ─── Init ───

async function initEditor() {
  const r = await fetch(`/api/jobs/${JOB_ID}/editor`);
  editorData = await r.json();
  editState = editorData.edit_data || { text_overlays: [], sfx_markers: [] };

  renderTimeline();
  renderSfxPanel();
  setupVideo();
  if (editorData.segments.length > 0) selectSegment(0);
}

// ─── Timeline ───

function renderTimeline() {
  const container = document.getElementById("timeline-segments");
  container.innerHTML = "";
  const total = editorData.total_duration || 1;

  editorData.segments.forEach((seg, i) => {
    const pct = (seg.duration / total) * 100;
    const el = document.createElement("div");
    el.className = "timeline-seg";
    if (seg.type === "intro") el.classList.add("seg-intro");
    if (seg.type === "outro") el.classList.add("seg-outro");
    el.style.width = `${Math.max(pct, 3)}%`;
    el.onclick = () => selectSegment(i);

    if (seg.type === "intro") {
      const introImg = seg.thumbnail || editorData.intro_bg_url;
      if (introImg) el.innerHTML = `<img src="${introImg}" alt="intro">`;
      el.innerHTML += `<div class="seg-type-badge" style="background:#6366f1;">IN</div>`;
    } else if (seg.type === "outro") {
      const outroImg = seg.thumbnail || editorData.outro_bg_url;
      if (outroImg) el.innerHTML = `<img src="${outroImg}" alt="outro">`;
      el.innerHTML += `<div class="seg-type-badge" style="background:#8b5cf6;">OUT</div>`;
    } else {
      // 콘텐츠 세그먼트 → slide_num 기반 슬라이드 이미지 매칭
      const sn = seg.slide_num || 0;
      const slideImg = sn > 0 ? editorData.slide_images[sn - 1] : null;
      if (slideImg) {
        el.innerHTML = `<img src="${slideImg.path}" alt="slide ${sn}">`;
      }
    }
    const label = seg.type === "intro" ? "인트로" : seg.type === "outro" ? "아웃트로" : `${seg.slide_num || ""}`;
    el.innerHTML += `<span class="seg-label">${label}</span>`;
    el.innerHTML += `<span class="seg-dur">${seg.duration.toFixed(1)}s</span>`;
    container.appendChild(el);
  });

  renderSfxMarkers();
}

function selectSegment(idx) {
  currentSegIdx = idx;
  document.querySelectorAll(".timeline-seg").forEach((el, i) => {
    el.classList.toggle("active", i === idx);
  });

  const seg = editorData.segments[idx];
  if (!seg) return;

  const video = document.getElementById("preview-video");
  video.src = seg.path;
  video.load();

  renderTextOverlays();
}

// ─── Video Playback ───

function setupVideo() {
  const video = document.getElementById("preview-video");
  const seekBar = document.getElementById("seek-bar");
  const timeDisplay = document.getElementById("time-display");

  video.addEventListener("timeupdate", () => {
    if (video.duration) {
      seekBar.value = (video.currentTime / video.duration) * 100;
      timeDisplay.textContent = `${_fmt(video.currentTime)} / ${_fmt(video.duration)}`;
    }
  });

  seekBar.addEventListener("input", () => {
    if (video.duration) {
      video.currentTime = (seekBar.value / 100) * video.duration;
    }
  });
}

function togglePlay() {
  const video = document.getElementById("preview-video");
  const btn = document.getElementById("btn-play");
  if (video.paused) {
    video.play();
    btn.innerHTML = "&#9646;&#9646;";
  } else {
    video.pause();
    btn.innerHTML = "&#9654;";
  }
}

function _fmt(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2,"0")}:${sec.toString().padStart(2,"0")}`;
}

// ─── Text Overlays ───

function addTextOverlay() {
  const seg = editorData.segments[currentSegIdx];
  if (!seg) return;

  const id = `t_${Date.now()}`;
  const overlay = {
    id,
    segment: seg.file,
    x: 160, y: 300,
    text: "텍스트 입력",
    font_size: 48,
    font_color: "#ffffff",
    bg_color: "#000000",
    start_time: 0,
    end_time: seg.duration,
  };
  editState.text_overlays.push(overlay);
  _dirty = true;
  renderTextOverlays();
  selectTextOverlay(id);
}

function renderTextOverlays() {
  const layer = document.getElementById("text-overlay-layer");
  layer.innerHTML = "";
  const seg = editorData.segments[currentSegIdx];
  if (!seg) return;

  const overlays = editState.text_overlays.filter(t => t.segment === seg.file);
  // 캔버스 크기 비율 (실제 1080x1920 → 표시 360x640)
  const scale = 360 / 1080;

  overlays.forEach(t => {
    const box = document.createElement("div");
    box.className = `text-overlay-box ${selectedOverlay === t.id ? "selected" : ""}`;
    box.style.left = `${t.x * scale}px`;
    box.style.top = `${t.y * scale}px`;
    box.style.fontSize = `${t.font_size * scale}px`;
    box.style.color = t.font_color;
    if (t.bg_color) {
      box.style.background = t.bg_color + "b3";
      box.style.padding = "2px 6px";
      box.style.borderRadius = "3px";
    }
    box.textContent = t.text;
    box.innerHTML += `<div class="resize-handle"></div>`;

    box.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      selectTextOverlay(t.id);
      _startDrag(e, t, scale);
    });
    box.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      _editTextInline(box, t);
    });

    layer.appendChild(box);
  });
}

function selectTextOverlay(id) {
  selectedOverlay = id;
  renderTextOverlays();
  renderProps();
}

function _startDrag(e, overlay, scale) {
  const startX = e.clientX, startY = e.clientY;
  const origX = overlay.x, origY = overlay.y;

  function onMove(e2) {
    overlay.x = origX + (e2.clientX - startX) / scale;
    overlay.y = origY + (e2.clientY - startY) / scale;
    _dirty = true;
    renderTextOverlays();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function _editTextInline(box, overlay) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = overlay.text;
  input.className = "prop-input";
  input.style.width = "200px";
  input.style.position = "absolute";
  input.style.left = box.style.left;
  input.style.top = box.style.top;
  input.style.zIndex = "100";
  input.style.pointerEvents = "auto";

  const layer = document.getElementById("text-overlay-layer");
  layer.appendChild(input);
  input.focus();
  input.select();

  function done() {
    overlay.text = input.value;
    _dirty = true;
    input.remove();
    renderTextOverlays();
    renderProps();
  }
  input.addEventListener("blur", done);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done();
    if (e.key === "Escape") { input.remove(); renderTextOverlays(); }
  });
}

function deleteSelectedOverlay() {
  if (!selectedOverlay) return;
  editState.text_overlays = editState.text_overlays.filter(t => t.id !== selectedOverlay);
  selectedOverlay = null;
  _dirty = true;
  renderTextOverlays();
  renderProps();
}

// ─── Properties Panel ───

function renderProps() {
  const container = document.getElementById("props-content");
  const t = editState.text_overlays.find(o => o.id === selectedOverlay);
  if (!t) {
    container.innerHTML = `<div class="text-gray-500">요소를 선택하세요</div>`;
    return;
  }

  container.innerHTML = `
    <div class="prop-row">
      <span class="prop-label">텍스트</span>
      <input class="prop-input" value="${_esc(t.text)}" onchange="updateProp('text', this.value)">
    </div>
    <div class="prop-row">
      <span class="prop-label">크기</span>
      <input class="prop-input" type="number" value="${t.font_size}" min="12" max="200"
             onchange="updateProp('font_size', +this.value)">
    </div>
    <div class="prop-row">
      <span class="prop-label">색상</span>
      <input type="color" value="${t.font_color}" style="width:30px;height:24px;border:none;background:none;cursor:pointer;"
             onchange="updateProp('font_color', this.value)">
    </div>
    <div class="prop-row">
      <span class="prop-label">배경</span>
      <input type="color" value="${t.bg_color || '#000000'}" style="width:30px;height:24px;border:none;background:none;cursor:pointer;"
             onchange="updateProp('bg_color', this.value)">
    </div>
    <div class="prop-row">
      <span class="prop-label">시작</span>
      <input class="prop-input" type="number" value="${t.start_time}" min="0" step="0.1"
             onchange="updateProp('start_time', +this.value)">
    </div>
    <div class="prop-row">
      <span class="prop-label">종료</span>
      <input class="prop-input" type="number" value="${t.end_time}" min="0" step="0.1"
             onchange="updateProp('end_time', +this.value)">
    </div>
    <div class="prop-row">
      <span class="prop-label">X</span>
      <input class="prop-input" type="number" value="${Math.round(t.x)}"
             onchange="updateProp('x', +this.value)">
    </div>
    <div class="prop-row">
      <span class="prop-label">Y</span>
      <input class="prop-input" type="number" value="${Math.round(t.y)}"
             onchange="updateProp('y', +this.value)">
    </div>
    <div class="mt-3">
      <button onclick="deleteSelectedOverlay()"
        class="w-full px-2 py-1 bg-red-800 hover:bg-red-700 rounded text-xs">삭제</button>
    </div>
  `;
}

function updateProp(key, val) {
  const t = editState.text_overlays.find(o => o.id === selectedOverlay);
  if (!t) return;
  t[key] = val;
  _dirty = true;
  renderTextOverlays();
}

function _esc(s) {
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ─── SFX Panel & Markers ───

function renderSfxPanel() {
  const sfxEl = document.getElementById("sfx-list");
  sfxEl.innerHTML = (editorData.sfx_list || []).map(s => `
    <div class="sfx-item" draggable="true"
         ondragstart="onSfxDragStart(event, '${s.file}')"
         title="${s.file} (${s.duration.toFixed(1)}s)">
      <span class="sfx-preview" onclick="previewAudio('${s.path}')">&#9654;</span>
      <span class="flex-1 truncate">${s.file.replace(/\.[^.]+$/, '')}</span>
      <span class="text-gray-600 text-[9px]">${s.duration.toFixed(1)}s</span>
    </div>
  `).join("");

  const bgmEl = document.getElementById("bgm-list");
  bgmEl.innerHTML = (editorData.bgm_list || []).map(s => `
    <div class="sfx-item" title="${s.file}">
      <span class="sfx-preview" onclick="previewAudio('${s.path}')">&#9654;</span>
      <span class="flex-1 truncate">${s.file.replace(/\.[^.]+$/, '')}</span>
    </div>
  `).join("");
}

let _previewAudio = null;
function previewAudio(path) {
  if (_previewAudio) { _previewAudio.pause(); _previewAudio = null; }
  _previewAudio = new Audio(path);
  _previewAudio.play();
}

// SFX drag & drop to timeline
function onSfxDragStart(e, filename) {
  e.dataTransfer.setData("sfx_file", filename);
}

function setupSfxDrop() {
  // SFX 트랙 + 타임라인 전체에서 드롭 가능
  const timeline = document.getElementById("timeline");
  const sfxTrack = document.getElementById("timeline-sfx");

  function handleDrop(e) {
    e.preventDefault();
    sfxTrack.classList.remove("sfx-drag-hover");
    const file = e.dataTransfer.getData("sfx_file");
    if (!file) return;
    // 시간 계산은 타임라인 전체 너비 기준
    const rect = timeline.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * (editorData.total_duration || 1);

    editState.sfx_markers.push({
      id: `s_${Date.now()}`,
      file,
      time: Math.round(time * 10) / 10,
      volume: 0.8,
    });
    _dirty = true;
    renderSfxMarkers();
  }

  timeline.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    sfxTrack.classList.add("sfx-drag-hover");
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
  const total = editorData.total_duration || 1;
  container.innerHTML = "";

  editState.sfx_markers.forEach(m => {
    const pct = (m.time / total) * 100;
    const el = document.createElement("div");
    el.className = "sfx-marker";
    el.style.left = `${pct}%`;
    el.innerHTML = `<span title="${m.file} @ ${m.time.toFixed(1)}s (더블클릭=삭제)">&#128264;</span>`;

    // 드래그로 위치 이동
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const timeline = document.getElementById("timeline");
      const rect = timeline.getBoundingClientRect();

      function onMove(e2) {
        const pctNew = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
        m.time = Math.round(pctNew * total * 10) / 10;
        el.style.left = `${(m.time / total) * 100}%`;
        el.querySelector("span").title = `${m.file} @ ${m.time.toFixed(1)}s (더블클릭=삭제)`;
        _dirty = true;
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // 더블클릭 삭제
    el.ondblclick = (e) => {
      e.stopPropagation();
      editState.sfx_markers = editState.sfx_markers.filter(x => x.id !== m.id);
      _dirty = true;
      renderSfxMarkers();
    };
    container.appendChild(el);
  });
}

// ─── SFX 실시간 미리보기 (브라우저 오디오) ───

let _sfxPreviewing = false;
let _sfxFiredIds = new Set();
let _sfxAudios = [];  // 재생 중인 SFX Audio 객체

function startSfxPreview() {
  // 전체 영상으로 전환 후 재생
  const video = document.getElementById("preview-video");
  video.src = `/api/jobs/${JOB_ID}/video?t=${Date.now()}`;
  video.load();
  video.oncanplay = () => {
    _sfxPreviewing = true;
    _sfxFiredIds.clear();
    _sfxAudios = [];
    video.play();
    video.oncanplay = null;
  };
}

function stopSfxPreview() {
  _sfxPreviewing = false;
  _sfxFiredIds.clear();
  _sfxAudios.forEach(a => { a.pause(); a.currentTime = 0; });
  _sfxAudios = [];
}

function _checkSfxTriggers() {
  if (!_sfxPreviewing) return;
  const video = document.getElementById("preview-video");
  if (video.paused || video.ended) {
    stopSfxPreview();
    return;
  }
  const t = video.currentTime;
  editState.sfx_markers.forEach(m => {
    if (_sfxFiredIds.has(m.id)) return;
    // 마커 시점 ±0.15초 이내이면 트리거
    if (t >= m.time - 0.05 && t <= m.time + 0.3) {
      _sfxFiredIds.add(m.id);
      const sfxInfo = (editorData.sfx_list || []).find(s => s.file === m.file);
      if (sfxInfo) {
        const audio = new Audio(sfxInfo.path);
        audio.volume = m.volume || 0.8;
        audio.play().catch(() => {});
        _sfxAudios.push(audio);
      }
    }
  });
  requestAnimationFrame(_checkSfxTriggers);
}

// timeupdate에서도 체크 (requestAnimationFrame 보완)
document.getElementById("preview-video").addEventListener("play", () => {
  if (_sfxPreviewing) requestAnimationFrame(_checkSfxTriggers);
});

// ─── Save & Apply ───

async function saveEdits() {
  const r = await fetch(`/api/jobs/${JOB_ID}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(editState),
  });
  if (r.ok) {
    _dirty = false;
    document.getElementById("btn-save").textContent = "저장됨";
    setTimeout(() => {
      document.getElementById("btn-save").textContent = "저장";
    }, 1500);
  }
}

async function applyEdits() {
  await saveEdits();
  const btn = document.getElementById("btn-apply");
  btn.textContent = "적용 중...";
  btn.disabled = true;
  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/apply-edits`, { method: "POST" });
    const data = await r.json();
    if (data.ok) {
      btn.textContent = "완료!";
      // 최종 합본 영상 미리보기 (SFX 포함)
      const video = document.getElementById("preview-video");
      video.src = `/api/jobs/${JOB_ID}/video?t=${Date.now()}`;
      video.load();
      setTimeout(() => {
        btn.textContent = "적용 (재렌더)";
        btn.disabled = false;
      }, 1500);
    } else {
      btn.textContent = "실패";
      setTimeout(() => { btn.textContent = "적용 (재렌더)"; btn.disabled = false; }, 2000);
    }
  } catch (e) {
    btn.textContent = "오류";
    setTimeout(() => { btn.textContent = "적용 (재렌더)"; btn.disabled = false; }, 2000);
  }
}

// ─── Keyboard shortcuts ───

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  if (e.key === "Delete" || e.key === "Backspace") deleteSelectedOverlay();
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveEdits(); }
});

// Click on canvas to deselect
document.getElementById("canvas-container").addEventListener("click", () => {
  selectedOverlay = null;
  renderTextOverlays();
  renderProps();
});

// ─── Init ───
setupSfxDrop();
initEditor();
