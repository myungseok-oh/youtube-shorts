/* ─── Editor JS ─── */

let editorData = null;       // from /api/jobs/{id}/editor
let editState = { text_overlays: [], sfx_markers: [], bgm: null };
let currentSegIdx = 0;
let selectedOverlay = null;
let _dirty = false;
let _textImages = [];  // 텍스트 이미지(스티커) 카테고리 목록
let _segTimes = [];    // [{start, end, idx}] 세그먼트별 시작/종료 시간

// ─── Init ───

async function initEditor() {
  const r = await fetch(`/api/jobs/${JOB_ID}/editor`);
  editorData = await r.json();
  editState = editorData.edit_data || { text_overlays: [], sfx_markers: [], bgm: null };
  editState.bgm = editState.bgm || null;

  _buildSegTimes();
  renderTimeline();
  renderSfxPanel();
  setupVideo();
  loadTextImages();
  renderProps();
}

// ─── Segment Time Map ───

function _buildSegTimes() {
  _segTimes = [];
  let t = 0;
  editorData.segments.forEach((seg, i) => {
    _segTimes.push({ start: t, end: t + seg.duration, idx: i });
    t += seg.duration;
  });
}

function _getSegmentAtTime(time) {
  for (const st of _segTimes) {
    if (time >= st.start && time < st.end) return st.idx;
  }
  // 끝에 도달한 경우 마지막 세그먼트
  return _segTimes.length > 0 ? _segTimes[_segTimes.length - 1].idx : 0;
}

// ─── Text Images (Stickers) ───

async function loadTextImages() {
  try {
    const r = await fetch("/api/text-images");
    const data = await r.json();
    _textImages = data.categories || [];
  } catch (e) {
    _textImages = [];
  }
  renderTextImagePanel();
}

function renderTextImagePanel() {
  const container = document.getElementById("text-images-list");
  if (!container) return;

  if (_textImages.length === 0) {
    container.innerHTML = '<div class="text-gray-600 text-[10px] px-2">data/text_images/ 폴더에<br>카테고리별 이미지를 추가하세요</div>';
    return;
  }

  container.innerHTML = _textImages.map((cat, ci) => `
    <div class="img-cat-section" data-cat="${ci}">
      <div class="img-cat-header" onclick="toggleImgCat(${ci})">
        <span class="sidebar-arrow">&#9654;</span>
        <span class="text-[10px] text-gray-500 font-semibold">${_esc(cat.name)}</span>
        <span class="text-[9px] text-gray-600 ml-auto">${cat.images.length}</span>
      </div>
      <div class="img-cat-body hidden" id="img-cat-${ci}">
        <div class="flex flex-wrap gap-1">
          ${cat.images.map(img => `
            <div class="text-img-item" onclick="addImageOverlay('${_esc(img.path)}')" title="${_esc(img.file)}">
              <img src="${img.path}" alt="${_esc(img.file)}">
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `).join("");
}

function addImageOverlay(src) {
  const seg = editorData.segments[currentSegIdx];
  if (!seg) return;

  const id = `i_${Date.now()}`;
  const overlay = {
    id,
    type: "image",
    segment: seg.file,
    x: 200, y: 400,
    width: 300, height: 300,
    rotation: 0,
    src,
    start_time: 0,
    end_time: seg.duration,
  };
  editState.text_overlays.push(overlay);
  _dirty = true;
  renderTextOverlays();
  selectTextOverlay(id);
}

// ─── Timeline ───

function renderTimeline() {
  const total = editorData.total_duration || 1;

  // ── Segment bar (색상 구간) ──
  const segBar = document.getElementById("timeline-segbar");
  segBar.innerHTML = "";
  editorData.segments.forEach((seg, i) => {
    const pct = (seg.duration / total) * 100;
    const el = document.createElement("div");
    el.className = "segbar-block";
    el.dataset.idx = i;
    el.style.width = `${Math.max(pct, 1.5)}%`;

    if (seg.type === "intro") {
      el.style.background = "#6366f1";
    } else if (seg.type === "outro") {
      el.style.background = "#8b5cf6";
    } else {
      el.style.background = "#374151";
    }
    if (i === currentSegIdx) el.classList.add("active");

    // 레이블
    let label = "";
    if (seg.type === "intro") label = "IN";
    else if (seg.type === "outro") label = "OUT";
    else label = `${seg.slide_num || ""}`;
    el.innerHTML = `<span class="segbar-label">${label}</span>`;
    if (pct > 8) {
      el.innerHTML += `<span class="segbar-dur">${seg.duration.toFixed(1)}s</span>`;
    }

    el.addEventListener("click", (e) => {
      e.stopPropagation();
      _seekToSegment(i);
    });

    segBar.appendChild(el);
  });

  // ── Thumbnail strip ──
  const thumbStrip = document.getElementById("timeline-thumbs");
  thumbStrip.innerHTML = "";
  editorData.segments.forEach((seg, i) => {
    const pct = (seg.duration / total) * 100;
    const el = document.createElement("div");
    el.className = "thumb-block";
    el.style.width = `${Math.max(pct, 1.5)}%`;

    let imgSrc = null;
    if (seg.type === "intro") {
      imgSrc = seg.thumbnail || editorData.intro_bg_url;
    } else if (seg.type === "outro") {
      imgSrc = seg.thumbnail || editorData.outro_bg_url;
    } else {
      const sn = seg.slide_num || 0;
      const slideImg = sn > 0 ? editorData.slide_images[sn - 1] : null;
      if (slideImg) imgSrc = slideImg.path;
    }

    if (imgSrc) {
      el.innerHTML = `<img src="${imgSrc}" alt="seg ${i}">`;
    }

    el.addEventListener("click", () => _seekToSegment(i));
    thumbStrip.appendChild(el);
  });

  renderSfxMarkers();
  renderBgmTrack();
}

function _seekToSegment(idx) {
  if (idx < 0 || idx >= _segTimes.length) return;
  const video = document.getElementById("preview-video");
  video.currentTime = _segTimes[idx].start;
  _updateCurrentSeg(idx);
}

function _updateCurrentSeg(idx) {
  if (idx === currentSegIdx) return;
  currentSegIdx = idx;
  // 하이라이트 업데이트
  document.querySelectorAll(".segbar-block").forEach((el) => {
    el.classList.toggle("active", +el.dataset.idx === idx);
  });
  renderTextOverlays();
}

// ─── Video Playback ───

function setupVideo() {
  const video = document.getElementById("preview-video");
  const timeDisplay = document.getElementById("time-display");

  // 합본 영상 로드 (없으면 첫 세그먼트 폴백)
  if (editorData.final_video) {
    video.src = editorData.final_video + `?t=${Date.now()}`;
  } else if (editorData.segments.length > 0) {
    video.src = editorData.segments[0].path;
  }
  video.load();

  // timeupdate: 시간 표시 + 세그먼트 감지 (저빈도 OK)
  video.addEventListener("timeupdate", () => {
    if (!video.duration) return;
    timeDisplay.textContent = `${_fmt(video.currentTime)} / ${_fmt(video.duration)}`;
    const segIdx = _getSegmentAtTime(video.currentTime);
    _updateCurrentSeg(segIdx);
    // BGM 구간 동기화
    if (_bgmAudio && editState.bgm) {
      const bgm = editState.bgm;
      const t = video.currentTime;
      if (t >= bgm.start_time && t <= bgm.end_time) {
        if (_bgmAudio.paused) _bgmAudio.play().catch(() => {});
      } else {
        if (!_bgmAudio.paused) _bgmAudio.pause();
      }
    }
  });

  // requestAnimationFrame: 플레이헤드 60fps 부드러운 이동
  function _animatePlayhead() {
    if (video.duration) {
      _updatePlayhead(video.currentTime, video.duration);
    }
    requestAnimationFrame(_animatePlayhead);
  }
  requestAnimationFrame(_animatePlayhead);

  // seek 시에도 즉시 반영
  video.addEventListener("seeked", () => {
    if (video.duration) _updatePlayhead(video.currentTime, video.duration);
    if (_bgmAudio) _syncBgmToVideo();
  });

  // 타임라인 클릭으로 seek
  const timelineBody = document.getElementById("timeline-body");
  timelineBody.addEventListener("mousedown", (e) => {
    // SFX 마커 드래그 무시
    if (e.target.closest(".sfx-marker")) return;
    // segbar-block, thumb-block 클릭은 각각 자체 핸들러가 있으므로 여기는 빈 영역 또는 드래그 스크럽용
    _startTimelineScrub(e);
  });
}

function _updatePlayhead(currentTime, duration) {
  const playhead = document.getElementById("timeline-playhead");
  if (!playhead || !duration) return;
  const pct = (currentTime / duration) * 100;
  playhead.style.left = `${pct}%`;
}

function _startTimelineScrub(e) {
  const timeline = document.getElementById("timeline-body");
  const video = document.getElementById("preview-video");
  const rect = timeline.getBoundingClientRect();
  const duration = video.duration || editorData.total_duration || 1;

  function seek(clientX) {
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = pct * duration;
  }

  seek(e.clientX);

  function onMove(e2) {
    e2.preventDefault();
    seek(e2.clientX);
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

let _bgmAudio = null;

function togglePlay() {
  const video = document.getElementById("preview-video");
  const btn = document.getElementById("btn-play");
  if (video.paused) {
    video.play();
    btn.innerHTML = "&#9646;&#9646;";
    // SFX 미리듣기 자동 시작
    _sfxPreviewing = true;
    _sfxFiredIds.clear();
    _sfxAudios = [];
    requestAnimationFrame(_checkSfxTriggers);
    // BGM 동시 재생
    _startBgmPlayback();
  } else {
    video.pause();
    btn.innerHTML = "&#9654;";
    stopSfxPreview();
    _stopBgmPlayback();
  }
}

function _startBgmPlayback() {
  _stopBgmPlayback();
  const bgm = editState.bgm;
  if (!bgm || !bgm.path) return;
  const video = document.getElementById("preview-video");
  _bgmAudio = new Audio(bgm.path);
  _bgmAudio.volume = bgm.volume || 0.1;
  _bgmAudio.loop = true;
  // 영상 시점에 맞춰 BGM 오프셋 계산
  _syncBgmToVideo();
  _bgmAudio.play().catch(() => {});
}

function _stopBgmPlayback() {
  if (_bgmAudio) {
    _bgmAudio.pause();
    _bgmAudio = null;
  }
}

function _syncBgmToVideo() {
  if (!_bgmAudio || !editState.bgm) return;
  const video = document.getElementById("preview-video");
  const bgm = editState.bgm;
  const t = video.currentTime;
  if (t >= bgm.start_time && t <= bgm.end_time) {
    _bgmAudio.currentTime = t - bgm.start_time;
    _bgmAudio.volume = bgm.volume || 0.1;
    if (_bgmAudio.paused) _bgmAudio.play().catch(() => {});
  } else {
    _bgmAudio.pause();
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
    type: "text",
    segment: seg.file,
    x: 160, y: 300,
    text: "\ud14d\uc2a4\ud2b8 \uc785\ub825",
    font_size: 48,
    font_color: "#ffffff",
    bg_color: "#000000",
    rotation: 0,
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
    const isImage = (t.type === "image");
    const rotation = t.rotation || 0;

    const box = document.createElement("div");
    box.className = `${isImage ? "image-overlay-box" : "text-overlay-box"} ${selectedOverlay === t.id ? "selected" : ""}`;
    box.style.left = `${t.x * scale}px`;
    box.style.top = `${t.y * scale}px`;
    box.style.transform = rotation ? `rotate(${rotation}deg)` : "";

    if (isImage) {
      // 이미지 오버레이
      const w = (t.width || 300) * scale;
      const h = (t.height || 300) * scale;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      const img = document.createElement("img");
      img.src = t.src;
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "contain";
      img.draggable = false;
      box.appendChild(img);
    } else {
      // 텍스트 오버레이
      box.style.fontSize = `${t.font_size * scale}px`;
      box.style.color = t.font_color;
      if (t.bg_color) {
        box.style.background = t.bg_color + "b3";
        box.style.padding = "2px 6px";
        box.style.borderRadius = "3px";
      }
      box.textContent = t.text;
    }

    // 리사이즈 핸들
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "resize-handle";
    resizeHandle.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      _startResize(e, t, scale, isImage);
    });
    box.appendChild(resizeHandle);

    // 회전 핸들
    const rotateHandle = document.createElement("div");
    rotateHandle.className = "rotate-handle";
    rotateHandle.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      _startRotate(e, t, box, scale);
    });
    box.appendChild(rotateHandle);

    // 드래그 이동
    box.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      selectTextOverlay(t.id);
      _startDrag(e, t, scale);
    });

    // 더블클릭 인라인 편집 (텍스트만)
    if (!isImage) {
      box.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        _editTextInline(box, t);
      });
    }

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
  const box = e.currentTarget;

  function onMove(e2) {
    overlay.x = origX + (e2.clientX - startX) / scale;
    overlay.y = origY + (e2.clientY - startY) / scale;
    _dirty = true;
    // DOM 재생성 없이 위치만 직접 업데이트
    box.style.left = `${overlay.x * scale}px`;
    box.style.top = `${overlay.y * scale}px`;
    renderProps();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    renderTextOverlays();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function _startResize(e, overlay, scale, isImage) {
  const startX = e.clientX, startY = e.clientY;
  // DOM 재생성 없이 스타일만 직접 업데이트 (드래그 중 DOM 유지)
  const box = e.target.parentElement;

  if (isImage) {
    const origW = overlay.width || 300;
    const origH = overlay.height || 300;
    const aspect = origW / origH;

    function onMove(e2) {
      const dx = (e2.clientX - startX) / scale;
      const dy = (e2.clientY - startY) / scale;
      const delta = (dx + dy) / 2;
      overlay.width = Math.max(50, origW + delta);
      overlay.height = Math.max(50, overlay.width / aspect);
      _dirty = true;
      box.style.width = `${overlay.width * scale}px`;
      box.style.height = `${overlay.height * scale}px`;
      renderProps();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      renderTextOverlays();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  } else {
    const origSize = overlay.font_size || 48;

    function onMove(e2) {
      const dx = (e2.clientX - startX) / scale;
      const dy = (e2.clientY - startY) / scale;
      const delta = (dx + dy) / 2;
      overlay.font_size = Math.max(12, Math.min(200, Math.round(origSize + delta * 0.5)));
      _dirty = true;
      box.style.fontSize = `${overlay.font_size * scale}px`;
      renderProps();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      renderTextOverlays();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
}

function _startRotate(e, overlay, box, scale) {
  const rect = box.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
  const origRotation = overlay.rotation || 0;

  function onMove(e2) {
    const currentAngle = Math.atan2(e2.clientY - cy, e2.clientX - cx) * (180 / Math.PI);
    let delta = currentAngle - startAngle;
    overlay.rotation = Math.round(origRotation + delta);
    _dirty = true;
    // DOM 재생성 없이 transform만 직접 업데이트
    box.style.transform = `rotate(${overlay.rotation}deg)`;
    renderProps();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    renderTextOverlays();
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

// ─── Properties Panel (3-Section) ───

function renderProps() {
  const container = document.getElementById("props-content");
  let html = "";

  // ── 텍스트/이미지 섹션 ──
  const t = editState.text_overlays.find(o => o.id === selectedOverlay);
  const textActive = t ? "prop-section-active" : "";
  html += `<div class="prop-section ${textActive}">
    <div class="prop-section-title" style="color:#3b82f6;">텍스트</div>`;
  if (t) {
    const isImage = (t.type === "image");
    if (isImage) {
      html += `
        <div class="prop-row"><span class="prop-label">타입</span><span class="text-[10px] text-gray-400">이미지</span></div>
        <div class="prop-row"><span class="prop-label">너비</span><input class="prop-input" type="number" value="${Math.round(t.width || 300)}" min="20" onchange="updateProp('width', +this.value)"></div>
        <div class="prop-row"><span class="prop-label">높이</span><input class="prop-input" type="number" value="${Math.round(t.height || 300)}" min="20" onchange="updateProp('height', +this.value)"></div>`;
    } else {
      html += `
        <div class="prop-row"><span class="prop-label">텍스트</span><input class="prop-input" value="${_esc(t.text)}" onchange="updateProp('text', this.value)"></div>
        <div class="prop-row"><span class="prop-label">크기</span><input class="prop-input" type="number" value="${t.font_size}" min="12" max="200" onchange="updateProp('font_size', +this.value)"></div>
        <div class="prop-row"><span class="prop-label">색상</span><input type="color" value="${t.font_color}" style="width:30px;height:24px;border:none;background:none;cursor:pointer;" onchange="updateProp('font_color', this.value)"></div>
        <div class="prop-row"><span class="prop-label">배경</span><input type="color" value="${t.bg_color || '#000000'}" style="width:30px;height:24px;border:none;background:none;cursor:pointer;" onchange="updateProp('bg_color', this.value)"></div>`;
    }
    html += `
      <div class="prop-row"><span class="prop-label">회전</span><input class="prop-input" type="number" value="${t.rotation || 0}" min="-360" max="360" onchange="updateProp('rotation', +this.value)"></div>
      <div class="prop-row"><span class="prop-label">시작</span><input class="prop-input" type="number" value="${t.start_time}" min="0" step="0.1" onchange="updateProp('start_time', +this.value)"></div>
      <div class="prop-row"><span class="prop-label">종료</span><input class="prop-input" type="number" value="${t.end_time}" min="0" step="0.1" onchange="updateProp('end_time', +this.value)"></div>
      <div class="prop-row"><span class="prop-label">X</span><input class="prop-input" type="number" value="${Math.round(t.x)}" onchange="updateProp('x', +this.value)"></div>
      <div class="prop-row"><span class="prop-label">Y</span><input class="prop-input" type="number" value="${Math.round(t.y)}" onchange="updateProp('y', +this.value)"></div>
      <button onclick="deleteSelectedOverlay()" class="w-full px-2 py-1 bg-red-800 hover:bg-red-700 rounded text-xs mt-2">삭제</button>`;
  } else {
    html += `<div class="text-gray-600 text-[10px]">텍스트를 선택하세요</div>`;
  }
  html += `</div>`;

  // ── SFX 섹션 ──
  const sfxActive = selectedOverlay && selectedOverlay.startsWith("s_") ? "prop-section-active" : "";
  const sfxMarker = editState.sfx_markers.find(m => m.id === selectedOverlay);
  html += `<div class="prop-section ${sfxActive}">
    <div class="prop-section-title" style="color:#f97316;">SFX</div>`;
  if (sfxMarker) {
    html += `
      <div class="prop-row"><span class="prop-label">파일</span><span class="text-[10px] text-orange-400 truncate">${_esc(sfxMarker.file)}</span></div>
      <div class="prop-row"><span class="prop-label">시점</span><input class="prop-input" type="number" value="${sfxMarker.time}" min="0" step="0.1" onchange="updateSfxProp('time', +this.value)"></div>
      <div class="prop-row"><span class="prop-label">볼륨</span><input class="prop-input" type="number" value="${sfxMarker.volume || 0.8}" min="0" max="1" step="0.05" onchange="updateSfxProp('volume', +this.value)"></div>
      <button onclick="deleteSelectedSfx()" class="w-full px-2 py-1 bg-red-800 hover:bg-red-700 rounded text-xs mt-2">삭제</button>`;
  } else {
    html += `<div class="text-gray-600 text-[10px]">SFX 마커를 선택하세요</div>`;
  }
  html += `</div>`;

  // ── BGM 섹션 ──
  const bgmActive = selectedOverlay === '__bgm__' ? "prop-section-active" : "";
  const b = editState.bgm;
  html += `<div class="prop-section ${bgmActive}">
    <div class="prop-section-title" style="color:#10b981;">BGM</div>`;
  if (b) {
    html += `
      <div class="prop-row"><span class="prop-label">파일</span><span class="text-[10px] text-emerald-400 truncate">${_esc(b.file)}</span></div>
      <div class="prop-row"><span class="prop-label">볼륨</span><input class="prop-input" type="number" value="${b.volume}" min="0" max="1" step="0.01" onchange="updateBgmProp('volume', +this.value)"></div>
      <div class="prop-row"><span class="prop-label">시작</span><input class="prop-input" type="number" value="${b.start_time}" min="0" step="0.1" onchange="updateBgmProp('start_time', +this.value)"></div>
      <div class="prop-row"><span class="prop-label">종료</span><input class="prop-input" type="number" value="${b.end_time}" min="0" step="0.1" onchange="updateBgmProp('end_time', +this.value)"></div>
      <button onclick="removeBgm()" class="w-full px-2 py-1 bg-red-800 hover:bg-red-700 rounded text-xs mt-2">제거</button>`;
  } else {
    html += `<div class="text-gray-600 text-[10px]">BGM을 적용하세요</div>`;
  }
  html += `</div>`;

  container.innerHTML = html;
}

function updateSfxProp(key, val) {
  const m = editState.sfx_markers.find(x => x.id === selectedOverlay);
  if (!m) return;
  m[key] = val;
  _dirty = true;
  renderSfxMarkers();
}

function updateBgmProp(key, val) {
  if (!editState.bgm) return;
  editState.bgm[key] = val;
  _dirty = true;
  renderBgmTrack();
}

function deleteSelectedSfx() {
  if (!selectedOverlay) return;
  editState.sfx_markers = editState.sfx_markers.filter(x => x.id !== selectedOverlay);
  selectedOverlay = null;
  _dirty = true;
  renderSfxMarkers();
  renderProps();
}

function selectSfxMarker(id) {
  selectedOverlay = id;
  renderProps();
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
  bgmEl.innerHTML = (editorData.bgm_list || []).map((s, i) => {
    const isActive = editState.bgm && editState.bgm.file === s.file;
    return `
    <div class="sfx-item ${isActive ? 'bgm-active' : ''}" title="${s.file} (${s.duration ? s.duration.toFixed(1) + 's' : ''})">
      <span class="sfx-preview bgm-preview-btn" onclick="toggleBgmPreview('${s.path}', this)">&#9654;</span>
      <span class="flex-1 truncate">${s.file.replace(/\.[^.]+$/, '')}</span>
      <button onclick="applyBgm('${_esc(s.file)}', '${_esc(s.path)}', ${s.duration || 0})"
        class="px-1.5 py-0.5 bg-emerald-800 hover:bg-emerald-700 rounded text-[9px] font-medium flex-shrink-0"
        title="타임라인에 적용">${isActive ? '적용됨' : '적용'}</button>
    </div>`;
  }).join("");
}

let _previewAudio = null;
function previewAudio(path) {
  if (_previewAudio) { _previewAudio.pause(); _previewAudio = null; }
  _previewAudio = new Audio(path);
  _previewAudio.play();
}

function toggleBgmPreview(path, btnEl) {
  if (_previewAudio && !_previewAudio.paused && _previewAudio._path === path) {
    _previewAudio.pause();
    _previewAudio.currentTime = 0;
    _previewAudio = null;
    btnEl.innerHTML = '&#9654;';
    return;
  }
  if (_previewAudio) { _previewAudio.pause(); }
  // 모든 미리듣기 버튼 초기화
  document.querySelectorAll('.bgm-preview-btn').forEach(b => b.innerHTML = '&#9654;');
  _previewAudio = new Audio(path);
  _previewAudio._path = path;
  _previewAudio.play();
  btnEl.innerHTML = '&#9632;';
  _previewAudio.addEventListener('ended', () => { btnEl.innerHTML = '&#9654;'; });
}

// ─── BGM ───

function applyBgm(file, path, duration) {
  const total = editorData.total_duration || 1;
  editState.bgm = {
    file,
    path,
    start_time: 0,
    end_time: Math.min(duration, total),
    volume: 0.1,
  };
  _dirty = true;
  renderBgmTrack();
  renderSfxPanel();  // 하이라이트 업데이트
}

function removeBgm() {
  editState.bgm = null;
  _dirty = true;
  selectedOverlay = null;
  renderBgmTrack();
  renderSfxPanel();
  renderProps();
}

function renderBgmTrack() {
  const container = document.getElementById("bgm-bar-container");
  if (!container) return;
  container.innerHTML = "";

  const bgm = editState.bgm;
  if (!bgm) return;

  const total = editorData.total_duration || 1;
  const leftPct = (bgm.start_time / total) * 100;
  const widthPct = ((bgm.end_time - bgm.start_time) / total) * 100;
  const durSec = (bgm.end_time - bgm.start_time).toFixed(1);
  const name = bgm.file.replace(/\.[^.]+$/, '');

  const bar = document.createElement("div");
  bar.className = "bgm-bar";
  bar.style.left = `${leftPct}%`;
  bar.style.width = `${Math.max(widthPct, 1)}%`;
  bar.title = `${bgm.file} (${durSec}s) vol:${Math.round(bgm.volume * 100)}%\n더블클릭=제거`;

  bar.innerHTML = `
    <div class="bgm-handle bgm-handle-left"></div>
    <span class="bgm-bar-label">${name} (${durSec}s)</span>
    <div class="bgm-handle bgm-handle-right"></div>
  `;

  // 클릭 → 속성 패널에 BGM 표시
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedOverlay = '__bgm__';
    renderTextOverlays();
    renderProps();
  });

  // 더블클릭 → BGM 제거
  bar.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    editState.bgm = null;
    _dirty = true;
    selectedOverlay = null;
    renderBgmTrack();
    renderSfxPanel();
    renderProps();
  });

  const leftHandle = bar.querySelector(".bgm-handle-left");
  const rightHandle = bar.querySelector(".bgm-handle-right");
  _setupBgmBarDrag(bar, leftHandle, rightHandle);

  container.appendChild(bar);
}

function _setupBgmBarDrag(bar, leftHandle, rightHandle) {
  const total = editorData.total_duration || 1;
  const body = document.getElementById("timeline-body");

  // 좌측 핸들 드래그 → start_time
  leftHandle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = body.getBoundingClientRect();
    function onMove(e2) {
      const pct = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
      const t = pct * total;
      if (t < editState.bgm.end_time - 0.5) {
        editState.bgm.start_time = Math.round(t * 10) / 10;
        _dirty = true;
        renderBgmTrack();
      }
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      renderProps();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 우측 핸들 드래그 → end_time
  rightHandle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = body.getBoundingClientRect();
    function onMove(e2) {
      const pct = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
      const t = pct * total;
      if (t > editState.bgm.start_time + 0.5) {
        editState.bgm.end_time = Math.round(t * 10) / 10;
        _dirty = true;
        renderBgmTrack();
      }
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      renderProps();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 바 전체 드래그 → 위치 이동 (길이 유지)
  bar.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("bgm-handle")) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = body.getBoundingClientRect();
    const bgm = editState.bgm;
    const dur = bgm.end_time - bgm.start_time;
    const startPct = (e.clientX - rect.left) / rect.width;
    const origStart = bgm.start_time;

    function onMove(e2) {
      const pctNow = (e2.clientX - rect.left) / rect.width;
      const delta = (pctNow - startPct) * total;
      let newStart = origStart + delta;
      newStart = Math.max(0, Math.min(total - dur, newStart));
      bgm.start_time = Math.round(newStart * 10) / 10;
      bgm.end_time = Math.round((newStart + dur) * 10) / 10;
      _dirty = true;
      renderBgmTrack();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      renderProps();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ─── Sidebar Toggle & Search ───

function toggleSection(name) {
  const section = document.querySelector(`.sidebar-section[data-section="${name}"]`);
  if (!section) return;
  const body = section.querySelector(".sidebar-section-body");
  section.classList.toggle("open");
  body.classList.toggle("hidden");
}

function toggleImgCat(idx) {
  const section = document.querySelector(`.img-cat-section[data-cat="${idx}"]`);
  if (!section) return;
  const body = document.getElementById(`img-cat-${idx}`);
  section.classList.toggle("open");
  body.classList.toggle("hidden");
}

function filterSidebarItems(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll(".sfx-item, .text-img-item").forEach(el => {
    const text = (el.textContent || "").toLowerCase();
    el.style.display = !q || text.includes(q) ? "" : "none";
  });
  // 검색어가 있으면 모든 섹션 펼침
  if (q) {
    document.querySelectorAll(".sidebar-section").forEach(s => {
      s.classList.add("open");
      s.querySelector(".sidebar-section-body").classList.remove("hidden");
    });
  }
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
    // 시간 계산은 타임라인 body 너비 기준
    const body = document.getElementById("timeline-body");
    const rect = body.getBoundingClientRect();
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
    // SFX 파일의 duration 조회 → 너비로 표현
    const sfxInfo = (editorData.sfx_list || []).find(s => s.file === m.file);
    const sfxDur = sfxInfo ? sfxInfo.duration : 1;
    const widthPct = (sfxDur / total) * 100;
    const name = m.file.replace(/\.[^.]+$/, '');

    const el = document.createElement("div");
    el.className = "sfx-marker";
    el.style.left = `${pct}%`;
    el.style.width = `${Math.max(widthPct, 1.5)}%`;
    el.title = `${m.file} @ ${m.time.toFixed(1)}s (${sfxDur.toFixed(1)}s) — 더블클릭=삭제`;
    el.innerHTML = `<span class="sfx-marker-icon">&#128264;</span><span class="sfx-marker-label">${name}</span>`;

    // 클릭 → 선택 + 드래그로 위치 이동
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectSfxMarker(m.id);
      const body = document.getElementById("timeline-body");
      const rect = body.getBoundingClientRect();

      function onMove(e2) {
        const pctNew = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
        m.time = Math.round(pctNew * total * 10) / 10;
        el.style.left = `${(m.time / total) * 100}%`;
        el.title = `${m.file} @ ${m.time.toFixed(1)}s — 더블클릭=삭제`;
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
    // 마커 시점 +-0.15초 이내이면 트리거
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
    document.getElementById("btn-save").textContent = "\uc800\uc7a5\ub428";
    setTimeout(() => {
      document.getElementById("btn-save").textContent = "\uc800\uc7a5";
    }, 1500);
  }
}

async function applyEdits() {
  await saveEdits();
  const btn = document.getElementById("btn-apply");
  btn.textContent = "\uc801\uc6a9 \uc911...";
  btn.disabled = true;
  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/apply-edits`, { method: "POST" });
    const data = await r.json();
    if (data.ok) {
      btn.textContent = "\uc644\ub8cc!";
      // 최종 합본 영상 미리보기 (SFX 포함)
      const video = document.getElementById("preview-video");
      video.src = `/api/jobs/${JOB_ID}/video?t=${Date.now()}`;
      video.load();
      setTimeout(() => {
        btn.textContent = "\uc801\uc6a9 (\uc7ac\ub80c\ub354)";
        btn.disabled = false;
      }, 1500);
    } else {
      btn.textContent = "\uc2e4\ud328";
      setTimeout(() => { btn.textContent = "\uc801\uc6a9 (\uc7ac\ub80c\ub354)"; btn.disabled = false; }, 2000);
    }
  } catch (e) {
    btn.textContent = "\uc624\ub958";
    setTimeout(() => { btn.textContent = "\uc801\uc6a9 (\uc7ac\ub80c\ub354)"; btn.disabled = false; }, 2000);
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
