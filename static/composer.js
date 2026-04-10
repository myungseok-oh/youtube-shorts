/* ─── Composer JS — 프리프로덕션 영상 편집기 ─── */

let composerData = null;
let composeState = { slide_order: [], slide_durations: {}, sfx_markers: [], bgm: null, voice_clips: [], subtitle_entries: [] };
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
  // 오버레이 기본 숨김: slide_overrides에 hidden 설정이 없는 슬라이드는 hidden=true
  if (composerData.slides) {
    for (const sl of composerData.slides) {
      if (!composeState.slide_overrides[sl.num]) composeState.slide_overrides[sl.num] = {};
      if (composeState.slide_overrides[sl.num].hidden === undefined) {
        composeState.slide_overrides[sl.num].hidden = true;
      }
    }
  }
  composeState.narr_file_map = composeState.narr_file_map || {};
  composeState.style_overrides = composeState.style_overrides || {};
  composeState.subtitle_overrides = composeState.subtitle_overrides || {};
  composeState.sentence_overrides = composeState.sentence_overrides || {};
  composeState.voice_clips = composeState.voice_clips || [];
  composeState.subtitle_entries = composeState.subtitle_entries || [];
  await loadNarrFilePool();
  // 마이그레이션: 기존 데이터 → voice_clips + subtitle_entries
  _migrateToVoiceClips();
  // slide_motions: 배열 → dict 변환
  if (Array.isArray(composeState.slide_motions)) {
    const dict = {};
    composeState.slide_motions.forEach(m => { if (m.slide) dict[m.slide] = m.motion; });
    composeState.slide_motions = dict;
  } else {
    composeState.slide_motions = composeState.slide_motions || {};
  }
  // transitions: 배열(slide_transitions) → dict 변환
  if (Array.isArray(composeState.slide_transitions)) {
    const dict = {};
    const order = composeState.slide_order && composeState.slide_order.length > 0
      ? composeState.slide_order : composerData.slides.map(s => s.num);
    composeState.slide_transitions.forEach((t, i) => {
      if (i < order.length - 1) {
        dict[`${order[i]}>${order[i+1]}`] = { effect: t.effect, duration: t.duration };
      }
    });
    composeState.transitions = dict;
    delete composeState.slide_transitions;
  } else {
    composeState.transitions = composeState.transitions || {};
  }

  // slide_durations를 서버 slide_audio 기준으로 항상 동기화
  _autoUpdateDurations();
  // voice_clips 위치를 slide_durations 기준으로 재정렬
  if (composeState.voice_clips && composeState.voice_clips.length > 0) {
    _recalcClipPositions();
  }

  // voice_clips 오디오 파일 프리로드 (새로고침 후 재생 지연 방지)
  _preloadVoiceClips();

  _tlInit();  // Canvas timeline 초기화
  renderTimeline();
  renderTabMedia();
  renderTabSfx();
  renderTabBgm();
  if (composeState.slide_order.length > 0) {
    selectSlide(0);
  }
  setupSfxDrop();
  setupVoiceClipDrop();
}

let _preloadedAudios = [];
function _preloadVoiceClips() {
  _preloadedAudios.forEach(a => { a.src = ""; });
  _preloadedAudios = [];
  (composeState.voice_clips || []).forEach(clip => {
    if (clip.path) {
      const a = new Audio();
      a.preload = "auto";
      a.src = clip.path;
      _preloadedAudios.push(a);
    }
  });
}

// ─── 클립/자막 시간 재계산 ───

function _recalcClipPositions() {
  /** voice_clips와 subtitle_entries의 start_time/end_time을 슬라이드 순서에 맞게 재계산.
   *  각 슬라이드 내 클립은 기존 순서를 유지하되, 슬라이드 경계에 맞춰 정렬. */
  const slides = getOrderedSlides();
  let cumTime = 0;
  slides.forEach(sl => {
    const slideDur = getSlideDuration(sl.num);
    // 이 슬라이드에 속한 클립 (기존 순서 유지)
    const clips = (composeState.voice_clips || []).filter(c => c.slide_num === sl.num);
    const subs = (composeState.subtitle_entries || []).filter(e => e.slide_num === sl.num);
    clips.sort((a, b) => a.start_time - b.start_time);
    subs.sort((a, b) => a.start_time - b.start_time);

    let clipTime = cumTime;
    clips.forEach(clip => {
      clip.start_time = clipTime;
      const matchSub = subs.find(s => s.slide_num === sl.num && !s._matched);
      if (matchSub) {
        matchSub.start_time = clipTime;
        matchSub.end_time = clipTime + clip.duration;
        matchSub._matched = true;
      }
      clipTime += clip.duration;
    });
    cumTime += slideDur;
  });
  // cleanup temp flags
  (composeState.subtitle_entries || []).forEach(s => delete s._matched);
}

// ─── Migration: narr_file_map / slide_audio → voice_clips + subtitle_entries ───

function _migrateToVoiceClips() {
  // 이미 voice_clips가 있으면 마이그레이션 불필요
  if (composeState.voice_clips && composeState.voice_clips.length > 0) return;

  const slides = getOrderedSlides();
  let cumTime = 0;
  const clips = [];
  const subs = [];

  slides.forEach(sl => {
    const dur = getSlideDuration(sl.num);
    const audioFiles = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
    const sentences = sl.sentences || [];

    if (audioFiles.length > 0) {
      let clipTime = cumTime;
      audioFiles.forEach((af, ai) => {
        const dur2 = af.duration || 2.0;
        clips.push({
          id: `vc_${sl.num}_${ai}_${Date.now()}`,
          file: af.file,
          path: af.path,
          start_time: clipTime,
          duration: dur2,
          volume: composeState.narr_volume !== undefined ? composeState.narr_volume : 100,
          slide_num: sl.num,
        });
        const subText = af.text || (sentences[ai] && sentences[ai].text) || "";
        if (subText) {
          subs.push({
            id: `sub_${sl.num}_${ai}_${Date.now()}`,
            text: subText,
            start_time: clipTime,
            end_time: clipTime + dur2,
            slide_num: sl.num,
          });
        }
        clipTime += dur2;
      });
    } else if (sentences.length > 0) {
      const sentDur = dur / sentences.length;
      let sentTime = cumTime;
      sentences.forEach((sent, si) => {
        if (sent.text) {
          subs.push({
            id: `sub_${sl.num}_${si}_${Date.now()}`,
            text: sent.text,
            start_time: sentTime,
            end_time: sentTime + sentDur,
            slide_num: sl.num,
          });
        }
        sentTime += sentDur;
      });
    }
    cumTime += dur;
  });

  if (clips.length > 0) {
    composeState.voice_clips = clips;
    _dirty = true;
  }
  if (subs.length > 0) {
    composeState.subtitle_entries = subs;
    _dirty = true;
  }
}

// ─── Timeline ───

// ══════════════════════════════════════════════════════════
// ─── TL: Canvas-based Timeline ───
// ══════════════════════════════════════════════════════════

const TL = {
  canvas: null, ctx: null, dpr: 1,
  w: 0, h: 0,               // CSS px
  needsRedraw: true,
  hitRegions: [],            // [{type, rect:{x,y,w,h}, data}]
  thumbCache: {},            // slideNum → Image
  thumbLoading: new Set(),
  textWidthCache: {},        // font+text → width
  // layout
  rulerH: 22,
  trackFlex: [5, 1, 1, 1, 1, 1],  // slides, transition, subtitle, narration, sfx, bgm
  trackY: [],   // computed y offsets
  trackH: [],   // computed heights
  // colors
  BG: '#1a1c24',
  RULER_BG: '#1e2028',
  RULER_TEXT: '#6b7280',
  RULER_LINE: '#3a3d48',
  SLIDE_BG: '#22242e',
  SLIDE_BORDER: '#2a2d38',
  SLIDE_ACTIVE_BORDER: '#6366f1',
  PLAYHEAD: '#f97316',
  SEP: '#22242e',
  TYPE_COLORS: { photo:'#3b82f6', broll:'#8b5cf6', graph:'#f59e0b', logo:'#10b981', closing:'#6b7280' },
  TYPE_LABELS: { photo:'사진', broll:'B롤', graph:'그래프', logo:'로고', closing:'클로징' },
  TR_BG: '#1e1e2e', TR_BORDER: '#2a2d38', TR_ACTIVE: '#1e2245', TR_ACTIVE_BORDER: '#4338ca',
  SFX_BG: 'rgba(99,102,241,0.2)', SFX_BORDER: 'rgba(99,102,241,0.5)', SFX_LABEL: '#818cf8',
  NARR_BG: 'rgba(20,184,166,0.25)', NARR_BORDER: 'rgba(20,184,166,0.6)', NARR_LABEL: '#5eead4',
  SUB_BG: 'rgba(96,165,250,0.2)', SUB_BORDER: 'rgba(96,165,250,0.5)', SUB_LABEL: '#93c5fd',
  BGM_BG: 'rgba(52,211,153,0.2)', BGM_BORDER: 'rgba(52,211,153,0.5)', BGM_LABEL: '#34d399',
  // drag state
  dragState: null, // {type, data, startX, startY, origData}
  hoverRegion: null,
  // drop highlight
  dropTrack: null, // 'sfx' | 'narration'
};

function _tlInit() {
  TL.canvas = document.getElementById('tl-canvas');
  if (!TL.canvas) return;
  TL.ctx = TL.canvas.getContext('2d');
  TL.dpr = window.devicePixelRatio || 1;

  const ro = new ResizeObserver(() => {
    _tlResize();
    TL.needsRedraw = true;
  });
  ro.observe(TL.canvas.parentElement);
  _tlResize();

  // mouse events on canvas
  TL.canvas.addEventListener('mousedown', _tlOnMouseDown);
  TL.canvas.addEventListener('mousemove', _tlOnMouseMove);
  TL.canvas.addEventListener('dblclick', _tlOnDblClick);
  TL.canvas.addEventListener('contextmenu', _tlOnContextMenu);

  // drag-drop for SFX/narration
  const overlay = document.getElementById('tl-drop-overlay');
  const timeline = document.getElementById('timeline');
  if (timeline) {
    timeline.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('sfx_file') || e.dataTransfer.types.includes('narr_file')) {
        e.preventDefault();
        overlay.classList.add('active');
        TL.dropTrack = e.dataTransfer.types.includes('sfx_file') ? 'sfx' : 'narration';
        TL.needsRedraw = true;
      }
    });
    timeline.addEventListener('dragleave', (e) => {
      if (!timeline.contains(e.relatedTarget)) {
        overlay.classList.remove('active');
        TL.dropTrack = null;
        TL.needsRedraw = true;
      }
    });
    timeline.addEventListener('drop', (e) => {
      overlay.classList.remove('active');
      TL.dropTrack = null;
      TL.needsRedraw = true;
      if (e.dataTransfer.types.includes('sfx_file')) {
        e.preventDefault();
        _tlHandleSfxDrop(e);
      } else if (e.dataTransfer.types.includes('narr_file')) {
        e.preventDefault();
        _tlHandleNarrDrop(e);
      }
    });
  }

  _tlRenderLoop();
}

function _tlResize() {
  if (!TL.canvas) return;
  const parent = TL.canvas.parentElement;
  TL.w = parent.clientWidth;
  TL.h = parent.clientHeight;
  TL.canvas.width = Math.round(TL.w * TL.dpr);
  TL.canvas.height = Math.round(TL.h * TL.dpr);
  TL.canvas.style.width = TL.w + 'px';
  TL.canvas.style.height = TL.h + 'px';
  _tlComputeLayout();
}

function _tlComputeLayout() {
  const bodyH = TL.h - TL.rulerH;
  const totalFlex = TL.trackFlex.reduce((a, b) => a + b, 0);
  TL.trackY = [];
  TL.trackH = [];
  let y = TL.rulerH;
  for (let i = 0; i < TL.trackFlex.length; i++) {
    const h = Math.round((TL.trackFlex[i] / totalFlex) * bodyH);
    TL.trackY.push(y);
    TL.trackH.push(h);
    y += h;
  }
}

function _tlRenderLoop() {
  if (TL.needsRedraw || _previewing) {
    TL.needsRedraw = false;
    _tlDraw();
  }
  requestAnimationFrame(_tlRenderLoop);
}

// ─── Master Draw ───
function _tlDraw() {
  const ctx = TL.ctx;
  if (!ctx) return;
  const dpr = TL.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // clear
  ctx.fillStyle = TL.BG;
  ctx.fillRect(0, 0, TL.w, TL.h);

  TL.hitRegions = [];

  _tlDrawRuler(ctx);
  _tlDrawSeparators(ctx);
  _tlDrawSlides(ctx);
  _tlDrawTransitions(ctx);
  _tlDrawSubtitles(ctx);
  _tlDrawVoiceClips(ctx);
  _tlDrawSfx(ctx);
  _tlDrawBgm(ctx);
  _tlDrawDropHighlight(ctx);
  _tlDrawPlayhead(ctx);
}

// ─── Ruler ───
function _tlDrawRuler(ctx) {
  ctx.fillStyle = TL.RULER_BG;
  ctx.fillRect(0, 0, TL.w, TL.rulerH);
  // bottom border
  ctx.fillStyle = TL.SLIDE_BORDER;
  ctx.fillRect(0, TL.rulerH - 1, TL.w, 1);

  const total = getTotalDuration() || 1;
  const interval = total <= 10 ? 1 : total <= 30 ? 2 : total <= 60 ? 5 : 10;

  ctx.font = '8px monospace';
  ctx.fillStyle = TL.RULER_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let s = 0; s <= total; s += interval) {
    const x = (s / total) * TL.w;
    ctx.fillText(_fmtDur(s), x, 4);
    // tick
    ctx.fillStyle = TL.RULER_LINE;
    ctx.fillRect(x, TL.rulerH - 5, 1, 4);
    ctx.fillStyle = TL.RULER_TEXT;
  }
}

// ─── Separators ───
function _tlDrawSeparators(ctx) {
  ctx.fillStyle = TL.SEP;
  for (let i = 1; i < TL.trackY.length; i++) {
    ctx.fillRect(0, TL.trackY[i], TL.w, 1);
  }
}

// ─── Slides Track ───
function _tlDrawSlides(ctx) {
  const slides = getOrderedSlides();
  if (slides.length === 0) return;
  const totalDur = getTotalDuration() || 1;
  const y = TL.trackY[0];
  const h = TL.trackH[0];
  const pad = 2;

  let cumTime = 0;
  slides.forEach((sl, idx) => {
    const dur = getSlideDuration(sl.num);
    const x = Math.round((cumTime / totalDur) * TL.w);
    const w = Math.round((dur / totalDur) * TL.w);
    const blockX = x + 1;
    const blockY = y + pad;
    const blockW = Math.max(w - 2, 4);
    const blockH = h - pad * 2;

    const isActive = idx === selectedSlide;

    // block background
    ctx.fillStyle = TL.SLIDE_BG;
    _tlRoundRect(ctx, blockX, blockY, blockW, blockH, 4);
    ctx.fill();

    // thumbnail
    const thumb = TL.thumbCache[sl.num];
    if (thumb && thumb.complete && thumb.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      _tlRoundRect(ctx, blockX, blockY, blockW, blockH, 4);
      ctx.clip();
      // cover fit
      const imgAspect = thumb.naturalWidth / thumb.naturalHeight;
      const boxAspect = blockW / blockH;
      let sx = 0, sy = 0, sw = thumb.naturalWidth, sh = thumb.naturalHeight;
      if (imgAspect > boxAspect) {
        sw = Math.round(sh * boxAspect);
        sx = Math.round((thumb.naturalWidth - sw) / 2);
      } else {
        sh = Math.round(sw / boxAspect);
        sy = Math.round((thumb.naturalHeight - sh) / 2);
      }
      ctx.globalAlpha = 0.7;
      ctx.drawImage(thumb, sx, sy, sw, sh, blockX, blockY, blockW, blockH);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // border
    ctx.strokeStyle = isActive ? TL.SLIDE_ACTIVE_BORDER : TL.SLIDE_BORDER;
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.beginPath();
    _tlRoundRect(ctx, blockX, blockY, blockW, blockH, 4);
    ctx.stroke();

    // type color bar (top 3px)
    const typeColor = TL.TYPE_COLORS[sl.bg_type] || '#3b82f6';
    ctx.fillStyle = typeColor;
    ctx.fillRect(blockX, blockY, blockW, 3);

    // slide number (top-left)
    if (blockW > 30) {
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(String(sl.num), blockX + 5, blockY + 6);
      ctx.shadowBlur = 0;

      // type label
      const typeLabel = TL.TYPE_LABELS[sl.bg_type] || sl.bg_type;
      ctx.fillStyle = typeColor;
      ctx.font = 'bold 7px sans-serif';
      const numW = _tlMeasureText(ctx, String(sl.num), 'bold 9px sans-serif');
      ctx.fillText(typeLabel, blockX + 5 + numW + 4, blockY + 7);
    }

    // narr duration badge
    const slideAudioFiles = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
    const narrDur = slideAudioFiles.reduce((s, a) => s + (a.duration || 0), 0);
    if (narrDur > 0 && blockW > 60) {
      const badgeText = '\u266B ' + narrDur.toFixed(1) + 's';
      ctx.font = '8px sans-serif';
      const bw = _tlMeasureText(ctx, badgeText, '8px sans-serif') + 6;
      const bx = blockX + 5 + _tlMeasureText(ctx, String(sl.num), 'bold 9px sans-serif') + 4 +
                 _tlMeasureText(ctx, TL.TYPE_LABELS[sl.bg_type] || sl.bg_type || '', 'bold 7px sans-serif') + 6;
      ctx.fillStyle = '#064e3b';
      _tlRoundRect(ctx, bx, blockY + 5, bw, 12, 2);
      ctx.fill();
      ctx.fillStyle = '#34d399';
      ctx.textBaseline = 'top';
      ctx.fillText(badgeText, bx + 3, blockY + 6);
    }

    // bottom gradient
    const grad = ctx.createLinearGradient(0, blockY + blockH - 18, 0, blockY + blockH);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    _tlRoundRect(ctx, blockX, blockY + blockH - 18, blockW, 18, 0);
    ctx.fill();

    // duration (bottom-right)
    if (blockW > 35) {
      ctx.font = '8px monospace';
      ctx.fillStyle = '#9ca3af';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(dur.toFixed(1) + 's', blockX + blockW - 5, blockY + blockH - 3);
    }

    // motion badge (bottom-left)
    const hasBg = !!sl.bg_url;
    const isVideo = hasBg && (sl.bg_url.includes('.mp4') || sl.bg_url.includes('.gif'));
    if (!isVideo && sl.bg_type !== 'closing' && blockW > 50) {
      const motion = _getSlideMotion(sl.num);
      const motionLabel = MOTION_LABELS[motion] || motion;
      ctx.font = 'bold 7px sans-serif';
      const mw = _tlMeasureText(ctx, motionLabel, 'bold 7px sans-serif') + 8;
      ctx.fillStyle = 'rgba(16,185,129,0.15)';
      _tlRoundRect(ctx, blockX + 4, blockY + blockH - 15, mw, 12, 3);
      ctx.fill();
      ctx.fillStyle = '#34d399';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(motionLabel, blockX + 8, blockY + blockH - 9);
      // hit region for motion badge
      TL.hitRegions.push({ type: 'motion_badge', rect: { x: blockX + 4, y: blockY + blockH - 15, w: mw, h: 12 }, data: { slideNum: sl.num, idx } });
    }

    // hit region for slide block
    TL.hitRegions.push({ type: 'slide', rect: { x: blockX, y: blockY, w: blockW, h: blockH }, data: { slideNum: sl.num, idx, dur } });
    // hit region for resize (right 12px)
    TL.hitRegions.push({ type: 'slide_resize', rect: { x: blockX + blockW - 12, y: blockY, w: 12, h: blockH }, data: { slideNum: sl.num, idx } });

    cumTime += dur;
  });
}

// ─── Transitions Track ───
function _tlDrawTransitions(ctx) {
  const slides = getOrderedSlides();
  if (slides.length < 2) return;
  const totalDur = getTotalDuration() || 1;
  const y = TL.trackY[1];
  const h = TL.trackH[1];
  const btnW = 24;

  let cumTime = 0;
  slides.forEach((sl, idx) => {
    const dur = getSlideDuration(sl.num);
    if (idx > 0) {
      const prevSl = slides[idx - 1];
      const tr = _getTransition(prevSl.num, sl.num);
      const hasTr = tr.duration > 0;
      const x = Math.round((cumTime / totalDur) * TL.w) - btnW / 2;
      const by = y + 2;
      const bh = h - 4;

      ctx.fillStyle = hasTr ? TL.TR_ACTIVE : TL.TR_BG;
      _tlRoundRect(ctx, x, by, btnW, bh, 3);
      ctx.fill();
      ctx.strokeStyle = hasTr ? TL.TR_ACTIVE_BORDER : TL.TR_BORDER;
      ctx.lineWidth = 1;
      ctx.beginPath();
      _tlRoundRect(ctx, x, by, btnW, bh, 3);
      ctx.stroke();

      if (hasTr) {
        const label = tr.effect.replace('wipeleft', '\u2190').replace('wiperight', '\u2192')
          .replace('fade', 'F').replace('dissolve', 'D').replace('none', '-');
        ctx.font = '7px sans-serif';
        ctx.fillStyle = '#a5b4fc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + btnW / 2, by + bh / 2);
      } else {
        ctx.font = '10px sans-serif';
        ctx.fillStyle = '#4b5563';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', x + btnW / 2, by + bh / 2);
      }

      TL.hitRegions.push({ type: 'transition', rect: { x, y: by, w: btnW, h: bh }, data: { fromNum: prevSl.num, toNum: sl.num, idx, hasTr } });
    }
    cumTime += dur;
  });
}

// ─── Subtitles Track ───
function _tlDrawSubtitles(ctx) {
  const entries = composeState.subtitle_entries || [];
  const total = getTotalDuration() || 1;
  const y = TL.trackY[2];
  const h = TL.trackH[2];
  const pad = 2;

  if (entries.length === 0) {
    ctx.font = '8px sans-serif';
    ctx.fillStyle = '#4b5563';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\uC790\uB9C9 \uC5C6\uC74C', TL.w / 2, y + h / 2);
    return;
  }

  entries.forEach((entry, ei) => {
    const x = Math.round((entry.start_time / total) * TL.w);
    const w = Math.max(Math.round(((entry.end_time - entry.start_time) / total) * TL.w), 8);
    const by = y + pad;
    const bh = h - pad * 2;

    ctx.fillStyle = TL.SUB_BG;
    _tlRoundRect(ctx, x, by, w, bh, 3);
    ctx.fill();
    ctx.strokeStyle = TL.SUB_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    _tlRoundRect(ctx, x, by, w, bh, 3);
    ctx.stroke();

    // label
    if (w > 20) {
      const truncated = entry.text.length > 15 ? entry.text.slice(0, 15) + '..' : entry.text;
      ctx.font = 'bold 8px sans-serif';
      ctx.fillStyle = TL.SUB_LABEL;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 4, by, w - 8, bh);
      ctx.clip();
      ctx.fillText(truncated, x + 4, by + bh / 2);
      ctx.restore();
    }

    // handles
    const handleW = 5;
    TL.hitRegions.push({ type: 'sub_handle_l', rect: { x: x, y: by, w: handleW, h: bh }, data: { entry, ei } });
    TL.hitRegions.push({ type: 'sub_handle_r', rect: { x: x + w - handleW, y: by, w: handleW, h: bh }, data: { entry, ei } });
    TL.hitRegions.push({ type: 'subtitle', rect: { x, y: by, w, h: bh }, data: { entry, ei } });
  });
}

// ─── Voice Clips Track ───
function _tlDrawVoiceClips(ctx) {
  const clips = composeState.voice_clips || [];
  const total = getTotalDuration() || 1;
  const y = TL.trackY[3];
  const h = TL.trackH[3];
  const pad = 2;

  clips.forEach((clip, ci) => {
    const x = Math.round((clip.start_time / total) * TL.w);
    const w = Math.max(Math.round((clip.duration / total) * TL.w), 8);
    const by = y + pad;
    const bh = h - pad * 2;

    ctx.fillStyle = TL.NARR_BG;
    _tlRoundRect(ctx, x, by, w, bh, 3);
    ctx.fill();
    ctx.strokeStyle = TL.NARR_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    _tlRoundRect(ctx, x, by, w, bh, 3);
    ctx.stroke();

    if (w > 20) {
      const name = clip.file.replace(/\.[^.]+$/, '');
      const label = name + ' ' + clip.duration.toFixed(1) + 's';
      ctx.font = 'bold 8px sans-serif';
      ctx.fillStyle = TL.NARR_LABEL;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 4, by, w - 8, bh);
      ctx.clip();
      ctx.fillText('\uD83C\uDFA4 ' + label, x + 4, by + bh / 2);
      ctx.restore();
    }

    TL.hitRegions.push({ type: 'voice_clip', rect: { x, y: by, w, h: bh }, data: { clip, ci } });
  });
}

// ─── SFX Track ───
function _tlDrawSfx(ctx) {
  const markers = composeState.sfx_markers || [];
  const total = getTotalDuration() || 1;
  const y = TL.trackY[4];
  const h = TL.trackH[4];
  const pad = 2;

  markers.forEach((m, mi) => {
    const sfxInfo = (composerData.sfx_list || []).find(s => s.file === m.file);
    const sfxFullDur = sfxInfo ? sfxInfo.duration : 1;
    const sfxDur = m.duration !== undefined ? m.duration : sfxFullDur;
    const x = Math.round((m.time / total) * TL.w);
    const w = Math.max(Math.round((sfxDur / total) * TL.w), 8);
    const by = y + pad;
    const bh = h - pad * 2;

    ctx.fillStyle = TL.SFX_BG;
    _tlRoundRect(ctx, x, by, w, bh, 3);
    ctx.fill();
    ctx.strokeStyle = TL.SFX_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    _tlRoundRect(ctx, x, by, w, bh, 3);
    ctx.stroke();

    if (w > 16) {
      const name = m.file.replace(/\.[^.]+$/, '');
      ctx.font = 'bold 8px sans-serif';
      ctx.fillStyle = TL.SFX_LABEL;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, by, w - 4, bh);
      ctx.clip();
      ctx.fillText('\uD83D\uDD0A ' + name, x + 4, by + bh / 2);
      ctx.restore();
    }

    // handles + body
    const handleW = 5;
    TL.hitRegions.push({ type: 'sfx_handle_l', rect: { x, y: by, w: handleW, h: bh }, data: { marker: m, mi, sfxDur } });
    TL.hitRegions.push({ type: 'sfx_handle_r', rect: { x: x + w - handleW, y: by, w: handleW, h: bh }, data: { marker: m, mi, sfxDur } });
    TL.hitRegions.push({ type: 'sfx', rect: { x, y: by, w, h: bh }, data: { marker: m, mi } });
  });
}

// ─── BGM Track ───
function _tlDrawBgm(ctx) {
  const bgm = composeState.bgm;
  if (!bgm || !bgm.file) return;
  const total = getTotalDuration() || 1;
  const y = TL.trackY[5];
  const h = TL.trackH[5];
  const pad = 2;

  const x = Math.round((bgm.start_time / total) * TL.w);
  const endX = Math.round((bgm.end_time / total) * TL.w);
  const w = Math.max(endX - x, 8);
  const by = y + pad;
  const bh = h - pad * 2;

  ctx.fillStyle = TL.BGM_BG;
  _tlRoundRect(ctx, x, by, w, bh, 3);
  ctx.fill();

  // fade in gradient
  const fi = bgm.fade_in || 0;
  if (fi > 0) {
    const fiW = Math.min(Math.round((fi / (bgm.end_time - bgm.start_time)) * w), w / 2);
    const grad = ctx.createLinearGradient(x, 0, x + fiW, 0);
    grad.addColorStop(0, 'rgba(26,28,36,0.8)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(x, by, fiW, bh);
  }

  // fade out gradient
  const fo = bgm.fade_out || 0;
  if (fo > 0) {
    const foW = Math.min(Math.round((fo / (bgm.end_time - bgm.start_time)) * w), w / 2);
    const grad = ctx.createLinearGradient(x + w - foW, 0, x + w, 0);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(1, 'rgba(26,28,36,0.8)');
    ctx.fillStyle = grad;
    ctx.fillRect(x + w - foW, by, foW, bh);
  }

  ctx.strokeStyle = TL.BGM_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  _tlRoundRect(ctx, x, by, w, bh, 3);
  ctx.stroke();

  // label
  if (w > 30) {
    const name = bgm.file.replace(/\.[^.]+$/, '');
    ctx.font = 'bold 8px sans-serif';
    ctx.fillStyle = TL.BGM_LABEL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 4, by, w - 8, bh);
    ctx.clip();
    ctx.fillText('\u266B ' + name, x + 6, by + bh / 2);
    ctx.restore();
  }

  const handleW = 6;
  TL.hitRegions.push({ type: 'bgm_handle_l', rect: { x, y: by, w: handleW, h: bh }, data: {} });
  TL.hitRegions.push({ type: 'bgm_handle_r', rect: { x: x + w - handleW, y: by, w: handleW, h: bh }, data: {} });
  TL.hitRegions.push({ type: 'bgm', rect: { x, y: by, w, h: bh }, data: {} });
}

// ─── Drop Highlight ───
function _tlDrawDropHighlight(ctx) {
  if (!TL.dropTrack) return;
  const trackIdx = TL.dropTrack === 'sfx' ? 4 : 3;
  const y = TL.trackY[trackIdx];
  const h = TL.trackH[trackIdx];
  ctx.fillStyle = TL.dropTrack === 'sfx' ? 'rgba(99,102,241,0.08)' : 'rgba(20,184,166,0.08)';
  ctx.fillRect(0, y, TL.w, h);
}

// ─── Playhead ───
function _tlDrawPlayhead(ctx) {
  const x = Math.round(_playheadPos * TL.w);
  ctx.fillStyle = TL.PLAYHEAD;
  ctx.fillRect(x - 1, 0, 2, TL.h);

  // triangle at top
  ctx.beginPath();
  ctx.moveTo(x - 6, 0);
  ctx.lineTo(x + 6, 0);
  ctx.lineTo(x, 8);
  ctx.closePath();
  ctx.fill();
}

// ─── Thumb preload ───
function _tlPreloadThumbs() {
  const slides = composerData?.slides || [];
  slides.forEach(sl => {
    if (sl.bg_url && !TL.thumbCache[sl.num] && !TL.thumbLoading.has(sl.num) &&
        !sl.bg_url.includes('.mp4') && !sl.bg_url.includes('.gif')) {
      TL.thumbLoading.add(sl.num);
      const img = new Image();
      img.onload = () => {
        TL.thumbCache[sl.num] = img;
        TL.thumbLoading.delete(sl.num);
        TL.needsRedraw = true;
      };
      img.onerror = () => { TL.thumbLoading.delete(sl.num); };
      img.src = sl.bg_url;
    }
  });
}

// ─── Hit test ───
function _tlHitTest(mx, my) {
  // search in reverse order (last drawn = on top)
  for (let i = TL.hitRegions.length - 1; i >= 0; i--) {
    const r = TL.hitRegions[i];
    const { x, y, w, h } = r.rect;
    if (mx >= x && mx <= x + w && my >= y && my <= y + h) return r;
  }
  return null;
}

// ─── Mouse Events ───
function _tlCanvasXY(e) {
  const rect = TL.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function _tlOnMouseDown(e) {
  const { x, y } = _tlCanvasXY(e);
  const hit = _tlHitTest(x, y);

  // Motion badge click
  if (hit && hit.type === 'motion_badge') {
    e.preventDefault(); e.stopPropagation();
    _showMotionDropdownCanvas(e.clientX, e.clientY, hit.data.slideNum);
    return;
  }

  // Transition click
  if (hit && hit.type === 'transition') {
    e.preventDefault(); e.stopPropagation();
    _selectedTrPair = { from: hit.data.fromNum, to: hit.data.toNum };
    selectSlide(hit.data.idx);
    switchTab('transition');
    return;
  }

  // Slide resize
  if (hit && hit.type === 'slide_resize') {
    e.preventDefault(); e.stopPropagation();
    _tlStartSlideResize(e, hit.data.slideNum);
    return;
  }

  // Slide select + drag
  if (hit && hit.type === 'slide') {
    e.preventDefault(); e.stopPropagation();
    selectSlide(hit.data.idx);
    _tlStartSlideDrag(e, hit.data.idx);
    return;
  }

  // Subtitle handle left
  if (hit && hit.type === 'sub_handle_l') {
    e.preventDefault(); e.stopPropagation();
    _tlStartSubHandleDrag(e, hit.data.entry, 'left');
    return;
  }
  // Subtitle handle right
  if (hit && hit.type === 'sub_handle_r') {
    e.preventDefault(); e.stopPropagation();
    _tlStartSubHandleDrag(e, hit.data.entry, 'right');
    return;
  }
  // Subtitle body drag
  if (hit && hit.type === 'subtitle') {
    e.preventDefault(); e.stopPropagation();
    _tlStartSubDrag(e, hit.data.entry);
    return;
  }

  // Voice clip drag
  if (hit && hit.type === 'voice_clip') {
    e.preventDefault(); e.stopPropagation();
    _tlStartVoiceClipDrag(e, hit.data.clip);
    return;
  }

  // SFX handle left
  if (hit && hit.type === 'sfx_handle_l') {
    e.preventDefault(); e.stopPropagation();
    _tlStartSfxHandleDrag(e, hit.data.marker, 'left', hit.data.sfxDur);
    return;
  }
  // SFX handle right
  if (hit && hit.type === 'sfx_handle_r') {
    e.preventDefault(); e.stopPropagation();
    _tlStartSfxHandleDrag(e, hit.data.marker, 'right', hit.data.sfxDur);
    return;
  }
  // SFX body drag
  if (hit && hit.type === 'sfx') {
    e.preventDefault(); e.stopPropagation();
    _tlStartSfxDrag(e, hit.data.marker);
    return;
  }

  // BGM handle left
  if (hit && hit.type === 'bgm_handle_l') {
    e.preventDefault(); e.stopPropagation();
    _tlStartBgmHandleDrag(e, 'left');
    return;
  }
  // BGM handle right
  if (hit && hit.type === 'bgm_handle_r') {
    e.preventDefault(); e.stopPropagation();
    _tlStartBgmHandleDrag(e, 'right');
    return;
  }
  // BGM body drag
  if (hit && hit.type === 'bgm') {
    e.preventDefault(); e.stopPropagation();
    _tlStartBgmDrag(e);
    return;
  }

  // Playhead click (fall through — click on empty area)
  _tlStartPlayheadDrag(e);
}

function _tlOnMouseMove(e) {
  const { x, y } = _tlCanvasXY(e);
  const hit = _tlHitTest(x, y);

  if (hit && (hit.type === 'slide_resize' || hit.type === 'sfx_handle_l' || hit.type === 'sfx_handle_r' ||
              hit.type === 'sub_handle_l' || hit.type === 'sub_handle_r' ||
              hit.type === 'bgm_handle_l' || hit.type === 'bgm_handle_r')) {
    TL.canvas.style.cursor = 'ew-resize';
  } else if (hit && (hit.type === 'slide' || hit.type === 'sfx' || hit.type === 'voice_clip' || hit.type === 'subtitle' || hit.type === 'bgm')) {
    TL.canvas.style.cursor = 'grab';
  } else if (hit && (hit.type === 'transition' || hit.type === 'motion_badge')) {
    TL.canvas.style.cursor = 'pointer';
  } else {
    TL.canvas.style.cursor = 'pointer';
  }
}

function _tlOnDblClick(e) {
  const { x, y } = _tlCanvasXY(e);
  const hit = _tlHitTest(x, y);

  if (hit && hit.type === 'subtitle') {
    e.stopPropagation();
    const entry = hit.data.entry;
    const newText = prompt('\uC790\uB9C9 \uD14D\uC2A4\uD2B8:', entry.text);
    if (newText !== null && newText.trim()) {
      entry.text = newText.trim();
      _dirty = true;
      TL.needsRedraw = true;
      if (_activeTab === 'narration') renderTabNarration();
    }
    return;
  }

  if (hit && hit.type === 'voice_clip') {
    e.stopPropagation();
    composeState.voice_clips = composeState.voice_clips.filter(c => c.id !== hit.data.clip.id);
    _dirty = true;
    TL.needsRedraw = true;
    if (_activeTab === 'narration') renderTabNarration();
    return;
  }

  if (hit && hit.type === 'sfx') {
    e.stopPropagation();
    composeState.sfx_markers = composeState.sfx_markers.filter(x => x.id !== hit.data.marker.id);
    _dirty = true;
    TL.needsRedraw = true;
    renderTabSfx();
    return;
  }

  if (hit && hit.type === 'bgm') {
    e.stopPropagation();
    removeBgm();
    return;
  }
}

function _tlOnContextMenu(e) {
  const { x, y } = _tlCanvasXY(e);
  const hit = _tlHitTest(x, y);
  if (hit && hit.type === 'transition' && hit.data.hasTr) {
    e.preventDefault();
    setTransitionPair(hit.data.fromNum, hit.data.toNum, 'effect', 'none');
    setTransitionPair(hit.data.fromNum, hit.data.toNum, 'duration', 0);
    TL.needsRedraw = true;
    if (_activeTab === 'transition') renderTabTransition();
  }
}

// ─── Drag helpers ───

function _tlPosFromEvent(e) {
  const rect = TL.canvas.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / TL.w));
}

function _tlStartPlayheadDrag(e) {
  _playheadPos = _tlPosFromEvent(e);
  _isDraggingPlayhead = true;
  TL.needsRedraw = true;

  if (_previewing) {
    const total = getTotalDuration() || 1;
    _previewStartTime = performance.now() - _playheadPos * total * 1000;
    _previewAudioPlayed = new Set();
    _previewSlideIdx = -1;
    if (_playingAudio) { _playingAudio.pause(); _playingAudio = null; }
  } else {
    _tlSelectSlideAtPlayhead();
  }

  function onMove(ev) {
    _playheadPos = _tlPosFromEvent(ev);
    TL.needsRedraw = true;
    if (_previewing) {
      const total = getTotalDuration() || 1;
      _previewStartTime = performance.now() - _playheadPos * total * 1000;
      _previewAudioPlayed = new Set();
      _previewSlideIdx = -1;
      if (_playingAudio) { _playingAudio.pause(); _playingAudio = null; }
    } else {
      _tlSelectSlideAtPlayhead();
    }
  }
  function onUp() {
    _isDraggingPlayhead = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlSelectSlideAtPlayhead() {
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

function _tlStartSlideDrag(e, fromIdx) {
  const startX = e.clientX;
  let moved = false;
  let insertIdx = -1;

  function onMove(ev) {
    if (Math.abs(ev.clientX - startX) > 8) moved = true;
    if (!moved) return;
    document.body.style.cursor = 'grabbing';

    // find insert position
    const pos = _tlPosFromEvent(ev);
    const total = getTotalDuration() || 1;
    const t = pos * total;
    const slides = getOrderedSlides();
    let cum = 0;
    insertIdx = slides.length;
    for (let i = 0; i < slides.length; i++) {
      const dur = getSlideDuration(slides[i].num);
      if (t < cum + dur / 2) { insertIdx = i; break; }
      cum += dur;
    }
    TL.needsRedraw = true;
  }

  function onUp(ev) {
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) return;

    if (insertIdx >= 0 && insertIdx !== fromIdx) {
      const order = [...composeState.slide_order];
      const [item] = order.splice(fromIdx, 1);
      const toIdx = insertIdx > fromIdx ? insertIdx - 1 : insertIdx;
      order.splice(toIdx, 0, item);
      composeState.slide_order = order;
      _dirty = true;
      selectedSlide = toIdx;
      _recalcClipPositions();
      TL.needsRedraw = true;
      renderPreview();
    }
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlStartSlideResize(e, slideNum) {
  const totalDur = getTotalDuration() || 1;
  const pxPerSec = TL.w / totalDur;
  const startX = e.clientX;
  const startDur = getSlideDuration(slideNum);
  document.body.style.cursor = 'ew-resize';

  const tooltip = document.createElement('div');
  tooltip.style.cssText = 'position:fixed;padding:2px 6px;background:#1e1e2e;color:#34d399;font-size:11px;border-radius:4px;z-index:9999;pointer-events:none;border:1px solid #374151;';
  tooltip.textContent = startDur.toFixed(1) + 's';
  tooltip.style.left = e.clientX + 'px';
  tooltip.style.top = (e.clientY - 28) + 'px';
  document.body.appendChild(tooltip);

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dSec = dx / pxPerSec;
    const newDur = Math.max(1, Math.round((startDur + dSec) * 10) / 10);
    updateSlideDuration(slideNum, newDur);
    tooltip.textContent = newDur.toFixed(1) + 's';
    tooltip.style.left = ev.clientX + 'px';
    tooltip.style.top = (ev.clientY - 28) + 'px';
  }
  function onUp() {
    document.body.style.cursor = '';
    tooltip.remove();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlStartSubHandleDrag(e, entry, side) {
  const total = getTotalDuration() || 1;
  function onMove(ev) {
    const pct = _tlPosFromEvent(ev);
    const newTime = Math.round(pct * total * 10) / 10;
    if (side === 'left' && newTime < entry.end_time - 0.2) {
      entry.start_time = newTime;
      _dirty = true;
      TL.needsRedraw = true;
    } else if (side === 'right' && newTime > entry.start_time + 0.2) {
      entry.end_time = newTime;
      _dirty = true;
      TL.needsRedraw = true;
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlStartSubDrag(e, entry) {
  const total = getTotalDuration() || 1;
  const startMouseX = e.clientX;
  const origStart = entry.start_time;
  const origEnd = entry.end_time;
  const dur = origEnd - origStart;
  function onMove(ev) {
    const dx = ev.clientX - startMouseX;
    const dSec = (dx / TL.w) * total;
    let newStart = origStart + dSec;
    newStart = Math.max(0, Math.min(total - dur, newStart));
    entry.start_time = Math.round(newStart * 10) / 10;
    entry.end_time = Math.round((newStart + dur) * 10) / 10;
    _dirty = true;
    TL.needsRedraw = true;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlStartVoiceClipDrag(e, clip) {
  const total = getTotalDuration() || 1;
  const startMouseX = e.clientX;
  const origStart = clip.start_time;
  function onMove(ev) {
    const dx = ev.clientX - startMouseX;
    const dSec = (dx / TL.w) * total;
    let newStart = origStart + dSec;
    newStart = Math.max(0, Math.min(total - clip.duration, newStart));
    clip.start_time = Math.round(newStart * 10) / 10;
    _dirty = true;
    TL.needsRedraw = true;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (_activeTab === 'narration') renderTabNarration();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlStartSfxHandleDrag(e, marker, side, origDur) {
  const total = getTotalDuration() || 1;
  const origTime = marker.time;
  function onMove(ev) {
    const pct = _tlPosFromEvent(ev);
    const newTime = pct * total;
    if (side === 'left') {
      if (newTime < origTime + origDur - 0.2) {
        const delta = newTime - origTime;
        marker.time = Math.round(newTime * 10) / 10;
        marker.duration = Math.round(Math.max(0.2, origDur - delta) * 10) / 10;
        _dirty = true;
        TL.needsRedraw = true;
      }
    } else {
      const newDur = newTime - marker.time;
      if (newDur >= 0.2) {
        marker.duration = Math.round(newDur * 10) / 10;
        _dirty = true;
        TL.needsRedraw = true;
      }
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    renderTabSfx();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlStartSfxDrag(e, marker) {
  const total = getTotalDuration() || 1;
  const startMouseX = e.clientX;
  const origTime = marker.time;
  function onMove(ev) {
    const dx = ev.clientX - startMouseX;
    const dSec = (dx / TL.w) * total;
    marker.time = Math.round(Math.max(0, origTime + dSec) * 10) / 10;
    _dirty = true;
    TL.needsRedraw = true;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlStartBgmHandleDrag(e, side) {
  const bgm = composeState.bgm;
  if (!bgm) return;
  const total = getTotalDuration() || 1;
  function onMove(ev) {
    const pct = _tlPosFromEvent(ev);
    const t = Math.round(pct * total * 10) / 10;
    if (side === 'left' && t < bgm.end_time - 0.5) {
      bgm.start_time = t;
      _dirty = true;
      TL.needsRedraw = true;
    } else if (side === 'right' && t > bgm.start_time + 0.5) {
      bgm.end_time = t;
      _dirty = true;
      TL.needsRedraw = true;
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    renderTabBgm();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _tlStartBgmDrag(e) {
  const bgm = composeState.bgm;
  if (!bgm) return;
  const total = getTotalDuration() || 1;
  const dur = bgm.end_time - bgm.start_time;
  const startPct = _tlPosFromEvent(e);
  const origStart = bgm.start_time;
  function onMove(ev) {
    const pctNow = _tlPosFromEvent(ev);
    const delta = (pctNow - startPct) * total;
    let ns = Math.max(0, Math.min(total - dur, origStart + delta));
    bgm.start_time = Math.round(ns * 10) / 10;
    bgm.end_time = Math.round((ns + dur) * 10) / 10;
    _dirty = true;
    TL.needsRedraw = true;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    renderTabBgm();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Drop handlers ───
function _tlHandleSfxDrop(e) {
  const file = e.dataTransfer.getData('sfx_file');
  if (!file) return;
  const total = getTotalDuration();
  const pct = _tlPosFromEvent(e);
  const time = pct * total;
  composeState.sfx_markers.push({
    id: 's_' + Date.now(),
    file,
    time: Math.round(time * 10) / 10,
    volume: 0.8,
  });
  _dirty = true;
  TL.needsRedraw = true;
}

function _tlHandleNarrDrop(e) {
  const file = e.dataTransfer.getData('narr_file');
  if (!file) return;
  const duration = parseFloat(e.dataTransfer.getData('narr_duration')) || 2.0;
  const url = e.dataTransfer.getData('narr_url') || '';
  const total = getTotalDuration();
  const pct = _tlPosFromEvent(e);
  const time = pct * total;
  composeState.voice_clips.push({
    id: 'vc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    file,
    path: url,
    start_time: Math.round(time * 10) / 10,
    duration,
    volume: composeState.narr_volume !== undefined ? composeState.narr_volume : 100,
  });
  _dirty = true;
  TL.needsRedraw = true;
  if (_activeTab === 'narration') renderTabNarration();
}

// ─── Motion dropdown (canvas coordinates → absolute DOM popup) ───
function _showMotionDropdownCanvas(clientX, clientY, slideNum) {
  // Reuse existing _showMotionDropdown with a virtual element
  const fakeEl = document.createElement('span');
  fakeEl.style.cssText = 'position:fixed;left:' + clientX + 'px;top:' + clientY + 'px;width:1px;height:1px;';
  fakeEl.dataset.slide = slideNum;
  document.body.appendChild(fakeEl);
  _showMotionDropdown(fakeEl, slideNum);
  setTimeout(() => fakeEl.remove(), 100);
}

// ─── Utility ───
function _tlRoundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function _tlMeasureText(ctx, text, font) {
  const key = font + '|' + text;
  if (TL.textWidthCache[key] !== undefined) return TL.textWidthCache[key];
  ctx.font = font;
  const w = ctx.measureText(text).width;
  TL.textWidthCache[key] = w;
  return w;
}

// ══════════════════════════════════════════════════════════
// ─── END TL Canvas ───
// ══════════════════════════════════════════════════════════

// ─── Motion 추천 (bg_type 기반) ───
const MOTION_RECOMMEND = {
  photo: "zoom_in", broll: "pan_right", graph: "zoom_out",
  logo: "zoom_in", closing: "none"
};
const MOTION_LABELS = {
  none:"정적", random:"랜덤", zoom_in:"줌인", zoom_out:"줌아웃",
  pan_right:"우패닝", pan_left:"좌패닝", shake:"흩뿌리기",
  pulse:"펄스", rotate:"회전", blur_in:"블러인",
  bright_pulse:"밝기펄스", vignette:"비네팅", glitch:"글리치"
};

function _getSlideMotion(slideNum) {
  const motions = composeState.slide_motions || {};
  if (motions[slideNum]) return motions[slideNum];
  const sl = composerData.slides.find(s => s.num === slideNum);
  return MOTION_RECOMMEND[sl?.bg_type] || "zoom_in";
}

function setSlideMotion(slideNum, motion) {
  if (!composeState.slide_motions) composeState.slide_motions = {};
  composeState.slide_motions[slideNum] = motion;
  _dirty = true;
  renderTimeline();
}

// ─── Transition per-pair ───
function _trKey(fromNum, toNum) { return `${fromNum}>${toNum}`; }

function _getTransition(fromNum, toNum) {
  const perPair = composeState.transitions || {};
  const key = _trKey(fromNum, toNum);
  if (perPair[key]) return perPair[key];
  // 전체 일괄 폴백
  const global = composeState.transition || {};
  const chCfg = composerData?.channel_config || {};
  return {
    effect: global.effect || chCfg.crossfade_transition || "fade",
    duration: global.duration !== undefined ? global.duration : (chCfg.crossfade_duration ?? 0.5)
  };
}

function setTransitionPair(fromNum, toNum, key, val) {
  if (!composeState.transitions) composeState.transitions = {};
  const k = _trKey(fromNum, toNum);
  if (!composeState.transitions[k]) {
    composeState.transitions[k] = { ..._getTransition(fromNum, toNum) };
  }
  composeState.transitions[k][key] = val;
  _dirty = true;
}

// ─── 전환 다이아몬드 팝업 ───
let _activeTransitionPopup = null;

function _showTransitionPopup(diamond, fromNum, toNum) {
  _closeTransitionPopup();
  const tr = _getTransition(fromNum, toNum);
  const popup = document.createElement("div");
  popup.className = "tr-popup";
  popup.id = "tr-popup-active";

  const effects = [
    {id:"fade",l:"페이드"},{id:"dissolve",l:"디졸브"},
    {id:"wipeleft",l:"←와이프"},{id:"wiperight",l:"→와이프"},
    {id:"slideup",l:"↑슬라이드"},{id:"slidedown",l:"↓슬라이드"},
    {id:"circlecrop",l:"원형"},{id:"radial",l:"시계방향"},
    {id:"smoothleft",l:"←부드럽게"},{id:"smoothright",l:"→부드럽게"},
  ];

  let html = `<div class="tr-popup-title">전환 효과</div>`;
  html += `<div class="tr-popup-grid">`;
  effects.forEach(e => {
    const active = e.id === tr.effect ? "active" : "";
    html += `<button class="tr-popup-btn ${active}" onclick="event.stopPropagation(); _setTrEffect(${fromNum},${toNum},'${e.id}')">${e.l}</button>`;
  });
  html += `</div>`;
  html += `<div class="tr-popup-dur">
    <span>길이</span>
    <input type="range" min="0" max="1.5" step="0.1" value="${tr.duration}"
           oninput="event.stopPropagation(); _setTrDuration(${fromNum},${toNum},+this.value); this.nextElementSibling.textContent=this.value+'s';">
    <span>${tr.duration}s</span>
  </div>`;

  popup.innerHTML = html;
  popup.addEventListener("click", e => e.stopPropagation());
  popup.addEventListener("mousedown", e => e.stopPropagation());

  // 위치: 다이아몬드 아래
  const rect = diamond.getBoundingClientRect();
  const trackRect = document.getElementById("timeline-tracks").getBoundingClientRect();
  popup.style.left = (rect.left - trackRect.left + rect.width/2 - 100) + "px";
  popup.style.top = (rect.bottom - trackRect.top + 4) + "px";

  document.getElementById("timeline-tracks").appendChild(popup);
  _activeTransitionPopup = popup;

  // 바깥 클릭 닫기
  setTimeout(() => {
    document.addEventListener("click", _closeTransitionPopup, { once: true });
  }, 50);
}

function _closeTransitionPopup() {
  const p = document.getElementById("tr-popup-active");
  if (p) p.remove();
  _activeTransitionPopup = null;
}

function _setTrEffect(fromNum, toNum, effect) {
  setTransitionPair(fromNum, toNum, "effect", effect);
  // 팝업 갱신
  const diamond = document.querySelector(`.tr-diamond[data-from="${fromNum}"][data-to="${toNum}"]`);
  if (diamond) _showTransitionPopup(diamond, fromNum, toNum);
}

function _setTrDuration(fromNum, toNum, dur) {
  setTransitionPair(fromNum, toNum, "duration", dur);
}

// ─── 모션 드롭다운 ───
function _showMotionDropdown(badge, slideNum) {
  // 기존 드롭다운 제거
  document.querySelectorAll(".motion-dropdown").forEach(e => e.remove());

  const dd = document.createElement("div");
  dd.className = "motion-dropdown";
  const motions = ["none","zoom_in","zoom_out","pan_right","pan_left","shake","pulse","rotate","blur_in","bright_pulse","vignette","glitch","random"];
  const cur = _getSlideMotion(slideNum);
  motions.forEach(m => {
    const active = m === cur ? "active" : "";
    dd.innerHTML += `<button class="motion-dd-btn ${active}" onclick="event.stopPropagation(); setSlideMotion(${slideNum},'${m}')">${MOTION_LABELS[m]||m}</button>`;
  });

  dd.addEventListener("click", e => e.stopPropagation());
  dd.addEventListener("mousedown", e => e.stopPropagation());

  const rect = badge.getBoundingClientRect();
  const trackRect = document.getElementById("timeline-tracks").getBoundingClientRect();
  dd.style.left = (rect.left - trackRect.left) + "px";
  dd.style.top = (rect.bottom - trackRect.top + 2) + "px";

  document.getElementById("timeline-tracks").appendChild(dd);
  setTimeout(() => {
    document.addEventListener("click", () => {
      document.querySelectorAll(".motion-dropdown").forEach(e => e.remove());
    }, { once: true });
  }, 50);
}

function renderTimeline() {
  _tlPreloadThumbs();
  TL.textWidthCache = {};  // invalidate on data change
  TL.needsRedraw = true;
}

// ─── Slide Timeline (legacy stubs — now Canvas-based) ───
// _startSlideDragMove, _startSlideResize → handled in TL canvas event system

// renderTransitionTrack — now Canvas-based (TL._tlDrawTransitions)
function renderTransitionTrack() { TL.needsRedraw = true; }

// ─── Preview Transition Animation ───
let _transitionClone = null;

function _applyPreviewTransition(effect, duration, newSlideIdx) {
  const cc = document.getElementById("canvas-container");
  const sp = document.getElementById("slide-preview");
  if (!cc || !sp) { selectedSlide = newSlideIdx; renderPreview(); return; }

  // 기존 전환 정리
  if (_transitionClone) { _transitionClone.remove(); _transitionClone = null; }

  // 이전 슬라이드 복제
  const oldCanvas = sp.querySelector(".preview-canvas");
  if (!oldCanvas) { selectedSlide = newSlideIdx; renderPreview(); return; }

  _transitionClone = oldCanvas.cloneNode(true);
  Object.assign(_transitionClone.style, {
    position: "absolute", top: "0", left: "0",
    width: "100%", height: "100%",
    zIndex: "60", pointerEvents: "none"
  });

  // 새 슬라이드 렌더
  selectedSlide = newSlideIdx;
  renderPreview();

  // 이전 슬라이드를 위에 겹침
  cc.appendChild(_transitionClone);
  const newCanvas = sp.querySelector(".preview-canvas");

  const startTime = performance.now();
  const ms = Math.max(100, (duration || 0.5) * 1000);
  const animFn = _getPreviewTransitionFn(effect);

  function tick() {
    if (!_transitionClone) return;
    const p = Math.min((performance.now() - startTime) / ms, 1);
    const ep = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;  // easeInOutQuad
    animFn(_transitionClone, newCanvas, ep);
    if (p < 1) {
      requestAnimationFrame(tick);
    } else {
      _transitionClone.remove();
      _transitionClone = null;
      if (newCanvas) { newCanvas.style.transform = ""; newCanvas.style.opacity = ""; newCanvas.style.clipPath = ""; newCanvas.style.filter = ""; }
    }
  }
  requestAnimationFrame(tick);
}

function _cleanupTransitionClone() {
  if (_transitionClone) { _transitionClone.remove(); _transitionClone = null; }
}

function _getPreviewTransitionFn(effect) {
  const _fade = (o, n, p) => { o.style.opacity = 1 - p; };
  const M = {
    // 페이드
    fade: _fade, dissolve: _fade, fadefast: _fade, fadeslow: _fade, fadegrays: _fade,
    fadeblack: (o, n, p) => {
      if (p < 0.5) { o.style.filter = `brightness(${1 - p * 2})`; }
      else { o.style.opacity = 0; if (n) n.style.opacity = (p - 0.5) * 2; }
    },
    fadewhite: (o, n, p) => {
      if (p < 0.5) { o.style.filter = `brightness(${1 + p * 6})`; }
      else { o.style.opacity = 0; if (n) n.style.opacity = (p - 0.5) * 2; }
    },
    // 와이프
    wipeleft: (o, n, p) => { o.style.clipPath = `inset(0 ${p * 100}% 0 0)`; },
    wiperight: (o, n, p) => { o.style.clipPath = `inset(0 0 0 ${p * 100}%)`; },
    wipeup: (o, n, p) => { o.style.clipPath = `inset(0 0 ${p * 100}% 0)`; },
    wipedown: (o, n, p) => { o.style.clipPath = `inset(${p * 100}% 0 0 0)`; },
    wipetl: (o, n, p) => { o.style.clipPath = `polygon(${p*100}% 0,100% 0,100% 100%,0 100%,0 ${p*100}%)`; },
    wipetr: (o, n, p) => { o.style.clipPath = `polygon(0 0,${100-p*100}% 0,100% ${p*100}%,100% 100%,0 100%)`; },
    wipebl: (o, n, p) => { o.style.clipPath = `polygon(0 0,100% 0,100% ${100-p*100}%,${p*100}% 100%,0 100%)`; },
    wipebr: (o, n, p) => { o.style.clipPath = `polygon(0 0,100% 0,100% ${100-p*100}%,${100-p*100}% 100%,0 100%)`; },
    // 슬라이드
    slideleft: (o, n, p) => { o.style.transform = `translateX(${-p*100}%)`; if (n) n.style.transform = `translateX(${(1-p)*100}%)`; },
    slideright: (o, n, p) => { o.style.transform = `translateX(${p*100}%)`; if (n) n.style.transform = `translateX(${-(1-p)*100}%)`; },
    slideup: (o, n, p) => { o.style.transform = `translateY(${-p*100}%)`; if (n) n.style.transform = `translateY(${(1-p)*100}%)`; },
    slidedown: (o, n, p) => { o.style.transform = `translateY(${p*100}%)`; if (n) n.style.transform = `translateY(${-(1-p)*100}%)`; },
    smoothleft: (o, n, p) => { o.style.transform = `translateX(${-p*100}%)`; if (n) n.style.transform = `translateX(${(1-p)*100}%)`; },
    smoothright: (o, n, p) => { o.style.transform = `translateX(${p*100}%)`; if (n) n.style.transform = `translateX(${-(1-p)*100}%)`; },
    smoothup: (o, n, p) => { o.style.transform = `translateY(${-p*100}%)`; if (n) n.style.transform = `translateY(${(1-p)*100}%)`; },
    smoothdown: (o, n, p) => { o.style.transform = `translateY(${p*100}%)`; if (n) n.style.transform = `translateY(${-(1-p)*100}%)`; },
    // 커버
    coverleft: (o, n, p) => { if (n) n.style.transform = `translateX(${(1-p)*100}%)`; },
    coverright: (o, n, p) => { if (n) n.style.transform = `translateX(${-(1-p)*100}%)`; },
    coverup: (o, n, p) => { if (n) n.style.transform = `translateY(${(1-p)*100}%)`; },
    coverdown: (o, n, p) => { if (n) n.style.transform = `translateY(${-(1-p)*100}%)`; },
    // 리빌
    revealleft: (o, n, p) => { o.style.transform = `translateX(${-p*100}%)`; },
    revealright: (o, n, p) => { o.style.transform = `translateX(${p*100}%)`; },
    revealup: (o, n, p) => { o.style.transform = `translateY(${-p*100}%)`; },
    revealdown: (o, n, p) => { o.style.transform = `translateY(${p*100}%)`; },
    // 원형
    circleopen: (o, n, p) => { o.style.clipPath = `circle(${(1-p)*75}% at 50% 50%)`; },
    circleclose: (o, n, p) => { o.style.clipPath = `circle(${(1-p)*75}% at 50% 50%)`; },
    circlecrop: (o, n, p) => { o.style.clipPath = `circle(${(1-p)*75}% at 50% 50%)`; },
    radial: (o, n, p) => { o.style.clipPath = `circle(${(1-p)*75}% at 50% 50%)`; },
    // 도형
    rectcrop: (o, n, p) => { const i = p * 50; o.style.clipPath = `inset(${i}% ${i}% ${i}% ${i}%)`; },
    horzclose: (o, n, p) => { o.style.clipPath = `inset(0 ${p*50}%)`; },
    horzopen: (o, n, p) => { o.style.clipPath = `inset(0 ${(1-p)*50}%)`; },
    vertclose: (o, n, p) => { o.style.clipPath = `inset(${p*50}% 0)`; },
    vertopen: (o, n, p) => { o.style.clipPath = `inset(${(1-p)*50}% 0)`; },
    // 줌/압축
    zoomin: (o, n, p) => { o.style.transform = `scale(${1+p*0.5})`; o.style.opacity = 1 - p; },
    squeezeh: (o, n, p) => { o.style.transform = `scaleX(${1-p})`; },
    squeezev: (o, n, p) => { o.style.transform = `scaleY(${1-p})`; },
    // 대각선
    diagtl: (o, n, p) => { o.style.clipPath = `polygon(${p*200}% 0,100% 0,100% 100%,0 100%,0 ${p*200}%)`; },
    diagtr: (o, n, p) => { o.style.clipPath = `polygon(0 0,${100-p*200}% 0,100% ${p*200}%,100% 100%,0 100%)`; },
    diagbl: (o, n, p) => { o.style.clipPath = `polygon(0 0,100% 0,100% ${100-p*200}%,${p*200}% 100%,0 100%)`; },
    diagbr: (o, n, p) => { o.style.clipPath = `polygon(0 0,100% 0,100% ${100-p*200}%,${100-p*200}% 100%,0 100%)`; },
    // 슬라이스 (와이프 근사)
    hlslice: (o, n, p) => { o.style.clipPath = `inset(0 ${p*100}% 0 0)`; },
    hrslice: (o, n, p) => { o.style.clipPath = `inset(0 0 0 ${p*100}%)`; },
    vuslice: (o, n, p) => { o.style.clipPath = `inset(${p*100}% 0 0 0)`; },
    vdslice: (o, n, p) => { o.style.clipPath = `inset(0 0 ${p*100}% 0)`; },
    pixelize: _fade, distance: _fade,
  };
  return M[effect] || _fade;
}

// renderSubtitleTrack, renderVoiceClipTrack, renderRuler — now Canvas-based
function renderSubtitleTrack() { TL.needsRedraw = true; }
function renderVoiceClipTrack() { TL.needsRedraw = true; }
function renderRuler() { TL.needsRedraw = true; }

let _playheadPos = 0;
let _isDraggingPlayhead = false;

// updatePlayhead — now Canvas-based (TL._tlDrawPlayhead)
function updatePlayhead() { TL.needsRedraw = true; }
// onTimelineMouseDown — now Canvas-based (TL._tlOnMouseDown)
function onTimelineMouseDown(e) { /* no-op: Canvas handles events directly */ }

function selectSlide(idx) {
  selectedSlide = idx;
  TL.needsRedraw = true;
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

let CANVAS_W = 225, CANVAS_H = 400;
const REAL_W = 1080, REAL_H = 1920;
let SCALE = CANVAS_W / REAL_W;  // 동적 갱신됨

/** 실제 캔버스 DOM 크기 기준으로 SCALE 재계산 */
function _updateScale() {
  const el = document.getElementById("canvas-container");
  if (el && el.offsetWidth > 0) {
    CANVAS_W = el.offsetWidth;
    CANVAS_H = el.offsetHeight;
    SCALE = CANVAS_W / REAL_W;
  }
}

function getOverride(slideNum) {
  return composeState.slide_overrides[slideNum] || {};
}

function setOverride(slideNum, key, val) {
  if (!composeState.slide_overrides[slideNum]) composeState.slide_overrides[slideNum] = {};
  composeState.slide_overrides[slideNum][key] = val;
  _dirty = true;
}

function renderPreview() {
  _updateScale();  // 실제 캔버스 크기 기반 SCALE 갱신
  const container = document.getElementById("slide-preview");
  const sl = getSelectedSlide();
  if (!sl) {
    container.innerHTML = `<span class="text-gray-600 text-sm">슬라이드를 선택하세요</span>`;
    return;
  }

  const ovr = getOverride(sl.num);
  const isHidden = ovr.hidden === true;

  // 채널 레이아웃에 따른 텍스트 위치 결정
  const chCfg = composerData.channel_config || {};
  const slideLayout = chCfg.slide_layout || "full";
  const bgDisplayMode = chCfg.bg_display_mode || "zone";
  const zoneRatio = (chCfg.slide_zone_ratio || "3:4:3").split(":").map(Number);
  const zoneTotal = zoneRatio[0] + zoneRatio[1] + zoneRatio[2];
  const topZonePct = zoneRatio[0] / zoneTotal;
  const midZonePct = zoneRatio[1] / zoneTotal;
  const isZonedLayout = (slideLayout === "center" || slideLayout === "top" || slideLayout === "bottom");
  const gradient = chCfg.slide_bg_gradient || "#0b0e1a,#141b2d,#1a2238";
  const gradColors = gradient.split(",").map(c => c.trim());
  const gradCss = `linear-gradient(180deg, ${gradColors[0] || '#0b0e1a'}, ${gradColors[1] || '#141b2d'}, ${gradColors[2] || '#1a2238'})`;

  // 배경
  let bgHtml = "";
  if (sl.bg_url) {
    if (isZonedLayout && bgDisplayMode === "zone" && !isHidden) {
      // 이미지 영역만 표시, 텍스트 영역은 그라디언트
      let imgZoneTop, imgZoneHeight, textZones;
      if (slideLayout === "center") {
        imgZoneTop = topZonePct * 100;
        imgZoneHeight = midZonePct * 100;
        textZones = `<div style="position:absolute;top:0;left:0;right:0;height:${topZonePct*100}%;background:${gradCss};"></div>
          <div style="position:absolute;bottom:0;left:0;right:0;height:${(zoneRatio[2]/zoneTotal)*100}%;background:${gradCss};"></div>`;
      } else if (slideLayout === "top") {
        // top = 이미지 상단, 텍스트 하단
        imgZoneTop = 0;
        imgZoneHeight = (topZonePct + midZonePct) * 100;
        textZones = `<div style="position:absolute;bottom:0;left:0;right:0;height:${(zoneRatio[2]/zoneTotal)*100}%;background:${gradCss};"></div>`;
      } else { // bottom = 텍스트 상단, 이미지 하단
        imgZoneTop = topZonePct * 100;
        imgZoneHeight = (midZonePct + (zoneRatio[2]/zoneTotal)) * 100;
        textZones = `<div style="position:absolute;top:0;left:0;right:0;height:${topZonePct*100}%;background:${gradCss};"></div>`;
      }
      const imgTag = sl.bg_url.includes(".mp4") || sl.bg_url.includes(".gif")
        ? `<video src="${sl.bg_url}" muted autoplay loop playsinline style="width:100%;height:100%;object-fit:cover;"></video>`
        : `<img src="${sl.bg_url}" draggable="false" style="width:100%;height:100%;object-fit:${slideLayout === 'center' ? 'contain' : 'cover'};">`;
      bgHtml = `${textZones}
        <div style="position:absolute;top:${imgZoneTop}%;left:0;right:0;height:${imgZoneHeight}%;overflow:hidden;">${imgTag}</div>`;
    } else {
      // full 또는 fullscreen — 이미지 크기/위치 조정 적용
      const _imgScale = (ovr.imgScale || 100) / 100;
      const _imgX = ovr.imgX !== undefined ? ovr.imgX : 50;
      const _imgY = ovr.imgY !== undefined ? ovr.imgY : 50;
      const _imgFit = ovr.imgFit || 'cover';
      const imgStyle = `width:100%;height:100%;object-fit:${_imgFit};object-position:${_imgX}% ${_imgY}%;transform:scale(${_imgScale});position:absolute;inset:0;`;
      if (sl.bg_url.includes(".mp4") || sl.bg_url.includes(".gif")) {
        bgHtml = `<video src="${sl.bg_url}" muted autoplay loop playsinline style="${imgStyle}"></video>`;
      } else {
        bgHtml = `<img src="${sl.bg_url}" draggable="false" style="${imgStyle}">`;
      }
    }
  }

  // 텍스트 오버레이 (드래그 가능) — 강조 적용
  const rawMain = (ovr.main !== undefined ? ovr.main : sl.main || "").replace(/<[^>]*>/g, "");
  const rawSub = (ovr.sub !== undefined ? ovr.sub : sl.sub || "").replace(/<[^>]*>/g, "");
  const mainText = ovr.richMain || _applyHighlights(rawMain, ovr.mainHighlights || ovr.highlights);
  const subText = ovr.richSub || _applyHighlights(rawSub, ovr.subHighlights);
  const _cfgMain = chCfg.slide_main_text_size || 100;
  const _cfgSub = chCfg.sub_text_size || 52;
  const mainSize = (ovr.mainSize || _cfgMain) * SCALE;
  const subSize = (ovr.subSize || _cfgSub) * SCALE;

  let posX, posY, subPosX, subPosY, useZoned = false;
  if (isZonedLayout) {
    // Zoned 레이아웃: 메인 상단, 서브 하단 분리 배치
    useZoned = true;
    const botZonePct = zoneRatio[2] / zoneTotal;
    // 동적 캔버스 크기 기반
    const scaleY = CANVAS_H / REAL_H;
    const scaleX = CANVAS_W / REAL_W;

    // 메인 텍스트: 수동 위치 우선
    posX = (ovr.x !== undefined ? ovr.x : REAL_W / 2) * scaleX;

    // 서브 텍스트: 수동 위치(subX/subY) 우선
    subPosX = (ovr.subX !== undefined ? ovr.subX : REAL_W / 2) * scaleX;

    const topZoneEndPx = CANVAS_H * topZonePct;
    const midZoneEndPx = CANVAS_H * (topZonePct + midZonePct);

    if (slideLayout === "center") {
      posY = ovr.y !== undefined ? ovr.y * scaleY : topZoneEndPx * 0.5;
      subPosY = ovr.subY !== undefined ? ovr.subY * scaleY : midZoneEndPx;
    } else if (slideLayout === "top") {
      const botStart = midZoneEndPx;
      const botH = CANVAS_H * botZonePct;
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

  // 오버레이 숨김이면 렌더링 자체를 건너뜀
  let overlayHtml = '';
  if (isHidden) {
    // overlayHtml은 빈 문자열 → 프리뷰에 오버레이 없음
  } else {

  const overlayOpacity = 1;
  const maxW = (ovr.maxWidth || 1000) * SCALE;
  const mainColor = ovr.mainColor || '#ffffff';
  const subColor = ovr.subColor || '#d1d5db';
  const fontFamily = ovr.fontFamily || 'Noto Sans KR';
  const _cfgTextBg = chCfg.slide_text_bg !== undefined ? chCfg.slide_text_bg : 4;
  const bgOpacity = ovr.bgOpacity !== undefined ? ovr.bgOpacity / 100 : _cfgTextBg / 10;

  const ovrRot = ovr.rotation || 0;
  const resizeHandles = `
        <div class="el-rotate" onmousedown="startOverlayRotate(event)">↻</div>
        <div class="el-resize el-r-tl" onmousedown="startOverlayResize(event, 'tl')"></div>
        <div class="el-resize el-r-tr" onmousedown="startOverlayResize(event, 'tr')"></div>
        <div class="el-resize el-r-bl" onmousedown="startOverlayResize(event, 'bl')"></div>
        <div class="el-resize el-r-br" onmousedown="startOverlayResize(event, 'br')"></div>
  `;

  if (useZoned && subText) {
    // Zoned 레이아웃: 메인/서브 분리 배치
    overlayHtml = `
      <div id="text-overlay-drag" class="comp-element-box"
           style="left:${posX}px; top:${posY}px; width:${maxW}px; background:rgba(5,8,20,${bgOpacity}); font-family:'${fontFamily}',sans-serif; z-index:20; transform:translate(-50%,-50%) rotate(${ovrRot}deg); text-align:center; padding:8px 12px;"
           onmousedown="startOverlayDrag(event)">
        <div class="overlay-main" style="font-size:${mainSize}px; color:${mainColor};">${mainText}</div>
        ${resizeHandles}
      </div>
      <div id="sub-overlay-drag" class="comp-element-box"
           style="left:${subPosX}px; top:${subPosY}px; width:${maxW}px; background:rgba(5,8,20,${bgOpacity * 0.7}); font-family:'${fontFamily}',sans-serif; z-index:19; transform:translate(-50%,0); text-align:center; padding:6px 10px;"
           onmousedown="startSubOverlayDrag(event)">
        <div class="overlay-sub" style="font-size:${subSize}px; color:${subColor};">${subText}</div>
      </div>
    `;
  } else {
    // full 레이아웃 또는 서브 텍스트 없음: 기존 동작
    overlayHtml = `
      <div id="text-overlay-drag" class="comp-element-box"
           style="left:${posX}px; top:${posY}px; width:${maxW}px; background:rgba(5,8,20,${bgOpacity}); font-family:'${fontFamily}',sans-serif; z-index:20; transform:translate(-50%,-50%) rotate(${ovrRot}deg); text-align:center;"
           onmousedown="startOverlayDrag(event)">
        <div class="overlay-main" style="font-size:${mainSize}px; color:${mainColor};">${mainText}</div>
        ${subText ? `<div class="overlay-sub" style="font-size:${subSize}px; color:${subColor};">${subText}</div>` : ""}
        ${resizeHandles}
      </div>
    `;
  }
  } // else (isHidden) 끝

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
      onmousedown="startFreeTextDrag(event, ${ftIdx})">${_esc(ft.text).replace(/\n/g, '<br>')}
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
      let styledSvg = bSvg.replace(/fill="white"/g, `fill="${elem.fillColor || '#ffffff'}"`);
      if (elem.strokeColor) {
        styledSvg = styledSvg.replace(/stroke="none"/g, `stroke="${elem.strokeColor}" stroke-width="${elem.strokeWidth || 2}"`);
        // stroke 속성이 없는 요소에도 추가
        styledSvg = styledSvg.replace(/(<(?:path|rect|ellipse|polygon|circle)\b)(?![^>]*\bstroke=)/g, `$1 stroke="${elem.strokeColor}" stroke-width="${elem.strokeWidth || 2}"`);
      }
      inner = `<svg viewBox="0 0 100 95" width="100%" height="100%" style="position:absolute;inset:0;">${styledSvg}</svg>`;
      if (elem.text) {
        const flipTxt = elem.flipX ? "transform:scaleX(-1);" : "";
        inner += `<div style="position:absolute;inset:10%;display:flex;align-items:center;justify-content:center;text-align:center;font-size:${(elem.textSize||36)*SCALE}px;color:${elem.textColor||'#000'};font-weight:700;word-break:keep-all;line-height:1.2;z-index:2;${flipTxt}">${_esc(elem.text).replace(/\n/g, '<br>')}</div>`;
      }
    } else if (elem.type === "image") {
      inner = `<img src="${elem.dataUrl}" style="width:100%;height:100%;object-fit:contain;" draggable="false">`;
    } else if (elem.type === "emotion") {
      const eSvg = EMOTION_SVGS[elem.emotionIdx]?.svg || '';
      inner = `<svg viewBox="0 0 100 100" width="100%" height="100%" style="position:absolute;inset:0;">${eSvg}</svg>`;
    }

    const eFlipX = elem.flipX ? " scaleX(-1)" : "";
    const eEmoCls = elem.emotion ? ` em-${elem.emotion}` : "";
    elemHtml += `<div class="comp-element-box" data-el-idx="${eIdx}"
      style="left:${eX}px;top:${eY}px;width:${eW}px;height:${eH}px;transform:translate(-50%,-50%) rotate(${eRot}deg)${eFlipX};"
      onmousedown="startElementDrag(event, ${eIdx})">
      <div class="el-emotion-inner${eEmoCls}">${inner}</div>
      <div class="el-flip" onmousedown="event.stopPropagation(); toggleElementFlip(${eIdx})" title="좌우 반전">⇔</div>
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

  // 자막 오버레이 (Composer subtitle_overrides 우선 → 채널설정 폴백)
  let subtitleHtml = "";
  const _so2 = composeState.subtitle_overrides || {};
  const _sg2 = (k, d) => _so2[k] !== undefined ? _so2[k] : (chCfg[k] !== undefined ? chCfg[k] : d);
  const subEnabled = _sg2('subtitle_enabled', false);
  if (subEnabled) {
    // 자막 설정은 픽셀(px) 단위 — 미리보기 캔버스 비율로 축소
    const _subRaw = _sg2('subtitle_font_size', 48);
    const subFontSize = Math.max(8, Math.round(_subRaw * SCALE));
    const subFont = _sg2('subtitle_font', 'Noto Sans KR');
    const subOutline = _sg2('subtitle_outline', 3);
    const subAlign = _sg2('subtitle_alignment', 2);
    const _subMarginRaw = _sg2('subtitle_margin_v', 100);
    const subMarginV = Math.max(4, Math.round(_subMarginRaw * SCALE));
    // alignment: 2=하단중앙, 8=상단중앙, 5=중앙
    let subPos = `bottom:${subMarginV}px;`;
    if (subAlign === 8) subPos = `top:${subMarginV}px;`;
    else if (subAlign === 5) subPos = `top:50%;transform:translateY(-50%);`;
    const textShadow = `0 0 ${subOutline}px #000, `.repeat(4).slice(0, -2);
    subtitleHtml = `<div id="preview-subtitle" style="position:absolute;${subPos}left:0;right:0;text-align:center;
      font-size:${subFontSize}px;font-family:'${subFont}',sans-serif;color:#fff;text-shadow:${textShadow};
      padding:4px 8px;z-index:50;pointer-events:none;word-break:keep-all;"></div>`;
  }

  container.innerHTML = `
    <div class="preview-canvas">
      ${bgHtml || '<div class="preview-bg-fallback"></div>'}
      ${zoneGuideHtml}
      ${elemHtml}
      ${freeTextHtml}
      ${overlayHtml}
      ${subtitleHtml}
      <div class="preview-slide-num">${sl.num}/${composerData.slides.length}</div>
    </div>
  `;

  // 자막 초기 텍스트 (선택된 슬라이드의 전체 문장)
  requestAnimationFrame(() => {
    const subEl = document.getElementById("preview-subtitle");
    if (subEl && sl.sentences && sl.sentences.length > 0) {
      subEl.textContent = sl.sentences.map(s => s.text || "").join("\n");
      subEl.style.whiteSpace = "pre-line";
    }
  });
}

// ─── 자석(스냅) 기능 ───
const SNAP_THRESHOLD = 8; // px (이 범위 안이면 스냅)

function _snapToGuides(x, y, canvasW, canvasH) {
  const centerX = canvasW / 2;
  const centerY = canvasH / 2;
  let snappedX = x, snappedY = y;
  let snapXActive = false, snapYActive = false;

  if (Math.abs(x - centerX) < SNAP_THRESHOLD) {
    snappedX = centerX;
    snapXActive = true;
  }
  if (Math.abs(y - centerY) < SNAP_THRESHOLD) {
    snappedY = centerY;
    snapYActive = true;
  }
  return { x: snappedX, y: snappedY, snapX: snapXActive, snapY: snapYActive };
}

function _showSnapGuide(snapX, snapY) {
  let guideV = document.getElementById("snap-guide-v");
  let guideH = document.getElementById("snap-guide-h");
  const canvas = document.querySelector(".preview-canvas");
  if (!canvas) return;

  if (!guideV) {
    guideV = document.createElement("div");
    guideV.id = "snap-guide-v";
    guideV.style.cssText = "position:absolute;top:0;bottom:0;width:1px;background:#f97316;z-index:60;pointer-events:none;display:none;left:50%;";
    canvas.appendChild(guideV);
  }
  if (!guideH) {
    guideH = document.createElement("div");
    guideH.id = "snap-guide-h";
    guideH.style.cssText = "position:absolute;left:0;right:0;height:1px;background:#f97316;z-index:60;pointer-events:none;display:none;top:50%;";
    canvas.appendChild(guideH);
  }
  guideV.style.display = snapX ? "" : "none";
  guideH.style.display = snapY ? "" : "none";
}

function _hideSnapGuides() {
  const v = document.getElementById("snap-guide-v");
  const h = document.getElementById("snap-guide-h");
  if (v) v.style.display = "none";
  if (h) h.style.display = "none";
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
    const raw = { x: origLeft + dx, y: origTop + dy };
    const snap = _snapToGuides(raw.x, raw.y, CANVAS_W, CANVAS_H);
    overlay.style.left = `${snap.x}px`;
    overlay.style.top = `${snap.y}px`;
    _showSnapGuide(snap.snapX, snap.snapY);

    setOverride(sl.num, "x", Math.round(snap.x / SCALE));
    setOverride(sl.num, "y", Math.round(snap.y / SCALE));
    renderProps();
  }

  function onUp() {
    _hideSnapGuides();
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
    const raw = { x: origLeft + dx, y: origTop + dy };
    const snap = _snapToGuides(raw.x, raw.y, CANVAS_W, CANVAS_H);
    subEl.style.left = `${snap.x}px`;
    subEl.style.top = `${snap.y}px`;
    _showSnapGuide(snap.snapX, snap.snapY);
    setOverride(sl.num, "subX", Math.round(snap.x / SCALE));
    setOverride(sl.num, "subY", Math.round(snap.y / SCALE));
  }
  function onUp() {
    _hideSnapGuides();
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
  const _rCfg = composerData.channel_config || {};
  const origMainSize = ovr.mainSize || _rCfg.slide_main_text_size || 100;
  const origSubSize = ovr.subSize || _rCfg.sub_text_size || 52;

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

// 슬라이드 duration 초기화: 저장된 값이 없는 슬라이드만 오디오 길이로 설정
function _autoUpdateDurations() {
  if (!composerData.slide_audio) return;
  if (!composeState.slide_durations) composeState.slide_durations = {};
  for (const num of composeState.slide_order) {
    // 이미 저장된 duration이 있으면 보존 (사용자가 조정한 값 유지)
    if (composeState.slide_durations[num]) continue;
    const audios = composerData.slide_audio[num];
    if (!audios || audios.length === 0) continue;
    const totalAudioDur = audios.reduce((sum, a) => sum + (a.duration || 0), 0);
    if (totalAudioDur > 0) {
      composeState.slide_durations[num] = totalAudioDur;
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
  _recalcClipPositions();
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

// ─── Narration File Pool ───

let _narrFilePool = [];  // [{filename, duration, url}]

async function loadNarrFilePool() {
  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/narration-files`);
    const data = await r.json();
    _narrFilePool = data.files || [];
  } catch { _narrFilePool = []; }
}

async function uploadNarrFiles(input) {
  const files = input.files;
  if (!files || files.length === 0) return;
  const status = document.getElementById("narr-pool-status");
  if (status) status.textContent = `${files.length}개 업로드 중...`;

  const formData = new FormData();
  for (const f of files) formData.append("files", f);

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/narration-files`, {
      method: "POST", body: formData,
    });
    if (r.ok) {
      await loadNarrFilePool();
      if (status) status.textContent = `${files.length}개 업로드 완료`;
      renderTabNarration();
    } else {
      if (status) status.textContent = "업로드 실패";
    }
  } catch (e) {
    if (status) status.textContent = `오류: ${e.message}`;
  }
  input.value = "";
}

async function deleteNarrFile(filename) {
  try {
    await fetch(`/api/jobs/${JOB_ID}/composer/narration-files/${encodeURIComponent(filename)}`, { method: "DELETE" });
    await loadNarrFilePool();
    renderTabNarration();
  } catch {}
}

async function assignNarrToSlide(slideNum, filename) {
  if (!filename) return;
  const status = document.getElementById("narr-pool-status");
  if (status) status.textContent = `슬라이드 ${slideNum}에 배치 중...`;

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/assign-narration/${slideNum}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_file: filename }),
    });
    if (r.ok) {
      const data = await r.json();
      // duration 자동 반영
      if (data.duration && data.duration > 0) {
        if (!composeState.slide_durations) composeState.slide_durations = {};
        composeState.slide_durations[slideNum] = data.duration;
        _dirty = true;
      }
      // narr_file_map 저장
      if (!composeState.narr_file_map) composeState.narr_file_map = {};
      composeState.narr_file_map[slideNum] = filename;
      _dirty = true;

      await refreshData();
      _autoUpdateDurations();
      renderTimeline();
      renderTabNarration();
      if (status) status.textContent = `슬라이드 ${slideNum} 배치 완료`;
    }
  } catch (e) {
    if (status) status.textContent = `오류: ${e.message}`;
  }
}

async function unassignNarr(slideNum) {
  // 배치 해제: narr_file_map에서만 제거 (오디오 파일은 유지)
  if (composeState.narr_file_map) {
    delete composeState.narr_file_map[slideNum];
    _dirty = true;
  }
  renderTabNarration();
}

async function splitNarrationToAll(filename) {
  if (!filename) return;
  const status = document.getElementById("narr-pool-status");
  if (status) status.textContent = `전체 분할 중...`;

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/split-narration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_file: filename }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      if (status) status.textContent = `분할 실패: ${data.detail || data.error || "알 수 없는 오류"}`;
      return;
    }

    await refreshData();

    // 기존 voice_clips / subtitle_entries 전체 제거 (새로 분할한 오디오로 교체)
    composeState.voice_clips = [];
    composeState.subtitle_entries = [];
    if (!composeState.slide_durations) composeState.slide_durations = {};

    // 분할 결과로 duration 업데이트 + voice_clips/subtitle_entries 재구성
    let cumTime = 0;
    const slides = getOrderedSlides();
    slides.forEach(sl => {
      const splitInfo = (data.slides || []).find(s => s.slide_num === sl.num);
      if (splitInfo) {
        composeState.slide_durations[sl.num] = splitInfo.duration;

        // voice_clip 배치
        composeState.voice_clips.push({
          id: `vc_${sl.num}_split_${Date.now()}`,
          file: splitInfo.file,
          path: `/api/jobs/${JOB_ID}/audio/${splitInfo.file}`,
          start_time: cumTime,
          duration: splitInfo.duration,
          volume: composeState.narr_volume !== undefined ? composeState.narr_volume : 100,
          slide_num: sl.num,
        });

        // subtitle_entries 배치 (슬라이드의 전체 문장 텍스트를 하나의 자막으로)
        const allText = (sl.sentences || []).map(s => s.text).filter(Boolean).join(" ");
        if (allText) {
          composeState.subtitle_entries.push({
            id: `sub_${sl.num}_split_${Date.now()}`,
            text: allText,
            start_time: cumTime,
            end_time: cumTime + splitInfo.duration,
            slide_num: sl.num,
          });
        }

        cumTime += splitInfo.duration;
      } else {
        cumTime += getSlideDuration(sl.num);
      }
    });

    _dirty = true;
    renderTimeline();
    renderTabNarration();
    if (status) status.textContent = `전체 분할 완료 — ${data.slides.length}개 슬라이드`;
  } catch (e) {
    if (status) status.textContent = `오류: ${e.message}`;
  }
}

function _updateSentence(slideNum, sentIdx, newText) {
  const sl = composerData.slides.find(s => s.num === slideNum);
  if (!sl || !sl.sentences || !sl.sentences[sentIdx]) return;
  sl.sentences[sentIdx].text = newText;
  // compose_data에 수정된 문장 저장
  if (!composeState.sentence_overrides) composeState.sentence_overrides = {};
  const key = `${slideNum}_${sentIdx}`;
  composeState.sentence_overrides[key] = newText;
  _dirty = true;
  renderPreview();
  renderSubtitleTrack();
}

function syncDurationsToAudio() {
  if (!composerData.slide_audio) return;
  if (!composeState.slide_durations) composeState.slide_durations = {};
  let count = 0;
  for (const num of composeState.slide_order) {
    const audios = composerData.slide_audio[num];
    if (!audios || audios.length === 0) continue;
    const totalAudioDur = audios.reduce((sum, a) => sum + (a.duration || 0), 0);
    if (totalAudioDur > 0) {
      composeState.slide_durations[num] = totalAudioDur;
      count++;
    }
  }
  if (count > 0) {
    _dirty = true;
    renderTimeline();
    renderTabNarration();
    const s = document.getElementById("narr-pool-status");
    if (s) s.textContent = `${count}개 슬라이드 길이를 오디오에 맞춤`;
  }
}

// ─── Audio Upload per Slide (legacy) ───

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
      _autoUpdateDurations();
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
  // Voice clip 오디오 정리
  if (_voiceClipAudios) { _voiceClipAudios.forEach(a => { a.pause(); }); _voiceClipAudios = []; }
  _voiceClipFired = new Set();
  if (_previewTimer) {
    cancelAnimationFrame(_previewTimer);
    _previewTimer = null;
  }
  _previewing = false;
  _cleanupTransitionClone();
  _hideSubtitle();
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
  _playingAudio.play().catch(e => { console.warn("[composer] audio play failed:", audioList[idx].path, e); });
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

  // voice_clips가 없으면 TTS 자동 생성
  const hasClips = (composeState.voice_clips || []).length > 0;
  if (!hasClips) {
    const hasAnyAudio = _checkAllHaveAudio();
    if (!hasAnyAudio) {
      const statusEl = document.getElementById("audio-status");
      if (statusEl) statusEl.textContent = "TTS 생성 중...";
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
          return;
        }
        await refreshData();
        _autoUpdateDurations();
        _migrateToVoiceClips();
        if (_activeTab === 'narration') renderTabNarration();
        renderTimeline();
      } catch (e) {
        if (statusEl) statusEl.textContent = `오류: ${e.message}`;
        return;
      }
    } else {
      // slide_audio 있지만 voice_clips 없으면 마이그레이션
      _migrateToVoiceClips();
    }
  }

  // 오디오 프리로드 대기 (최대 2초, 이미 캐시되어 있으면 즉시)
  const statusEl2 = document.getElementById("audio-status");
  const clips = composeState.voice_clips || [];
  const notReady = clips.filter(c => c.path && !_preloadedAudios.some(a => a.src.endsWith(c.path.split('/').pop()) && a.readyState >= 3));
  if (notReady.length > 0) {
    if (statusEl2) statusEl2.textContent = "오디오 로딩 중...";
    _preloadVoiceClips();
    await new Promise(resolve => {
      let resolved = false;
      const check = () => {
        const ready = _preloadedAudios.every(a => a.readyState >= 3);
        if (ready && !resolved) { resolved = true; resolve(); }
      };
      _preloadedAudios.forEach(a => {
        a.addEventListener("canplaythrough", check);
        a.addEventListener("error", check);
      });
      setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 2000);
      check();
    });
    if (statusEl2) statusEl2.textContent = "";
  }

  // 현재 플레이헤드 위치에서 이어서 재생
  const total = getTotalDuration() || 1;
  const resumeTime = (_playheadPos > 0 && _playheadPos < 1) ? _playheadPos * total : 0;

  stopAllAudio();
  _previewing = true;
  _previewStartTime = performance.now() - resumeTime * 1000;
  _previewSlideIdx = -1;
  _previewAudioPlayed = new Set();
  _voiceClipFired = new Set();

  const pb2 = document.getElementById("btn-play") || document.getElementById("btn-play-slide");
  if (pb2) pb2.innerHTML = "&#9646;&#9646;";

  _sfxFired = new Set();
  _buildSlideTimeMap();

  // 현재 위치의 voice_clips 즉시 트리거 (사용자 제스처 컨텍스트)
  _triggerVoiceClips(resumeTime);

  _syncBgm(resumeTime);
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
let _voiceClipFired = new Set();
let _voiceClipAudios = [];

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

function _triggerVoiceClips(elapsed) {
  (composeState.voice_clips || []).forEach(clip => {
    if (_voiceClipFired.has(clip.id)) return;
    // 클립 시작 시간이 지났고, 아직 끝나지 않은 클립만 트리거
    if (elapsed >= clip.start_time && elapsed < clip.start_time + (clip.duration || 2.0)) {
      _voiceClipFired.add(clip.id);
      if (clip.path) {
        const a = new Audio(clip.path);
        const vol = (clip.volume !== undefined ? clip.volume : (composeState.narr_volume !== undefined ? composeState.narr_volume : 100)) / 100;
        a.volume = vol;
        // 실제 오디오 duration으로 클립 duration 보정 (MP3 duration 불일치 대응)
        a.addEventListener("loadedmetadata", () => {
          if (a.duration && Math.abs(a.duration - clip.duration) > 0.1) {
            const diff = a.duration - clip.duration;
            clip.duration = a.duration;
            // slide_durations도 동기화 (누적 드리프트 방지)
            if (clip.slide_num && composeState.slide_durations && composeState.slide_durations[clip.slide_num]) {
              composeState.slide_durations[clip.slide_num] += diff;
            }
            _recalcClipPositions();
            renderVoiceClipTrack();
          }
        });
        // 이미 시작 시간이 지났으면 해당 위치부터 재생
        const offset = elapsed - clip.start_time;
        if (offset > 0.1) a.currentTime = offset;
        a.play().catch(() => {});
        _voiceClipAudios.push(a);
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

    // 슬라이드 전환 시 미리보기 갱신 + 전환효과
    if (curSlideIdx !== _previewSlideIdx) {
      const prevIdx = _previewSlideIdx;
      _previewSlideIdx = curSlideIdx;
      const map = _slideTimeMap[curSlideIdx];
      if (map) {
        const slideOrderIdx = composeState.slide_order.indexOf(map.num);
        if (slideOrderIdx >= 0) {
          const prevMap = prevIdx >= 0 ? _slideTimeMap[prevIdx] : null;
          const tr = prevMap ? _getTransition(prevMap.num, map.num) : null;
          if (tr && tr.effect && tr.effect !== 'none' && tr.duration > 0) {
            _applyPreviewTransition(tr.effect, tr.duration, slideOrderIdx);
          } else {
            selectedSlide = slideOrderIdx;
            renderPreview();
          }
        }
      }
    }

    // 플레이헤드 위치 (퍼센트)
    _playheadPos = elapsed / total;
    TL.needsRedraw = true;

    // BGM + SFX + Voice Clips 동기화
    _syncBgm(elapsed);
    _triggerSfx(elapsed);
    _triggerVoiceClips(elapsed);

    // 자막 업데이트 (subtitle_entries 기반)
    _updateSubtitle(curSlideIdx, elapsed);

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

function _updateSubtitle(slideIdx, elapsed) {
  const el = document.getElementById("preview-subtitle");
  if (!el) return;

  // subtitle_entries 기반: 현재 시간에 맞는 자막 찾기
  const entries = composeState.subtitle_entries || [];
  const match = entries.find(e => elapsed >= e.start_time && elapsed < e.end_time);

  if (match) {
    el.textContent = match.text;
    el.style.display = "";
  } else {
    el.style.display = "none";
  }
}

function _hideSubtitle() {
  const el = document.getElementById("preview-subtitle");
  if (el) el.style.display = "none";
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
  if (tab === 'motion') renderTabMotion();
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

  // ── 선택된 슬라이드 이미지 조정 ──
  const sl = getSelectedSlide();
  if (sl && sl.bg_url) {
    const ovr = getOverride(sl.num);
    const imgScale = ovr.imgScale || 100;
    const imgX = ovr.imgX || 50;
    const imgY = ovr.imgY || 50;
    const imgFit = ovr.imgFit || 'cover';

    html += `<div class="ctrl-section" style="margin-top:10px;padding-top:8px;border-top:1px solid #2a2d38;">
      <div class="comp-tab-subtitle">이미지 조정 <span style="color:#6b7280;font-weight:400;">S${sl.num}</span></div>
      <div style="display:flex;gap:4px;margin-bottom:6px;">
        ${['cover', 'contain', 'fill'].map(f =>
          `<button onclick="updateImgOverride(${sl.num}, 'imgFit', '${f}')"
            style="flex:1;padding:3px;font-size:9px;border:1px solid ${imgFit === f ? '#6366f1' : '#3a3d48'};background:${imgFit === f ? '#2d2f6b' : '#22242e'};color:${imgFit === f ? '#a5b4fc' : '#9ca3af'};border-radius:4px;cursor:pointer;">${f === 'cover' ? '채우기' : f === 'contain' ? '맞추기' : '늘이기'}</button>`
        ).join('')}
      </div>
      <div class="ctrl-row"><span class="ctrl-label">크기</span>
        <input type="range" min="50" max="200" step="5" value="${imgScale}"
          style="flex:1;accent-color:#6366f1;" oninput="updateImgOverride(${sl.num}, 'imgScale', +this.value); this.nextElementSibling.textContent=this.value+'%'">
        <span style="font-size:9px;color:#9ca3af;width:30px;text-align:right;">${imgScale}%</span>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">X 위치</span>
        <input type="range" min="0" max="100" step="1" value="${imgX}"
          style="flex:1;accent-color:#6366f1;" oninput="updateImgOverride(${sl.num}, 'imgX', +this.value)">
      </div>
      <div class="ctrl-row"><span class="ctrl-label">Y 위치</span>
        <input type="range" min="0" max="100" step="1" value="${imgY}"
          style="flex:1;accent-color:#6366f1;" oninput="updateImgOverride(${sl.num}, 'imgY', +this.value)">
      </div>
    </div>`;
  }

  el.innerHTML = html;
}

function updateImgOverride(slideNum, key, val) {
  setOverride(slideNum, key, val);
  renderPreview();
  renderTabMedia();
}

function removeSlide(idx) {
  if (composeState.slide_order.length <= 1) return;
  composeState.slide_order.splice(idx, 1);
  _dirty = true;
  if (selectedSlide >= composeState.slide_order.length) selectedSlide = composeState.slide_order.length - 1;
  _recalcClipPositions();
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

// ─── 감정 표현 요소 SVG ───
const EMOTION_SVGS = [
  { name:"빙글빙글", anim:"em-halo", svg:`<circle cx="50" cy="50" r="40" fill="none" stroke="#333" stroke-width="1.8"/><circle cx="50" cy="50" r="32" fill="none" stroke="#555" stroke-width="1.4"/><g><path d="M50,4 L52,8 L56,10 L52,12 L50,16 L48,12 L44,10 L48,8Z" fill="#fff" stroke="#333" stroke-width="0.8"/><path d="M90,44 L88,48 L90,52 L86,50 L82,52 L84,48 L82,44 L86,46Z" fill="#FFD700" stroke="#333" stroke-width="0.8"/><path d="M50,84 L52,88 L56,90 L52,92 L50,96 L48,92 L44,90 L48,88Z" fill="#fff" stroke="#333" stroke-width="0.8"/><path d="M10,44 L12,48 L10,52 L14,50 L18,52 L16,48 L18,44 L14,46Z" fill="#4FC3F7" stroke="#333" stroke-width="0.8"/><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="1.8s" repeatCount="indefinite"/></g><g><path d="M50,12 L52,16 L56,18 L52,20 L50,24 L48,20 L44,18 L48,16Z" fill="#66BB6A" stroke="#333" stroke-width="0.8"/><path d="M82,44 L80,48 L82,52 L78,50 L74,52 L76,48 L74,44 L78,46Z" fill="#fff" stroke="#333" stroke-width="0.8"/><path d="M50,76 L52,80 L56,82 L52,84 L50,88 L48,84 L44,82 L48,80Z" fill="#FF7043" stroke="#333" stroke-width="0.8"/><path d="M18,44 L20,48 L18,52 L22,50 L26,52 L24,48 L26,44 L22,46Z" fill="#AB47BC" stroke="#333" stroke-width="0.8"/><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="2.6s" repeatCount="indefinite"/></g>` },
  { name:"반짝반짝", anim:"em-pulse", svg:`<polygon points="50,5 58,38 95,38 65,58 75,92 50,70 25,92 35,58 5,38 42,38" fill="#FFD700" opacity="0.9"/><polygon points="50,25 54,43 72,43 57,53 62,70 50,60 38,70 43,53 28,43 46,43" fill="#FFF3B0"/>` },
  { name:"한숨", anim:"em-float", svg:`<ellipse cx="30" cy="50" rx="22" ry="14" fill="#B0C4DE" opacity="0.7"/><ellipse cx="60" cy="35" rx="18" ry="11" fill="#B0C4DE" opacity="0.5"/><ellipse cx="80" cy="55" rx="14" ry="9" fill="#B0C4DE" opacity="0.4"/><path d="M15,50 Q5,40 20,35" fill="none" stroke="#B0C4DE" stroke-width="3" stroke-linecap="round" opacity="0.6"/>` },
  { name:"하트", anim:"em-float", svg:`<path d="M50,85 C20,65 5,45 5,30 A20,20,0,0,1,50,25 A20,20,0,0,1,95,30 C95,45 80,65 50,85Z" fill="#FF4D6D"/>` },
  { name:"분노", anim:"em-shake", svg:`<g fill="#FF3333"><path d="M25,20 L50,30 L40,5 L50,30 L75,20 L50,30 L50,30Z" opacity="0.9"/><path d="M75,80 L50,70 L60,95 L50,70 L25,80 L50,70Z" opacity="0.9"/><path d="M20,75 L30,50 L5,60 L30,50 L20,25 L30,50Z" opacity="0.7"/><path d="M80,25 L70,50 L95,40 L70,50 L80,75 L70,50Z" opacity="0.7"/></g>` },
  { name:"당황", anim:"em-bounce", svg:`<path d="M40,15 Q42,50 35,85" fill="none" stroke="#4FC3F7" stroke-width="5" stroke-linecap="round" opacity="0.8"/><ellipse cx="37" cy="90" rx="5" ry="4" fill="#4FC3F7" opacity="0.6"/><path d="M65,25 Q67,55 62,75" fill="none" stroke="#4FC3F7" stroke-width="4" stroke-linecap="round" opacity="0.6"/><ellipse cx="61" cy="80" rx="4" ry="3" fill="#4FC3F7" opacity="0.4"/>` },
  { name:"물음표", anim:"em-wobble", svg:`<text x="50" y="72" text-anchor="middle" font-size="70" font-weight="900" fill="#FFB300" stroke="#E65100" stroke-width="2">?</text>` },
  { name:"느낌표", anim:"em-bounce", svg:`<text x="50" y="72" text-anchor="middle" font-size="70" font-weight="900" fill="#FF5252" stroke="#B71C1C" stroke-width="2">!</text>` },
  { name:"음표", anim:"em-float", svg:`<text x="28" y="60" font-size="50" fill="#AB47BC">♪</text><text x="58" y="45" font-size="38" fill="#AB47BC" opacity="0.7">♫</text>` },
  { name:"전구", anim:"em-pulse", svg:`<ellipse cx="50" cy="40" rx="24" ry="26" fill="#FFEE58" stroke="#FBC02D" stroke-width="2"/><rect x="40" y="64" width="20" height="8" rx="2" fill="#FBC02D"/><rect x="42" y="72" width="16" height="4" rx="2" fill="#F9A825"/><line x1="50" y1="10" x2="50" y2="2" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/><line x1="78" y1="20" x2="84" y2="14" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/><line x1="22" y1="20" x2="16" y2="14" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/><line x1="85" y1="42" x2="92" y2="42" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/><line x1="15" y1="42" x2="8" y2="42" stroke="#FBC02D" stroke-width="3" stroke-linecap="round"/>` },
  { name:"졸림", anim:"em-float", svg:`<text x="20" y="55" font-size="30" font-weight="900" fill="#78909C" opacity="0.5">z</text><text x="42" y="40" font-size="40" font-weight="900" fill="#78909C" opacity="0.7">z</text><text x="65" y="25" font-size="50" font-weight="900" fill="#78909C" opacity="0.9">Z</text>` },
  { name:"폭발", anim:"em-tada", svg:`<polygon points="50,2 62,30 95,15 72,42 98,58 68,60 75,92 50,72 25,92 32,60 2,58 28,42 5,15 38,30" fill="#FF9800" stroke="#E65100" stroke-width="1.5"/><circle cx="50" cy="50" r="15" fill="#FFEB3B"/>` },
];

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
      const flipStyle = elem.flipX ? "transform:scaleX(-1);" : "";
      const isBubble = elem.type === "bubble";
      const isEmotion = elem.type === "emotion";
      const thumbVb = isEmotion ? "0 0 100 100" : "0 0 100 95";
      const thumbSvg = isEmotion
        ? (EMOTION_SVGS[elem.emotionIdx]?.svg || '')
        : (BUBBLE_SVGS[elem.bubbleIdx]?.svg || '');
      html += `<div style="padding:4px 0;border-bottom:1px solid #22242e;">
        <div style="display:flex;align-items:center;gap:6px;">
          <svg viewBox="${thumbVb}" width="24" height="24" style="flex-shrink:0;${flipStyle}"><rect width="100" height="100" rx="4" fill="#2a2d38"/>${thumbSvg}</svg>
          <span style="flex:1;font-size:9px;color:#d1d5db;">${elem.name || '말풍선'}</span>
          <button onclick="toggleElementFlip(${eIdx})" title="좌우 반전" style="background:none;border:none;color:${elem.flipX ? '#60a5fa' : '#6b7280'};cursor:pointer;font-size:12px;">⇔</button>
          <button onclick="removeElement(${eIdx})" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;">&times;</button>
        </div>
        ${isBubble ? `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;padding-left:4px;">
          <div style="display:flex;align-items:center;gap:2px;flex:1;">
            <span style="font-size:8px;color:#6b7280;white-space:nowrap;">배경</span>
            <input type="color" value="${elem.fillColor || '#ffffff'}" style="width:20px;height:18px;border:none;background:none;cursor:pointer;padding:0;"
                   onchange="updateElementProp(${eIdx}, 'fillColor', this.value)">
          </div>
          <div style="display:flex;align-items:center;gap:2px;flex:1;">
            <span style="font-size:8px;color:#6b7280;white-space:nowrap;">테두리</span>
            <input type="color" value="${elem.strokeColor || '#000000'}" style="width:20px;height:18px;border:none;background:none;cursor:pointer;padding:0;"
                   onchange="updateElementProp(${eIdx}, 'strokeColor', this.value)">
            <input type="number" class="ctrl-input" value="${elem.strokeWidth || 2}" min="0" max="10" step="0.5"
                   style="width:36px;font-size:9px;padding:1px 2px;" title="두께"
                   onchange="updateElementProp(${eIdx}, 'strokeWidth', +this.value)">
          </div>
          <button onclick="updateElementProp(${eIdx}, 'strokeColor', '')" title="테두리 제거"
                  style="background:none;border:none;color:${elem.strokeColor ? '#60a5fa' : '#3a3d48'};cursor:pointer;font-size:10px;">✕</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:3px;padding-left:4px;">
          <div style="display:flex;align-items:center;gap:2px;flex:1;">
            <span style="font-size:8px;color:#6b7280;white-space:nowrap;">텍스트</span>
            <textarea class="ctrl-input" rows="2" style="flex:1;font-size:9px;padding:1px 4px;resize:vertical;min-height:22px;"
                   oninput="updateElementProp(${eIdx}, 'text', this.value)">${_esc(elem.text || '')}</textarea>
          </div>
          <div style="display:flex;align-items:center;gap:2px;">
            <input type="color" value="${elem.textColor || '#000000'}" style="width:20px;height:18px;border:none;background:none;cursor:pointer;padding:0;"
                   onchange="updateElementProp(${eIdx}, 'textColor', this.value)">
            <input type="number" class="ctrl-input" value="${elem.textSize || 36}" min="12" max="120" step="2"
                   style="width:36px;font-size:9px;padding:1px 2px;" title="글자 크기"
                   onchange="updateElementProp(${eIdx}, 'textSize', +this.value)">
          </div>
        </div>` : ''}
      </div>`;
    });
  }

  // 이미지 업로드
  html += `<div class="comp-tab-subtitle" style="margin-top:12px;">이미지 요소</div>`;
  html += `<input type="file" accept="image/*" id="element-img-upload" class="hidden" onchange="addImageElement(this)">`;
  html += `<button onclick="document.getElementById('element-img-upload').click()" style="width:100%;padding:6px;background:#2a2d38;color:#9ca3af;border:1px dashed #3a3d48;border-radius:6px;font-size:10px;cursor:pointer;">+ 이미지 추가</button>`;

  // 감정 표현 요소
  html += `<div class="comp-tab-subtitle" style="margin-top:12px;">감정 표현</div>`;
  html += `<div class="elements-grid">`;
  EMOTION_SVGS.forEach((e, i) => {
    html += `<div class="element-item" onclick="addEmotionElement(${i})" title="${e.name}">
      <svg viewBox="0 0 100 100" width="100%" height="100%">${e.svg}</svg>
      <div style="position:absolute;bottom:2px;left:0;right:0;text-align:center;font-size:7px;color:#9ca3af;">${e.name}</div>
    </div>`;
  });
  html += `</div>`;

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
    x: 540, y: 960,
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

function addEmotionElement(emotionIdx) {
  const sl = getSelectedSlide();
  if (!sl) return;
  if (!composeState.elements) composeState.elements = [];
  const emo = EMOTION_SVGS[emotionIdx];
  composeState.elements.push({
    id: `el_${Date.now()}`,
    type: "emotion",
    slideNum: sl.num,
    emotionIdx,
    name: emo?.name || "감정",
    emotion: emo?.anim?.replace("em-", "") || "",
    x: 540, y: 400,
    width: 200, height: 200,
    rotation: 0,
  });
  _dirty = true;
  renderPreview();
  renderTabElements();
}

function toggleElementFlip(idx) {
  const elem = (composeState.elements || [])[idx];
  if (!elem) return;
  elem.flipX = !elem.flipX;
  _dirty = true;
  renderPreview();
  renderTabElements();
}

function updateElementEmotion(idx, val) {
  const elem = (composeState.elements || [])[idx];
  if (!elem) return;
  elem.emotion = val || "";
  _dirty = true;
  renderPreview();
  renderTabElements();
}

function updateElementProp(idx, key, val) {
  const elem = (composeState.elements || [])[idx];
  if (!elem) return;
  elem[key] = val;
  _dirty = true;
  renderPreview();
  // 텍스트 입력 중 패널 재렌더링하면 포커스 날아감 → text/textSize/textColor만 미리보기만 갱신
  if (!["text"].includes(key)) renderTabElements();
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

  let html = `<div class="comp-tab-title">텍스트 <span style="color:#6b7280;font-weight:400;">슬라이드 ${sl.num}</span></div>`;

  // ── 자유 텍스트 ──
  const freeTexts = (composeState.freeTexts || []).filter(ft => ft.slideNum === sl.num);
  html += `<div class="ctrl-section" style="margin-top:12px;padding-top:10px;border-top:1px solid #2a2d38;">
    <div class="comp-tab-subtitle">자유 텍스트</div>`;
  freeTexts.forEach((ft, fi) => {
    const ftIdx = (composeState.freeTexts || []).indexOf(ft);
    html += `<div style="background:#22242e;border-radius:6px;padding:6px;margin-bottom:6px;">
      <div class="ctrl-row" style="flex-direction:column;align-items:stretch;"><span class="ctrl-label">텍스트</span>
        <textarea class="ctrl-input" rows="2" style="resize:vertical;min-height:28px;" oninput="updateFreeText(${ftIdx}, 'text', this.value)">${_esc(ft.text)}</textarea>
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


function _updateSubtitleCfg(key, value) {
  if (!composerData.channel_config) composerData.channel_config = {};
  composerData.channel_config[key] = value;
  if (!composeState.subtitle_overrides) composeState.subtitle_overrides = {};
  composeState.subtitle_overrides[key] = value;
  _dirty = true;
  renderPreview();
  renderSubtitleTrack();
  if (key === 'subtitle_enabled') renderTabNarration();
}

// ─── Tab: Motion (배경 모션) ───

function renderTabMotion() {
  const el = document.getElementById("tab-motion");
  if (!el) return;

  const slides = getOrderedSlides();
  let html = `<div class="comp-tab-title">배경 모션</div>`;
  html += `<div style="font-size:9px;color:#6b7280;margin-bottom:8px;">정적 이미지 배경에 카메라 모션 효과를 적용합니다. MP4/GIF 배경에는 적용되지 않습니다.</div>`;

  // 전체 일괄 적용
  html += `<div style="margin-bottom:8px;">
    <div class="comp-tab-subtitle" style="margin-bottom:4px;">전체 일괄</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:2px;">`;
  const motions = ["none","zoom_in","zoom_out","pan_right","pan_left","shake","pulse","rotate","blur_in","bright_pulse","vignette","glitch","random"];
  motions.forEach(m => {
    html += `<button onclick="_applyMotionToAll('${m}')"
      style="padding:3px;background:#1e1e2e;color:#9ca3af;border:1px solid #333;border-radius:3px;font-size:9px;cursor:pointer;">${MOTION_LABELS[m]||m}</button>`;
  });
  html += `</div></div>`;

  // 슬라이드별 모션
  html += `<div class="comp-tab-subtitle" style="margin-bottom:4px;">슬라이드별</div>`;
  slides.forEach(sl => {
    const isVideo = sl.bg_url && (sl.bg_url.includes(".mp4") || sl.bg_url.includes(".gif"));
    const cur = _getSlideMotion(sl.num);
    const label = MOTION_LABELS[cur] || cur;

    html += `<div style="display:flex;align-items:center;gap:4px;padding:4px;border-bottom:1px solid #2a2d38;">
      <span style="font-size:11px;font-weight:600;color:#e5e7eb;min-width:24px;">S${sl.num}</span>`;

    if (isVideo || sl.bg_type === "closing") {
      html += `<span style="font-size:9px;color:#6b7280;flex:1;">${isVideo ? 'MP4/GIF' : 'closing'}</span>
        <span style="font-size:9px;color:#4b5563;">해당없음</span>`;
    } else {
      html += `<select onchange="setSlideMotion(${sl.num}, this.value); renderTabMotion();"
        style="flex:1;padding:2px 4px;background:#1e1e2e;color:#d1d5db;border:1px solid #374151;border-radius:3px;font-size:10px;">`;
      motions.forEach(m => {
        html += `<option value="${m}" ${m === cur ? 'selected' : ''}>${MOTION_LABELS[m]||m}</option>`;
      });
      html += `</select>`;
    }
    html += `</div>`;
  });

  el.innerHTML = html;
}

function _applyMotionToAll(motion) {
  if (!composeState.slide_motions) composeState.slide_motions = {};
  const slides = getOrderedSlides();
  slides.forEach(sl => {
    const isVideo = sl.bg_url && (sl.bg_url.includes(".mp4") || sl.bg_url.includes(".gif"));
    if (!isVideo && sl.bg_type !== "closing") {
      composeState.slide_motions[sl.num] = motion;
    }
  });
  _dirty = true;
  renderTabMotion();
  renderTimeline();
}

// ─── Tab: Transition (전환 효과) ───
// 선택된 전환 쌍 (타임라인 다이아몬드 클릭 시 설정)
let _selectedTrPair = null;  // { from: slideNum, to: slideNum }

let _transitionList = null;
async function renderTabTransition() {
  const el = document.getElementById("tab-transition");
  if (!el) return;

  if (!_transitionList) {
    try {
      const res = await fetch("/api/transitions");
      _transitionList = await res.json();
    } catch (e) {
      el.innerHTML = `<div class="text-xs text-red-400">전환 효과 목록 로드 실패</div>`;
      return;
    }
  }

  const slides = getOrderedSlides();

  // 선택된 쌍이 없으면 현재 슬라이드 기준 자동 선택
  if (!_selectedTrPair && slides.length >= 2) {
    const curIdx = Math.max(0, selectedSlide);
    if (curIdx < slides.length - 1) {
      _selectedTrPair = { from: slides[curIdx].num, to: slides[curIdx + 1].num };
    } else {
      _selectedTrPair = { from: slides[curIdx - 1].num, to: slides[curIdx].num };
    }
  }

  if (!_selectedTrPair) {
    el.innerHTML = `<div class="text-xs text-gray-600" style="padding:20px;">슬라이드가 2개 이상 필요합니다.</div>`;
    return;
  }

  const tr = _getTransition(_selectedTrPair.from, _selectedTrPair.to);

  // 구간 네비게이션 (◀ 1→2 ▶)
  const curPairIdx = slides.findIndex((s, i) => i < slides.length - 1
    && s.num === _selectedTrPair.from && slides[i + 1].num === _selectedTrPair.to);
  const totalPairs = slides.length - 1;
  const pairLabel = `${_selectedTrPair.from} → ${_selectedTrPair.to}`;
  let html = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:8px;">
    <button onclick="_navTrPair(-1)" style="background:none;border:none;color:${curPairIdx > 0 ? '#a5b4fc' : '#3a3d48'};font-size:16px;cursor:pointer;padding:2px 6px;"
      ${curPairIdx <= 0 ? 'disabled' : ''}>◀</button>
    <span style="font-size:12px;font-weight:700;color:#e5e7eb;">${pairLabel}</span>
    <span style="font-size:9px;color:#6b7280;">(${curPairIdx + 1}/${totalPairs})</span>
    <button onclick="_navTrPair(1)" style="background:none;border:none;color:${curPairIdx < totalPairs - 1 ? '#a5b4fc' : '#3a3d48'};font-size:16px;cursor:pointer;padding:2px 6px;"
      ${curPairIdx >= totalPairs - 1 ? 'disabled' : ''}>▶</button>
  </div>`;

  // 미리보기 영상 (크게)
  html += `<video id="transition-preview-video" class="w-full rounded" style="max-height:200px;aspect-ratio:9/16;object-fit:contain;background:#000;margin-bottom:8px;" loop muted playsinline></video>`;

  // 효과 카테고리별 그리드
  const cats = [];
  const catMap = {};
  _transitionList.forEach(t => {
    const c = t.cat || "기타";
    if (!catMap[c]) { catMap[c] = []; cats.push(c); }
    catMap[c].push(t);
  });
  cats.forEach(cat => {
    const items = catMap[cat];
    const hasActive = items.some(t => t.id === tr.effect);
    const collapsed = hasActive ? '' : 'collapsed';
    html += `<div class="tr-cat-section ${collapsed}" style="margin-bottom:6px;">
      <button onclick="this.parentElement.classList.toggle('collapsed')"
        class="tr-cat-header" style="display:flex;align-items:center;gap:4px;width:100%;background:none;border:none;cursor:pointer;padding:3px 0;">
        <span style="font-size:8px;color:#6b7280;transition:transform 0.15s;" class="tr-cat-arrow">▼</span>
        <span style="font-size:10px;font-weight:700;color:${hasActive ? '#a5b4fc' : '#9ca3af'};">${cat}</span>
        <span style="font-size:8px;color:#4b5563;">(${items.length})</span>
      </button>
      <div class="tr-cat-body" style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:3px;">`;
    items.forEach(t => {
      const isActive = t.id === tr.effect;
      html += `<button onclick="selectTransition('${t.id}')"
        class="text-left px-2 py-1 rounded text-xs transition-all ${isActive ? 'bg-indigo-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}"
        style="border:1px solid ${isActive ? '#6366f1' : '#333'};"
        title="${t.desc}">
        <div class="font-medium" style="font-size:10px;">${t.label}</div>
      </button>`;
    });
    html += `</div></div>`;
  });

  // duration
  html += `<div class="ctrl-section">
    <div class="ctrl-row">
      <span class="ctrl-label">길이</span>
      <input type="range" min="0" max="1.5" step="0.1" value="${tr.duration}"
             oninput="updateTransitionDur(+this.value); this.nextElementSibling.textContent=this.value+'초';"
             style="flex:1;accent-color:#6366f1;">
      <span style="font-size:10px;color:#9ca3af;width:30px;text-align:right;">${tr.duration}초</span>
    </div>
    <div style="font-size:9px;color:#6b7280;margin-top:2px;">0 = 하드컷, 0.3~0.7 권장</div>
  </div>`;

  // 전체 일괄 적용
  html += `<div style="display:flex;gap:4px;margin-top:6px;">
    <button onclick="_applyTransitionToAll()" class="comp-btn comp-btn-secondary" style="flex:1;font-size:10px;">전체 동일 적용</button>
    <button onclick="_removeAllTransitions()" style="padding:6px 10px;background:#7f1d1d;color:#fca5a5;border:none;border-radius:5px;font-size:10px;cursor:pointer;">전체 제거</button>
  </div>`;

  el.innerHTML = html;
  _playTransitionPreview(tr.effect, tr.duration);
}

function _navTrPair(dir) {
  const slides = getOrderedSlides();
  if (slides.length < 2) return;
  const curIdx = slides.findIndex((s, i) => i < slides.length - 1
    && s.num === _selectedTrPair.from && slides[i + 1].num === _selectedTrPair.to);
  const newIdx = Math.max(0, Math.min(slides.length - 2, curIdx + dir));
  _selectedTrPair = { from: slides[newIdx].num, to: slides[newIdx + 1].num };
  selectSlide(newIdx + 1);
  renderTabTransition();
}

function selectTransition(effect) {
  if (_selectedTrPair) {
    setTransitionPair(_selectedTrPair.from, _selectedTrPair.to, "effect", effect);
  }
  renderTabTransition();
  renderTimeline();
}

function updateTransitionDur(dur) {
  if (_selectedTrPair) {
    setTransitionPair(_selectedTrPair.from, _selectedTrPair.to, "duration", dur);
  }
  renderTimeline();
}

function _applyTransitionToAll() {
  if (!_selectedTrPair) return;
  const tr = _getTransition(_selectedTrPair.from, _selectedTrPair.to);
  const slides = getOrderedSlides();
  if (!composeState.transitions) composeState.transitions = {};
  for (let i = 0; i < slides.length - 1; i++) {
    const k = _trKey(slides[i].num, slides[i + 1].num);
    composeState.transitions[k] = { effect: tr.effect, duration: tr.duration };
  }
  _dirty = true;
  renderTabTransition();
  renderTimeline();
}

function _removeAllTransitions() {
  const slides = getOrderedSlides();
  if (!composeState.transitions) composeState.transitions = {};
  for (let i = 0; i < slides.length - 1; i++) {
    const k = _trKey(slides[i].num, slides[i + 1].num);
    composeState.transitions[k] = { effect: "none", duration: 0 };
  }
  _dirty = true;
  renderTabTransition();
  renderTimeline();
}

function _playTransitionPreview(effect, dur) {
  const video = document.getElementById("transition-preview-video");
  if (!video) return;
  if (dur <= 0) { video.style.display = "none"; return; }
  video.style.display = "";

  const fromIdx = _selectedTrPair ? _selectedTrPair.from : 1;
  const toIdx = _selectedTrPair ? _selectedTrPair.to : 2;
  const src = `/api/jobs/${JOB_ID}/transition-preview?effect=${effect}&duration=${dur}&slide_from=${fromIdx}&slide_to=${toIdx}&t=${Date.now()}`;
  video.src = src;
  video.load();
  video.play().catch(() => {});
}


// ─── Tab: Narration ───

function renderTabNarration() {
  const el = document.getElementById("tab-narration");
  if (!el) return;

  const chCfg = composerData.channel_config || {};
  const curEngine = chCfg.tts_engine || "edge-tts";
  const clips = composeState.voice_clips || [];
  const subs = composeState.subtitle_entries || [];

  let html = `<div class="comp-tab-title">나레이션</div>`;

  // ── 음성 파일 풀 (드래그 가능) ──
  html += `<div class="comp-tab-subtitle" style="margin-top:4px;">음성 파일 풀</div>`;
  html += `<div style="margin-bottom:4px;font-size:9px;color:#6b7280;">타임라인 나레이션 트랙으로 드래그하세요</div>`;
  html += `<div style="margin-bottom:6px;">
    <input type="file" accept="audio/*" multiple id="narr-pool-input" class="hidden" onchange="uploadNarrFiles(this)">
    <button onclick="document.getElementById('narr-pool-input').click()"
      style="width:100%;padding:6px;background:#1e3a5f;color:#60a5fa;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">+ 음성 파일 추가</button>
  </div>`;

  if (_narrFilePool.length > 0) {
    _narrFilePool.forEach(f => {
      const inUse = clips.some(c => c.file === f.filename);
      html += `<div class="narr-pool-item ${inUse ? 'in-use' : ''}" draggable="true"
        ondragstart="onNarrDragStart(event, '${_esc(f.filename)}', ${f.duration}, '${f.url}')">
        <button onclick="event.stopPropagation(); previewAudio('${f.url}', this)" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:10px;padding:0 2px;">&#9654;</button>
        <span style="flex:1;color:${inUse ? '#5eead4' : '#d1d5db'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(f.filename)}">${_esc(f.filename)}</span>
        <span style="color:#6b7280;white-space:nowrap;">${f.duration.toFixed(1)}s</span>
        <button onclick="event.stopPropagation(); splitNarrationToAll('${_esc(f.filename)}')" style="background:none;border:none;color:#f59e0b;cursor:pointer;font-size:10px;padding:0 2px;" title="전체 슬라이드에 분할 배치">&#9998;</button>
        <button onclick="event.stopPropagation(); deleteNarrFile('${_esc(f.filename)}')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:10px;padding:0 2px;" title="삭제">&times;</button>
      </div>`;
    });
  } else {
    html += `<div style="font-size:10px;color:#6b7280;padding:4px;">업로드된 파일 없음</div>`;
  }
  html += `<div id="narr-pool-status" style="font-size:9px;color:#6b7280;margin-top:2px;margin-bottom:8px;"></div>`;

  // ── 배치된 음성 클립 ──
  // ── 자막 항목 ──
  // slide_audio에서 sentence_idx 매핑 구성
  const _sentIdxMap = {};  // text → sentence_idx
  if (composerData.slide_audio) {
    Object.values(composerData.slide_audio).flat().forEach(af => {
      if (af.text && af.sentence_idx !== undefined) _sentIdxMap[af.text] = af.sentence_idx;
    });
  }
  // voice_clips 수 표시
  const _clipCount = clips.length;
  const _audioLabel = _clipCount > 0 ? `<span style="color:#34d399;font-size:9px;margin-left:4px;">&#9835; ${_clipCount}개 클립</span>` : `<span style="color:#f59e0b;font-size:9px;margin-left:4px;">클립 없음</span>`;
  html += `<div class="comp-tab-subtitle" style="margin-top:8px;">자막 (${subs.length}개)${_audioLabel}</div>`;
  if (subs.length > 0) {
    subs.sort((a, b) => a.start_time - b.start_time).forEach((sub, si) => {
      const sentIdx = _sentIdxMap[sub.text] !== undefined ? _sentIdxMap[sub.text] : -1;
      // TTS 존재 여부: voice_clip 매칭 또는 slide_audio 매칭
      const _hasClip = clips.some(c => c.slide_num === sub.slide_num &&
        c.start_time < sub.end_time && (c.start_time + c.duration) > sub.start_time);
      const _hasAudio = sentIdx >= 0 || _hasClip;
      const _dotColor = _hasAudio ? '#34d399' : '#f59e0b';
      const _dotTitle = _hasAudio ? 'TTS 있음' : 'TTS 없음';
      html += `<div style="display:flex;align-items:center;gap:4px;padding:3px 4px;background:#1e2a45;border-radius:4px;margin-bottom:2px;font-size:10px;">
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${_dotColor};flex-shrink:0;" title="${_dotTitle}"></span>
        <input type="text" value="${_esc(sub.text)}" style="flex:1;background:#141b2d;border:1px solid #2d3748;border-radius:3px;color:#93c5fd;font-size:10px;padding:2px 4px;"
          onchange="_editSubtitleText('${sub.id}', this.value)">
        ${sentIdx >= 0 ? `<button onclick="_regenSingleTTS(${sentIdx}, '${sub.id}')" style="background:none;border:none;color:#34d399;cursor:pointer;font-size:10px;padding:0 2px;" title="이 문장 TTS 재생성">&#9654;</button>` : ''}
        <button onclick="_removeSubtitleEntry('${sub.id}')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:10px;padding:0 2px;" title="삭제">&times;</button>
      </div>`;
    });
  }
  html += `<button onclick="_addSubtitleEntry()" style="width:100%;padding:4px;background:#1e2a45;color:#60a5fa;border:1px dashed #3b82f6;border-radius:4px;font-size:10px;cursor:pointer;margin-top:4px;">+ 자막 추가</button>`;

  // ── TTS 섹션 ──
  html += `<div class="comp-tab-subtitle" style="margin-top:10px;">TTS 생성</div>`;
  const sl = getSelectedSlide();
  html += `<div class="ctrl-section">
    <div class="ctrl-row"><span class="ctrl-label">엔진</span>
      <select id="tts-engine" class="ctrl-input" style="font-size:10px;" onchange="_updateVoiceSelect()">
        <option value="edge-tts" ${curEngine === 'edge-tts' ? 'selected' : ''}>Edge TTS</option>
        <option value="google-cloud" ${curEngine === 'google-cloud' ? 'selected' : ''}>Google Cloud</option>
        <option value="gpt-sovits" ${curEngine === 'gpt-sovits' ? 'selected' : ''}>GPT-SoVITS</option>
        <option value="gemini-tts" ${curEngine === 'gemini-tts' ? 'selected' : ''}>Gemini TTS</option>
      </select>
    </div>
    <div class="ctrl-row" id="voice-row" style="margin-top:4px;"><span class="ctrl-label">음성</span>
      <select id="tts-voice" class="ctrl-input" style="font-size:10px;"></select>
    </div>
    <div class="ctrl-row" style="margin-top:4px;"><span class="ctrl-label">속도</span>
      <input type="range" id="tts-rate" min="-50" max="100" step="10" value="${chCfg.tts_rate ? parseInt(chCfg.tts_rate) : 0}"
        style="flex:1;accent-color:#34d399;" oninput="this.nextElementSibling.textContent=(this.value>0?'+':'')+this.value+'%'">
      <span style="font-size:9px;color:#9ca3af;width:34px;text-align:right;">${chCfg.tts_rate || '+0%'}</span>
    </div>
    <div id="tts-style-row" class="ctrl-row" style="margin-top:4px;${curEngine === 'gemini-tts' ? '' : 'display:none;'}"><span class="ctrl-label">스타일</span>
      <input id="tts-style" class="ctrl-input" style="font-size:10px;" value="${_esc(chCfg.gemini_tts_style || '')}" placeholder="음성 스타일 (Gemini TTS)">
    </div>
    <div class="ctrl-row" style="margin-top:4px;"><span class="ctrl-label">볼륨</span>
      <input type="range" min="0" max="100" value="${(composeState.narr_volume !== undefined ? composeState.narr_volume : 100)}"
        style="flex:1;accent-color:#34d399;" oninput="updateNarrVolume(+this.value)" title="나레이션 볼륨">
      <span id="narr-vol-val" style="font-size:9px;color:#9ca3af;width:28px;text-align:right;">${(composeState.narr_volume !== undefined ? composeState.narr_volume : 100)}%</span>
    </div>
    <div style="display:flex;gap:4px;margin-top:4px;">
      <button onclick="_generateTTSAndAddClips(${sl ? sl.num : 0})" id="btn-gen-tts"
        style="flex:1;padding:6px;background:#065f46;color:#34d399;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">TTS → 클립${sl ? ` (S${sl.num})` : ''}</button>
      <button onclick="_generateTTSAndAddClips(0)" id="btn-gen-all-tts"
        style="padding:6px 10px;background:#064e3b;color:#6ee7b7;border:none;border-radius:5px;font-size:10px;cursor:pointer;">전체</button>
    </div>
  </div>`;
  html += `<div id="tts-status" style="font-size:9px;color:#6b7280;margin-top:4px;"></div>`;

  // ── 자막 설정 ──
  const _so = composeState.subtitle_overrides || {};
  const _sget = (k, d) => _so[k] !== undefined ? _so[k] : (chCfg[k] !== undefined ? chCfg[k] : d);
  const subOn = _sget('subtitle_enabled', false);
  const subSize = _sget('subtitle_font_size', 48);
  const subOutline = _sget('subtitle_outline', 3);
  const subMargin = _sget('subtitle_margin_v', 100);
  const subFont = _sget('subtitle_font', 'Noto Sans KR');
  const subAlign = _sget('subtitle_alignment', 2);

  html += `<div class="comp-tab-subtitle" style="margin-top:10px;">자막 설정</div>
  <div class="ctrl-section">
    <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px;cursor:pointer;">
      <input type="checkbox" ${subOn ? 'checked' : ''} onchange="_updateSubtitleCfg('subtitle_enabled', this.checked)"
             style="accent-color:#6366f1;width:14px;height:14px;">
      <span style="font-size:11px;color:#d1d5db;">자막 표시</span>
    </label>
    <div style="${subOn ? '' : 'opacity:0.3;pointer-events:none;'}">
      <div class="ctrl-row"><span class="ctrl-label">폰트</span>
        <select class="ctrl-input" style="font-size:10px;" onchange="_updateSubtitleCfg('subtitle_font', this.value)">
          ${['Noto Sans KR','Malgun Gothic','맑은 고딕','Arial','NanumGothic','NanumSquare'].map(f =>
            `<option value="${f}" ${f === subFont ? 'selected' : ''}>${f}</option>`
          ).join('')}
        </select>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">위치</span>
        <select class="ctrl-input" style="font-size:10px;" onchange="_updateSubtitleCfg('subtitle_alignment', +this.value)">
          <option value="2" ${subAlign===2?'selected':''}>하단</option>
          <option value="8" ${subAlign===8?'selected':''}>상단</option>
          <option value="5" ${subAlign===5?'selected':''}>중앙</option>
        </select>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">크기</span>
        <input type="range" min="24" max="120" value="${subSize}" step="2" style="flex:1;accent-color:#6366f1;"
          oninput="_updateSubtitleCfg('subtitle_font_size', +this.value); this.nextElementSibling.textContent=this.value+'px';">
        <span style="font-size:9px;color:#9ca3af;width:35px;text-align:right;">${subSize}px</span>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">테두리</span>
        <input type="range" min="0" max="6" value="${subOutline}" style="flex:1;accent-color:#6366f1;"
          oninput="_updateSubtitleCfg('subtitle_outline', +this.value); this.nextElementSibling.textContent=this.value;">
        <span style="font-size:9px;color:#9ca3af;width:20px;text-align:right;">${subOutline}</span>
      </div>
      <div class="ctrl-row"><span class="ctrl-label">여백</span>
        <input type="range" min="20" max="500" value="${subMargin}" step="10" style="flex:1;accent-color:#6366f1;"
          oninput="_updateSubtitleCfg('subtitle_margin_v', +this.value); this.nextElementSibling.textContent=this.value+'px';">
        <span style="font-size:9px;color:#9ca3af;width:35px;text-align:right;">${subMargin}px</span>
      </div>
    </div>
  </div>`;

  el.innerHTML = html;
  _updateVoiceSelect();
}

// 음성 클립 삭제
function _removeVoiceClip(clipId) {
  composeState.voice_clips = (composeState.voice_clips || []).filter(c => c.id !== clipId);
  _dirty = true;
  renderVoiceClipTrack();
  renderTabNarration();
}

// 자막 항목 삭제
function _removeSubtitleEntry(entryId) {
  composeState.subtitle_entries = (composeState.subtitle_entries || []).filter(e => e.id !== entryId);
  _dirty = true;
  renderSubtitleTrack();
  renderTabNarration();
}

// 자막 텍스트 편집
function _editSubtitleText(entryId, newText) {
  const entry = (composeState.subtitle_entries || []).find(e => e.id === entryId);
  if (entry) {
    entry.text = newText;
    _dirty = true;
    renderSubtitleTrack();
    renderPreview();
  }
}

// 자막 추가
function _addSubtitleEntry() {
  const total = getTotalDuration() || 10;
  const lastSub = (composeState.subtitle_entries || []).slice(-1)[0];
  const startTime = lastSub ? lastSub.end_time : 0;
  composeState.subtitle_entries.push({
    id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    text: "새 자막",
    start_time: Math.round(Math.min(startTime, total - 2) * 10) / 10,
    end_time: Math.round(Math.min(startTime + 2, total) * 10) / 10,
  });
  _dirty = true;
  renderSubtitleTrack();
  renderTabNarration();
}

// 개별 문장 TTS 재생성
async function _regenSingleTTS(sentenceIdx, subId) {
  const status = document.getElementById("tts-status");
  if (status) status.textContent = `문장 ${sentenceIdx + 1} TTS 생성 중...`;

  const engine = document.getElementById("tts-engine")?.value || "edge-tts";
  const voice = document.getElementById("tts-voice")?.value || "";
  const rateVal = document.getElementById("tts-rate")?.value || "0";
  const styleVal = document.getElementById("tts-style")?.value || "";

  try {
    const body = { tts_engine: engine, tts_voice: voice, tts_rate: +rateVal, sentence_idx: sentenceIdx };
    if (engine === "gemini-tts" && styleVal) body.gemini_tts_style = styleVal;
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.ok) {
      await refreshData();
      // 해당 자막의 voice_clip 찾아서 duration 업데이트
      const allSentences = (composerData.slides || []).flatMap(s => s.sentences || []);
      const sent = allSentences[sentenceIdx];
      if (sent) {
        // slide_audio에서 새 duration 가져오기
        const slideNum = sent.slide || 1;
        const audioFiles = composerData.slide_audio ? composerData.slide_audio[slideNum] || [] : [];
        const af = audioFiles.find(a => a.sentence_idx === sentenceIdx);
        if (af) {
          // voice_clip 업데이트
          const clip = (composeState.voice_clips || []).find(c =>
            c.file === `audio_${sentenceIdx + 1}.mp3` || c.file === `audio_${sentenceIdx + 1}.wav`);
          if (clip) {
            clip.duration = af.duration;
            clip.path = af.path;
          }
          // subtitle_entry 업데이트
          const sub = (composeState.subtitle_entries || []).find(e => e.id === subId);
          if (sub) {
            sub.end_time = sub.start_time + af.duration;
          }
          // 슬라이드 duration 재계산
          const slideDur = audioFiles.reduce((s, a) => s + (a.duration || 0), 0);
          if (!composeState.slide_durations) composeState.slide_durations = {};
          composeState.slide_durations[slideNum] = slideDur;
          // duration 변경 시 후속 클립/자막 위치 재계산
          _recalcClipPositions();
        }
      }
      _dirty = true;
      renderTimeline();
      renderTabNarration();
      if (status) status.textContent = `문장 ${sentenceIdx + 1} 재생성 완료`;
    } else {
      if (status) status.textContent = `실패: ${data.error}`;
    }
  } catch (e) {
    if (status) status.textContent = `오류: ${e.message}`;
  }
}

// TTS 생성 후 voice_clips + subtitle_entries로 자동 배치
async function _generateTTSAndAddClips(slideNum) {
  const btn = slideNum > 0 ? document.getElementById("btn-gen-tts") : document.getElementById("btn-gen-all-tts");
  const status = document.getElementById("tts-status");
  if (btn) { btn.textContent = "생성 중..."; btn.disabled = true; }
  if (status) status.textContent = "TTS 생성 중...";

  const engine = document.getElementById("tts-engine")?.value || "edge-tts";
  const voice = document.getElementById("tts-voice")?.value || "";
  const rateVal = document.getElementById("tts-rate")?.value || "0";
  const styleVal = document.getElementById("tts-style")?.value || "";

  try {
    const body = { tts_engine: engine, tts_voice: voice, tts_rate: +rateVal };
    if (engine === "gemini-tts" && styleVal) body.gemini_tts_style = styleVal;
    if (slideNum > 0) body.slide_num = slideNum;
    const r = await fetch(`/api/jobs/${JOB_ID}/composer/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.ok) {
      if (status) status.textContent = `생성 완료 (${data.count}개 문장) — 클립 배치 중...`;
      await refreshData();

      // 대상 슬라이드 결정
      const targetSlides = slideNum > 0 ? [slideNum] : composeState.slide_order;

      // 1) 기존 클립/자막에서 대상 슬라이드 제거 (slide_num 없는 것도 제거)
      composeState.voice_clips = (composeState.voice_clips || []).filter(
        c => c.slide_num && !targetSlides.includes(c.slide_num)
      );
      composeState.subtitle_entries = (composeState.subtitle_entries || []).filter(
        e => e.slide_num && !targetSlides.includes(e.slide_num)
      );

      // 2) 슬라이드 duration을 slide_audio 기준으로 정확히 설정 (반올림 없이)
      if (!composeState.slide_durations) composeState.slide_durations = {};
      composeState.slide_order.forEach(sn => {
        const audioFiles = composerData.slide_audio ? composerData.slide_audio[sn] || [] : [];
        if (audioFiles.length > 0) {
          // 클립 duration 합과 정확히 일치하도록 반올림 없이 저장
          composeState.slide_durations[sn] = audioFiles.reduce((s, a) => s + (a.duration || 0), 0);
        }
      });

      // 3) voice_clips + subtitle_entries 배치 + cumTime을 slide_durations와 동일하게 산출
      let cumTime = 0;
      const slides = getOrderedSlides();
      slides.forEach(sl => {
        const slideDur = getSlideDuration(sl.num);
        if (targetSlides.includes(sl.num)) {
          const audioFiles = composerData.slide_audio ? composerData.slide_audio[sl.num] || [] : [];
          const sentences = sl.sentences || [];
          let clipTime = cumTime;
          audioFiles.forEach((af, ai) => {
            const dur = af.duration || 2.0;
            composeState.voice_clips.push({
              id: `vc_${sl.num}_${ai}_${Date.now()}`,
              file: af.file,
              path: af.path,
              start_time: clipTime,
              duration: dur,
              volume: composeState.narr_volume !== undefined ? composeState.narr_volume : 100,
              slide_num: sl.num,
            });
            const subText = af.text || (sentences[ai] && sentences[ai].text) || "";
            if (subText) {
              composeState.subtitle_entries.push({
                id: `sub_${sl.num}_${ai}_${Date.now()}`,
                text: subText,
                start_time: clipTime,
                end_time: clipTime + dur,
                slide_num: sl.num,
              });
            }
            clipTime += dur;
          });
        } else {
          // 대상이 아닌 슬라이드의 기존 클립/자막을 cumTime 기준으로 정렬
          const clips = composeState.voice_clips.filter(c => c.slide_num === sl.num);
          const subs = composeState.subtitle_entries.filter(e => e.slide_num === sl.num);
          if (clips.length > 0) {
            const firstStart = clips.reduce((m, c) => Math.min(m, c.start_time), Infinity);
            const offset = cumTime - firstStart;
            clips.forEach(c => { c.start_time += offset; });
            subs.forEach(e => { e.start_time += offset; e.end_time += offset; });
          }
        }
        cumTime += slideDur;
      });

      // 디버그: 클립 배치 확인
      console.log("[TTS] clip placement:", composeState.voice_clips.map(c =>
        `slide${c.slide_num} @${c.start_time}s dur=${c.duration.toFixed(2)}s`));
      console.log("[TTS] slide_durations:", JSON.stringify(composeState.slide_durations));

      _dirty = true;
      renderTimeline();
      renderTabNarration();
      if (status) status.textContent = `완료 — ${data.count}개 클립 배치됨`;
    } else {
      if (status) status.textContent = `실패: ${data.error || "알 수 없는 오류"}`;
    }
  } catch (e) {
    if (status) status.textContent = `오류: ${e.message}`;
  } finally {
    if (btn) { btn.textContent = slideNum > 0 ? "TTS → 클립" : "전체"; btn.disabled = false; }
  }
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

  // Gemini TTS일 때만 스타일 입력 표시
  const styleRow = document.getElementById("tts-style-row");
  if (styleRow) styleRow.style.display = engine === "gemini-tts" ? "" : "none";

  // GPT-SoVITS → 참조 음성 목록 로드
  if (engine === "gpt-sovits") {
    voiceRow.style.display = "";
    _loadSovitsVoices(voiceSel, chCfg.sovits_ref_voice || "");
    return;
  }

  // Gemini TTS → 프리빌트 음성
  if (engine === "gemini-tts") {
    voiceRow.style.display = "";
    const geminiVoices = {
      "Kore": "Kore (Firm)", "Puck": "Puck (Upbeat)", "Sulafat": "Sulafat (Warm)",
      "Charon": "Charon (Informative)", "Fenrir": "Fenrir (Excitable)", "Leda": "Leda (Youthful)",
      "Orus": "Orus (Firm)", "Aoede": "Aoede (Breezy)", "Zephyr": "Zephyr (Bright)",
      "Enceladus": "Enceladus (Breathy)", "Iapetus": "Iapetus (Clear)", "Umbriel": "Umbriel (Easy-going)",
      "Achernar": "Achernar (Soft)", "Achird": "Achird (Friendly)", "Gacrux": "Gacrux (Mature)",
      "Vindemiatrix": "Vindemiatrix (Gentle)", "Sadachbia": "Sadachbia (Lively)",
    };
    const defaultGemini = chCfg.gemini_tts_voice || "Kore";
    let opts = "";
    for (const [key, label] of Object.entries(geminiVoices)) {
      opts += `<option value="${key}" ${key === defaultGemini ? 'selected' : ''}>${label}</option>`;
    }
    voiceSel.innerHTML = opts;
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

function onNarrDragStart(e, filename, duration, url) {
  e.dataTransfer.setData("narr_file", filename);
  e.dataTransfer.setData("narr_duration", String(duration));
  e.dataTransfer.setData("narr_url", url);
}

// setupVoiceClipDrop, setupSfxDrop — now Canvas-based (_tlInit handles drag-drop)
function setupVoiceClipDrop() { /* handled by _tlInit */ }
function setupSfxDrop() { /* handled by _tlInit */ }

// renderSfxMarkers, renderBgmTrack — now Canvas-based
function renderSfxMarkers() { TL.needsRedraw = true; }
function renderBgmTrack() { TL.needsRedraw = true; }

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
  TL.needsRedraw = true;
  renderTabBgm();
  renderProps();
}

function removeBgm() {
  composeState.bgm = null;
  _dirty = true;
  TL.needsRedraw = true;
  renderTabBgm();
  renderProps();
}

function updateBgmProp(key, val) {
  if (!composeState.bgm) return;
  composeState.bgm[key] = val;
  _dirty = true;
  TL.needsRedraw = true;
}

// ─── Save & Render ───

async function saveCompose() {
  // runner 호환: transitions dict → slide_transitions 배열, slide_motions dict → 배열
  const saveData = { ...composeState };

  // transitions dict {"1>2": {effect,duration}} → [{slide:1, effect, duration}, ...]
  if (saveData.transitions && typeof saveData.transitions === "object" && !Array.isArray(saveData.transitions)) {
    const arr = [];
    const order = saveData.slide_order || [];
    for (let i = 0; i < order.length - 1; i++) {
      const key = `${order[i]}>${order[i+1]}`;
      const tr = saveData.transitions[key];
      if (tr) {
        arr.push({ slide: i + 1, effect: tr.effect, duration: tr.duration });
      } else {
        const chCfg = composerData?.channel_config || {};
        arr.push({ slide: i + 1, effect: chCfg.crossfade_transition || "fade", duration: chCfg.crossfade_duration ?? 0.5 });
      }
    }
    saveData.slide_transitions = arr;
  }

  // slide_motions dict {slideNum: motion} → [{slide, motion}, ...]
  if (saveData.slide_motions && typeof saveData.slide_motions === "object" && !Array.isArray(saveData.slide_motions)) {
    saveData.slide_motions = Object.entries(saveData.slide_motions).map(([k, v]) => ({ slide: parseInt(k), motion: v }));
  }

  const r = await fetch(`/api/jobs/${JOB_ID}/composer/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(saveData),
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

  const status = document.getElementById("audio-status");

  // 오디오가 이미 존재하면 TTS override를 보내지 않음 (기존 오디오 보존)
  // Composer에서 TTS 생성/업로드된 오디오가 있으면 재생성 방지
  const hasAudio = _checkAllHaveAudio();
  const bodyData = {};
  if (!hasAudio) {
    bodyData.tts_engine = document.getElementById("tts-engine")?.value || "edge-tts";
  }

  try {
    const r = await fetch(`/api/jobs/${JOB_ID}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyData),
    });
    if (r.ok) {
      btn.textContent = "렌더링 중...";
      if (status) status.textContent = "렌더링 진행 중...";
      // Composer에 머물면서 상태 폴링
      _pollRenderStatus();
    } else {
      const err = await r.json();
      btn.textContent = "실패";
      if (status) status.textContent = err.detail || "렌더링 시작 실패";
      setTimeout(() => { btn.textContent = "렌더링 시작"; btn.disabled = false; }, 3000);
    }
  } catch (e) {
    btn.textContent = "오류";
    if (status) status.textContent = `오류: ${e.message}`;
    setTimeout(() => { btn.textContent = "렌더링 시작"; btn.disabled = false; }, 3000);
  }
}

function _pollRenderStatus() {
  const btn = document.getElementById("btn-render");
  const status = document.getElementById("audio-status");
  let pollCount = 0;

  const poll = async () => {
    pollCount++;
    try {
      const r = await fetch(`/api/jobs/${JOB_ID}`);
      const job = await r.json();
      const st = job.status || "";
      const step = job.current_step || "";

      if (st === "completed") {
        btn.textContent = "렌더링 완료!";
        btn.style.background = "#065f46";
        if (status) status.textContent = "렌더링 완료 — 영상 생성됨";
        setTimeout(() => { btn.textContent = "렌더링 시작"; btn.disabled = false; btn.style.background = ""; }, 5000);
        return;
      } else if (st === "failed") {
        btn.textContent = "렌더링 실패";
        btn.style.background = "#7f1d1d";
        if (status) status.textContent = `실패: ${step}`;
        setTimeout(() => { btn.textContent = "렌더링 시작"; btn.disabled = false; btn.style.background = ""; }, 5000);
        return;
      } else {
        // 진행 중
        const stepLabels = { slides: "슬라이드", tts: "TTS", render: "영상합성", upload: "업로드" };
        const label = stepLabels[step] || step || "대기";
        btn.textContent = `렌더링 중... (${label})`;
        if (status) status.textContent = `렌더링 진행: ${label} (${pollCount * 3}초)`;
      }
    } catch {}

    // 최대 10분 폴링
    if (pollCount < 200) {
      setTimeout(poll, 3000);
    } else {
      btn.textContent = "렌더링 시작";
      btn.disabled = false;
      if (status) status.textContent = "시간 초과 — 대시보드에서 확인";
    }
  };

  setTimeout(poll, 3000);
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
  const origPxX = elem.x * SCALE, origPxY = elem.y * SCALE;
  function onMove(e2) {
    const rawX = origPxX + (e2.clientX - startX);
    const rawY = origPxY + (e2.clientY - startY);
    const snap = _snapToGuides(rawX, rawY, CANVAS_W, CANVAS_H);
    el.style.left = `${snap.x}px`;
    el.style.top = `${snap.y}px`;
    elem.x = Math.round(snap.x / SCALE);
    elem.y = Math.round(snap.y / SCALE);
    _showSnapGuide(snap.snapX, snap.snapY);
    _dirty = true;
  }
  function onUp() { _hideSnapGuides(); document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp); }
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
    const rawX = origLeft + (e2.clientX - startX);
    const rawY = origTop + (e2.clientY - startY);
    const snap = _snapToGuides(rawX, rawY, CANVAS_W, CANVAS_H);
    el.style.left = `${snap.x}px`;
    el.style.top = `${snap.y}px`;
    ft.x = Math.round(snap.x / SCALE);
    ft.y = Math.round(snap.y / SCALE);
    _showSnapGuide(snap.snapX, snap.snapY);
    _dirty = true;
  }
  function onUp() {
    _hideSnapGuides();
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
  const r = await fetch(`/api/jobs/${JOB_ID}/composer?_t=${Date.now()}`);
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
window.addEventListener("resize", () => { _updateScale(); renderPreview(); });
initComposer();
