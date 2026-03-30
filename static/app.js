/* ─── YouTube Shorts Dashboard JS ─── */

// ── zone 레이아웃 이미지 크기 계산 ──
function calcZoneImageSize(layout, bgDisplayMode, zoneRatio) {
  if (bgDisplayMode !== "zone" || layout === "full") return { w: 1080, h: 1920, ar: "9:16" };
  const parts = (zoneRatio || "3:4:3").split(":").map(Number).filter(n => !isNaN(n));
  if (parts.length !== 3) return { w: 1080, h: 1080, ar: "1:1" };
  const total = parts[0] + parts[1] + parts[2] || 1;
  let imgPct;
  if (layout === "center") imgPct = parts[1] / total;
  else if (layout === "top") imgPct = (parts[0] + parts[1]) / total;
  else if (layout === "bottom") imgPct = (parts[1] + parts[2]) / total;
  else return { w: 1080, h: 1920, ar: "9:16" };
  const imgH = Math.round(1920 * imgPct);
  let ar;
  if (imgH >= 1600) ar = "9:16";
  else if (imgH >= 1080) ar = "3:4";
  else if (imgH >= 810) ar = "1:1";
  else ar = "16:9";
  return { w: 1080, h: imgH, ar };
}

// ── 버튼 로딩 상태 공통 유틸 ──
function btnLoading(btn, label) {
  if (!btn) return;
  btn._origHTML = btn.innerHTML;
  btn._origDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.innerHTML = `<span class="inline-block animate-spin mr-1">⏳</span> ${label || '처리중...'}`;
}
function btnDone(btn, label, autoRestore) {
  if (!btn) return;
  btn.classList.remove('btn-loading');
  if (label) {
    btn.innerHTML = `✅ ${label}`;
    btn.classList.add('btn-done');
  }
  if (autoRestore !== false) {
    setTimeout(() => btnRestore(btn), 2000);
  }
}
function btnError(btn, label) {
  if (!btn) return;
  btn.classList.remove('btn-loading');
  btn.innerHTML = `❌ ${label || '실패'}`;
  btn.classList.add('btn-error');
  setTimeout(() => btnRestore(btn), 3000);
}
function btnRestore(btn) {
  if (!btn || !btn._origHTML) return;
  btn.innerHTML = btn._origHTML;
  btn.disabled = btn._origDisabled || false;
  btn.classList.remove('btn-loading', 'btn-done', 'btn-error');
  delete btn._origHTML;
  delete btn._origDisabled;
}

// ── 통합 지침 merge/split ──
function mergeInstructions(instructions, scriptRules, roundupRules) {
  let parts = [];
  const inst = (instructions || "").trim();
  const sr = (scriptRules || "").trim();
  const rr = (roundupRules || "").trim();

  if (inst) parts.push("# 채널 지침\n\n" + inst);
  if (sr) parts.push("# 대본 규칙\n\n" + sr);
  if (rr) parts.push("# 라운드업 규칙\n\n" + rr);

  // 아무 내용도 없으면 빈 문자열
  if (parts.length === 0) return "";
  // instructions만 있으면 헤더 없이 반환 (하위호환)
  if (parts.length === 1 && inst && !sr && !rr) return inst;
  return parts.join("\n\n");
}

function splitInstructions(unified) {
  const text = (unified || "").trim();
  if (!text) return { instructions: "", script_rules: "", roundup_rules: "" };

  // 섹션 헤더로 분리: # 채널 지침 / # 대본 규칙 / # 라운드업 규칙
  const sectionRe = /^# (채널 지침|대본 규칙|라운드업 규칙)\s*$/m;
  const result = { instructions: "", script_rules: "", roundup_rules: "" };

  const lines = text.split("\n");
  let currentKey = null;
  let buf = [];

  for (const line of lines) {
    const m = line.match(/^# (채널 지침|대본 규칙|라운드업 규칙)\s*$/);
    if (m) {
      // flush
      if (currentKey !== null) result[currentKey] = buf.join("\n").trim();
      else if (buf.join("\n").trim()) result.instructions = buf.join("\n").trim();
      buf = [];
      const label = m[1];
      if (label === "채널 지침") currentKey = "instructions";
      else if (label === "대본 규칙") currentKey = "script_rules";
      else if (label === "라운드업 규칙") currentKey = "roundup_rules";
      continue;
    }
    buf.push(line);
  }
  // flush last
  if (currentKey !== null) result[currentKey] = buf.join("\n").trim();
  else result.instructions = buf.join("\n").trim();

  return result;
}

const POLL_INTERVAL = 4000;
let pollTimer = null;
let channelsCache = [];
let currentDetailJobId = null;
let selectedChannelId = null;
let _completedCollapsed = true;
let _selectMode = false;
let _selectedJobs = new Set();
let _wizardStep = 1;
let _lastScriptData = null;
let _lastStepsData = null;
let _pollAbort = null;  // 폴링 요청 취소용
let _perSlideTts = {};  // 슬라이드별 TTS 설정: {slideNum: {engine, voice, rate, style}}
let _activeSlideTab = null;  // 현재 활성 슬라이드 탭 번호
const _collapsedChannels = new Set(JSON.parse(localStorage.getItem('collapsedChannels') || '[]'));

const STEP_ICONS = {
  synopsis:    "\uD83D\uDD0D",
  visual_plan: "\uD83C\uDFA8",
  script:      "\uD83D\uDCDD",
  slides:      "\uD83D\uDDBC\uFE0F",
  tts:         "\uD83D\uDD0A",
  render:      "\uD83C\uDFAC",
  upload:      "\uD83D\uDCE4",
};

const STEP_LABELS = {
  synopsis:    "시놉시스",
  visual_plan: "비주얼",
  script:      "대본",
  slides:      "슬라이드",
  tts:         "TTS",
  render:      "영상합성",
  upload:      "업로드",
};

const STEP_ORDER = ["synopsis", "visual_plan", "script", "slides", "tts", "render", "upload"];

const _CHANNEL_COLORS = [
  "rgba(234,88,12,0.25)",   // orange
  "rgba(59,130,246,0.25)",  // blue
  "rgba(168,85,247,0.25)",  // purple
  "rgba(34,197,94,0.25)",   // green
  "rgba(236,72,153,0.25)",  // pink
  "rgba(14,165,233,0.25)",  // sky
];
const _channelColorCache = {};
let _channelColorIdx = 0;
function _channelColor(name) {
  if (!name) return "rgba(107,114,128,0.25)";
  if (!_channelColorCache[name]) {
    _channelColorCache[name] = _CHANNEL_COLORS[_channelColorIdx % _CHANNEL_COLORS.length];
    _channelColorIdx++;
  }
  return _channelColorCache[name];
}

function _channelIcon(name) {
  if (!name) return "\uD83D\uDD25"; // 🔥
  const n = name.toLowerCase();
  if (n.includes("top5") || n.includes("top 5") || n.includes("순위")) return "\uD83D\uDCCA"; // 📊
  if (n.includes("코인") || n.includes("coin") || n.includes("crypto")) return "\u20BF"; // ₿
  if (n.includes("뉴스") || n.includes("news") || n.includes("30초")) return "\uD83D\uDCF0"; // 📰
  if (n.includes("이슈") || n.includes("issue")) return "\uD83D\uDD25"; // 🔥
  return "\uD83D\uDD25"; // 🔥
}

const STATUS_TEXT = {
  pending:         "대기",
  running:         "진행중",
  queued:          "큐 대기",
  waiting_slides:  "이미지 대기",
  completed:       "완료",
  failed:          "실패",
};

// ─── Init ───

document.addEventListener("DOMContentLoaded", () => {
  loadAll();
  startPolling();
  startUsagePolling();

  // Gemini 토글 초기화
  const geminiToggle = document.getElementById("gemini-toggle");
  if (geminiToggle) {
    geminiToggle.checked = !!localStorage.getItem("gemini_draft_on");
  }

  // 모달 바깥 클릭으로 닫기
  document.getElementById("job-detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal("job-detail-modal");
  });
  document.getElementById("manual-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal("manual-modal");
  });
  document.getElementById("news-browser-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal("news-browser-modal");
  });
});

let _prevDashboardHash = "";

async function loadAll() {
  // 이전 폴링 요청이 아직 진행 중이면 취소 (ConnectionReset 방지)
  if (_pollAbort) _pollAbort.abort();
  _pollAbort = new AbortController();
  let res;
  try {
    res = await fetch("/api/dashboard", { signal: _pollAbort.signal });
  } catch (e) {
    if (e.name === "AbortError") return; // 정상 취소
    throw e;
  }
  const raw = await res.json();
  const data = raw.channels || raw;   // {channels, claude_active}

  // Claude 상태 — dashboard 응답에 포함 (별도 API 호출 불필요)
  _updateClaudeDot(raw.claude_active);

  // 변경 감지: 해시 비교로 불필요한 리렌더링 방지
  const hash = JSON.stringify(data.map(ch => ({
    id: ch.id, name: ch.name, jobs: (ch.jobs || []).map(j => ({ id: j.id, status: j.status, steps: j.steps }))
  })));
  const changed = hash !== _prevDashboardHash;
  _prevDashboardHash = hash;

  channelsCache = data;

  if (changed) {
    // 채널 사이드바: 입력 필드에 포커스 없을 때만 리렌더링
    const reqFocused = document.activeElement?.id?.startsWith("req-");
    if (!reqFocused) renderChannels(channelsCache);
    renderMain(channelsCache);
  }
  updateHeaderStatus();

  // 상세 팝업이 열려있으면 자동 갱신 (스킵 조건: 초기 로딩 중, waiting_slides, 영상 재생 중)
  if (currentDetailJobId && !_detailLoading && !document.getElementById("job-detail-modal").classList.contains("hidden")) {
    const video = document.querySelector("#job-detail-content video");
    const isPlaying = video && !video.paused && !video.ended;
    if (isPlaying) return; // 영상 재생 중이면 새로고침 스킵

    const job = channelsCache.flatMap(ch => ch.jobs || []).find(j => j.id === currentDetailJobId);
    if (job && job.status !== "waiting_slides" && job.status !== "completed" && job.status !== "failed") {
      refreshJobDetail(currentDetailJobId);
    }
  }
}

// ─── Sidebar ───

function selectChannel(channelId) {
  selectedChannelId = selectedChannelId === channelId ? null : channelId;
  renderChannels(channelsCache);
  renderMain(channelsCache);
}

function renderChannels(channels) {
  const list = document.getElementById("channel-list");

  // 입력 필드 값 & 포커스 보존
  const savedInputs = {};
  let focusedId = null;
  channels.forEach(ch => {
    const el = document.getElementById(`req-${ch.id}`);
    if (el) {
      if (el.value) savedInputs[ch.id] = el.value;
      if (document.activeElement === el) focusedId = ch.id;
    }
  });

  list.innerHTML = channels.map(ch => {
    const hasRequest = (ch.default_topics || "").trim().length > 0;
    let statusText = "";
    if (ch.running_jobs > 0) statusText = `${ch.running_jobs}개 진행중`;
    else if (ch.queued_jobs > 0) statusText = `${ch.queued_jobs}개 큐 대기`;
    else if (ch.waiting_jobs > 0) statusText = `${ch.waiting_jobs}개 이미지 대기`;
    else if (ch.failed_jobs > 0) statusText = `${ch.failed_jobs}개 실패`;
    else if (ch.total_jobs > 0) statusText = `${ch.total_jobs}개 작업`;
    else if (!hasRequest) statusText = "요청 미설정";

    const isSelected = selectedChannelId === ch.id;
    const icon = _channelIcon(ch.name);

    // 스케줄 표시
    let scheduleTag = "";
    try {
      const _cfg = JSON.parse(ch.config || "{}");
      if (_cfg.schedule_enabled && (_cfg.schedule_times || []).length > 0) {
        scheduleTag = `<span class="text-[9px] text-orange-400 ml-1" title="${_cfg.schedule_times.join(', ')}">[${_cfg.schedule_times.join(',')}]</span>`;
      }
    } catch {}

    const collapsed = _collapsedChannels.has(ch.id);
    return `
      <div class="channel-item ${isSelected ? 'selected' : ''}" draggable="true" data-channel-id="${ch.id}" onclick="selectChannel('${ch.id}')">
        <div class="flex items-center gap-2">
          <span class="drag-handle text-gray-600 cursor-grab text-xs select-none" title="드래그하여 순서 변경">⠿</span>
          <span class="channel-icon">${icon}</span>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm"><span class="text-gray-500 text-xs mr-1">${ch.id}</span>${esc(ch.name)}${scheduleTag}</div>
            <div class="text-xs text-gray-500 mt-0.5">${statusText}</div>
          </div>
          <div class="flex items-center gap-1">
            <button class="ch-toolbar-btn" onclick="event.stopPropagation(); toggleChannelCollapse('${ch.id}')" title="${collapsed ? '펼치기' : '접기'}">${collapsed ? '▸' : '▾'}</button>
          </div>
        </div>
        <div class="mt-2 ${collapsed ? 'hidden' : ''}">
          <textarea id="req-${ch.id}" rows="2" placeholder="${esc(ch.default_topics || '요청 입력...')}"
                 onclick="event.stopPropagation()" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopPropagation();runChannel('${ch.id}',document.getElementById('run-btn-${ch.id}'))}"
                 class="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 placeholder-gray-600 mb-2 focus:border-orange-500 focus:outline-none resize-none leading-relaxed"></textarea>
          <div class="flex justify-between items-center">
            <button class="ch-settings-link" onclick="event.stopPropagation(); openChannelSettings('${ch.id}')">⚙ 설정</button>
            <div class="flex gap-2">
              <button onclick="event.stopPropagation(); openManualModal('${ch.id}')"
                      class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition">수동</button>
              <button id="run-btn-${ch.id}" onclick="event.stopPropagation(); runChannel('${ch.id}', this)"
                      class="px-3 py-1 bg-orange-600 hover:bg-orange-500 rounded text-xs font-medium transition">자동</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");
  // 입력 필드 값 & 포커스 복원
  for (const [cid, val] of Object.entries(savedInputs)) {
    const el = document.getElementById(`req-${cid}`);
    if (el) el.value = val;
  }
  if (focusedId) {
    const el = document.getElementById(`req-${focusedId}`);
    if (el) el.focus();
  }
  // 실행 중인 채널 버튼 로딩 상태 복원
  for (const cid of _runningChannels) {
    _setRunBtnLoading(cid, true);
  }
  // 드래그앤드롭 설정
  _initChannelDragDrop();
}

function toggleChannelCollapse(channelId) {
  if (_collapsedChannels.has(channelId)) {
    _collapsedChannels.delete(channelId);
  } else {
    _collapsedChannels.add(channelId);
  }
  localStorage.setItem('collapsedChannels', JSON.stringify([..._collapsedChannels]));
  renderChannels(channelsCache);
}

// ─── Main: 주제별 카드 ───

function renderMain(channels) {
  const container = document.getElementById("job-cards");

  // 선택된 채널이 있으면 해당 채널만, 없으면 전체 표시
  const filteredChannels = selectedChannelId
    ? channels.filter(ch => ch.id === selectedChannelId)
    : channels;

  const allJobs = [];
  for (const ch of filteredChannels) {
    for (const job of (ch.jobs || [])) {
      allJobs.push({ ...job, channelName: ch.name });
    }
  }

  if (allJobs.length === 0) {
    container.innerHTML = `
      <div class="text-gray-500 text-center py-20 col-span-full">
        <div class="text-4xl mb-4">&#128237;</div>
        <div>아직 작업이 없습니다</div>
        <div class="text-sm mt-1">채널의 실행 버튼을 눌러 시작하세요</div>
      </div>`;
    return;
  }

  // 업로드까지 완료된 것만 "완료", 나머지는 "진행중"
  const isFullyDone = j => j.status === "completed" && (j.steps?.upload === "completed");
  const activeJobs = allJobs.filter(j => !isFullyDone(j));
  const completedJobs = allJobs.filter(j => isFullyDone(j));

  let html = "";

  if (activeJobs.length > 0) {
    html += `<div class="col-span-full text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">진행중 (${activeJobs.length})</div>`;
    html += activeJobs.map(job => renderJobCard(job)).join("");
  }

  if (completedJobs.length > 0) {
    const isCollapsed = _completedCollapsed && activeJobs.length > 0;
    const selCount = _selectedJobs.size;
    html += `<div class="col-span-full flex items-center gap-2 mt-4 mb-1 select-none">
      <span class="text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer" onclick="toggleCompleted()">완료됨 (${completedJobs.length})</span>
      <span class="text-gray-600 text-xs cursor-pointer" onclick="toggleCompleted()">${isCollapsed ? '▶' : '▼'}</span>
      ${!isCollapsed ? `<button onclick="toggleSelectMode()" class="text-xs px-2 py-0.5 rounded ${_selectMode ? 'bg-orange-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'} transition ml-2">선택</button>` : ''}
      ${_selectMode && !isCollapsed ? `
        <label class="text-xs text-gray-400 flex items-center gap-1 ml-1 cursor-pointer">
          <input type="checkbox" onchange="toggleSelectAll(this.checked)" ${selCount === completedJobs.length && selCount > 0 ? 'checked' : ''}> 전체
        </label>
        <button onclick="deleteSelectedJobs()" class="text-xs px-2 py-0.5 rounded bg-red-800 hover:bg-red-700 text-red-200 transition ${selCount === 0 ? 'opacity-50 cursor-not-allowed' : ''}" ${selCount === 0 ? 'disabled' : ''}>삭제 (${selCount})</button>
      ` : ''}
    </div>`;
    if (!isCollapsed) {
      html += completedJobs.map(job => renderJobCard(job, true)).join("");
    }
  }

  container.innerHTML = html;
}

function toggleCompleted() {
  _completedCollapsed = !_completedCollapsed;
  if (_completedCollapsed) { _selectMode = false; _selectedJobs.clear(); }
  renderMain(channelsCache);
}

function toggleSelectMode() {
  _selectMode = !_selectMode;
  if (!_selectMode) _selectedJobs.clear();
  renderMain(channelsCache);
}

function toggleJobSelect(jobId) {
  if (_selectedJobs.has(jobId)) _selectedJobs.delete(jobId);
  else _selectedJobs.add(jobId);
  renderMain(channelsCache);
}

function toggleSelectAll(checked) {
  const allJobs = channelsCache.flatMap(ch => (ch.jobs || []).map(j => ({ ...j, channelName: ch.name })));
  const completedIds = allJobs.filter(j => j.status === "completed" && j.steps?.upload === "completed").map(j => j.id);
  if (checked) completedIds.forEach(id => _selectedJobs.add(id));
  else _selectedJobs.clear();
  renderMain(channelsCache);
}

async function deleteSelectedJobs() {
  const count = _selectedJobs.size;
  if (count === 0) return;
  if (!confirm(`선택한 ${count}개 작업을 삭제하시겠습니까?`)) return;

  const ids = [..._selectedJobs];
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      ok++;
    } catch (e) { fail++; }
  }
  _selectedJobs.clear();
  _selectMode = false;
  loadAll();
  if (fail > 0) alert(`${ok}개 삭제, ${fail}개 실패`);
}

function renderJobCard(job, isCompleted = false) {
  // 업로드 안 됐으면 "영상 완성"으로 표시
  let displayStatus = job.status;
  if (job.status === "completed" && job.steps["upload"] !== "completed") {
    displayStatus = "rendered";
  }
  const statusClass = `status-${displayStatus}`;
  const statusText = displayStatus === "rendered" ? "영상 완성" : (STATUS_TEXT[job.status] || job.status);

  // 현재 활성 단계 찾기
  let activeStep = "";
  for (const step of STEP_ORDER) {
    if (job.steps[step] === "running") { activeStep = STEP_LABELS[step]; break; }
  }
  if (job.status === "waiting_slides") activeStep = (job.uploaded_bg_count > 0) ? "영상 제작 대기" : "이미지 업로드 필요";
  if (job.status === "queued") activeStep = job.queue_position ? `대기 ${job.queue_position}번째` : "곧 시작";

  // 누락 단계 보정 (가장 늦은 완료 단계 이전은 completed)
  let latestDoneIdx = -1;
  for (const name of STEP_ORDER) {
    const st = job.steps[name];
    if (st === "completed" || st === "skipped") {
      const idx = STEP_ORDER.indexOf(name);
      if (idx > latestDoneIdx) latestDoneIdx = idx;
    }
  }
  for (let i = 0; i < latestDoneIdx; i++) {
    if (!job.steps[STEP_ORDER[i]]) job.steps[STEP_ORDER[i]] = "completed";
  }

  // 진행률 계산
  const completed = STEP_ORDER.filter(s => job.steps[s] === "completed" || job.steps[s] === "skipped").length;
  const pct = Math.round((completed / STEP_ORDER.length) * 100);

  const jobNum = job.id.replace(/^job-\d+-0*/, "#");

  const showCheck = isCompleted && _selectMode;
  const isChecked = _selectedJobs.has(job.id);

  // 좌측 보더 색상 클래스
  const borderClass = displayStatus === "rendered" ? "border-l-rendered"
    : job.status === "running" ? "border-l-running"
    : job.status === "completed" ? "border-l-completed"
    : job.status === "failed" ? "border-l-failed"
    : (job.status === "waiting_slides") ? "border-l-waiting"
    : job.status === "queued" ? "border-l-queued" : "";

  // 단계 아이콘 시퀀스
  const CARD_STEPS = ["synopsis", "visual_plan", "script", "slides", "tts", "render", "upload"];
  const CARD_ICONS = { synopsis: "\uD83D\uDD0D", visual_plan: "\uD83C\uDFA8", script: "\uD83D\uDCDD", slides: "\uD83D\uDDBC\uFE0F", tts: "\uD83D\uDD0A", render: "\uD83C\uDFAC", upload: "\uD83D\uDCE4" };
  let stepSeqHtml = CARD_STEPS.map((s, i) => {
    const st = job.steps[s];
    let cls = "seq-pending";
    if (st === "completed" || st === "skipped") cls = st === "skipped" ? "seq-skipped" : "seq-done";
    else if (st === "running") cls = "seq-active";
    else if (st === "failed") cls = "seq-failed";
    const arrow = i < CARD_STEPS.length - 1 ? `<span class="step-seq-arrow">›</span>` : "";
    return `<span class="step-seq-item ${cls}" title="${STEP_LABELS[s] || s}">${CARD_ICONS[s]}</span>${arrow}`;
  }).join("");

  return `
    <div class="job-card ${borderClass} ${isChecked ? 'ring-1 ring-orange-500' : ''}" onclick="${showCheck ? `toggleJobSelect('${job.id}')` : `openJobDetail('${job.id}')`}">
      <div class="flex items-start justify-between mb-2">
        ${showCheck ? `<input type="checkbox" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation(); toggleJobSelect('${job.id}')" class="mt-1 mr-2 accent-orange-500 flex-shrink-0">` : ''}
        <div class="font-medium text-sm leading-tight flex-1 mr-2"><span class="text-gray-500 text-xs mr-1">${jobNum}</span>${esc(job.topic)}</div>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="mb-1"><span class="channel-tag" style="background:${_channelColor(job.channelName)}">${esc(job.channelName || '')}</span></div>
      ${activeStep ? `<div class="text-xs text-gray-500 mb-2">${activeStep}</div>` : ""}
      <div class="step-seq">${stepSeqHtml}</div>
      <div class="flex items-center gap-2">
        <div class="flex-1 bg-gray-800 rounded-full h-2">
          <div class="h-2 rounded-full transition-all duration-500 ${job.status === 'failed' ? 'bg-red-500' : job.status === 'completed' ? 'bg-green-500' : job.status === 'waiting_slides' ? 'bg-yellow-500' : job.status === 'queued' ? 'bg-blue-500' : 'bg-orange-500'}"
               style="width: ${pct}%"></div>
        </div>
        <span class="text-xs text-gray-500 w-8 text-right">${pct}%</span>
      </div>
      <div class="flex items-center justify-between mt-2">
        <div class="text-xs text-gray-600">${formatTime(job.created_at)}</div>
        <button onclick="event.stopPropagation(); deleteJob('${job.id}', '${job.status}')" class="text-xs text-gray-600 hover:text-red-400 transition">삭제</button>
      </div>
    </div>
  `;
}

// ─── Job Detail Popup ───

let _detailLoading = false;

async function openJobDetail(jobId) {
  currentDetailJobId = jobId;
  _lastDetailStatus = null;
  _lastDetailHadScript = false;
  _detailLoading = true;
  _wizardStep = 1; // will be auto-determined after data load
  _slideTransitions = []; // 전환효과 캐시 초기화
  _slideMotions = []; // 모션 캐시 초기화
  _selectedPreviewSlide = 1;
  document.getElementById("job-detail-modal").classList.remove("hidden");
  document.getElementById("job-detail-content").innerHTML = `
    <div class="text-center py-8 text-gray-500">로딩중...</div>`;
  await refreshJobDetail(jobId, true);
  _detailLoading = false;
}

let _lastDetailStatus = null;
let _lastDetailHadScript = false;

async function refreshJobDetail(jobId, autoStep = false) {
  try {
    const [scriptRes, stepsRes] = await Promise.all([
      fetch(`/api/jobs/${jobId}/script`),
      fetch(`/api/jobs/${jobId}/steps`),
    ]);

    // fetch 도중 다른 작업이 열렸으면 렌더링 스킵 (stale 응답 방지)
    if (jobId !== currentDetailJobId) return;

    const scriptData = await scriptRes.json();
    const stepsData = await stepsRes.json();

    // 캐시 저장
    _lastScriptData = scriptData;
    _lastStepsData = stepsData;

    const status = scriptData.status;
    const hasScript = !!scriptData.script;
    const isRunning = status === "running";
    const wasRunning = _lastDetailStatus === "running";
    const scriptChanged = hasScript !== _lastDetailHadScript;

    // running → running 동일 상태: 부분 갱신 (깜박임 방지)
    if (isRunning && wasRunning && !scriptChanged && document.getElementById("pipeline-steps-live")) {
      _patchRunningDetail(scriptData, stepsData);
      _lastDetailStatus = status;
      return;
    }

    _lastDetailStatus = status;
    _lastDetailHadScript = hasScript;

    // 자동 스텝 결정 (최초 오픈 시)
    if (autoStep) {
      _wizardStep = determineWizardStep(scriptData, stepsData);
    }

    renderJobDetail(scriptData, stepsData);
  } catch (e) {
    console.error("refreshJobDetail error:", e);
    document.getElementById("job-detail-content").innerHTML = `
      <div class="text-red-400 text-center py-8">데이터 로드 실패: ${e.message}</div>`;
  }
}

function _patchRunningDetail(scriptData, stepsData) {
  const steps = stepsData.steps || [];
  const { status, script, job_id } = scriptData;

  // 다른 작업 팝업으로 바뀌었으면 패치 스킵
  if (currentDetailJobId && job_id !== currentDetailJobId) return;

  const stepStatus = {};
  for (const s of steps) stepStatus[s.step_name] = s.status || "pending";

  // render 완료 but 아직 running view → 전체 재렌더링으로 video UI 전환
  if (stepStatus["render"] === "completed" && document.getElementById("running-status-msg")) {
    _wizardStep = determineWizardStep(scriptData, stepsData);
    renderJobDetail(scriptData, stepsData);
    return;
  }

  // 파이프라인 노드 상태만 업데이트 (클래스 교체)
  const container = document.getElementById("pipeline-steps-live");
  if (container) {
    const nodes = container.querySelectorAll(".step-node");
    STEP_ORDER.forEach((name, idx) => {
      const st = stepStatus[name] || "pending";
      if (nodes[idx]) {
        nodes[idx].className = `step-node step-${st}`;
      }
    });
    // 화살표 업데이트
    const arrows = container.querySelectorAll(".step-arrow");
    STEP_ORDER.forEach((name, idx) => {
      if (idx === 0) return;
      const arrow = arrows[idx - 1];
      if (!arrow) return;
      const prevSt = stepStatus[STEP_ORDER[idx - 1]];
      let cls = "step-arrow";
      if (prevSt === "completed" || prevSt === "skipped") cls += " done";
      if (stepStatus[name] === "running") cls += " active";
      arrow.className = cls;
    });
  }

  // 진행 메시지 업데이트
  const msgEl = document.getElementById("running-status-msg");
  if (msgEl) {
    const runningStep = steps.find(s => s.status === "running");
    const label = runningStep ? (STEP_LABELS[runningStep.step_name] || runningStep.step_name) : "영상";
    msgEl.innerHTML = `<span class="inline-block animate-pulse">⏳</span> ${esc(label)} 진행 중...`;
  }

  // 렌더 완료 시 영상 미리보기 추가 (아직 없으면)
  if (stepStatus["render"] === "completed" && !document.querySelector("#job-detail-content .video-preview")) {
    const videoArea = document.getElementById("running-video-area");
    if (videoArea) {
      videoArea.innerHTML = `
        <div class="flex flex-col items-center py-4 gap-3">
          <div class="text-sm font-semibold text-gray-300 w-full">영상 미리보기</div>
          <video class="video-preview" controls preload="metadata"
                 poster="/api/jobs/${job_id}/thumbnail?t=${Date.now()}"
                 onloadeddata="this.currentTime=0.1">
            <source src="/api/jobs/${job_id}/video?t=${Date.now()}" type="video/mp4">
          </video>
        </div>`;
    }
  }
}

// ─── Wizard: Step Determination ───

function determineWizardStep(scriptData, stepsData) {
  const { status, script, uploaded_backgrounds } = scriptData;
  const steps = stepsData.steps || [];
  const stepStatus = {};
  for (const s of steps) stepStatus[s.step_name] = s.status || "pending";

  if (status === "pending" || (status === "running" && !script)) return 1;
  if (status === "waiting_slides") {
    const _ipc = (scriptData.image_prompts || []).filter(p => (typeof p === "object" ? p.en : p)).length;
    const bgCount = _ipc > 0 ? _ipc : (script?.slides || []).filter(s => s.bg_type !== "closing").length;
    const uploadedCount = Object.keys(uploaded_backgrounds || {}).length;
    return uploadedCount > 0 ? 2 : 1;
  }
  if (status === "queued" || status === "completed") return 4;
  if (status === "running" && script) {
    // Phase B — check if slides step is done
    if (stepStatus["slides"] === "completed" || stepStatus["tts"] === "running" || stepStatus["tts"] === "completed" ||
        stepStatus["render"] === "running" || stepStatus["render"] === "completed") return 4;
    return 2;
  }
  if (status === "failed") {
    const failedStep = steps.find(s => s.status === "failed");
    const fn = failedStep ? failedStep.step_name : "";
    if (["synopsis", "visual_plan", "script"].includes(fn)) return 1;
    if (["slides", "tts"].includes(fn)) return 2;
    return 4;
  }
  return 1;
}

function renderWizardNav(step, scriptData, stepsData) {
  const { status, script, uploaded_backgrounds, image_prompts } = scriptData;
  const labels = ["대본 작성", "이미지 + 음성", "전환효과", "영상 제작"];
  const icons = ["📝", "🖼️", "✨", "🎬"];

  const hasScript = !!script;
  const slides = script?.slides || [];
  const _npc = (image_prompts || []).filter(p => (typeof p === "object" ? p.en : p)).length;
  const bgCount = _npc > 0 ? _npc : slides.filter(s => s.bg_type !== "closing").length;
  const uploadedCount = Object.keys(uploaded_backgrounds || {}).length;
  const stepStatuses = {};
  for (const s of (stepsData.steps || [])) stepStatuses[s.step_name] = s.status || "pending";
  const renderDone = stepStatuses["render"] === "completed";

  const isDone = [
    hasScript,
    hasScript && uploadedCount >= bgCount && bgCount > 0,
    hasScript && uploadedCount >= bgCount && bgCount > 0,
    renderDone || status === "completed",
  ];

  let html = '<div class="wizard-nav">';
  for (let i = 0; i < 4; i++) {
    if (i > 0) {
      const lineCls = isDone[i - 1] ? "done" : ((i + 1 === step) ? "active" : "");
      html += `<div class="wizard-step-line ${lineCls}"></div>`;
    }
    const isActive = (i + 1 === step);
    const cls = isActive ? "active" : (isDone[i] ? "done" : "");
    const numContent = isDone[i] && !isActive ? "&#10003;" : (i + 1);
    html += `
      <div class="wizard-step-item ${cls}" onclick="navigateWizard(${i + 1})">
        <div class="wizard-step-num">${numContent}</div>
        <div class="wizard-step-label">${icons[i]} ${labels[i]}</div>
      </div>`;
  }
  html += '</div>';
  return html;
}

function navigateWizard(step) {
  if (step < 1 || step > 4) return;
  _wizardStep = step;
  if (_lastScriptData && _lastStepsData) {
    renderJobDetail(_lastScriptData, _lastStepsData);
  }
}

// ─── Wizard: Step Renderers ───

function renderWizardStep1(jobId, scriptData, stepsData) {
  const { status, script } = scriptData;
  const steps = stepsData.steps || [];

  if (!script) {
    // 대본 미생성 — 진행중 또는 대기
    const runningStep = steps.find(s => s.status === "running");
    const label = runningStep ? (STEP_LABELS[runningStep.step_name] || runningStep.step_name) : "대본";
    if (status === "running") {
      return `<div class="wizard-step-content">
        <div id="running-status-msg" class="text-center py-12 text-gray-400">
          <span class="inline-block animate-pulse text-2xl mb-2">⏳</span><br>
          ${esc(label)} 진행 중...
        </div>
      </div>`;
    }
    if (status === "failed") {
      const failedStep = steps.find(s => s.status === "failed");
      const errMsg = failedStep ? failedStep.error_msg : "알 수 없는 오류";
      const shortErr = (errMsg || "").length > 200 ? (errMsg.substring(0, 200) + "...") : (errMsg || "");
      return `<div class="wizard-step-content">
        <div class="text-center py-6">
          <div class="text-red-400 text-lg mb-2">제작 실패</div>
          <div class="text-sm text-gray-500 mb-3 max-h-24 overflow-y-auto text-left px-4" style="word-break:break-all;">${esc(shortErr)}</div>
          <button onclick="retryJob('${jobId}')" class="px-6 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition">재시도</button>
        </div>
      </div>`;
    }
    return `<div class="wizard-step-content"><div class="text-center py-8 text-gray-500">대기중</div></div>`;
  }

  const slides = script.slides || [];
  const sentences = script.sentences || [];

  // 슬라이드 보기
  let slideView = `<div class="script-panel slide-edit-layout" id="script-slide-view"><div class="slide-edit-left">`;
  slides.forEach((s, i) => {
    const isClosing = i === slides.length - 1;
    // <br>을 \n으로 변환하여 textarea에 표시, 저장 시 다시 <br>로 변환
    const mainText = (s.main || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, (m) => m);
    const subText = (s.sub || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, (m) => m);
    slideView += `
      <div class="slide-item">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs font-bold text-orange-400">${i + 1}</span>
          <span class="text-xs text-gray-500">${esc(s.category || "")}</span>
          <span class="text-xs text-gray-600">${s.bg_type || ""}</span>
        </div>
        <textarea class="slide-edit-main" data-slide-idx="${i}" rows="2" placeholder="메인 텍스트">${mainText}</textarea>
        <textarea class="slide-edit-sub" data-slide-idx="${i}" rows="1" placeholder="서브 텍스트">${subText}</textarea>
        ${isClosing ? `<span class="text-xs text-gray-600">(클로징)</span>` : ""}
      </div>`;
  });
  slideView += `</div><div class="slide-edit-right">
    <div class="flex items-center gap-2 mb-3">
      <button onclick="saveSlideScript('${jobId}')" id="btn-save-slides"
              class="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 rounded text-xs font-medium transition">저장</button>
      <span id="slide-save-msg" class="text-xs text-green-400 hidden">저장 완료</span>
    </div>
    <div class="fmt-toolbar-title">텍스트 서식</div>
    <div class="fmt-group">
      <div class="fmt-label">스타일</div>
      <div class="fmt-row">
        <button onmousedown="event.preventDefault()" onclick="slideFormatHL()" class="fmt-btn" title="강조 (노란색)">HL</button>
        <button onmousedown="event.preventDefault()" onclick="slideFormatBold()" class="fmt-btn" title="굵게"><b>B</b></button>
        <button onmousedown="event.preventDefault()" onclick="slideFormatItalic()" class="fmt-btn" title="기울임"><i>I</i></button>
      </div>
    </div>
    <div class="fmt-group">
      <div class="fmt-label">크기</div>
      <div class="fmt-row">
        <button onmousedown="event.preventDefault()" onclick="slideFormatSize('130%')" class="fmt-btn" title="크게">A+</button>
        <button onmousedown="event.preventDefault()" onclick="slideFormatSize('80%')" class="fmt-btn" title="작게">A-</button>
      </div>
    </div>
    <div class="fmt-group">
      <div class="fmt-label">색상</div>
      <div class="fmt-row">
        <button onmousedown="event.preventDefault()" onclick="slideFormatColor('#ffd700')" class="fmt-btn fmt-color" title="노란색" style="background:#ffd700"></button>
        <button onmousedown="event.preventDefault()" onclick="slideFormatColor('#ff4444')" class="fmt-btn fmt-color" title="빨간색" style="background:#ff4444"></button>
        <button onmousedown="event.preventDefault()" onclick="slideFormatColor('#4fc3f7')" class="fmt-btn fmt-color" title="파란색" style="background:#4fc3f7"></button>
        <button onmousedown="event.preventDefault()" onclick="slideFormatColor('#66bb6a')" class="fmt-btn fmt-color" title="초록색" style="background:#66bb6a"></button>
        <button onmousedown="event.preventDefault()" onclick="slideFormatColor('#ffffff')" class="fmt-btn fmt-color" title="흰색" style="background:#ffffff"></button>
      </div>
    </div>
    <div class="fmt-group">
      <div class="fmt-label">삽입</div>
      <div class="fmt-row">
        <button onmousedown="event.preventDefault()" onclick="slideInsertBR()" class="fmt-btn" title="줄바꿈">↵ 줄바꿈</button>
      </div>
    </div>
    <div class="fmt-hint">텍스트 선택 후 버튼 클릭</div>
  </div></div>`;

  // 나레이션 대본 — 슬라이드별 textarea 1개
  let narrationView = `<div class="script-panel hidden" id="script-narration-view">`;
  // 슬라이드별로 문장 그룹핑
  const slideGroups = {};
  sentences.forEach(sen => {
    if (!slideGroups[sen.slide]) slideGroups[sen.slide] = [];
    slideGroups[sen.slide].push(sen.text);
  });
  const slideNums = Object.keys(slideGroups).map(Number).sort((a, b) => a - b);
  slideNums.forEach((slideNum, idx) => {
    const lines = slideGroups[slideNum];
    const rows = Math.max(2, lines.length);
    narrationView += `<div class="text-xs text-orange-400 font-bold mt-2 mb-1 flex items-center justify-between ${idx > 0 ? 'pt-2 border-t border-gray-800' : ''}">
      <span>슬라이드 ${slideNum}</span>
      <button onclick="copySlideNarration(${slideNum})" class="text-gray-500 hover:text-white transition" title="이 슬라이드 복사">📋</button>
    </div>`;
    narrationView += `<div class="text-sm text-gray-300 py-0.5">
      <textarea class="narration-slide-input" data-slide="${slideNum}"
                rows="${rows}" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'">${esc(lines.join("\n"))}</textarea>
    </div>`;
  });
  narrationView += `<div class="mt-3 flex gap-2 items-center">
    <button onclick="saveNarrationScript('${jobId}')" id="btn-save-narration"
            class="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 rounded text-xs font-medium transition">💾 저장</button>
    <button onclick="copyAllNarration()" class="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition">📋 전체 복사</button>
    <span id="narration-save-msg" class="text-xs text-green-400 self-center hidden"></span>
  </div>`;
  narrationView += `</div>`;

  return `
    <div class="wizard-step-content" id="tab-script">
      <div class="flex gap-2 mb-2">
        <button class="script-view-btn active" onclick="switchScriptView('slide', this)">슬라이드</button>
        <button class="script-view-btn" onclick="switchScriptView('narration', this)">나레이션 대본</button>
      </div>
      <div class="mb-3">${slideView}${narrationView}</div>
    </div>`;
}

function renderWizardStep2(jobId, scriptData, stepsData) {
  const { script, uploaded_backgrounds, has_narration, image_prompts, status } = scriptData;
  window._bgSource = scriptData.auto_bg_source || "sd_image";
  window._slideLayout = scriptData.slide_layout || "full";
  const _chCfg2 = scriptData.channel_config || {};
  const _bgDisplayMode = _chCfg2.bg_display_mode || "zone";
  const _zoneRatio = _chCfg2.slide_zone_ratio || "3:4:3";
  const _imgSize = calcZoneImageSize(window._slideLayout, _bgDisplayMode, _zoneRatio);
  window._imgSizeLabel = `📐 ${_imgSize.w}×${_imgSize.h}`;

  if (!script) return `<div class="wizard-step-content"><div class="text-center py-8 text-gray-500">먼저 대본을 생성하세요</div></div>`;

  const slides = script.slides || [];
  const slideCount = slides.length;
  const _imgPromptCount = (image_prompts || []).filter(p => (typeof p === "object" ? p.en : p)).length;
  const bgCount = _imgPromptCount > 0 ? _imgPromptCount : slides.filter(s => s.bg_type !== "closing").length;
  const uploadedBgs = uploaded_backgrounds || {};
  const uploadedCount = Object.keys(uploadedBgs).length;
  const steps = stepsData.steps || [];

  // === Left column: Images ===
  const imgPrompts = image_prompts || [];
  const hasImgPrompts = imgPrompts.length > 0;
  let imgPromptsHtml = "";
  if (hasImgPrompts) {
    const items = imgPrompts.map((p, i) => {
      const ko = typeof p === "object" ? (p.ko || "") : "";
      const en = typeof p === "object" ? (p.en || "") : String(p);
      const motion = typeof p === "object" ? (p.motion || "") : "";
      const media = typeof p === "object" ? (p.media || "image") : "image";
      const slideNum = typeof p === "object" ? (p.slide || i+1) : i+1;
      if (!ko && !en) return "";  // 클로징 등 빈 프롬프트 숨김
      const copyText = [ko, en, motion].filter(Boolean).join("\\n");
      // 같은 슬라이드에 여러 프롬프트면 슬라이드 번호 표시
      const slideLabel = slideNum !== (i+1) ? ` <span class="text-gray-600">S${slideNum}</span>` : "";
      const mediaBadge = media === "video"
        ? `<span class="ml-1 px-1 rounded text-[10px] font-bold bg-purple-700 text-purple-200">VIDEO</span>`
        : `<span class="ml-1 px-1 rounded text-[10px] font-bold bg-gray-700 text-gray-400">IMAGE</span>`;
      return `<div class="text-xs py-1 border-b border-gray-800">
        <div class="flex items-start justify-between gap-1">
          <div class="flex-1">
            <span class="text-orange-400 font-bold mr-1">${i+1}.${slideLabel}</span>${mediaBadge}
            ${ko ? `<br><span class="text-gray-300">${esc(ko)}</span>` : ""}
            <br><span class="text-gray-500">${esc(en)}</span>
            ${motion ? `<br><span class="text-blue-400">🎬 ${esc(motion)}</span>` : ""}
          </div>
          <div class="flex gap-1 flex-shrink-0 items-start">
            ${(() => {
              const bgUrl = uploadedBgs[i+1] || "";
              const isMp4 = bgUrl.includes(".mp4");
              return isMp4
                ? `<span class="rounded bg-green-800 text-green-300 flex-shrink-0 font-bold" style="font-size:10px;padding:2px 5px;line-height:1;">MP4</span>`
                : `<button onclick="event.stopPropagation(); bgToVideo('${jobId}', ${i+1}, this)" class="rounded bg-purple-800 hover:bg-purple-600 text-purple-200 flex-shrink-0 font-bold" title="영상화 (Veo)" style="font-size:10px;padding:2px 5px;line-height:1;">VEO</button>`;
            })()}
            <button onclick="event.stopPropagation(); copyOnePrompt(this)" class="copy-icon-btn text-gray-600 hover:text-white flex-shrink-0" style="font-size:11px;padding:1px 3px;" data-copy="${btoa(unescape(encodeURIComponent(copyText)))}">&#x1F4CB;</button>
          </div>
        </div>
      </div>`;
    }).join("");
    const _videoCount = imgPrompts.filter(p => typeof p === "object" && p.media === "video").length;
    const _videoLabel = _videoCount > 0 ? ` <span class="text-purple-400 font-normal">🎥 ${_videoCount}video</span>` : "";
    imgPromptsHtml = `<details class="mb-2" open>
      <summary class="flex items-center justify-between text-xs font-semibold text-gray-400 cursor-pointer mb-1">
        <span>이미지 프롬프트 <span class="text-orange-400 font-normal">${window._imgSizeLabel || "📐 1080×1920"}</span>${_videoLabel}</span>
        <button onclick="event.stopPropagation(); copyImagePrompts(this)" class="copy-icon-btn" title="복사">&#x1F4CB;</button>
      </summary>
      <div class="bg-gray-900 rounded p-2 prompt-scroll-area" id="image-prompts-box">${items}</div>
    </details>`;
  } else {
    imgPromptsHtml = `<div class="mb-3 flex items-center gap-2">
      <span class="text-xs text-gray-500">프롬프트 미생성</span>
      <button onclick="generateImagePrompts('${jobId}')" id="btn-gen-img-prompts"
              class="px-3 py-1 bg-orange-700 hover:bg-orange-600 rounded text-xs font-medium transition">프롬프트 생성</button>
    </div>`;
  }

  // 업로드 슬롯: 프롬프트가 있으면 프롬프트 수 기준, 없으면 슬라이드(closing 제외) 기준
  const slotCount = hasImgPrompts ? imgPrompts.filter(p => (typeof p === "object" ? p.en : p)).length : bgCount;
  let slotsHtml = `<div class="upload-scroll-area"><div class="upload-grid">`;
  for (let i = 1; i <= slotCount; i++) {
    const promptSlide = hasImgPrompts && imgPrompts[i-1] ? (imgPrompts[i-1].slide || i) : i;
    const bgType = (slides[promptSlide - 1] || {}).bg_type || "photo";
    if (bgType === "closing") continue;
    const bgUrl = uploadedBgs[i] || null;
    const hasImage = bgUrl ? "has-image" : "";
    const bgTypeLabel = {photo:"📷",broll:"🎬",graph:"📊",logo:"🏢"}[bgType] || "📷";
    slotsHtml += `
      <div class="upload-slot-wrap" id="slot-wrap-${i}"
           draggable="true"
           ondragstart="onSlotDragStart(event, '${jobId}', ${i})"
           ondragover="onSlotDragOver(event)"
           ondragenter="onSlotDragEnter(event)"
           ondragleave="onSlotDragLeave(event)"
           ondrop="onSlotDrop(event, '${jobId}', ${i})">
        <div class="upload-slot ${hasImage}" onclick="triggerUpload('${jobId}', ${i})" id="slot-${i}" title="배경 ${i} (${bgType})" data-bg-type="${bgType}">

          ${bgUrl ? (bgUrl.includes('.mp4') || bgUrl.includes('.gif') ? `<video src="${bgUrl}" autoplay loop muted playsinline draggable="false" style="width:100%;height:100%;object-fit:cover;"></video>` : `<img src="${bgUrl}" alt="bg_${i}" draggable="false">`) : ""}
          <div class="slot-icon">+</div>
          <div class="slot-number">${bgTypeLabel} ${i}</div>
          <div class="slot-label">클릭하여 업로드</div>
          <input type="file" accept="image/*,video/mp4" class="hidden" id="file-${i}"
                 onchange="uploadSlideImage('${jobId}', ${i}, this)">
          <div class="slot-actions-overlay">
            ${bgUrl ? `<button onclick="event.stopPropagation(); previewImage('${bgUrl}', ${i})"
                    class="text-white" title="크게 보기">
              <span class="act-icon">&#128269;</span><span class="act-label">보기</span>
            </button>` : ''}
            <button onclick="event.stopPropagation(); sdRegenerateSingle('${jobId}', ${i}, 'image')"
                    class="text-purple-300" title="재생성">
              <span class="act-icon">&#9638;</span><span class="act-label">${_bgSource === 'gemini' ? '재생성' : '이미지'}</span>
            </button>
            ${_bgSource !== 'gemini' ? `<button onclick="event.stopPropagation(); sdRegenerateSingle('${jobId}', ${i}, 'video')"
                    class="text-indigo-300" title="SD 영상 재생성">
              <span class="act-icon">&#9654;</span><span class="act-label">영상</span>
            </button>` : ''}
            <button onclick="event.stopPropagation(); openSlideTtsModal(${promptSlide})"
                    class="text-orange-300" title="음성 설정">
              <span class="act-icon">&#127908;</span><span class="act-label">음성</span>
            </button>
            <button onclick="event.stopPropagation(); togglePromptEdit('${jobId}', ${i})"
                    class="text-gray-300" title="프롬프트 편집">
              <span class="act-icon">&#9998;</span><span class="act-label">프롬프트</span>
            </button>
          </div>
        </div>
      </div>`;
  }
  slotsHtml += `</div></div>
    <div id="prompt-edit-area" class="prompt-edit-area hidden">
      <div class="prompt-edit-header">
        <span class="text-xs text-gray-400">슬롯 <span id="prompt-edit-index"></span> 이미지 프롬프트 <span id="prompt-size-hint" class="text-orange-400 ml-2"></span></span>
        <button onclick="closePromptEdit()" class="text-xs text-gray-500 hover:text-white">&times;</button>
      </div>
      <label class="text-xs text-gray-500 mb-1 block">한국어 설명</label>
      <textarea id="prompt-text-ko" rows="2" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-gray-300 resize-y mb-2"
                placeholder="한국어 장면 설명..."></textarea>
      <label class="text-xs text-gray-500 mb-1 block">English Prompt</label>
      <textarea id="prompt-text-en" rows="3" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-gray-300 resize-y mb-2"
                placeholder="English image generation prompt..."></textarea>
      <label class="text-xs text-blue-400 mb-1 block">Motion Prompt (영상 변환용)</label>
      <textarea id="prompt-text-motion" rows="1" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-blue-300 resize-y"
                placeholder="e.g. slow zoom in, gentle pan right..."></textarea>
      <div class="flex gap-2 mt-2">
        <button onclick="saveImagePrompt()" class="prompt-save-btn">저장</button>
        <button onclick="regenerateFromEdit()" class="prompt-save-btn" style="background:rgba(147,51,234,0.2);color:#c084fc;">이미지 생성</button>
      </div>
      <div id="prompt-edit-sd" class="text-xs text-gray-600 mt-1" style="display:none">
        <span class="text-gray-500">변환된 SD 프롬프트:</span> <span id="prompt-edit-sd-text"></span>
      </div>
    </div>`;

  // 왼쪽: 프롬프트
  const promptCol = `
    <div class="wizard-col" id="tab-prompts" style="flex:1; min-width:0;">
      <div class="wizard-col-header">이미지 프롬프트</div>
      ${imgPromptsHtml}
    </div>`;

  // 오른쪽: 버튼 + 이미지 업로드 슬롯
  const imageCol = `
    <div class="wizard-col" id="tab-images" style="flex:1; min-width:0;">
      <div class="wizard-col-header">배경 이미지</div>
      <div class="btn-group-bar mb-2">
        <div class="btn-group">
          <span class="btn-group-label">AI</span>
          <button onclick="sdGenerateAuto('${jobId}')" id="btn-sd-auto"
                  class="btn-grouped btn-sd" style="background:#059669">
            ${_bgSource === 'gemini' ? 'Gemini 생성' : _bgSource === 'sd_video' ? 'SD 영상 생성' : 'SD 이미지 생성'}
          </button>
        </div>
        <div class="btn-group-sep"></div>
        <div class="btn-group">
          <span class="btn-group-label">수동</span>
          <button onclick="document.getElementById('bulk-upload').click()"
                  class="btn-grouped btn-upload">전체 업로드</button>
          <input type="file" accept="image/*" multiple class="hidden" id="bulk-upload"
                 onchange="bulkUploadImages('${jobId}', this)">
        </div>
      </div>
      <div id="sd-status"></div>
      ${slotsHtml}
    </div>`;

  // === Right column: TTS / Narration ===
  // scriptData.channel_config은 API에서 직접 제공 (channelsCache 의존 제거)
  const chCfg = scriptData.channel_config || {};
  window._currentChannelConfig = chCfg;
  const chTtsEngine = chCfg.tts_engine || "edge-tts";
  const chTtsVoice = chCfg.tts_voice || "ko-KR-SunHiNeural";
  const chTtsRate = parseInt((chCfg.tts_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  const chGoogleVoice = chCfg.google_voice || "ko-KR-Wavenet-A";
  const chGoogleRate = parseInt((chCfg.google_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  const chSovitsText = chCfg.sovits_ref_text || "";
  const narrationMode = has_narration ? "upload" : "tts";

  const ttsStep = steps.find(s => s.step_name === "tts");
  const ttsError = (ttsStep && ttsStep.status === "failed") ? ttsStep.error_msg : "";

  // 슬라이드별 TTS 개별 설정 (슬롯 아이콘 팝업에서 설정)
  const _contentSlides = (script?.slides || []).filter(s => s.bg_type !== "closing");
  // _perSlideTts 초기화: script_json에 개별 설정이 저장된 슬라이드만 복원
  _perSlideTts = {};
  _activeSlideTab = null;
  _contentSlides.forEach((sl, idx) => {
    const sn = String(idx + 1);
    // 슬라이드에 개별 TTS 설정이 있는 경우만 저장
    if (sl.tts_engine || sl.tts_voice || sl.gemini_tts_style) {
      _perSlideTts[sn] = {
        engine: sl.tts_engine || chTtsEngine,
        voice: sl.tts_voice || (chTtsEngine === "gemini-tts" ? (chCfg.gemini_tts_voice || "Kore") :
               chTtsEngine === "google-cloud" ? chGoogleVoice : chTtsVoice),
        rate: sl.tts_rate != null ? sl.tts_rate : chTtsRate,
        style: sl.gemini_tts_style || chCfg.gemini_tts_style || "",
      };
    }
  });

  const rightCol = `
    <div class="wizard-col" id="tab-narration">
      <div class="wizard-col-header">음성 / 나레이션</div>
      ${ttsError ? `<div class="text-xs text-red-400 bg-red-900/20 rounded p-2 mb-3">TTS 실패: ${esc(ttsError)}</div>` : ''}
      <div id="narration-tts">
        <select id="tts-engine-select" class="hidden"><option value="${chTtsEngine}"></option></select>
        <div class="grid grid-cols-2 gap-4">
          <!-- 좌측: 엔진|음성 한줄 + 속도 -->
          <div>
            <div id="narration-edge-section" class="${(chTtsEngine === 'edge-tts' || chTtsEngine === 'gemini-tts') ? '' : 'hidden'}">
              <div class="flex gap-1 items-center">
                <select id="tts-engine-select-e" class="bg-gray-800 border border-gray-700 rounded px-1.5 py-1.5 text-xs"
                        style="width:42%" onchange="document.getElementById('tts-engine-select').value=this.value;toggleNarrationEngine()">
                  <option value="edge-tts" ${chTtsEngine === 'edge-tts' ? 'selected' : ''}>Edge</option>
                  <option value="google-cloud" ${chTtsEngine === 'google-cloud' ? 'selected' : ''}>Google</option>
                  <option value="gpt-sovits" ${chTtsEngine === 'gpt-sovits' ? 'selected' : ''}>SoVITS</option>
                  <option value="gemini-tts" ${chTtsEngine === 'gemini-tts' ? 'selected' : ''}>Gemini</option>
                </select>
                <select id="tts-voice-select" class="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1.5 text-xs min-w-0">
                  <option value="ko-KR-SunHiNeural" ${chTtsVoice === 'ko-KR-SunHiNeural' ? 'selected' : ''}>선히 (여)</option>
                  <option value="ko-KR-InJoonNeural" ${chTtsVoice === 'ko-KR-InJoonNeural' ? 'selected' : ''}>인준 (남)</option>
                  <option value="ko-KR-HyunsuNeural" ${chTtsVoice === 'ko-KR-HyunsuNeural' ? 'selected' : ''}>현수 (남)</option>
                  <option value="ko-KR-HyunsuMultilingualNeural" ${chTtsVoice === 'ko-KR-HyunsuMultilingualNeural' ? 'selected' : ''}>현수M (남)</option>
                </select>
                <button onclick="previewVoice()" id="btn-preview-voice"
                        class="px-1.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition whitespace-nowrap shrink-0">듣기</button>
              </div>
              <div class="flex items-center gap-2 mt-2">
                <span class="text-xs text-gray-500 shrink-0">속도</span>
                <input type="range" id="tts-rate" min="-30" max="50" value="${chTtsRate}" step="10"
                       class="flex-1 h-1 accent-orange-500" oninput="updateRateLabel()">
                <span id="tts-rate-label" class="text-xs text-gray-400 w-8 text-right shrink-0">${chTtsRate}%</span>
              </div>
            </div>
            <div id="narration-google-section" class="${chTtsEngine === 'google-cloud' ? '' : 'hidden'}">
              <div class="flex gap-1 items-center">
                <select id="tts-engine-select-g" class="bg-gray-800 border border-gray-700 rounded px-1.5 py-1.5 text-xs"
                        style="width:42%" onchange="document.getElementById('tts-engine-select').value=this.value;toggleNarrationEngine()">
                  <option value="edge-tts">Edge</option>
                  <option value="google-cloud" selected>Google</option>
                  <option value="gpt-sovits">SoVITS</option>
                  <option value="gemini-tts">Gemini</option>
                </select>
                <select id="google-voice-select" class="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1.5 text-xs min-w-0">
                  <option value="ko-KR-Wavenet-A" ${chGoogleVoice === 'ko-KR-Wavenet-A' ? 'selected' : ''}>Wavenet A (여)</option>
                  <option value="ko-KR-Wavenet-B" ${chGoogleVoice === 'ko-KR-Wavenet-B' ? 'selected' : ''}>Wavenet B (여)</option>
                  <option value="ko-KR-Wavenet-C" ${chGoogleVoice === 'ko-KR-Wavenet-C' ? 'selected' : ''}>Wavenet C (남)</option>
                  <option value="ko-KR-Wavenet-D" ${chGoogleVoice === 'ko-KR-Wavenet-D' ? 'selected' : ''}>Wavenet D (남)</option>
                  <option value="ko-KR-Neural2-A" ${chGoogleVoice === 'ko-KR-Neural2-A' ? 'selected' : ''}>Neural2 A (여)</option>
                  <option value="ko-KR-Neural2-B" ${chGoogleVoice === 'ko-KR-Neural2-B' ? 'selected' : ''}>Neural2 B (여)</option>
                  <option value="ko-KR-Neural2-C" ${chGoogleVoice === 'ko-KR-Neural2-C' ? 'selected' : ''}>Neural2 C (남)</option>
                </select>
                <button onclick="previewVoice()" id="btn-preview-google-popup"
                        class="px-1.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition whitespace-nowrap shrink-0">듣기</button>
              </div>
              <div class="flex items-center gap-2 mt-2">
                <span class="text-xs text-gray-500 shrink-0">속도</span>
                <input type="range" id="google-rate" min="-30" max="50" value="${chGoogleRate}" step="10"
                       class="flex-1 h-1 accent-orange-500" oninput="updateGoogleRateLabel()">
                <span id="google-rate-label" class="text-xs text-gray-400 w-8 text-right shrink-0">${chGoogleRate}%</span>
              </div>
            </div>
            <div id="narration-sovits-section" class="${chTtsEngine === 'gpt-sovits' ? '' : 'hidden'}">
              <div class="flex gap-1 items-center">
                <select id="tts-engine-select-s" class="bg-gray-800 border border-gray-700 rounded px-1.5 py-1.5 text-xs"
                        style="width:42%" onchange="document.getElementById('tts-engine-select').value=this.value;toggleNarrationEngine()">
                  <option value="edge-tts">Edge</option>
                  <option value="google-cloud">Google</option>
                  <option value="gpt-sovits" selected>SoVITS</option>
                  <option value="gemini-tts">Gemini</option>
                </select>
                <select id="sovits-ref-select" class="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1.5 text-xs min-w-0">
                </select>
                <button onclick="previewSovitsNarration()" id="btn-preview-sovits"
                        class="px-1.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition whitespace-nowrap shrink-0">듣기</button>
              </div>
              <div class="mt-2">
                <input type="text" id="sovits-ref-text" value="${esc(chSovitsText)}"
                       class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs"
                       placeholder="참조 텍스트 (선택)">
                <div id="sovits-status-narration" class="text-xs mt-1"></div>
              </div>
            </div>
            <audio id="voice-preview-popup" class="hidden mt-2"></audio>
          </div>
          <!-- 우측: 스타일 -->
          <div>
            <div id="narration-gemini-style-section" class="${chTtsEngine === 'gemini-tts' ? '' : 'hidden'}">
              <div class="flex items-center justify-between mb-1">
                <label class="text-xs text-gray-500">음성 스타일</label>
                <button onclick="navigator.clipboard.writeText(document.getElementById('gemini-tts-style-popup').value);this.textContent='copied';setTimeout(()=>this.innerHTML='&#x1f4cb;',1000)"
                        class="text-gray-500 hover:text-gray-300 text-xs transition" title="복사">&#x1f4cb;</button>
              </div>
              <textarea id="gemini-tts-style-popup" rows="4" placeholder="Read aloud in a warm and friendly tone"
                        class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs resize-none">${esc(chCfg.gemini_tts_style || '')}</textarea>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  // Running status banner
  let bannerHtml = "";
  if (status === "running") {
    const runningStep = steps.find(s => s.status === "running");
    const runningLabel = runningStep ? (STEP_LABELS[runningStep.step_name] || runningStep.step_name) : "영상";
    bannerHtml = `<div id="running-status-msg" class="text-center py-2 text-gray-400 text-sm mb-2">
      <span class="inline-block animate-pulse">⏳</span> ${esc(runningLabel)} 진행 중...
    </div>`;
  }

  return `
    <div class="wizard-step-content">
      ${bannerHtml}
      <div class="wizard-top-bar">${rightCol}</div>
      <div class="wizard-two-col">${promptCol}${imageCol}</div>
    </div>`;
}

// ─── Step 3: 전환효과 + 모션 ───

let _slideTransitions = []; // 슬라이드별 전환 설정 캐시
let _slideMotions = []; // 슬라이드별 모션 설정 캐시
let _motionsCache = null; // 모션 프리셋 캐시

function renderWizardStep3_Transition(jobId, scriptData, stepsData) {
  const { script, uploaded_backgrounds, image_prompts, channel_config } = scriptData;
  const slides = script?.slides || [];
  const _fpc = (image_prompts || []).filter(p => (typeof p === "object" ? p.en : p)).length;
  const bgCount = _fpc > 0 ? _fpc : slides.filter(s => s.bg_type !== "closing").length;
  const uploadedBgs = uploaded_backgrounds || {};
  const cfg = channel_config || {};

  const defaultEffect = cfg.crossfade_transition || "fade";
  const defaultDur = cfg.crossfade_duration ?? 0.5;

  // 초기화
  if (_slideTransitions.length !== bgCount - 1) {
    _slideTransitions = [];
    for (let i = 1; i < bgCount; i++)
      _slideTransitions.push({ slide: i, effect: defaultEffect, duration: defaultDur });
  }
  if (_slideMotions.length !== bgCount) {
    _slideMotions = [];
    for (let i = 1; i <= bgCount; i++) {
      const isVideo = (uploadedBgs[i] || "").includes(".mp4");
      _slideMotions.push({ slide: i, motion: isVideo ? "none" : "random" });
    }
    _loadSlideEffects(jobId, defaultEffect, defaultDur, uploadedBgs);
  }

  const trOptions = _transitionsCache || [];
  const moOptions = _motionsCache || [];

  const MO_ICONS = { none:"\u23F8", random:"\uD83C\uDFB2", zoom_in:"\uD83D\uDD0D", zoom_out:"\uD83D\uDD0E", pan_right:"\u2192", pan_left:"\u2190", shake:"\u2B50", pulse:"\uD83D\uDCAB", rotate:"\uD83D\uDD04", blur_in:"\uD83C\uDF2B\uFE0F", bright_pulse:"\u2600\uFE0F", vignette:"\uD83D\uDD73\uFE0F", glitch:"\u26A1" };
  const TR_ICONS = { fade:"\u25D0", dissolve:"\u25D1", wipeleft:"\u25E7", wiperight:"\u25E8", slideup:"\u2B06", slidedown:"\u2B07",
    slideleft:"\u2B05", slideright:"\u27A1", circlecrop:"\u25CE", radial:"\u21BB", smoothleft:"\u21E0", smoothright:"\u21E2", smoothup:"\u21E1", smoothdown:"\u21E3" };

  // CSS 애니메이션 클래스 매핑
  const MO_ANIM = { zoom_in:"fx-anim-zoom-in", zoom_out:"fx-anim-zoom-out", pan_right:"fx-anim-pan-right", pan_left:"fx-anim-pan-left", shake:"fx-anim-shake", pulse:"fx-anim-pulse", rotate:"fx-anim-rotate", blur_in:"fx-anim-blur-in", bright_pulse:"fx-anim-bright-pulse", vignette:"fx-anim-vignette", glitch:"fx-anim-glitch" };
  const TR_ANIM = { fade:"fx-anim-fade", dissolve:"fx-anim-dissolve", wipeleft:"fx-anim-wipe-left", wiperight:"fx-anim-wipe-right",
    slideup:"fx-anim-slide-up", slidedown:"fx-anim-slide-down", slideleft:"fx-anim-slide-left", slideright:"fx-anim-slide-right",
    circlecrop:"fx-anim-circle", radial:"fx-anim-radial",
    smoothleft:"fx-anim-slide-left", smoothright:"fx-anim-slide-right", smoothup:"fx-anim-slide-up", smoothdown:"fx-anim-slide-down" };

  const curMotion = (_selectedPreviewSlide >= 1 && _slideMotions[_selectedPreviewSlide - 1])
    ? _slideMotions[_selectedPreviewSlide - 1].motion : null;
  // 슬라이드 선택 시에도 해당 슬라이드의 전환(이전→현재) 표시
  const _effTrIdx = _selectedTransitionIdx > 0
    ? _selectedTransitionIdx
    : (_selectedPreviewSlide > 1 ? _selectedPreviewSlide - 1 : 0);
  const curTransition = (_effTrIdx >= 1 && _slideTransitions[_effTrIdx - 1])
    ? _slideTransitions[_effTrIdx - 1].effect : null;
  const curDurVal = (_effTrIdx >= 1 && _slideTransitions[_effTrIdx - 1])
    ? _slideTransitions[_effTrIdx - 1].duration : defaultDur;

  let html = `<div class="wizard-step-content">`;

  // ═══ 상단: 좌측 사이드바 + 중앙 미리보기 ═══
  html += `<div class="fx-main-layout">`;

  // ── 좌측: 효과 드롭다운 패널 ──
  html += `<div class="fx-sidebar">`;

  // 선택 상태 표시
  const selLabel = _selectedTransitionIdx > 0
    ? `전환 ${_selectedTransitionIdx} → ${_selectedTransitionIdx + 1}`
    : `슬라이드 ${_selectedPreviewSlide}`;
  html += `<div class="fx-sel-badge">${selLabel}</div>`;

  // 모션 효과 드롭다운
  html += `<div class="fx-section-title">모션 효과</div>
    <select id="fx-motion-select" class="fx-select" onchange="applyMotionToSelected('${jobId}', this.value)">`;
  for (const m of moOptions) {
    const sel = (curMotion === m.id && _selectedTransitionIdx === 0) ? "selected" : "";
    html += `<option value="${m.id}" ${sel}>${MO_ICONS[m.id] || "\u2726"} ${m.label}</option>`;
  }
  html += `</select>`;

  // 전환 효과 드롭다운
  html += `<div class="fx-section-title" style="margin-top:10px;">전환 효과</div>
    <select id="fx-transition-select" class="fx-select" onchange="applyTransitionToSelected(this.value)">`;
  for (const t of trOptions) {
    const sel = (curTransition === t.id && _effTrIdx > 0) ? "selected" : "";
    html += `<option value="${t.id}" ${sel}>${TR_ICONS[t.id] || "\u25C6"} ${t.label}</option>`;
  }
  html += `</select>`;

  // 전환 길이
  html += `<div class="fx-section-title" style="margin-top:10px;">전환 길이</div>
    <div class="flex items-center gap-2">
      <input type="range" id="tr-dur-global" min="0" max="1.5" step="0.1" value="${curDurVal}"
        class="flex-1 accent-blue-500" oninput="document.getElementById('tr-dur-global-label').textContent=this.value+'s'">
      <span id="tr-dur-global-label" class="text-[10px] text-gray-400 w-6">${curDurVal}s</span>
    </div>
    <button onclick="applyBulkAll()" class="fx-bulk-btn mt-2">전체 일괄 적용</button>`;

  html += `</div>`; // /fx-sidebar

  // ── 중앙: 미리보기 ──
  html += `<div class="fx-preview-area">
    <div class="fx-preview-container" id="fx-preview-box">
      <div class="flex items-center justify-center h-full text-gray-600 text-xs" id="tr-preview-placeholder">
        슬라이드를 선택하세요
      </div>
      <div class="fx-preview-loading hidden" id="tr-preview-loading">
        <span class="animate-pulse">로딩 중...</span>
      </div>
      <video id="tr-preview-video" class="hidden" style="width:100%;height:100%;object-fit:contain;" autoplay muted loop></video>
      <div id="fx-css-preview" class="hidden" style="position:absolute;inset:0;overflow:hidden;">
        <div id="fx-css-cur" style="position:absolute;inset:0;width:100%;height:100%;opacity:1;"></div>
        <div id="fx-css-nxt" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;"></div>
      </div>
    </div>
    <div class="flex items-center justify-center gap-2 mt-2">
      <button onclick="_fullPreviewPlaying ? _stopFullPreview() : playFullPreview('${jobId}')" id="btn-full-preview" class="fx-play-btn">&#9654; 전체 재생</button>
    </div>
    <div id="fx-preview-status" class="text-[10px] text-gray-500 mt-1 text-center font-mono"></div>
  </div>`;

  html += `</div>`; // /fx-main-layout

  // ═══ 하단: 타임라인 (CapCut 스타일 — 전환을 겹침 영역으로 표현) ═══
  html += `<div class="fx-timeline-wrap">
    <div class="overflow-x-auto">
      <div class="fx-tl-strip" id="fx-timeline">`;

  const _MO_LABELS = {none:"정적",random:"랜덤",zoom_in:"줌인",zoom_out:"줌아웃",pan_right:"우패닝",pan_left:"좌패닝",shake:"흩뿌리기",pulse:"펄스",rotate:"회전",blur_in:"블러인",bright_pulse:"밝기펄스",vignette:"비네팅",glitch:"글리치"};
  for (let i = 1; i <= bgCount; i++) {
    const bgUrl = uploadedBgs[i] || null;
    const isVideo = bgUrl && bgUrl.includes(".mp4");
    const mo = _slideMotions[i - 1] || { motion: "random" };
    const selected = (_selectedPreviewSlide === i && _selectedTransitionIdx === 0);
    const selCls = selected ? "fx-tl-slide-selected" : "";
    const moLabel = (moOptions.find(m=>m.id===mo.motion)||{}).label || _MO_LABELS[mo.motion] || "";

    // 전환 버튼 (슬라이드 사이에 독립 배치, Composer 스타일)
    if (i > 1) {
      const tr = _slideTransitions[i - 2] || { effect: defaultEffect, duration: defaultDur };
      const trSelected = (_selectedTransitionIdx === (i - 1));
      const trSelCls = trSelected ? "fx-tl-tr-btn-selected" : "";
      const trIcon = TR_ICONS[tr.effect] || "\u25C6";
      const trLabel = (trOptions.find(t=>t.id===tr.effect)||{}).label || tr.effect;
      html += `<div class="fx-tl-tr-btn ${trSelCls}" id="fx-tr-${i-1}"
        onclick="selectTransitionForFx('${jobId}', ${i-1})"
        title="${trLabel} ${tr.duration}s">
        <span>${trIcon}</span>
      </div>`;
    }

    html += `<div class="fx-tl-slide ${selCls}" onclick="selectSlideForFx('${jobId}', ${i})" id="fx-slide-${i}">`;
    html += `<div class="fx-tl-thumb">`;
    html += bgUrl
      ? (isVideo
        ? `<video src="${bgUrl}" muted playsinline style="width:100%;height:100%;object-fit:cover;pointer-events:none;"></video>`
        : `<img src="${bgUrl}" loading="eager" decoding="async" style="width:100%;height:100%;object-fit:cover;" />`)
      : `<div class="fx-tl-placeholder">${i}</div>`;
    html += `<div class="fx-tl-motion-badge">${MO_ICONS[mo.motion] || "\u2726"} ${moLabel}</div>`;

    html += `</div>`; // /fx-tl-thumb
    html += `<div class="fx-tl-num">${i}</div>`;
    html += `</div>`; // /fx-tl-slide
  }

  html += `</div></div></div>`;
  html += `</div>`; // /wizard-step-content

  if (!_transitionsCache || !_motionsCache) _ensureEffectsLoaded(jobId);
  return html;
}

let _selectedPreviewSlide = 1;
let _selectedTransitionIdx = 0; // 0 = none selected

function _updatePaletteHighlights() {
  // 드롭다운 select 값 동기화
  if (_selectedTransitionIdx === 0 && _selectedPreviewSlide >= 1) {
    const curMotion = _slideMotions[_selectedPreviewSlide - 1]?.motion;
    const motionSel = document.getElementById("fx-motion-select");
    if (motionSel && curMotion) motionSel.value = curMotion;
  }
  if (_selectedTransitionIdx >= 1) {
    const curEffect = _slideTransitions[_selectedTransitionIdx - 1]?.effect;
    const trSel = document.getElementById("fx-transition-select");
    if (trSel && curEffect) trSel.value = curEffect;
  }
  // 레거시 .fx-btn 호환 (다른 Step에서 사용)
  document.querySelectorAll(".fx-btn").forEach(b => b.classList.remove("active-motion", "active-transition"));
}

function _updateSelBadge() {
  const badge = document.querySelector('.fx-sel-badge');
  if (!badge) return;
  badge.textContent = _selectedTransitionIdx > 0
    ? `전환 ${_selectedTransitionIdx} → ${_selectedTransitionIdx + 1}`
    : `슬라이드 ${_selectedPreviewSlide}`;
}

function selectSlideForFx(jobId, slideIdx) {
  _selectedPreviewSlide = slideIdx;
  _selectedTransitionIdx = 0;
  document.querySelectorAll("[id^='fx-slide-']").forEach(el => el.classList.remove("fx-tl-slide-selected","ring-2","ring-orange-500"));
  document.querySelectorAll("[id^='fx-tr-']").forEach(el => el.classList.remove("fx-tl-tr-selected","fx-tl-tr-btn-selected","ring-2","ring-blue-500"));
  const el = document.getElementById(`fx-slide-${slideIdx}`);
  if (el) el.classList.add("fx-tl-slide-selected");
  _updateSelBadge();
  _updatePaletteHighlights();
  _playMotionPreview(jobId, slideIdx);
}

function selectTransitionForFx(jobId, trIdx) {
  _selectedTransitionIdx = trIdx;
  _selectedPreviewSlide = trIdx;
  document.querySelectorAll("[id^='fx-slide-']").forEach(el => el.classList.remove("fx-tl-slide-selected","ring-2","ring-orange-500"));
  document.querySelectorAll("[id^='fx-tr-']").forEach(el => el.classList.remove("fx-tl-tr-selected","fx-tl-tr-btn-selected","ring-2","ring-blue-500"));
  const el = document.getElementById(`fx-tr-${trIdx}`);
  if (el) el.classList.add("fx-tl-tr-btn-selected");
  _updateSelBadge();
  _updatePaletteHighlights();
  _playTransitionPreview(jobId, trIdx);
}

function applyMotionToSelected(jobId, motionId) {
  const s = _selectedPreviewSlide;
  if (s < 1 || s > _slideMotions.length) return;
  const bgUrl = _lastScriptData?.uploaded_backgrounds?.[s] || "";
  if (bgUrl.includes(".mp4")) return;
  _slideMotions[s - 1] = { slide: s, motion: motionId };
  _updateTimelineBadge(s, motionId);
  _updatePaletteHighlights();
  _playMotionPreview(jobId, s);
  _autoSaveEffects();
}

function applyTransitionToSelected(effectId) {
  let idx = _selectedTransitionIdx;
  // 슬라이드 선택 시 → 해당 슬라이드 이전 전환에 적용
  if (idx === 0 && _selectedPreviewSlide > 1) idx = _selectedPreviewSlide - 1;
  if (idx < 1 || idx > _slideTransitions.length) return;
  const dur = parseFloat(document.getElementById("tr-dur-global")?.value) || 0.5;
  _slideTransitions[idx - 1] = { slide: idx, effect: effectId, duration: dur };
  _updateTimelineTransition(idx, effectId, dur);
  _updatePaletteHighlights();
  _playTransitionPreview(_lastScriptData?.job_id || "", idx);
  _autoSaveEffects();
}

// 효과 변경 시 디바운스 자동 저장 (1초 후)
let _fxSaveTimer = null;
function _autoSaveEffects() {
  if (_fxSaveTimer) clearTimeout(_fxSaveTimer);
  _fxSaveTimer = setTimeout(async () => {
    const jobId = _lastScriptData?.job_id;
    if (!jobId) return;
    try {
      const cdRes = await fetch(`/api/jobs/${jobId}/composer`);
      if (!cdRes.ok) return;
      const data = await cdRes.json();
      const cd = data.compose_data || {};
      cd.slide_transitions = _slideTransitions;
      cd.slide_motions = _slideMotions;
      await fetch(`/api/jobs/${jobId}/composer/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cd),
      });
    } catch {}
  }, 1000);
}

function _updateTimelineBadge(slideNum, motionId) {
  const MO_ICONS = { none:"\u23F8", random:"\uD83C\uDFB2", zoom_in:"\uD83D\uDD0D", zoom_out:"\uD83D\uDD0E", pan_right:"\u2192", pan_left:"\u2190", shake:"\u2B50", pulse:"\uD83D\uDCAB", rotate:"\uD83D\uDD04", blur_in:"\uD83C\uDF2B\uFE0F", bright_pulse:"\u2600\uFE0F", vignette:"\uD83D\uDD73\uFE0F", glitch:"\u26A1" };
  const _MO_LABELS = {none:"정적",random:"랜덤",zoom_in:"줌인",zoom_out:"줌아웃",pan_right:"우패닝",pan_left:"좌패닝",shake:"흩뿌리기",pulse:"펄스",rotate:"회전",blur_in:"블러인",bright_pulse:"밝기펄스",vignette:"비네팅",glitch:"글리치"};
  const slideEl = document.getElementById(`fx-slide-${slideNum}`);
  if (!slideEl) return;
  const badge = slideEl.querySelector('.fx-tl-motion-badge') || slideEl.querySelector('[style*="rgba(139,92,246"]');
  if (badge) badge.innerHTML = `${MO_ICONS[motionId] || "\u2726"} ${_MO_LABELS[motionId] || ""}`;
}

function _updateTimelineTransition(trIdx, effect, dur) {
  const TR_ICONS = { fade:"\u25D0", dissolve:"\u25D1", wipeleft:"\u25E7", wiperight:"\u25E8", slideup:"\u2B06", slidedown:"\u2B07",
    slideleft:"\u2B05", slideright:"\u27A1", circlecrop:"\u25CE", radial:"\u21BB", smoothleft:"\u21E0", smoothright:"\u21E2", smoothup:"\u21E1", smoothdown:"\u21E3" };
  const trEl = document.getElementById(`fx-tr-${trIdx}`);
  if (!trEl) return;
  // 아이콘 갱신
  const iconSpan = trEl.querySelector('span');
  if (iconSpan) iconSpan.textContent = TR_ICONS[effect] || "\u25C6";
}

function _setTransitionDur(trIdx, dur) {
  if (trIdx < 1 || trIdx > _slideTransitions.length) return;
  _slideTransitions[trIdx - 1].duration = dur;
  _updateTimelineTransition(trIdx, _slideTransitions[trIdx - 1].effect, dur);
  _autoSaveEffects();
}

function _showPreviewLoading() {
  const loading = document.getElementById("tr-preview-loading");
  const ph = document.getElementById("tr-preview-placeholder");
  const video = document.getElementById("tr-preview-video");
  if (ph) ph.classList.add("hidden");
  if (loading) loading.classList.remove("hidden");
  if (video) video.classList.add("hidden");
}

function _hidePreviewLoading() {
  const loading = document.getElementById("tr-preview-loading");
  if (loading) loading.classList.add("hidden");
}

async function _playMotionPreview(jobId, slideIdx) {
  const mo = _slideMotions[slideIdx - 1];
  if (!mo) return;
  const video = document.getElementById("tr-preview-video");
  if (!video) return;
  _showPreviewLoading();
  video.src = `/api/jobs/${jobId}/motion-preview?slide=${slideIdx}&motion=${mo.motion}&t=${Date.now()}`;
  video.oncanplay = () => { _hidePreviewLoading(); video.classList.remove("hidden"); };
  video.onerror = () => { _hidePreviewLoading(); video.classList.remove("hidden"); };
  video.load();
  video.play().catch(() => {});
}

async function _playTransitionPreview(jobId, trIdx) {
  const tr = _slideTransitions[trIdx - 1];
  if (!tr) return;
  const video = document.getElementById("tr-preview-video");
  if (!video) return;
  _showPreviewLoading();
  video.src = `/api/jobs/${jobId}/transition-preview?effect=${tr.effect}&duration=${tr.duration}&slide_from=${trIdx}&slide_to=${trIdx + 1}&t=${Date.now()}`;
  video.oncanplay = () => { _hidePreviewLoading(); video.classList.remove("hidden"); };
  video.onerror = () => { _hidePreviewLoading(); video.classList.remove("hidden"); };
  video.load();
  video.play().catch(() => {});
}

// ─── 전체 미리보기: CSS 애니메이션 (실시간, 렌더 불필요) ───
let _fullPreviewPlaying = false;
let _fullPreviewTimer = null;
let _fullPreviewSlideIdx = 0;

// 모션 → CSS transform 매핑
const _CSS_MOTIONS = {
  zoom_in:       { from: "scale(1)",       to: "scale(1.3)" },
  zoom_out:      { from: "scale(1.3)",     to: "scale(1)" },
  pan_right:     { from: "translateX(-8%) scale(1.1)", to: "translateX(8%) scale(1.1)" },
  pan_left:      { from: "translateX(8%) scale(1.1)",  to: "translateX(-8%) scale(1.1)" },
  shake:         { from: "translate(-2px, 1px) scale(1.05)", to: "translate(2px, -1px) scale(1.05)" },
  pulse:         { from: "scale(1)",       to: "scale(1.08)", css: "transform 0.5s ease-in-out", repeat: true },
  rotate:        { from: "rotate(0deg) scale(1.1)",   to: "rotate(8deg) scale(1.1)" },
  blur_in:       { from: "scale(1)",       to: "scale(1)", filter_from: "blur(8px)", filter_to: "blur(0px)" },
  bright_pulse:  { from: "scale(1)",       to: "scale(1)", filter_from: "brightness(0.85)", filter_to: "brightness(1.15)" },
  vignette:      { from: "scale(1.05)",    to: "scale(1.05)" },
  glitch:        { from: "scale(1)",       to: "scale(1)" },
  none:          { from: "scale(1)",       to: "scale(1)" },
};

// 전환 → CSS 애니메이션 매핑
const _CSS_TRANSITIONS = {
  fade:        (cur, nxt, dur) => { nxt.style.transition = `opacity ${dur}s`; nxt.style.opacity = "1"; },
  dissolve:    (cur, nxt, dur) => { cur.style.transition = `opacity ${dur}s`; cur.style.opacity = "0"; nxt.style.transition = `opacity ${dur}s`; nxt.style.opacity = "1"; },
  wipeleft:    (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  wiperight:   (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  slideup:     (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateY(0)"; },
  slidedown:   (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateY(0)"; },
  slideleft:   (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateX(0)"; },
  slideright:  (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateX(0)"; },
  circlecrop:  (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "circle(100% at 50% 50%)"; },
  radial:      (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "circle(100% at 50% 50%)"; },
  smoothleft:  (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateX(0)"; },
  smoothright: (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateX(0)"; },
  smoothup:    (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateY(0)"; },
  smoothdown:  (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateY(0)"; },
  // 추가 효과 — 매핑 없는 효과는 fade 폴백
  fadeblack:   (cur, nxt, dur) => { cur.style.transition = `opacity ${dur*0.5}s`; cur.style.opacity = "0"; setTimeout(() => { nxt.style.transition = `opacity ${dur*0.5}s`; nxt.style.opacity = "1"; }, dur*500); },
  fadewhite:   (cur, nxt, dur) => { cur.style.transition = `opacity ${dur*0.5}s`; cur.style.opacity = "0"; setTimeout(() => { nxt.style.transition = `opacity ${dur*0.5}s`; nxt.style.opacity = "1"; }, dur*500); },
  wipeup:      (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  wipedown:    (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  circleclose: (cur, nxt, dur) => { cur.style.transition = `clip-path ${dur}s ease`; cur.style.clipPath = "circle(0% at 50% 50%)"; nxt.style.opacity = "1"; },
  circleopen:  (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "circle(100% at 50% 50%)"; },
  rectcrop:    (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  horzclose:   (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  horzopen:    (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  vertclose:   (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  vertopen:    (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `clip-path ${dur}s ease`; nxt.style.clipPath = "inset(0 0 0 0)"; },
  coverleft:   (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateX(0)"; },
  coverright:  (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateX(0)"; },
  coverup:     (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateY(0)"; },
  coverdown:   (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease`; nxt.style.transform = "translateY(0)"; },
  pixelize:    (cur, nxt, dur) => { cur.style.transition = `opacity ${dur*0.5}s`; cur.style.opacity = "0"; setTimeout(() => { nxt.style.transition = `opacity ${dur*0.5}s`; nxt.style.opacity = "1"; }, dur*500); },
  zoomin:      (cur, nxt, dur) => { nxt.style.opacity = "1"; nxt.style.transition = `transform ${dur}s ease, opacity ${dur}s`; nxt.style.transform = "scale(1)"; },
};

// 전환 초기 상태 (전환 시작 전 nxt 위치)
const _CSS_TR_INIT = {
  wipeleft:    (nxt) => { nxt.style.clipPath = "inset(0 100% 0 0)"; },
  wiperight:   (nxt) => { nxt.style.clipPath = "inset(0 0 0 100%)"; },
  wipeup:      (nxt) => { nxt.style.clipPath = "inset(100% 0 0 0)"; },
  wipedown:    (nxt) => { nxt.style.clipPath = "inset(0 0 100% 0)"; },
  slideup:     (nxt) => { nxt.style.transform = "translateY(100%)"; },
  slidedown:   (nxt) => { nxt.style.transform = "translateY(-100%)"; },
  slideleft:   (nxt) => { nxt.style.transform = "translateX(100%)"; },
  slideright:  (nxt) => { nxt.style.transform = "translateX(-100%)"; },
  circlecrop:  (nxt) => { nxt.style.clipPath = "circle(0% at 50% 50%)"; },
  circleopen:  (nxt) => { nxt.style.clipPath = "circle(0% at 50% 50%)"; },
  radial:      (nxt) => { nxt.style.clipPath = "circle(0% at 50% 50%)"; },
  rectcrop:    (nxt) => { nxt.style.clipPath = "inset(50% 50% 50% 50%)"; },
  horzclose:   (nxt) => { nxt.style.clipPath = "inset(0 50% 0 50%)"; },
  horzopen:    (nxt) => { nxt.style.clipPath = "inset(0 0 0 0)"; },
  vertclose:   (nxt) => { nxt.style.clipPath = "inset(50% 0 50% 0)"; },
  vertopen:    (nxt) => { nxt.style.clipPath = "inset(0 0 0 0)"; },
  smoothleft:  (nxt) => { nxt.style.transform = "translateX(100%)"; },
  smoothright: (nxt) => { nxt.style.transform = "translateX(-100%)"; },
  smoothup:    (nxt) => { nxt.style.transform = "translateY(100%)"; },
  smoothdown:  (nxt) => { nxt.style.transform = "translateY(-100%)"; },
  coverleft:   (nxt) => { nxt.style.transform = "translateX(100%)"; },
  coverright:  (nxt) => { nxt.style.transform = "translateX(-100%)"; },
  coverup:     (nxt) => { nxt.style.transform = "translateY(100%)"; },
  coverdown:   (nxt) => { nxt.style.transform = "translateY(-100%)"; },
  zoomin:      (nxt) => { nxt.style.transform = "scale(0.3)"; nxt.style.opacity = "0"; },
};

function playFullPreview(jobId) {
  if (_fullPreviewPlaying) { _stopFullPreview(); return; }

  const box = document.getElementById("fx-css-preview");
  const ph = document.getElementById("tr-preview-placeholder");
  const video = document.getElementById("tr-preview-video");
  const statusEl = document.getElementById("fx-preview-status");
  if (!box) return;
  if (!_lastScriptData?.uploaded_backgrounds) {
    if (statusEl) statusEl.textContent = "데이터 로딩 중...";
    // 잠시 후 재시도
    setTimeout(() => playFullPreview(jobId), 1000);
    return;
  }

  // 배경 URL 수집 (이미지 + 영상 모두 지원)
  const bgUrls = [];
  for (let i = 0; i < _slideMotions.length; i++) {
    const slideNum = _slideMotions[i].slide;
    const bgUrl = _lastScriptData?.uploaded_backgrounds?.[slideNum] || "";
    bgUrls.push(bgUrl);
  }

  // 유효한 이미지만 필터 (최소 1개는 있어야)
  if (bgUrls.every(u => !u)) { if (statusEl) statusEl.textContent = "배경 이미지 없음"; return; }

  // 이미지 프리로드 (깜빡임 방지)
  bgUrls.forEach(u => { if (u) { const img = new Image(); img.src = u; } });

  // UI 전환
  if (ph) ph.classList.add("hidden");
  if (video) video.classList.add("hidden");
  _hidePreviewLoading();
  box.classList.remove("hidden");

  const btn = document.getElementById("btn-full-preview");
  if (btn) btn.textContent = "⏹ 정지";
  _fullPreviewPlaying = true;
  _fullPreviewSlideIdx = 0;

  const SLIDE_DUR = 2000;
  const TR_DUR = 600;

  // 컨테이너에 미디어 요소(img 또는 video) 설정
  function _setMedia(container, url) {
    container.innerHTML = "";
    container.style.transition = "none";
    container.style.transform = "scale(1)";
    container.style.opacity = "0";
    container.style.clipPath = "none";
    if (!url) return;
    const isVideo = url.includes(".mp4") || url.includes(".gif");
    if (isVideo) {
      const v = document.createElement("video");
      v.src = url; v.muted = true; v.autoplay = true; v.loop = true; v.playsInline = true;
      v.style.cssText = "width:100%;height:100%;object-fit:cover;";
      container.appendChild(v);
      v.play().catch(() => {});
    } else {
      const img = document.createElement("img");
      img.src = url;
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      container.appendChild(img);
    }
  }

  function showSlide(idx) {
    if (!_fullPreviewPlaying) return;
    if (idx >= _slideMotions.length) { idx = 0; } // 루프

    _fullPreviewSlideIdx = idx;
    const curDiv = document.getElementById("fx-css-cur");
    const nxtDiv = document.getElementById("fx-css-nxt");
    if (!curDiv || !nxtDiv) return;

    // 타임라인 하이라이트
    document.querySelectorAll("[id^='fx-slide-']").forEach(el => el.classList.remove("ring-2","ring-orange-500"));
    document.querySelectorAll("[id^='fx-tr-']").forEach(el => el.classList.remove("ring-2","ring-blue-500"));
    const slideEl = document.getElementById(`fx-slide-${_slideMotions[idx].slide}`);
    if (slideEl) slideEl.classList.add("ring-2","ring-orange-500");
    if (statusEl) statusEl.textContent = `${idx + 1} / ${_slideMotions.length}`;

    // 현재 슬라이드 설정
    const mo = _slideMotions[idx]?.motion || "none";
    const cssMotion = _CSS_MOTIONS[mo] || _CSS_MOTIONS.none;
    const url = bgUrls[idx];

    // 이미지가 없는 슬라이드는 스킵
    if (!url) {
      _fullPreviewTimer = setTimeout(() => showSlide(idx + 1), 200);
      return;
    }

    // 미디어 설정
    _setMedia(curDiv, url);
    _setMedia(nxtDiv, "");
    curDiv.style.opacity = "1";
    curDiv.style.transform = cssMotion.from;
    curDiv.style.filter = cssMotion.filter_from || "";

    // 브라우저가 리셋을 렌더한 후 모션 시작 (2프레임 대기)
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      if (!_fullPreviewPlaying) return;
      curDiv.style.transition = `transform ${SLIDE_DUR/1000}s ease-out, filter ${SLIDE_DUR/1000}s ease-out`;
      curDiv.style.transform = cssMotion.to;
      curDiv.style.filter = cssMotion.filter_to || "";
    }); });

    // 전환 시작
    _fullPreviewTimer = setTimeout(() => {
      if (!_fullPreviewPlaying) return;
      const nextIdx = (idx + 1) % _slideMotions.length;
      const nxtUrl = bgUrls[nextIdx];

      // 다음 이미지가 없으면 바로 다음으로
      if (!nxtUrl) {
        showSlide(nextIdx);
        return;
      }

      // 전환 효과
      const trCfg = _slideTransitions[idx] || {};
      const effect = trCfg.effect || "fade";

      // 전환 하이라이트
      const trEl = document.getElementById(`fx-tr-${_slideMotions[idx].slide}`);
      if (trEl) {
        document.querySelectorAll("[id^='fx-slide-']").forEach(el => el.classList.remove("ring-2","ring-orange-500"));
        trEl.classList.add("ring-2","ring-blue-500");
      }

      // nxt 미디어 준비
      _setMedia(nxtDiv, nxtUrl);
      nxtDiv.style.transition = "none";
      nxtDiv.style.opacity = "0";
      nxtDiv.style.transform = "scale(1)";
      nxtDiv.style.clipPath = "none";

      // 전환 초기 상태
      const initFn = _CSS_TR_INIT[effect];
      if (initFn) {
        nxtDiv.style.opacity = "1";
        initFn(nxtDiv);
      }

      // 전환 애니메이션 (2프레임 대기 후)
      requestAnimationFrame(() => { requestAnimationFrame(() => {
        if (!_fullPreviewPlaying) return;
        const trFn = _CSS_TRANSITIONS[effect] || _CSS_TRANSITIONS.fade;
        trFn(curDiv, nxtDiv, TR_DUR / 1000);
      }); });

      // 전환 완료 → 다음 슬라이드
      _fullPreviewTimer = setTimeout(() => {
        if (!_fullPreviewPlaying) return;
        showSlide(nextIdx);
      }, TR_DUR + 100);
    }, SLIDE_DUR - TR_DUR);
  }

  showSlide(0);
}

function _stopFullPreview() {
  _fullPreviewPlaying = false;
  if (_fullPreviewTimer) { clearTimeout(_fullPreviewTimer); _fullPreviewTimer = null; }
  const btn = document.getElementById("btn-full-preview");
  if (btn) btn.textContent = "▶ 전체";
  const box = document.getElementById("fx-css-preview");
  if (box) box.classList.add("hidden");
  const statusEl = document.getElementById("fx-preview-status");
  if (statusEl) statusEl.textContent = "";
  // 타임라인 하이라이트 제거
  document.querySelectorAll("[id^='fx-slide-']").forEach(el => el.classList.remove("ring-2","ring-orange-500"));
  document.querySelectorAll("[id^='fx-tr-']").forEach(el => el.classList.remove("ring-2","ring-blue-500"));
}

async function _ensureEffectsLoaded(jobId) {
  try {
    const fetches = [];
    if (!_transitionsCache) fetches.push(fetch("/api/transitions").then(r => r.json()).then(d => { _transitionsCache = d; }));
    if (!_motionsCache) fetches.push(fetch("/api/motions").then(r => r.json()).then(d => { _motionsCache = d; }));
    await Promise.all(fetches);
    if (_wizardStep === 3 && _lastScriptData && _lastStepsData) {
      renderJobDetail(_lastScriptData, _lastStepsData);
    }
  } catch (e) { console.warn("effects load failed", e); }
}

async function _loadSlideEffects(jobId, defaultEffect, defaultDur, uploadedBgs) {
  try {
    const res = await fetch(`/api/jobs/${jobId}/composer`);
    if (!res.ok) return;
    const data = await res.json();

    const cd = data.compose_data || data;
    const savedTr = cd.slide_transitions || data.slide_transitions || [];
    const savedMo = cd.slide_motions || data.slide_motions || [];

    // 저장된 효과가 없으면 서버에 자동 생성 요청
    if (savedTr.length === 0 && savedMo.length === 0) {
      try {
        const autoRes = await fetch(`/api/jobs/${jobId}/auto-effects`, { method: "POST" });
        if (autoRes.ok) {
          // 재귀 호출로 자동 생성된 값 로드
          return _loadSlideEffects(jobId, defaultEffect, defaultDur, uploadedBgs);
        }
      } catch (e) { console.warn("auto-effects failed", e); }
    }

    // 전환 복원
    for (const t of savedTr) {
      const idx = t.slide - 1;
      if (idx >= 0 && idx < _slideTransitions.length) {
        _slideTransitions[idx] = { slide: t.slide, effect: t.effect || defaultEffect, duration: t.duration ?? defaultDur };
      }
    }

    // 모션 복원
    for (const m of savedMo) {
      const idx = m.slide - 1;
      if (idx >= 0 && idx < _slideMotions.length) {
        _slideMotions[idx] = { slide: m.slide, motion: m.motion || "random" };
      }
    }

    if (_wizardStep === 3 && _lastScriptData && _lastStepsData) {
      renderJobDetail(_lastScriptData, _lastStepsData);
    }
  } catch (e) { console.warn("load slide effects failed", e); }
}

function updateSlideMotion(slideIdx) {
  const sel = document.getElementById(`mo-${slideIdx}`);
  if (!sel) return;
  const idx = slideIdx - 1;
  if (idx >= 0 && idx < _slideMotions.length) {
    _slideMotions[idx] = { slide: slideIdx, motion: sel.value };
  }
}

function updateSlideTransition(slideIdx) {
  const effectSel = document.getElementById(`tr-effect-${slideIdx}`);
  const durInput = document.getElementById(`tr-dur-${slideIdx}`);
  if (!effectSel || !durInput) return;
  const idx = slideIdx - 1;
  if (idx >= 0 && idx < _slideTransitions.length) {
    _slideTransitions[idx] = {
      slide: slideIdx,
      effect: effectSel.value,
      duration: parseFloat(durInput.value) || 0.5,
    };
  }
}

function applyBulkAll() {
  const dur = parseFloat(document.getElementById("tr-dur-global")?.value) || 0.5;
  for (let i = 0; i < _slideTransitions.length; i++) {
    _slideTransitions[i].duration = dur;
    // 타임라인 아이콘 업데이트
    _updateTimelineTransition(i + 1, _slideTransitions[i].effect, dur);
  }
  _autoSaveEffects();
}

async function saveTransitionsAndResume(jobId) {
  const btn = document.getElementById("btn-resume-job");
  if (btn) {
    btn.textContent = "저장 중...";
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
  }

  try {
    // compose_data에 slide_transitions + slide_motions 저장
    let composeData = {};
    try {
      const cdRes = await fetch(`/api/jobs/${jobId}/composer`);
      if (cdRes.ok) composeData = await cdRes.json();
    } catch {}

    composeData.slide_transitions = _slideTransitions;
    composeData.slide_motions = _slideMotions;

    await fetch(`/api/jobs/${jobId}/composer/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(composeData),
    });

    // Phase B 실행 — Step 2에서 설정한 TTS 엔진/음성 포함
    if (btn) btn.textContent = "영상 제작 중...";

    const _ttsPayload = _collectTtsPayload();

    // 슬라이드별 개별 TTS 설정 포함
    if (Object.keys(_perSlideTts).length > 0) {
      _ttsPayload.per_slide_tts = _perSlideTts;
    }

    const res = await fetch(`/api/jobs/${jobId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_ttsPayload),
    });
    if (res.ok) {
      _wizardStep = 4;
      await refreshJobDetail(jobId);
      loadAll();
    } else {
      const err = await res.json();
      alert(err.detail || "영상 제작 시작 실패");
      if (btn) {
        btn.textContent = "영상 제작 →";
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
      }
    }
  } catch (e) {
    alert("저장 또는 제작 시작 실패");
    if (btn) {
      btn.textContent = "영상 제작 →";
      btn.disabled = false;
      btn.classList.remove("opacity-50", "cursor-not-allowed");
    }
  }
}

// ─── Quick Render (효과 없이 바로 영상 제작) ───

async function quickRender(jobId) {
  const btn = document.getElementById("btn-quick-render");
  if (btn) {
    btn.textContent = "제작 중...";
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
  }

  try {
    // compose_data에 효과 비활성화 플래그 저장
    let composeData = {};
    try {
      const cdRes = await fetch(`/api/jobs/${jobId}/composer`);
      if (cdRes.ok) composeData = await cdRes.json();
    } catch {}

    composeData.no_effects = false;  // Phase A 자동 생성 모션/전환 효과 적용

    await fetch(`/api/jobs/${jobId}/composer/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(composeData),
    });

    // TTS 엔진/음성 수집
    const _ttsPayload = _collectTtsPayload();

    // 슬라이드별 개별 TTS 설정 포함
    if (Object.keys(_perSlideTts).length > 0) {
      _ttsPayload.per_slide_tts = _perSlideTts;
    }

    const res = await fetch(`/api/jobs/${jobId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_ttsPayload),
    });
    if (res.ok) {
      _wizardStep = 4;
      await refreshJobDetail(jobId);
      loadAll();
    } else {
      const err = await res.json();
      alert(err.detail || "영상 제작 시작 실패");
      if (btn) {
        btn.textContent = "영상 제작";
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
      }
    }
  } catch (e) {
    alert("제작 시작 실패");
    if (btn) {
      btn.textContent = "영상 제작";
      btn.disabled = false;
      btn.classList.remove("opacity-50", "cursor-not-allowed");
    }
  }
}


// ─── Step 4: 영상 제작 ───

function renderWizardStep4(jobId, scriptData, stepsData) {
  const { status, script, has_thumbnail } = scriptData;
  const steps = stepsData.steps || [];
  const stepStatus = {};
  for (const s of steps) stepStatus[s.step_name] = s.status || "pending";

  const renderDone = stepStatus["render"] === "completed";
  const isRunning = status === "running" || status === "queued";

  // Running / Queued state
  if (isRunning && !renderDone) {
    const runningStep = steps.find(s => s.status === "running");
    const label = runningStep ? (STEP_LABELS[runningStep.step_name] || runningStep.step_name) : "영상";
    const isQueued = status === "queued";
    return `
      <div class="wizard-step-content">
        <div id="running-status-msg" class="text-center py-12 text-gray-400">
          <span class="inline-block animate-pulse text-2xl mb-2">${isQueued ? '⏳' : '🎬'}</span><br>
          <span class="text-lg">${isQueued ? '큐 대기 중...' : esc(label) + ' 진행 중...'}</span>
        </div>
        <div id="running-video-area"></div>
      </div>`;
  }

  // Video ready or completed
  let videoHtml = "";
  if (renderDone || status === "completed") {
    const thumbTs = Date.now();

    // 썸네일 (왼쪽 — 가운데 정렬 + 버튼 우측)
    const thumbHtml = `
      <div class="flex flex-col flex-1" style="min-width:0;">
        <div class="flex justify-end gap-1 mb-2">
          <button onclick="generateThumbnail('${jobId}')" id="btn-gen-thumb"
                  class="px-2 py-1 bg-orange-700 hover:bg-orange-600 rounded text-[10px] font-medium transition">${has_thumbnail ? '재생성' : '생성'}</button>
          <label class="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-[10px] font-medium transition cursor-pointer">
            교체 <input type="file" accept="image/*" class="hidden" onchange="uploadThumbnail('${jobId}', this.files[0])">
          </label>
        </div>
        <div class="flex justify-center flex-1">
          ${has_thumbnail
            ? `<img src="/api/jobs/${jobId}/thumbnail?t=${thumbTs}" class="rounded" style="max-width:100%; max-height:400px; object-fit:contain;" />`
            : `<div class="rounded border border-dashed border-gray-700 flex items-center justify-center text-xs text-gray-500" style="width:200px; height:120px;">썸네일 미생성</div>`}
        </div>
        <div id="thumb-status-${jobId}" class="text-xs mt-1 text-center"></div>
      </div>`;

    // 영상 (오른쪽 — 가운데 정렬 + 버튼 우측)
    const vidHtml = `
      <div class="flex flex-col flex-1" style="min-width:0;">
        <div class="flex justify-end gap-1 mb-2">
          <a href="/editor/${jobId}" target="_blank"
             class="px-2 py-1 bg-blue-700 hover:bg-blue-600 rounded text-[10px] font-medium transition">편집</a>
        </div>
        <div class="flex justify-center flex-1">
          <video class="rounded" controls preload="metadata" style="max-width:100%; max-height:400px; aspect-ratio:9/16; object-fit:contain; background:#000;"
                 poster="/api/jobs/${jobId}/thumbnail?t=${thumbTs}"
                 onloadeddata="this.currentTime=0.1">
            <source src="/api/jobs/${jobId}/video?t=${thumbTs}" type="video/mp4">
          </video>
        </div>
        <div id="upload-status-${jobId}" class="text-xs mt-1 text-center"></div>
      </div>`;

    videoHtml = `
      <div class="flex gap-4 mb-3" style="align-items:stretch;">
        <div style="flex:2; min-width:0;">${thumbHtml}</div>
        <div style="flex:3; min-width:0;">${vidHtml}</div>
      </div>`;

    // QA Checklist
    videoHtml += renderQAChecklist(steps);
  }

  // Failed state
  if (status === "failed") {
    const failedStep = steps.find(s => s.status === "failed");
    const errMsg = failedStep ? failedStep.error_msg : "알 수 없는 오류";
    const shortErr = (errMsg || "").length > 200 ? (errMsg.substring(0, 200) + "...") : (errMsg || "");
    videoHtml = `
      <div class="text-center py-6">
        <div class="text-red-400 text-lg mb-2">제작 실패</div>
        <div class="text-sm text-gray-500 mb-3 max-h-24 overflow-y-auto text-left px-4" style="word-break:break-all;">${esc(shortErr)}</div>
        <button onclick="retryJob('${jobId}')" class="px-6 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition">재시도</button>
      </div>`;
  }

  return `<div class="wizard-step-content">${videoHtml}</div>`;
}

function renderQAChecklist(steps) {
  const qaStep = steps.find(s => s.step_name === "qa");
  if (!qaStep || qaStep.status !== "completed") return "";

  let outputData = {};
  try {
    outputData = JSON.parse(qaStep.output_data || "{}");
  } catch { return ""; }

  const passed = outputData.passed;
  const score = outputData.score;
  const issues = outputData.issues || [];
  const rawDetails = outputData.details;
  const details = Array.isArray(rawDetails) ? rawDetails : [];
  const detailText = typeof rawDetails === "string" ? rawDetails : "";

  let html = `<div class="qa-checklist">
    <div class="qa-checklist-title">QA 검사 결과</div>`;

  if (score !== undefined) {
    html += `<div class="qa-score ${passed ? 'pass' : 'fail'}">${passed ? '✅' : '❌'} ${score}점</div>`;
  }

  if (detailText) {
    html += `<div class="qa-item qa-detail-text"><span class="qa-text text-xs text-gray-300">${esc(detailText)}</span></div>`;
  }

  if (details.length > 0) {
    html += details.map(d => {
      const ok = d.passed !== false;
      return `<div class="qa-item ${ok ? 'qa-passed' : 'qa-failed'}">
        <span class="qa-icon">${ok ? '✓' : '✕'}</span>
        <span class="qa-text">${esc(d.name || d.check || '')}: ${esc(d.message || d.result || '')}</span>
      </div>`;
    }).join("");
  } else if (issues.length > 0) {
    html += issues.map(issue => `
      <div class="qa-item qa-failed">
        <span class="qa-icon">✕</span>
        <span class="qa-text">${esc(typeof issue === 'string' ? issue : issue.message || JSON.stringify(issue))}</span>
      </div>`).join("");
  }

  html += `</div>`;
  return html;
}

// ─── Wizard: Footer ───

function renderWizardFooter(step, jobId, scriptData, stepsData) {
  const { status, script, uploaded_backgrounds, image_prompts } = scriptData;
  const slides = script?.slides || [];
  const _fpc = (image_prompts || []).filter(p => (typeof p === "object" ? p.en : p)).length;
  const bgCount = _fpc > 0 ? _fpc : slides.filter(s => s.bg_type !== "closing").length;
  const uploadedBgs = uploaded_backgrounds || {};
  const uploadedCount = Object.keys(uploadedBgs).length;
  const stepStatus = {};
  for (const s of (stepsData.steps || [])) stepStatus[s.step_name] = s.status || "pending";
  const uploadDone = stepStatus["upload"] === "completed";

  const prevBtn = step > 1
    ? `<button onclick="navigateWizard(${step - 1})" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition">← 이전</button>`
    : `<div></div>`;

  let centerHtml = "";
  let rightBtn = "";

  if (step === 1) {
    centerHtml = script ? `<span class="text-xs text-gray-500">${slides.length}개 슬라이드</span>` : "";
    rightBtn = script
      ? `<button onclick="navigateWizard(2)" class="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition">이미지 생성 →</button>`
      : "";
  } else if (step === 2) {
    centerHtml = `<span class="text-xs text-gray-500">${uploadedCount}/${bgCount}장 준비됨</span>`;
    const isRunning2 = status === "running";
    rightBtn = `<div class="flex gap-2">
      <a href="/composer/${jobId}" target="_blank"
        class="px-4 py-2 bg-blue-700 hover:bg-blue-600 rounded-lg text-sm font-medium transition inline-block">
        전문 편집
      </a>
      <button onclick="navigateWizard(3)"
        class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition">
        효과 추가 →
      </button>
      <button id="btn-quick-render" onclick="quickRender('${jobId}')"
        class="px-4 py-2 ${isRunning2 ? 'bg-gray-600 opacity-50 cursor-not-allowed' : uploadedCount >= bgCount ? 'bg-orange-600 hover:bg-orange-500' : 'bg-gray-700 hover:bg-gray-600'} rounded-lg text-sm font-medium transition"
        ${isRunning2 ? 'disabled' : ''}>
        ${isRunning2 ? '제작 중...' : '영상 제작'}
      </button>
    </div>`;
  } else if (step === 3) {
    centerHtml = `<span class="text-xs text-gray-500">슬라이드 간 전환효과 설정</span>`;
    const isRunning = status === "running";
    rightBtn = `<div class="flex gap-2">
      <button id="btn-resume-job" onclick="saveTransitionsAndResume('${jobId}')"
        class="px-4 py-2 ${isRunning ? 'bg-gray-600 opacity-50 cursor-not-allowed' : uploadedCount >= bgCount ? 'bg-orange-600 hover:bg-orange-500' : 'bg-gray-700 hover:bg-gray-600'} rounded-lg text-sm font-medium transition"
        ${isRunning ? 'disabled' : ''}>
        ${isRunning ? '영상 제작 중...' : '영상 제작 →'}
      </button>
    </div>`;
  } else if (step === 4) {
    const renderDone = stepStatus["render"] === "completed" || status === "completed";
    if (renderDone) {
      rightBtn = `
        <div class="flex gap-2">
          <button onclick="resetToWaiting('${jobId}')" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition">재작업</button>
          <a href="/api/jobs/${jobId}/video" download class="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition inline-block">다운로드</a>
          <button onclick="showUploadOptions('${jobId}')" id="btn-manual-upload"
                  class="px-3 py-2 bg-red-700 hover:bg-red-600 rounded-lg text-xs font-medium transition">YouTube 업로드</button>
        </div>
        <div id="upload-options-${jobId}" class="hidden mt-2 p-3 bg-gray-800 rounded-lg border border-gray-700">
          <div class="flex gap-2 items-center mb-2">
            <label class="flex items-center gap-1 cursor-pointer text-xs">
              <input type="radio" name="upload-mode-${jobId}" value="now" checked class="accent-red-500" onchange="toggleSchedulePicker('${jobId}')"> 즉시 게시
            </label>
            <label class="flex items-center gap-1 cursor-pointer text-xs">
              <input type="radio" name="upload-mode-${jobId}" value="schedule" class="accent-red-500" onchange="toggleSchedulePicker('${jobId}')"> 예약 게시
            </label>
          </div>
          <div id="schedule-picker-${jobId}" class="hidden mb-2">
            <input type="datetime-local" id="schedule-time-${jobId}" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs">
            <p class="text-xs text-gray-500 mt-1">예약 시 비공개로 업로드 후, 지정 시간에 자동 공개됩니다</p>
          </div>
          <div class="flex gap-2">
            <button onclick="manualUpload('${jobId}')" class="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-xs font-medium transition">업로드</button>
            <button onclick="document.getElementById('upload-options-${jobId}').classList.add('hidden')" class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">취소</button>
          </div>
        </div>`;
    } else if (status === "failed") {
      const failedStep = (stepsData.steps || []).find(s => s.status === "failed");
      const fn = failedStep ? failedStep.step_name : "";
      const isPhaseA = ["synopsis", "visual_plan", "script"].includes(fn);
      rightBtn = `<div class="flex gap-2">
        <button onclick="retryJob('${jobId}')" class="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition">재시도</button>
        ${!isPhaseA ? `<button onclick="resetToWaiting('${jobId}')" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition">이미지 대기로</button>` : ''}
      </div>`;
    }
  }

  return `
    <div class="wizard-footer">
      ${prevBtn}
      <div class="wizard-footer-center">${centerHtml}</div>
      ${rightBtn || '<div></div>'}
    </div>`;
}

// ─── Wizard: Main Render ───

function renderJobDetail(scriptData, stepsData) {
  const { job_id, topic, status, auto_bg_source, slide_layout } = scriptData;
  const jobId = job_id;

  // 다른 작업 팝업으로 바뀌었으면 렌더링 스킵
  if (currentDetailJobId && jobId !== currentDetailJobId) return;

  window._bgSource = auto_bg_source || "sd_image";
  window._slideLayout = slide_layout || "full";
  window._jobStatus = status;
  const steps = stepsData.steps || [];

  // 단계별 상태 맵
  const stepStatus = {};
  for (const s of steps) {
    stepStatus[s.step_name] = s.status || "pending";
  }
  if (status === "waiting_slides") {
    stepStatus["slides"] = "waiting";
  }
  // 누락된 단계 보정
  {
    let latestIdx = -1;
    for (const name of Object.keys(stepStatus)) {
      const st = stepStatus[name];
      if (st === "completed" || st === "skipped") {
        const idx = STEP_ORDER.indexOf(name);
        if (idx > latestIdx) latestIdx = idx;
      }
    }
    for (let i = 0; i < latestIdx; i++) {
      if (!stepStatus[STEP_ORDER[i]]) stepStatus[STEP_ORDER[i]] = "completed";
    }
  }

  const uploadDone = stepStatus["upload"] === "completed";
  const displayStatus = (status === "completed" && !uploadDone) ? "rendered" : status;
  const statusText = displayStatus === "rendered" ? "영상 완성" : (STATUS_TEXT[status] || status);
  const statusClass = `status-${displayStatus}`;

  // 파이프라인 단계 — 위자드 네비로 통합, 상단 아이콘 제거
  const pipelineHtml = "";

  // Wizard body
  let bodyHtml = "";
  if (_wizardStep === 1) bodyHtml = renderWizardStep1(jobId, scriptData, stepsData);
  else if (_wizardStep === 2) bodyHtml = renderWizardStep2(jobId, scriptData, stepsData);
  else if (_wizardStep === 3) bodyHtml = renderWizardStep3_Transition(jobId, scriptData, stepsData);
  else if (_wizardStep === 4) bodyHtml = renderWizardStep4(jobId, scriptData, stepsData);

  const wizardNav = renderWizardNav(_wizardStep, scriptData, stepsData);
  const wizardFooter = renderWizardFooter(_wizardStep, jobId, scriptData, stepsData);

  document.getElementById("job-detail-content").innerHTML = `
    <div class="flex items-start justify-between mb-1">
      <div>
        <h3 class="text-lg font-bold"><span class="text-gray-500 text-sm mr-1">${job_id.replace(/^job-\d+-0*/, "#")}</span>${esc(topic)}</h3>
        <span class="status-badge ${statusClass} mt-1 inline-block">${statusText}</span>
        ${["running","failed","queued"].includes(status) ? `
        <select onchange="forceJobStatus('${jobId}', this.value)" class="ml-2 mt-1 text-xs bg-gray-800 text-gray-300 border border-gray-600 rounded px-1 py-0.5">
          <option value="">상태 수정</option>
          <option value="completed">완료 처리</option>
          <option value="failed">실패 처리</option>
          <option value="waiting_slides">대기 복귀</option>
        </select>` : ''}
      </div>
      <button onclick="closeModal('job-detail-modal')" class="text-gray-500 hover:text-white text-lg transition">&times;</button>
    </div>
    ${wizardNav}
    <div class="wizard-body">
      ${bodyHtml}
    </div>
    ${wizardFooter}
  `;

  // GPT-SoVITS 참조 음성 목록 로드
  _loadSovitsRefSelect();
  // Gemini TTS 초기화 (음성 목록 + rate 숨기기)
  const _engineSel = document.getElementById("tts-engine-select");
  if (_engineSel && _engineSel.value === "gemini-tts") {
    toggleNarrationEngine();
  }
  // 슬라이드별 TTS 탭 초기화 — 첫 번째 탭 값 로드
  if (_activeSlideTab && _perSlideTts[_activeSlideTab]) {
    _loadSlideTabTts(_activeSlideTab);
  }
}

async function _loadSovitsRefSelect() {
  const select = document.getElementById("sovits-ref-select");
  if (!select) return;
  try {
    const res = await fetch("/api/ref-voices");
    const voices = await res.json();
    // 채널 config에서 기본 참조 음성 가져오기
    const jobCh = channelsCache.find(c => c.jobs?.some(j => j.id === currentDetailJobId));
    let chCfg = {};
    try { chCfg = JSON.parse(jobCh?.config || "{}"); } catch {}
    const defaultRef = chCfg.sovits_ref_voice || "";

    select.innerHTML = '<option value="">-- 선택하세요 --</option>';
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.filename;
      opt.textContent = `${v.name} (${v.size_kb} KB)`;
      if (v.filename === defaultRef) opt.selected = true;
      select.appendChild(opt);
    }
  } catch {}
}

/* OLD TAB FUNCTIONS REMOVED — replaced by wizard */

async function forceJobStatus(jobId, newStatus) {
  if (!newStatus) return;
  if (!confirm(`작업 상태를 "${newStatus}"로 변경하시겠습니까?`)) return;
  try {
    const res = await fetch(`/api/jobs/${jobId}/force-status`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({status: newStatus})
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    openJobDetail(jobId);
  } catch (e) {
    alert("상태 변경 실패: " + e.message);
  }
}

function showUploadOptions(jobId) {
  const optionsEl = document.getElementById(`upload-options-${jobId}`);
  if (optionsEl) {
    optionsEl.classList.toggle("hidden");
    // 기본 예약 시간: 내일 오전 9시
    const picker = document.getElementById(`schedule-time-${jobId}`);
    if (picker && !picker.value) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      picker.value = tomorrow.toISOString().slice(0, 16);
    }
  }
}

function toggleSchedulePicker(jobId) {
  const mode = document.querySelector(`input[name="upload-mode-${jobId}"]:checked`)?.value;
  const picker = document.getElementById(`schedule-picker-${jobId}`);
  if (picker) {
    if (mode === "schedule") picker.classList.remove("hidden");
    else picker.classList.add("hidden");
  }
}

async function manualUpload(jobId) {
  const statusEl = document.getElementById(`upload-status-${jobId}`);

  // 예약 모드 확인
  const modeEl = document.querySelector(`input[name="upload-mode-${jobId}"]:checked`);
  const mode = modeEl ? modeEl.value : "now";
  let publishAt = "";

  if (mode === "schedule") {
    const picker = document.getElementById(`schedule-time-${jobId}`);
    if (!picker || !picker.value) {
      alert("예약 시간을 선택하세요");
      return;
    }
    // 로컬 시간 → ISO 8601 UTC
    const localDate = new Date(picker.value);
    publishAt = localDate.toISOString();
  }

  const confirmMsg = mode === "schedule"
    ? `예약 게시로 업로드하시겠습니까?\n(${new Date(publishAt).toLocaleString()} 에 자동 공개)`
    : "YouTube에 즉시 업로드하시겠습니까?";
  if (!confirm(confirmMsg)) return;

  // 옵션 패널 숨기기
  const optionsEl = document.getElementById(`upload-options-${jobId}`);
  if (optionsEl) optionsEl.classList.add("hidden");

  const btn = document.getElementById("btn-manual-upload");
  btnLoading(btn, "업로드 중...");

  try {
    const res = await fetch(`/api/jobs/${jobId}/youtube-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publish_at: publishAt }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      throw new Error(err.detail || "업로드 실패");
    }
    const data = await res.json();
    const label = publishAt ? "예약 업로드 완료" : "업로드 완료";
    btnDone(btn, label, false);
    const scheduleInfo = publishAt ? ` (${new Date(publishAt).toLocaleString()} 공개 예정)` : "";
    if (statusEl) statusEl.innerHTML = `<span class="text-green-400">${label}! ID: ${data.video_id || ""}${scheduleInfo}</span>`;
  } catch (e) {
    btnError(btn, "업로드 실패");
    if (statusEl) statusEl.innerHTML = `<span class="text-red-400">실패: ${e.message}</span>`;
  }
}


function copyPrompt(btn) {
  const el = document.getElementById("genspark-prompt");
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    btn.innerHTML = "&#x2705;";
    setTimeout(() => { btn.innerHTML = "&#x1F4CB;"; }, 1500);
  });
}

const _veoInProgress = new Set();  // 진행 중인 Veo 변환 슬롯 번호
async function bgToVideo(jobId, bgIdx, btn) {
  if (!confirm(`bg_${bgIdx}을 Veo 3.1 Fast로 영상화합니다.\n비용: ~$0.60 (6초)\n진행할까요?`)) return;
  if (btn.disabled) return;
  const origText = btn.innerHTML;
  btn.innerHTML = "⏳";
  btn.disabled = true;
  _veoInProgress.add(bgIdx);

  // 슬롯별 로딩 표시
  const slotWrap = document.getElementById(`slot-wrap-${bgIdx}`);
  if (slotWrap) slotWrap.classList.add("veo-converting");
  const statusEl = document.getElementById("sd-status");
  _updateVeoStatus(statusEl);

  try {
    const resp = await fetch(`/api/jobs/${jobId}/bg/${bgIdx}/to-video`, { method: "POST" });
    const data = await resp.json();
    _veoInProgress.delete(bgIdx);
    if (slotWrap) slotWrap.classList.remove("veo-converting");
    if (resp.ok) {
      btn.innerHTML = "✅";
      setTimeout(() => { btn.innerHTML = "🎬"; }, 3000);
      // 다른 변환이 아직 진행 중이면 전체 리렌더 스킵
      if (_veoInProgress.size === 0) {
        _lastDetailStatus = null;
        await refreshJobDetail(jobId);
      } else {
        // 완료된 슬롯만 MP4 뱃지로 교체
        const slot = document.getElementById(`slot-${bgIdx}`);
        if (slot && data.path) {
          const img = slot.querySelector("img");
          if (img) img.src = data.path + "?t=" + Date.now();
        }
      }
    } else {
      alert(`영상화 실패: ${data.detail || "unknown error"}`);
      btn.innerHTML = origText;
      btn.disabled = false;
    }
    _updateVeoStatus(statusEl);
  } catch (e) {
    _veoInProgress.delete(bgIdx);
    if (slotWrap) slotWrap.classList.remove("veo-converting");
    alert(`영상화 요청 실패: ${e.message}`);
    btn.innerHTML = origText;
    btn.disabled = false;
    _updateVeoStatus(statusEl);
  }
}
function _updateVeoStatus(statusEl) {
  if (!statusEl) return;
  if (_veoInProgress.size > 0) {
    const slots = [..._veoInProgress].sort((a,b) => a-b).join(", ");
    statusEl.innerHTML = `<div class="text-xs text-purple-400 mb-2 flex items-center gap-2"><span class="veo-spinner"></span> bg_${slots} 영상 변환 중... (${_veoInProgress.size}개)</div>`;
  } else {
    statusEl.innerHTML = "";
  }
}

function copyOnePrompt(btn) {
  const encoded = btn.getAttribute("data-copy");
  const text = encoded ? decodeURIComponent(escape(atob(encoded))) : "";
  navigator.clipboard.writeText(text.replace(/\\n/g, "\n")).then(() => {
    btn.innerHTML = "&#x2705;";
    setTimeout(() => { btn.innerHTML = "&#x1F4CB;"; }, 1500);
  });
}

function copyImagePrompts(btn) {
  // 프롬프트 텍스트만 추출 (배지/VEO/클립보드 제외, 번호는 유지)
  const box = document.getElementById("image-prompts-box");
  if (!box) return;
  const lines = [];
  box.querySelectorAll(".text-xs.py-1").forEach(item => {
    const num = item.querySelector(".text-orange-400");
    const ko = item.querySelector(".text-gray-300");
    const en = item.querySelector(".text-gray-500");
    const parts = [];
    if (num) parts.push(num.textContent.trim());
    if (ko && ko.textContent.trim()) parts.push(ko.textContent.trim());
    if (en && en.textContent.trim()) parts.push(en.textContent.trim());
    if (parts.length) lines.push(parts.join("\n"));
  });
  navigator.clipboard.writeText(lines.join("\n\n")).then(() => {
    btn.innerHTML = "&#x2705;";
    setTimeout(() => { btn.innerHTML = "&#x1F4CB;"; }, 1500);
  });
}

// ─── Library Matching ───

async function matchFromLibrary(jobId) {
  const btn = document.getElementById("btn-match");
  const statusEl = document.getElementById("match-status");

  btn.textContent = "매칭중...";
  btn.disabled = true;

  try {
    const res = await fetch(`/api/jobs/${jobId}/match-library`, { method: "POST" });
    const data = await res.json();
    const matches = data.matches || [];
    const stats = data.library_stats || {};

    if (stats.total === 0) {
      statusEl.innerHTML = `<div class="text-xs text-gray-500 mb-2">라이브러리에 이미지가 없습니다. 직접 업로드해주세요.</div>`;
      btn.textContent = "라이브러리 자동매칭";
      btn.disabled = false;
      return;
    }

    const matched = matches.filter(m => m.matched);
    const unmatched = matches.filter(m => !m.matched && m.reason !== "closing");

    // 매칭 결과 적용
    if (matched.length > 0) {
      const applyRes = await fetch(`/api/jobs/${jobId}/apply-matches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matches }),
      });
      await applyRes.json();
    }

    // 상태 표시
    let statusMsg = `<div class="text-xs mb-2">`;
    statusMsg += `<span class="text-green-400">${matched.length}장 매칭</span>`;
    if (unmatched.length > 0) {
      statusMsg += ` · <span class="text-yellow-400">${unmatched.length}장 매칭 안됨</span>`;
      statusMsg += ` <span class="text-gray-500">(직접 업로드 필요)</span>`;
    }
    statusMsg += `</div>`;
    statusEl.innerHTML = statusMsg;

    // 팝업 전체 새로고침
    await refreshJobDetail(jobId);

  } catch (e) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">매칭 실패: ${e.message}</div>`;
  }

  btn.textContent = "라이브러리 자동매칭";
  btn.disabled = false;
}

// ─── Image Preview ───

function previewImage(url, index) {
  let overlay = document.getElementById("image-preview-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "image-preview-overlay";
    overlay.className = "image-preview-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add("hidden"); };
    document.body.appendChild(overlay);
  }
  const isVideo = url.includes('.mp4') || url.includes('.gif');
  const mediaTag = isVideo
    ? `<video src="${url}" autoplay loop muted playsinline style="max-width:100%;max-height:80vh;border-radius:8px;"></video>`
    : `<img src="${url}" alt="slide ${index}">`;
  overlay.innerHTML = `
    <div class="image-preview-card">
      <div class="image-preview-header">
        <span class="text-sm text-gray-300">슬라이드 ${index}</span>
        <button onclick="document.getElementById('image-preview-overlay').classList.add('hidden')"
                class="text-gray-500 hover:text-white text-lg">&times;</button>
      </div>
      ${mediaTag}
    </div>`;
  overlay.classList.remove("hidden");
}

// ─── Voice Preview ───

function toggleNarrationEngine() {
  const engine = document.getElementById("tts-engine-select").value;
  const edgeSection = document.getElementById("narration-edge-section");
  const googleSection = document.getElementById("narration-google-section");
  const sovitsSection = document.getElementById("narration-sovits-section");
  const geminiStyleSection = document.getElementById("narration-gemini-style-section");

  [edgeSection, googleSection, sovitsSection].forEach(el => el && el.classList.add("hidden"));
  if (geminiStyleSection) geminiStyleSection.classList.add("hidden");

  // 각 섹션의 엔진 셀렉트 동기화
  ["tts-engine-select-e","tts-engine-select-g","tts-engine-select-s"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = engine;
  });

  if (engine === "google-cloud") {
    googleSection.classList.remove("hidden");
  } else if (engine === "gpt-sovits") {
    sovitsSection.classList.remove("hidden");
    _loadSovitsRefSelect();
  } else if (engine === "gemini-tts") {
    edgeSection.classList.remove("hidden");
    const voiceSel = document.getElementById("tts-voice-select");
    if (voiceSel) {
      const geminiVoices = {
        "Kore": "Kore (Firm)", "Puck": "Puck (Upbeat)", "Sulafat": "Sulafat (Warm)",
        "Charon": "Charon (Informative)", "Fenrir": "Fenrir (Excitable)", "Leda": "Leda (Youthful)",
        "Orus": "Orus (Firm)", "Aoede": "Aoede (Breezy)", "Zephyr": "Zephyr (Bright)",
        "Enceladus": "Enceladus (Breathy)", "Iapetus": "Iapetus (Clear)", "Umbriel": "Umbriel (Easy-going)",
        "Achernar": "Achernar (Soft)", "Achird": "Achird (Friendly)", "Gacrux": "Gacrux (Mature)",
        "Vindemiatrix": "Vindemiatrix (Gentle)", "Sadachbia": "Sadachbia (Lively)",
      };
      const chCfg = window._currentChannelConfig || {};
      const defaultV = chCfg.gemini_tts_voice || "Kore";
      let opts = "";
      for (const [k, v] of Object.entries(geminiVoices)) {
        opts += `<option value="${k}" ${k === defaultV ? 'selected' : ''}>${v}</option>`;
      }
      voiceSel.innerHTML = opts;
    }
    if (geminiStyleSection) geminiStyleSection.classList.remove("hidden");
  } else {
    edgeSection.classList.remove("hidden");
    // Edge 음성 복원
    const voiceSel = document.getElementById("tts-voice-select");
    if (voiceSel && !voiceSel.querySelector('option[value="ko-KR-SunHiNeural"]')) {
      const chCfg = window._currentChannelConfig || {};
      const dv = chCfg.tts_voice || "ko-KR-SunHiNeural";
      voiceSel.innerHTML = `
        <option value="ko-KR-SunHiNeural" ${dv==='ko-KR-SunHiNeural'?'selected':''}>선히 (여)</option>
        <option value="ko-KR-InJoonNeural" ${dv==='ko-KR-InJoonNeural'?'selected':''}>인준 (남)</option>
        <option value="ko-KR-HyunsuNeural" ${dv==='ko-KR-HyunsuNeural'?'selected':''}>현수 (남)</option>
        <option value="ko-KR-HyunsuMultilingualNeural" ${dv==='ko-KR-HyunsuMultilingualNeural'?'selected':''}>현수M (남)</option>`;
    }
  }
}

// ─── 공통 TTS 페이로드 수집 ───

function _collectTtsPayload() {
  const payload = {};
  const _engineSel = document.getElementById("tts-engine-select");
  const _engine = _engineSel ? _engineSel.value : (_lastScriptData?.channel_config?.tts_engine || "edge-tts");
  payload.tts_engine = _engine;
  if (_engine === "google-cloud") {
    const _gv = document.getElementById("google-voice-select");
    const _gr = document.getElementById("google-rate");
    payload.tts_voice = _gv ? _gv.value : (_lastScriptData?.channel_config?.google_voice || "ko-KR-Wavenet-A");
    payload.tts_rate = _gr ? _gr.value : "0";
  } else if (_engine === "gpt-sovits") {
    const _ref = document.getElementById("sovits-ref-select");
    payload.sovits_ref_voice = _ref ? _ref.value : "";
  } else {
    const _ev = document.getElementById("tts-voice-select");
    const _er = document.getElementById("tts-rate");
    payload.tts_voice = _ev ? _ev.value : (_lastScriptData?.channel_config?.tts_voice || "");
    payload.tts_rate = _er ? _er.value : "0";
  }
  if (_engine === "gemini-tts") {
    const _gs = document.getElementById("gemini-tts-style-popup");
    if (_gs) payload.gemini_tts_style = _gs.value.trim();
  }
  return payload;
}

// ─── 슬라이드별 TTS 모달 팝업 ───

function openSlideTtsModal(slideNum) {
  const sn = String(slideNum);
  const existing = _perSlideTts[sn] || null;
  const isCustom = !!existing;
  const chCfg = window._currentChannelConfig || {};
  const chEngine = chCfg.tts_engine || "edge-tts";

  // 현재 공통 설정값 읽기
  const commonTts = _collectTtsPayload();
  const cfg = existing || {
    engine: commonTts.tts_engine || chEngine,
    voice: commonTts.tts_voice || chCfg.tts_voice || "ko-KR-SunHiNeural",
    rate: parseInt(commonTts.tts_rate || "0"),
    style: commonTts.gemini_tts_style || chCfg.gemini_tts_style || "",
  };

  // Edge 음성 옵션
  const edgeVoices = [
    ["ko-KR-SunHiNeural","선히 (여)"],["ko-KR-InJoonNeural","인준 (남)"],
    ["ko-KR-HyunsuNeural","현수 (남)"],["ko-KR-HyunsuMultilingualNeural","현수M (남)"]
  ];
  const edgeOpts = edgeVoices.map(([v,l]) => `<option value="${v}" ${cfg.voice===v?'selected':''}>${l}</option>`).join("");

  // Google 음성 옵션
  const googleVoices = [
    ["ko-KR-Wavenet-A","Wavenet A (여)"],["ko-KR-Wavenet-B","Wavenet B (여)"],
    ["ko-KR-Wavenet-C","Wavenet C (남)"],["ko-KR-Wavenet-D","Wavenet D (남)"],
    ["ko-KR-Neural2-A","Neural2 A (여)"],["ko-KR-Neural2-B","Neural2 B (여)"],
    ["ko-KR-Neural2-C","Neural2 C (남)"]
  ];
  const googleOpts = googleVoices.map(([v,l]) => `<option value="${v}" ${cfg.voice===v?'selected':''}>${l}</option>`).join("");

  // Gemini 음성 옵션
  const geminiVoices = {
    "Kore":"Kore (Firm)","Puck":"Puck (Upbeat)","Sulafat":"Sulafat (Warm)",
    "Charon":"Charon (Informative)","Fenrir":"Fenrir (Excitable)","Leda":"Leda (Youthful)",
    "Orus":"Orus (Firm)","Aoede":"Aoede (Breezy)","Zephyr":"Zephyr (Bright)",
    "Enceladus":"Enceladus (Breathy)","Iapetus":"Iapetus (Clear)","Umbriel":"Umbriel (Easy-going)",
    "Achernar":"Achernar (Soft)","Achird":"Achird (Friendly)","Gacrux":"Gacrux (Mature)",
    "Vindemiatrix":"Vindemiatrix (Gentle)","Sadachbia":"Sadachbia (Lively)"
  };
  const geminiOpts = Object.entries(geminiVoices).map(([k,v]) => `<option value="${k}" ${cfg.voice===k?'selected':''}>${v}</option>`).join("");

  const rateVal = cfg.rate || 0;
  const rateSign = rateVal >= 0 ? "+" : "";

  // 모달 HTML
  const modalHtml = `
    <div id="slide-tts-modal" class="fixed inset-0 z-[9999] flex items-center justify-center" style="background:rgba(0,0,0,0.6);backdrop-filter:blur(2px);">
      <div class="bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-5" style="width:400px;max-width:90vw;">
        <div class="flex items-center justify-between mb-4">
          <span class="text-sm font-bold text-white">슬라이드 ${slideNum} 음성 설정</span>
          <button onclick="closeSlideTtsModal()" class="text-gray-500 hover:text-white text-lg leading-none">&times;</button>
        </div>
        <div class="flex items-center gap-2 mb-4">
          <label class="flex items-center gap-2 cursor-pointer text-xs">
            <input type="checkbox" id="stm-use-custom" ${isCustom ? 'checked' : ''}
                   onchange="toggleSlideTtsCustom()" class="accent-orange-500">
            <span class="text-gray-300">이 슬라이드에 개별 음성 적용</span>
          </label>
        </div>
        <div id="stm-custom-area" class="${isCustom ? '' : 'opacity-40 pointer-events-none'}">
          <div class="mb-3">
            <label class="text-xs text-gray-500 mb-1 block">엔진</label>
            <select id="stm-engine" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs"
                    onchange="toggleSlideTtsEngine()">
              <option value="edge-tts" ${cfg.engine==='edge-tts'?'selected':''}>Edge</option>
              <option value="google-cloud" ${cfg.engine==='google-cloud'?'selected':''}>Google</option>
              <option value="gpt-sovits" ${cfg.engine==='gpt-sovits'?'selected':''}>SoVITS</option>
              <option value="gemini-tts" ${cfg.engine==='gemini-tts'?'selected':''}>Gemini</option>
            </select>
          </div>
          <div id="stm-edge-section" class="${(cfg.engine==='edge-tts'||cfg.engine==='gemini-tts')?'':'hidden'}">
            <label class="text-xs text-gray-500 mb-1 block">음성</label>
            <select id="stm-voice-edge" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs mb-2">
              ${cfg.engine==='gemini-tts' ? geminiOpts : edgeOpts}
            </select>
          </div>
          <div id="stm-google-section" class="${cfg.engine==='google-cloud'?'':'hidden'}">
            <label class="text-xs text-gray-500 mb-1 block">음성</label>
            <select id="stm-voice-google" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs mb-2">
              ${googleOpts}
            </select>
          </div>
          <div id="stm-sovits-section" class="${cfg.engine==='gpt-sovits'?'':'hidden'}">
            <label class="text-xs text-gray-500 mb-1 block">참조 음성</label>
            <select id="stm-voice-sovits" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs mb-2">
            </select>
          </div>
          <div class="flex items-center gap-2 mb-3">
            <span class="text-xs text-gray-500 shrink-0">속도</span>
            <input type="range" id="stm-rate" min="-30" max="50" value="${rateVal}" step="10"
                   class="flex-1 h-1 accent-orange-500" oninput="document.getElementById('stm-rate-label').textContent=(this.value>=0?'+':'')+this.value+'%'">
            <span id="stm-rate-label" class="text-xs text-gray-400 w-10 text-right shrink-0">${rateSign}${rateVal}%</span>
          </div>
          <div id="stm-gemini-style-section" class="${cfg.engine==='gemini-tts'?'':'hidden'}">
            <label class="text-xs text-gray-500 mb-1 block">음성 스타일</label>
            <textarea id="stm-style" rows="3" placeholder="Read aloud in a warm and friendly tone"
                      class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs resize-none">${esc(cfg.style)}</textarea>
          </div>
        </div>
        <div class="flex justify-end gap-2 mt-4 pt-3 border-t border-gray-800">
          <button onclick="closeSlideTtsModal()" class="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">취소</button>
          <button onclick="saveSlideTtsModal(${slideNum})" class="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 rounded text-xs font-medium transition">저장</button>
        </div>
      </div>
    </div>`;

  // 기존 모달 제거 후 추가
  closeSlideTtsModal();
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  // SoVITS 참조 음성 로드
  if (cfg.engine === "gpt-sovits") {
    _loadSlideTtsSovitsRefs(cfg.voice);
  }
}

function toggleSlideTtsCustom() {
  const checked = document.getElementById("stm-use-custom")?.checked;
  const area = document.getElementById("stm-custom-area");
  if (!area) return;
  if (checked) {
    area.classList.remove("opacity-40", "pointer-events-none");
  } else {
    area.classList.add("opacity-40", "pointer-events-none");
  }
}

function toggleSlideTtsEngine() {
  const engine = document.getElementById("stm-engine")?.value || "edge-tts";
  document.getElementById("stm-edge-section")?.classList.add("hidden");
  document.getElementById("stm-google-section")?.classList.add("hidden");
  document.getElementById("stm-sovits-section")?.classList.add("hidden");
  document.getElementById("stm-gemini-style-section")?.classList.add("hidden");

  if (engine === "google-cloud") {
    document.getElementById("stm-google-section")?.classList.remove("hidden");
  } else if (engine === "gpt-sovits") {
    document.getElementById("stm-sovits-section")?.classList.remove("hidden");
    _loadSlideTtsSovitsRefs();
  } else {
    document.getElementById("stm-edge-section")?.classList.remove("hidden");
    // Gemini면 음성 목록 교체
    const voiceSel = document.getElementById("stm-voice-edge");
    if (voiceSel) {
      if (engine === "gemini-tts") {
        const gv = {"Kore":"Kore (Firm)","Puck":"Puck (Upbeat)","Sulafat":"Sulafat (Warm)","Charon":"Charon (Informative)","Fenrir":"Fenrir (Excitable)","Leda":"Leda (Youthful)","Orus":"Orus (Firm)","Aoede":"Aoede (Breezy)","Zephyr":"Zephyr (Bright)","Enceladus":"Enceladus (Breathy)","Iapetus":"Iapetus (Clear)","Umbriel":"Umbriel (Easy-going)","Achernar":"Achernar (Soft)","Achird":"Achird (Friendly)","Gacrux":"Gacrux (Mature)","Vindemiatrix":"Vindemiatrix (Gentle)","Sadachbia":"Sadachbia (Lively)"};
        voiceSel.innerHTML = Object.entries(gv).map(([k,v]) => `<option value="${k}">${v}</option>`).join("");
        document.getElementById("stm-gemini-style-section")?.classList.remove("hidden");
      } else {
        const ev = [["ko-KR-SunHiNeural","선히 (여)"],["ko-KR-InJoonNeural","인준 (남)"],["ko-KR-HyunsuNeural","현수 (남)"],["ko-KR-HyunsuMultilingualNeural","현수M (남)"]];
        voiceSel.innerHTML = ev.map(([v,l]) => `<option value="${v}">${l}</option>`).join("");
      }
    }
  }
}

async function _loadSlideTtsSovitsRefs(selectedVoice) {
  const sel = document.getElementById("stm-voice-sovits");
  if (!sel) return;
  try {
    const res = await fetch("/api/sovits/ref-voices");
    const data = await res.json();
    sel.innerHTML = (data.voices || []).map(v =>
      `<option value="${v.file}" ${v.file===selectedVoice?'selected':''}>${v.name}</option>`
    ).join("");
  } catch {}
}

function saveSlideTtsModal(slideNum) {
  const sn = String(slideNum);
  const useCustom = document.getElementById("stm-use-custom")?.checked;

  if (!useCustom) {
    // 개별 설정 해제 → 공통 설정 사용
    delete _perSlideTts[sn];
  } else {
    const engine = document.getElementById("stm-engine")?.value || "edge-tts";
    let voice = "";
    if (engine === "google-cloud") {
      voice = document.getElementById("stm-voice-google")?.value || "";
    } else if (engine === "gpt-sovits") {
      voice = document.getElementById("stm-voice-sovits")?.value || "";
    } else {
      voice = document.getElementById("stm-voice-edge")?.value || "";
    }
    const rate = parseInt(document.getElementById("stm-rate")?.value || "0");
    const style = (engine === "gemini-tts") ? (document.getElementById("stm-style")?.value?.trim() || "") : "";

    _perSlideTts[sn] = { engine, voice, rate, style };
  }

  closeSlideTtsModal();
}

function closeSlideTtsModal() {
  const modal = document.getElementById("slide-tts-modal");
  if (modal) modal.remove();
}


function updateRateLabel() {
  const val = document.getElementById("tts-rate").value;
  const sign = val >= 0 ? "+" : "";
  document.getElementById("tts-rate-label").textContent = `${sign}${val}%`;
}

function updateGoogleRateLabel() {
  const val = document.getElementById("google-rate").value;
  const sign = val >= 0 ? "+" : "";
  document.getElementById("google-rate-label").textContent = `${sign}${val}%`;
}

async function previewVoice() {
  const engineEl = document.getElementById("tts-engine-select");
  const engine = engineEl ? engineEl.value : "edge-tts";
  let voice, rate, btn;

  if (engine === "gemini-tts") {
    voice = document.getElementById("tts-voice-select")?.value || "Kore";
    btn = document.getElementById("btn-preview-voice");
    const audio = document.getElementById("voice-preview-popup");
    btn.textContent = "로딩...";
    btn.disabled = true;
    try {
      const res = await fetch(`/api/tts/gemini-sample/${voice}`);
      if (!res.ok) throw new Error("샘플 없음");
      const blob = await res.blob();
      audio.src = URL.createObjectURL(blob);
      audio.controls = true;
      audio.classList.remove("hidden");
      audio.play().catch(() => {});
    } catch (e) {
      alert("Gemini 미리듣기 실패: " + e.message);
    }
    btn.textContent = "미리듣기";
    btn.disabled = false;
    return;
  }

  if (engine === "google-cloud") {
    voice = document.getElementById("google-voice-select").value;
    rate = document.getElementById("google-rate").value;
    btn = document.getElementById("btn-preview-google-popup");
  } else {
    voice = document.getElementById("tts-voice-select").value;
    rate = document.getElementById("tts-rate").value;
    btn = document.getElementById("btn-preview-voice");
  }
  const audio = document.getElementById("voice-preview-popup");

  btn.textContent = "생성중...";
  btn.disabled = true;

  try {
    const url = `/api/tts/preview?voice=${encodeURIComponent(voice)}&rate=${rate}&t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("생성 실패");

    const blob = await res.blob();
    audio.src = URL.createObjectURL(blob);
    audio.controls = true;
    audio.classList.remove("hidden");
    audio.play().catch(() => {});
  } catch (e) {
    alert("음성 생성 실패: " + e.message);
  }

  btn.textContent = "미리듣기";
  btn.disabled = false;
}

// ─── Channel Settings — Option Groups ───

// 그룹 정의 캐시 (서버에서 로드)
let _configGroups = null;
let _enabledGroups = new Set();

// 그룹 ID → 탭 ID 매핑 (basic/content는 탭 분리 없이 기존 ID 사용)
const _GROUP_TAB_MAP = {
  basic: "basic",
  content: "content",
  tts: "tts",
  slide_style: "slide_style",
  image: "image",
  intro_outro: "intro_outro",
  audio_fx: "audio_fx",
  market_data: "market_data",
  prompt: "prompt",
  youtube: "youtube",
  schedule: "schedule",
};

// 앱 시작 시 미리 로드
let _configGroupsPromise = null;
async function _loadConfigGroups() {
  if (_configGroups) return _configGroups;
  if (!_configGroupsPromise) {
    _configGroupsPromise = fetch("/api/config/groups").then(r => r.json()).catch(e => {
      console.error("Failed to load config groups:", e);
      return { defaults: {}, groups: [] };
    });
  }
  _configGroups = await _configGroupsPromise;
  return _configGroups;
}
// 페이지 로드 시 미리 가져오기
_loadConfigGroups();

function _detectEnabledGroups(cfg) {
  if (!_configGroups) return new Set(["basic", "content", "tts"]);
  const enabled = new Set();
  for (const g of _configGroups.groups) {
    if (g.always_on) { enabled.add(g.id); continue; }
    for (const field of g.fields) {
      const val = cfg[field];
      const def = _configGroups.defaults[field];
      if (val !== undefined && val !== null && JSON.stringify(val) !== JSON.stringify(def)) {
        enabled.add(g.id);
        break;
      }
    }
  }
  // enabled_groups가 명시적으로 저장되어 있으면 그것을 우선
  if (cfg.enabled_groups && Array.isArray(cfg.enabled_groups)) {
    cfg.enabled_groups.forEach(g => enabled.add(g));
  }
  return enabled;
}

function _renderGroupChips() {
  const container = document.getElementById("cs-group-chips");
  if (!container || !_configGroups) return;
  container.innerHTML = "";
  for (const g of _configGroups.groups) {
    if (g.always_on) continue; // always_on 그룹은 칩으로 표시 안 함
    const chip = document.createElement("button");
    const active = _enabledGroups.has(g.id);
    chip.className = `cs-group-chip ${active ? "active" : ""}`;
    chip.dataset.groupId = g.id;
    chip.textContent = g.label;
    chip.onclick = () => _toggleGroup(g.id);
    container.appendChild(chip);
  }
}

function _toggleGroup(groupId) {
  if (_enabledGroups.has(groupId)) {
    _enabledGroups.delete(groupId);
  } else {
    _enabledGroups.add(groupId);
  }
  _renderGroupChips();
  _renderTabBar();
}

function _renderTabBar() {
  const bar = document.getElementById("cs-tab-bar");
  if (!bar || !_configGroups) return;
  bar.innerHTML = "";
  // 탭 순서: always_on 먼저, 그 다음 활성 그룹 순서대로
  const visibleGroups = _configGroups.groups.filter(
    g => g.always_on || _enabledGroups.has(g.id)
  );
  // 모든 탭 콘텐츠 숨김
  document.querySelectorAll(".cs-tab-content").forEach(el => {
    el.classList.add("hidden");
    el.style.display = "none";
  });
  for (const g of visibleGroups) {
    const tabId = _GROUP_TAB_MAP[g.id] || g.id;
    const btn = document.createElement("button");
    btn.className = "cs-tab-btn px-3 py-1.5 text-sm rounded-t-lg transition text-gray-500 hover:text-gray-300";
    btn.dataset.csTab = tabId;
    btn.textContent = g.label;
    btn.onclick = () => switchSettingsTab(tabId);
    bar.appendChild(btn);
  }
  // 첫 번째 탭 자동 선택
  if (visibleGroups.length > 0) {
    const firstTab = _GROUP_TAB_MAP[visibleGroups[0].id] || visibleGroups[0].id;
    switchSettingsTab(firstTab);
  }
}

function switchSettingsTab(tabName) {
  document.querySelectorAll(".cs-tab-content").forEach(el => {
    el.classList.add("hidden");
    el.style.display = "none";
  });
  document.querySelectorAll(".cs-tab-btn").forEach(btn => {
    btn.classList.remove("text-orange-400", "border-b-2", "border-orange-400");
    btn.classList.add("text-gray-500", "hover:text-gray-300");
  });
  const tab = document.getElementById("cs-tab-" + tabName);
  if (tab) {
    tab.classList.remove("hidden");
    tab.style.display = (tabName === "prompt" || tabName === "slide_style") ? "flex" : "block";
  }
  const btn = document.querySelector(`.cs-tab-btn[data-cs-tab="${tabName}"]`);
  if (btn) {
    btn.classList.add("text-orange-400", "border-b-2", "border-orange-400");
    btn.classList.remove("text-gray-500", "hover:text-gray-300");
  }
  // 슬라이드 탭 전환 시 미리보기 재렌더 (clientHeight 정확한 시점)
  if (tabName === "slide_style") {
    requestAnimationFrame(() => updateSlidePreview());
  }
}

// ─── Channel Fixed Background Images ───

function _showChannelBg(type, hasImage, channelId) {
  const img = document.getElementById(`cs-${type}-bg-img`);
  const placeholder = document.getElementById(`cs-${type}-bg-placeholder`);
  const delBtn = document.getElementById(`cs-${type}-bg-del`);
  if (hasImage) {
    img.src = `/api/channels/${channelId}/${type}-bg?t=${Date.now()}`;
    img.classList.remove("hidden");
    placeholder.classList.add("hidden");
    delBtn.classList.remove("hidden");
  } else {
    img.src = "";
    img.classList.add("hidden");
    placeholder.classList.remove("hidden");
    delBtn.classList.add("hidden");
  }
}

async function uploadChannelBg(type) {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  const fileInput = document.getElementById(`cs-${type}-bg-file`);
  const file = fileInput.files[0];
  if (!file) return;

  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/channels/${channelId}/${type}-bg`, {
    method: "POST", body: form
  });
  fileInput.value = "";
  if (res.ok) {
    _showChannelBg(type, true, channelId);
  } else {
    alert("업로드 실패");
  }
}

async function deleteChannelBg(type) {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  if (!confirm(`${type === 'intro' ? '인트로' : '아웃트로'} 고정 이미지를 삭제하시겠습니까?`)) return;
  await fetch(`/api/channels/${channelId}/${type}-bg`, { method: "DELETE" });
  _showChannelBg(type, false, channelId);
}

// ─── Character Reference Image ───

function _loadCharRefPreview(containerId, url) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const img = new Image();
  img.src = url;
  img.onload = () => {
    container.innerHTML = "";
    img.className = "w-full h-full object-cover";
    container.appendChild(img);
  };
  img.onerror = () => {
    container.innerHTML = '<span class="text-gray-600 text-xs">없음</span>';
  };
}

function loadCharacterRefPreview() {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  const t = Date.now();
  _loadCharRefPreview("cs-character-ref-preview", `/api/channels/${channelId}/character-ref?t=${t}`);
  _loadCharRefPreview("cs-character-ref-male-preview", `/api/channels/${channelId}/character-ref/male?t=${t}`);
  _loadCharRefPreview("cs-character-ref-female-preview", `/api/channels/${channelId}/character-ref/female?t=${t}`);
}

async function uploadCharacterRef(input) {
  const file = input.files[0];
  if (!file) return;
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/channels/${channelId}/character-ref`, { method: "POST", body: fd });
  if (res.ok) loadCharacterRefPreview();
  input.value = "";
}

async function deleteCharacterRef() {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  if (!confirm("캐릭터 참조 이미지를 삭제하시겠습니까?")) return;
  await fetch(`/api/channels/${channelId}/character-ref`, { method: "DELETE" });
  loadCharacterRefPreview();
}

async function uploadCharacterRefRole(input, role) {
  const file = input.files[0];
  if (!file) return;
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/channels/${channelId}/character-ref/${role}`, { method: "POST", body: fd });
  if (res.ok) loadCharacterRefPreview();
  input.value = "";
}

async function deleteCharacterRefRole(role) {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  const label = role === "male" ? "남자" : "여자";
  if (!confirm(`${label} 캐릭터 참조 이미지를 삭제하시겠습니까?`)) return;
  await fetch(`/api/channels/${channelId}/character-ref/${role}`, { method: "DELETE" });
  loadCharacterRefPreview();
}

// ─── Channel TTS Settings ───


function toggleAutoBgSource() {
  // 배경 이미지 소스는 항상 표시 (수동/자동 모두 사용)
}

function toggleBgDisplayMode() {
  const layout = document.getElementById("cs-slide-layout").value;
  const section = document.getElementById("bg-display-mode-section");
  if (layout === "full") {
    section.classList.add("hidden");
  } else {
    section.classList.remove("hidden");
  }
}

function toggleTtsEngine() {
  const engine = document.getElementById("cs-tts-engine").value;
  const edgeSection = document.getElementById("cs-tts-edge-section");
  const googleSection = document.getElementById("cs-tts-google-section");
  const sovitsSection = document.getElementById("cs-tts-sovits-section");
  const geminiSection = document.getElementById("cs-tts-gemini-section");

  edgeSection.classList.add("hidden");
  googleSection.classList.add("hidden");
  sovitsSection.classList.add("hidden");
  geminiSection.classList.add("hidden");

  if (engine === "google-cloud") {
    googleSection.classList.remove("hidden");
  } else if (engine === "gpt-sovits") {
    sovitsSection.classList.remove("hidden");
    checkSovitsStatus();
  } else if (engine === "gemini-tts") {
    geminiSection.classList.remove("hidden");
    _populateGeminiVoices();
  } else {
    edgeSection.classList.remove("hidden");
  }
}

function _populateGeminiVoices() {
  const sel = document.getElementById("cs-gemini-tts-voice");
  if (sel.options.length > 1) return; // already populated
  sel.innerHTML = "";
  const voices = {
    "Kore": "Kore (Firm)", "Puck": "Puck (Upbeat)", "Sulafat": "Sulafat (Warm)",
    "Charon": "Charon (Informative)", "Fenrir": "Fenrir (Excitable)", "Leda": "Leda (Youthful)",
    "Orus": "Orus (Firm)", "Aoede": "Aoede (Breezy)", "Zephyr": "Zephyr (Bright)",
    "Enceladus": "Enceladus (Breathy)", "Iapetus": "Iapetus (Clear)", "Umbriel": "Umbriel (Easy-going)",
    "Algieba": "Algieba (Smooth)", "Despina": "Despina (Smooth)", "Erinome": "Erinome (Clear)",
    "Algenib": "Algenib (Gravelly)", "Rasalgethi": "Rasalgethi (Informative)",
    "Laomedeia": "Laomedeia (Upbeat)", "Achernar": "Achernar (Soft)", "Alnilam": "Alnilam (Firm)",
    "Schedar": "Schedar (Even)", "Gacrux": "Gacrux (Mature)", "Pulcherrima": "Pulcherrima (Forward)",
    "Achird": "Achird (Friendly)", "Zubenelgenubi": "Zubenelgenubi (Casual)",
    "Vindemiatrix": "Vindemiatrix (Gentle)", "Sadachbia": "Sadachbia (Lively)",
    "Sadaltager": "Sadaltager (Knowledgeable)", "Callirrhoe": "Callirrhoe (Easy-going)",
    "Autonoe": "Autonoe (Bright)",
  };
  for (const [k, v] of Object.entries(voices)) {
    const opt = document.createElement("option");
    opt.value = k; opt.textContent = v;
    sel.appendChild(opt);
  }
}

// ─── 자막 설정 토글 ───
function toggleSubtitleSection() {
  const enabled = document.getElementById("cs-subtitle-enabled").checked;
  const section = document.getElementById("cs-subtitle-section");
  if (enabled) section.classList.remove("hidden");
  else section.classList.add("hidden");
  updateSlidePreview();
}

// ─── 슬라이드 미리보기 업데이트 ───
function updateSlidePreview() {
  const pvTop = document.getElementById("cs-pv-top");
  const pvMid = document.getElementById("cs-pv-mid");
  const pvBot = document.getElementById("cs-pv-bot");
  const pvSub = document.getElementById("cs-pv-subtitle");
  const pvWrap = document.getElementById("cs-slide-preview");
  if (!pvTop || !pvMid || !pvBot || !pvSub || !pvWrap) return;

  // Read settings
  const layout = document.getElementById("cs-slide-layout").value;
  const ratioStr = document.getElementById("cs-zone-ratio").value.trim();
  const mainZone = document.getElementById("cs-main-zone").value;
  const subZone = document.getElementById("cs-sub-zone").value;
  const textBgVal = parseInt(document.getElementById("cs-text-bg").value) || 4;
  const mainTextEnabled = document.getElementById("cs-main-text-enabled").checked;
  const subTextEnabled = document.getElementById("cs-sub-text-enabled").checked;
  const mainTextSize = parseInt(document.getElementById("cs-slide-main-text-size").value) || 0;
  const subTextSize = parseInt(document.getElementById("cs-sub-text-size").value) || 0;

  // Parse zone ratio
  const parts = ratioStr.split(":").map(Number).filter(n => !isNaN(n) && n >= 0);
  const zr = parts.length === 3 ? parts : [3, 4, 3];
  const zrTotal = zr[0] + zr[1] + zr[2];
  const topPct = (zr[0] / zrTotal * 100).toFixed(1);
  const midPct = (zr[1] / zrTotal * 100).toFixed(1);
  const botPct = (zr[2] / zrTotal * 100).toFixed(1);

  // Text bg opacity
  const textBgOpacity = (textBgVal * 0.1).toFixed(2);
  const textBgColor = `rgba(5,8,20,${textBgOpacity})`;

  // Bg gradient
  const bgGradStr = (document.getElementById("cs-slide-bg-gradient").value || "").trim();
  const bgCols = bgGradStr.split(",").map(s => s.trim()).filter(s => /^#[0-9a-fA-F]{3,8}$/.test(s));
  const bg0 = bgCols[0] || "#0b0e1a";
  const bg1 = bgCols[1] || "#141b2d";
  const bg2 = bgCols[2] || "#1a2238";
  pvWrap.style.background = bg0;

  // Scaled font sizes (dynamic preview height vs 1920px actual)
  const pvHeight = pvWrap.clientHeight || 320;
  const scale = pvHeight / 1920;
  const mainFontPx = ((mainTextSize || 100) * scale).toFixed(0);
  const subFontPx = ((subTextSize || 56) * scale).toFixed(0);

  // Sample texts (enabled 플래그로 온오프)
  const mainText = mainTextEnabled ? `<div style="font-weight:900;font-size:${mainFontPx}px;line-height:1.25;text-align:center;word-break:keep-all;">반도체 수출 급증</div>` : "";
  const subText = subTextEnabled ? `<div style="font-weight:400;font-size:${subFontPx}px;line-height:1.3;text-align:center;color:rgba(255,255,255,0.7);word-break:keep-all;margin-top:4px;">환율 상승 / 금리 동결 등 주요 이슈</div>` : "";

  // Reset all zones (레이아웃 전환 시 이전 스타일 잔류 방지)
  pvTop.innerHTML = "";
  pvMid.innerHTML = `<span style="font-size:11px;color:rgba(255,255,255,0.3);">IMAGE ZONE</span>`;
  pvBot.innerHTML = "";
  pvTop.style.background = textBgColor;
  pvBot.style.background = textBgColor;
  pvMid.style.background = `linear-gradient(135deg,${bg1} 0%,${bg2} 50%,${bg1} 100%)`;
  pvTop.style.display = "flex";
  pvBot.style.display = "flex";
  pvMid.style.display = "flex";
  pvTop.style.justifyContent = "center";
  pvBot.style.justifyContent = "center";
  pvTop.style.paddingBottom = "8px";
  pvTop.style.paddingTop = "8px";
  pvBot.style.paddingBottom = "8px";
  pvBot.style.paddingTop = "8px";
  pvBot.style.top = "auto";
  pvBot.style.bottom = "0";
  pvBot.style.height = "";

  if (layout === "full") {
    // Full layout: no zone split, text at bottom
    pvTop.style.display = "none";
    pvMid.style.display = "none";
    pvBot.style.top = "0";
    pvBot.style.bottom = "0";
    pvBot.style.height = "100%";
    pvBot.style.background = `linear-gradient(135deg,${bg1} 0%,${bg2} 100%)`;
    pvBot.style.justifyContent = "flex-end";
    pvBot.style.paddingBottom = "24px";
    pvBot.innerHTML = mainText + subText;
  } else {
    pvTop.style.display = "flex";
    pvMid.style.display = "flex";

    if (layout === "center") {
      pvTop.style.top = "0";
      pvTop.style.height = topPct + "%";
      pvTop.style.justifyContent = "flex-end";
      pvTop.style.paddingBottom = "6px";
      pvMid.style.top = topPct + "%";
      pvMid.style.height = midPct + "%";
      pvBot.style.top = "auto";
      pvBot.style.bottom = "0";
      pvBot.style.height = botPct + "%";
      pvBot.style.justifyContent = "flex-start";
      pvBot.style.paddingTop = "6px";

      // Place main/sub according to mainZone/subZone
      const topTexts = [];
      const botTexts = [];
      if (mainZone === "top") topTexts.push(mainText); else botTexts.push(mainText);
      if (subZone === "top") topTexts.push(subText); else botTexts.push(subText);
      pvTop.innerHTML = topTexts.join("");
      pvBot.innerHTML = botTexts.join("");
    } else if (layout === "top") {
      // Image top+mid, text bottom (하단 영역 → 텍스트 top 기준)
      pvTop.style.display = "none";
      pvMid.style.top = "0";
      pvMid.style.height = (parseFloat(topPct) + parseFloat(midPct)).toFixed(1) + "%";
      pvBot.style.top = "auto";
      pvBot.style.bottom = "0";
      pvBot.style.height = botPct + "%";
      pvBot.style.justifyContent = "flex-start";
      pvBot.style.paddingTop = "8px";
      pvBot.innerHTML = mainText + subText;
    } else if (layout === "bottom") {
      // Text top, image mid+bottom (상단 영역 → 텍스트 bottom 기준)
      pvTop.style.top = "0";
      pvTop.style.height = topPct + "%";
      pvTop.style.justifyContent = "flex-end";
      pvTop.style.paddingBottom = "8px";
      pvMid.style.top = topPct + "%";
      pvMid.style.height = (parseFloat(midPct) + parseFloat(botPct)).toFixed(1) + "%";
      pvBot.style.display = "none";
      pvTop.innerHTML = mainText + subText;
    }
  }

  // Subtitle overlay
  const subtitleEnabled = document.getElementById("cs-subtitle-enabled").checked;
  if (subtitleEnabled) {
    const subFont = document.getElementById("cs-subtitle-font").value;
    const subSize = parseInt(document.getElementById("cs-subtitle-size").value) || 48;
    const subOutline = parseInt(document.getElementById("cs-subtitle-outline").value) || 3;
    const subAlign = document.getElementById("cs-subtitle-alignment").value;
    const subMargin = parseInt(document.getElementById("cs-subtitle-margin").value) || 100;

    // 픽셀(px) 단위 — Pillow 렌더링과 동일 기준, 미리보기에 비례 축소
    const pxScale = pvHeight / 1920;
    const scaledSize = Math.max(8, (subSize * pxScale).toFixed(0));
    const scaledOutline = Math.max(1, Math.round(subOutline * pxScale));
    const scaledMargin = Math.round(subMargin * pxScale);

    pvSub.style.display = "block";
    pvSub.style.fontFamily = `'${subFont}', sans-serif`;
    pvSub.style.fontSize = scaledSize + "px";
    pvSub.style.fontWeight = "700";
    pvSub.style.color = "#ffffff";
    pvSub.style.textShadow = `0 0 ${scaledOutline}px #000, 0 0 ${scaledOutline}px #000, 0 0 ${scaledOutline * 2}px #000`;
    pvSub.innerHTML = "반도체 수출이 크게 늘고 있는데<br>시장 기대가 커졌습니다";

    // Position — margin_v = 바닥(상단)에서의 여백, 텍스트는 그 안쪽에 배치
    pvSub.style.top = "auto";
    pvSub.style.bottom = "auto";
    pvSub.style.transform = "none";
    pvSub.style.paddingTop = "0";
    pvSub.style.height = "auto";
    pvSub.style.display = "block";
    pvSub.style.textAlign = "center";
    if (subAlign === "8") {
      pvSub.style.top = scaledMargin + "px";
    } else if (subAlign === "5") {
      pvSub.style.top = "50%";
      pvSub.style.transform = "translateY(-50%)";
    } else {
      // 하단: 바닥에서 margin_v 여백
      pvSub.style.bottom = scaledMargin + "px";
    }
  } else {
    pvSub.style.display = "none";
  }
}

// ─── RVC 음성 변환 ───

function toggleRvcSection() {
  const enabled = document.getElementById("cs-rvc-enabled").checked;
  const section = document.getElementById("cs-rvc-section");
  if (enabled) {
    section.classList.remove("hidden");
    loadRvcModels();
  } else {
    section.classList.add("hidden");
  }
}

async function loadRvcModels() {
  try {
    const r = await fetch("/api/rvc-models");
    const models = await r.json();
    const sel = document.getElementById("cs-rvc-model");
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- 선택하세요 --</option>';
    models.forEach(m => {
      sel.innerHTML += `<option value="${m.id}">${m.label}</option>`;
    });
    if (cur) sel.value = cur;
  } catch (e) {
    console.error("RVC 모델 목록 로드 실패:", e);
  }
}

async function previewRvcVoice() {
  const model = document.getElementById("cs-rvc-model").value;
  if (!model) { alert("RVC 모델을 선택하세요"); return; }
  const btn = document.getElementById("btn-cs-preview-rvc");
  btn.textContent = "변환 중..."; btn.disabled = true;

  const pitch = document.getElementById("cs-rvc-pitch").value;
  const index = document.getElementById("cs-rvc-index").value;

  // 현재 선택된 TTS 음성 + 속도 가져오기
  const voiceSel = document.getElementById("cs-tts-voice");
  const tts_voice = voiceSel ? voiceSel.value : "ko-KR-SunHiNeural";
  const rateSel = document.getElementById("cs-tts-rate");
  const tts_rate = rateSel ? +rateSel.value : 0;

  try {
    const r = await fetch("/api/rvc-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, pitch: +pitch, index_influence: +index, tts_voice, tts_rate }),
    });
    if (r.ok) {
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = document.getElementById("cs-rvc-preview");
      audio.src = url;
      audio.classList.remove("hidden");
      audio.play();
    } else {
      const err = await r.json();
      alert("미리듣기 실패: " + (err.detail || "알 수 없는 오류"));
    }
  } catch (e) {
    alert("미리듣기 오류: " + e.message);
  } finally {
    btn.textContent = "RVC 미리듣기"; btn.disabled = false;
  }
}

async function checkSovitsStatus() {
  const el = document.getElementById("cs-sovits-status");
  try {
    const res = await fetch("/api/sovits/status");
    const data = await res.json();
    if (data.available) {
      el.innerHTML = '<span class="text-green-400">● GPT-SoVITS 서버 연결됨</span>';
    } else {
      el.innerHTML = '<span class="text-red-400">● GPT-SoVITS 서버 미실행 — start_api.bat 실행 필요</span>';
    }
  } catch {
    el.innerHTML = '<span class="text-red-400">● 상태 확인 실패</span>';
  }
}

async function loadBgmFiles(cfg) {
  try {
    const res = await fetch("/api/bgm");
    const files = await res.json();
    const sel = document.getElementById("cs-bgm-file");
    sel.innerHTML = '<option value="">없음</option>';
    for (const f of files) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f.replace(/\.mp3$/, "");
      if (cfg.bgm_file === f) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch {}
}

let _bgmAudio = null;
function previewBgm(filename) {
  if (_bgmAudio) { _bgmAudio.pause(); _bgmAudio = null; }
  const el = document.getElementById("cs-bgm-preview");
  if (!filename) { el.classList.add("hidden"); return; }
  el.src = `/api/bgm/${encodeURIComponent(filename)}?t=${Date.now()}`;
  el.classList.remove("hidden");
  el.play();
  _bgmAudio = el;
}

let _transitionsCache = null;
async function loadTransitionOptions(selected) {
  const sel = document.getElementById("cs-crossfade-transition");
  if (!sel) return;
  try {
    if (!_transitionsCache) {
      const res = await fetch("/api/transitions");
      _transitionsCache = await res.json();
    }
    sel.innerHTML = _transitionsCache.map(t =>
      `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${t.label} — ${t.desc}</option>`
    ).join("");
  } catch (e) {
    console.warn("transition list load failed", e);
  }
}

async function previewTransition() {
  const effect = document.getElementById("cs-crossfade-transition").value || "fade";
  const dur = document.getElementById("cs-crossfade-duration").value || 0.5;
  const video = document.getElementById("cs-transition-preview");
  if (!video) return;
  video.classList.remove("hidden");
  video.src = `/api/transitions/${effect}/preview?duration=${dur}&t=${Date.now()}`;
  video.load();
  video.play();
}

async function loadSfxFiles(cfg) {
  try {
    const res = await fetch("/api/sfx");
    const files = await res.json();
    const ids = ["cs-sfx-transition", "cs-sfx-intro", "cs-sfx-outro", "cs-sfx-highlight"];
    const keys = ["sfx_transition", "sfx_intro", "sfx_outro", "sfx_highlight"];
    for (let j = 0; j < ids.length; j++) {
      const sel = document.getElementById(ids[j]);
      sel.innerHTML = '<option value="">없음</option>';
      for (const f of files) {
        const opt = document.createElement("option");
        opt.value = f;
        opt.textContent = f.replace(/-\d+\.mp3$/, "").replace(/[-_]/g, " ");
        if (cfg[keys[j]] === f) opt.selected = true;
        sel.appendChild(opt);
      }
    }
  } catch {}
}

let _sfxAudio = null;
function previewSfx(filename) {
  if (_sfxAudio) { _sfxAudio.pause(); _sfxAudio = null; }
  const el = document.getElementById("cs-sfx-preview");
  if (!filename) { el.classList.add("hidden"); return; }
  el.src = `/api/sfx/${encodeURIComponent(filename)}?t=${Date.now()}`;
  el.classList.remove("hidden");
  el.play();
  _sfxAudio = el;
}

async function loadRefVoices(selectedVoice) {
  const select = document.getElementById("cs-sovits-ref-voice");
  try {
    const res = await fetch("/api/ref-voices");
    const voices = await res.json();
    select.innerHTML = '<option value="">-- 선택하세요 --</option>';
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.filename;
      opt.textContent = `${v.name} (${v.size_kb} KB)`;
      if (v.filename === selectedVoice) opt.selected = true;
      select.appendChild(opt);
    }
    if (selectedVoice) previewRefVoice();
  } catch {}
}

function previewRefVoice() {
  const select = document.getElementById("cs-sovits-ref-voice");
  const audioEl = document.getElementById("cs-ref-audio-preview");
  if (select.value) {
    audioEl.src = `/api/ref-voices/${encodeURIComponent(select.value)}?t=${Date.now()}`;
    audioEl.classList.remove("hidden");
  } else {
    audioEl.classList.add("hidden");
  }
}

async function uploadRefVoiceFile(input) {
  if (!input.files.length) return;
  const formData = new FormData();
  formData.append("file", input.files[0]);

  try {
    const res = await fetch("/api/ref-voices", { method: "POST", body: formData });
    if (!res.ok) throw new Error("업로드 실패");
    const data = await res.json();
    // 목록 새로고침 후 방금 업로드한 파일 선택
    await loadRefVoices(data.filename);
  } catch (e) {
    alert("음성 추가 실패: " + e.message);
  }
  input.value = "";
}

async function previewChannelVoice() {
  const engine = document.getElementById("cs-tts-engine").value;
  let voice, rateVal, btn, audio;

  if (engine === "google-cloud") {
    voice = document.getElementById("cs-google-voice").value;
    rateVal = document.getElementById("cs-google-rate")?.value || 0;
    btn = document.getElementById("btn-cs-preview-google");
    audio = document.getElementById("cs-google-preview");
  } else {
    voice = document.getElementById("cs-tts-voice").value;
    rateVal = document.getElementById("cs-tts-rate")?.value || 0;
    btn = document.getElementById("btn-cs-preview-voice");
    audio = document.getElementById("cs-voice-preview");
  }

  btn.textContent = "생성중...";
  btn.disabled = true;

  try {
    const url = `/api/tts/preview?voice=${encodeURIComponent(voice)}&rate=${rateVal}&t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("생성 실패");
    const blob = await res.blob();
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove("hidden");
    audio.play().catch(() => {});
  } catch (e) {
    alert("음성 생성 실패: " + e.message);
  }
  btn.textContent = "미리듣기";
  btn.disabled = false;
}

async function previewSovitsNarration() {
  const refVoice = document.getElementById("sovits-ref-select").value;
  const refText = document.getElementById("sovits-ref-text").value.trim();
  const btn = document.getElementById("btn-preview-sovits");
  const audio = document.getElementById("voice-preview-popup");

  if (!refVoice) { alert("참조 음성을 선택하세요"); return; }

  btn.textContent = "생성중...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/tts/preview-sovits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref_voice: refVoice, ref_text: refText }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "생성 실패");
    }
    const blob = await res.blob();
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove("hidden");
    audio.play().catch(() => {});
  } catch (e) {
    alert("GPT-SoVITS 미리듣기 실패: " + e.message);
  }
  btn.textContent = "미리듣기";
  btn.disabled = false;
}

async function previewSovitsVoice() {
  const refVoice = document.getElementById("cs-sovits-ref-voice").value;
  const refText = document.getElementById("cs-sovits-ref-text").value.trim();
  const btn = document.getElementById("btn-cs-preview-sovits");
  const audio = document.getElementById("cs-sovits-preview");

  if (!refVoice) { alert("참조 음성을 선택하세요"); return; }

  btn.textContent = "생성중...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/tts/preview-sovits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref_voice: refVoice, ref_text: refText }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "생성 실패");
    }
    const blob = await res.blob();
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove("hidden");
    audio.play().catch(() => {});
  } catch (e) {
    alert("GPT-SoVITS 미리듣기 실패: " + e.message);
  }
  btn.textContent = "GPT-SoVITS 미리듣기";
  btn.disabled = false;
}

async function previewGeminiVoice() {
  const voice = document.getElementById("cs-gemini-tts-voice").value;
  const style = document.getElementById("cs-gemini-tts-style").value.trim();
  const audio = document.getElementById("cs-gemini-preview");
  const btn = document.getElementById("btn-cs-preview-gemini");

  btn.textContent = "로딩...";
  btn.disabled = true;
  try {
    let res;
    if (style) {
      // 스타일 인스트럭션 있으면 → API로 새로 생성
      const apiKey = document.getElementById("cs-gemini-api-key")?.value || "";
      if (!apiKey) { alert("Gemini API 키를 먼저 입력하세요 (YouTube 탭)"); return; }
      btn.textContent = "생성중...";
      res = await fetch("/api/tts/gemini-preview-styled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice, style, api_key: apiKey }),
      });
    } else {
      // 인스트럭션 없으면 → 사전 생성된 샘플
      res = await fetch(`/api/tts/gemini-sample/${voice}`);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "미리듣기 실패");
    }
    const blob = await res.blob();
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove("hidden");
    audio.play().catch(() => {});
  } catch (e) {
    alert("Gemini 미리듣기 실패: " + e.message);
  }
  btn.textContent = "미리듣기";
  btn.disabled = false;
}

// ─── Stable Diffusion ───

async function sdGeneratePrompts(jobId) {
  const btn = document.getElementById("btn-sd-prompts");
  const statusEl = document.getElementById("sd-status");
  btn.textContent = "생성중...";
  btn.disabled = true;
  statusEl.innerHTML = `<div class="text-xs text-purple-400 mb-2">Claude가 SD 프롬프트를 생성 중입니다...</div>`;

  try {
    const res = await fetch(`/api/jobs/${jobId}/sd-prompts`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "프롬프트 생성 실패");
    }
    const data = await res.json();
    const prompts = data.prompts || [];

    statusEl.innerHTML = `<div class="text-xs text-green-400 mb-2">${prompts.length}개 프롬프트 생성 완료. 슬롯별 프롬프트 버튼으로 확인/수정 가능.</div>`;
  } catch (e) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">프롬프트 생성 실패: ${e.message}</div>`;
  }

  btn.textContent = "SD 프롬프트 생성";
  btn.disabled = false;
}

async function rerenderSlides(jobId) {
  const btn = document.getElementById("btn-rerender");
  if (btn) btn.textContent = "렌더링 중...";
  try {
    const res = await fetch(`/api/jobs/${jobId}/rerender-slides`, { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      if (btn) btn.textContent = `완료 (${data.layout})`;
      loadAll();
    } else {
      if (btn) btn.textContent = "실패";
    }
  } catch (e) {
    if (btn) btn.textContent = "오류";
  }
  setTimeout(() => { if (btn) btn.textContent = "슬라이드 재렌더"; }, 3000);
}

async function sdGenerateAuto(jobId) {
  const btn = document.getElementById("btn-sd-auto");
  const statusEl = document.getElementById("sd-status");

  // 즉시 버튼 비활성화 (중복 클릭 방지)
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "준비중...";

  // 프롬프트 확인
  const promptRes = await fetch(`/api/jobs/${jobId}/sd-prompts`);
  const promptData = await promptRes.json();
  if (!promptData.prompts || promptData.prompts.length === 0) {
    statusEl.innerHTML = `<div class="text-xs text-yellow-400 mb-2">먼저 프롬프트를 생성하세요.</div>`;
    btn.textContent = _bgSource === 'gemini' ? 'Gemini 생성' : _bgSource === 'sd_video' ? 'SD 영상 생성' : 'SD 이미지 생성';
    btn.disabled = false;
    return;
  }

  btn.textContent = "생성중...";
  statusEl.innerHTML = `<div class="text-xs text-emerald-400 mb-2">AI 배경 이미지 생성 중...</div>`;

  try {
    const res = await fetch(`/api/jobs/${jobId}/sd-generate-auto`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "생성 실패" }));
      throw new Error(err.detail || "생성 실패");
    }
    const data = await res.json();
    const results = data.results || [];
    const ok = results.filter(r => r.ok && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const fail = results.filter(r => !r.ok).length;

    let msg = `<span class="text-green-400">${ok}장 생성</span>`;
    if (skipped > 0) msg += ` · <span class="text-gray-400">${skipped}장 스킵</span>`;
    if (fail > 0) msg += ` · <span class="text-red-400">${fail}장 실패</span>`;
    statusEl.innerHTML = `<div class="text-xs mb-2">${msg}</div>`;

    // 강제 전체 리렌더 (running 상태에서 _patchRunningDetail 우회)
    _lastDetailStatus = null;
    await refreshJobDetail(jobId);
  } catch (e) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">생성 실패: ${e.message}</div>`;
  }

  btn.textContent = _bgSource === 'gemini' ? 'Gemini 생성' : _bgSource === 'sd_video' ? 'SD 영상 생성' : 'SD 이미지 생성';
  btn.disabled = false;
}


async function sdGenerateAll(jobId, mode) {
  const btnId = mode === "video" ? "btn-sd-video" : "btn-sd-image";
  const btn = document.getElementById(btnId);
  const statusEl = document.getElementById("sd-status");

  // 즉시 버튼 비활성화 (중복 클릭 방지)
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "준비중...";

  // 프롬프트 존재 확인
  const promptRes = await fetch(`/api/jobs/${jobId}/sd-prompts`);
  const promptData = await promptRes.json();
  if (!promptData.prompts || promptData.prompts.length === 0) {
    statusEl.innerHTML = `<div class="text-xs text-yellow-400 mb-2">먼저 [SD 프롬프트 생성] 버튼을 눌러 프롬프트를 생성하세요.</div>`;
    btn.textContent = mode === "video" ? "SD 영상 생성" : "SD 이미지 생성";
    btn.disabled = false;
    return;
  }

  // ComfyUI 상태 확인
  const sdRes = await fetch("/api/sd/status");
  const sdData = await sdRes.json();
  if (!sdData.available) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">ComfyUI 서버가 실행 중이 아닙니다 (${sdData.host}:${sdData.port})</div>`;
    btn.textContent = mode === "video" ? "SD 영상 생성" : "SD 이미지 생성";
    btn.disabled = false;
    return;
  }

  btn.textContent = "생성중...";
  const label = mode === "video" ? "영상" : "이미지";
  statusEl.innerHTML = `<div class="text-xs text-purple-400 mb-2">SD ${label} 일괄 생성 중... (시간이 걸릴 수 있습니다)</div>`;

  // 모든 슬롯에 로딩 표시
  document.querySelectorAll('.upload-slot').forEach(slot => {
    slot.querySelectorAll('.slot-loading').forEach(el => el.remove());
    const loader = document.createElement("div");
    loader.className = "slot-loading";
    loader.innerHTML = `<div class="slot-spinner"></div><div class="slot-loading-text">대기중</div>`;
    slot.appendChild(loader);
  });

  try {
    const endpoint = mode === "video"
      ? `/api/jobs/${jobId}/sd-generate-video`
      : `/api/jobs/${jobId}/sd-generate`;
    const res = await fetch(endpoint, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "생성 실패");
    }
    const data = await res.json();
    const results = data.results || [];
    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;

    let msg = `<span class="text-green-400">${ok}장 생성 완료</span>`;
    if (fail > 0) msg += ` · <span class="text-red-400">${fail}장 실패</span>`;
    statusEl.innerHTML = `<div class="text-xs mb-2">${msg}</div>`;

    _lastDetailStatus = null;  // 강제 전체 리렌더
    await refreshJobDetail(jobId);
  } catch (e) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">생성 실패: ${e.message}</div>`;
  }

  btn.textContent = mode === "video" ? "SD 영상 생성" : "SD 이미지 생성";
  btn.disabled = false;
}

async function sdRegenerateSingle(jobId, index, mode) {
  const statusEl = document.getElementById("sd-status");

  // 프롬프트 가져오기: 활성 편집기 또는 서버에서
  let prompt = "";
  if (_activePromptIndex === index) {
    const taEn = document.getElementById("prompt-text-en");
    prompt = taEn ? taEn.value.trim() : "";
  }
  if (!prompt) {
    try {
      const pRes = await fetch(`/api/jobs/${jobId}/sd-prompts`);
      const pData = await pRes.json();
      const prompts = pData.prompts || [];
      if (index - 1 < prompts.length) prompt = prompts[index - 1];
    } catch (e) {}
  }

  if (!prompt) {
    statusEl.innerHTML = `<div class="text-xs text-yellow-400 mb-2">슬롯 ${index}의 프롬프트가 없습니다. 먼저 프롬프트를 생성하세요.</div>`;
    return;
  }

  const label = mode === "video" ? "영상" : "이미지";
  statusEl.innerHTML = `<div class="text-xs text-purple-400 mb-2">슬롯 ${index} 배경 생성 중...</div>`;

  // 슬롯에 로딩 표시
  const slot = document.getElementById(`slot-${index}`);
  if (slot) {
    const loader = document.createElement("div");
    loader.className = "slot-loading";
    loader.id = `slot-loading-${index}`;
    loader.innerHTML = `<div class="slot-spinner"></div><div class="slot-loading-text">생성중</div>`;
    slot.appendChild(loader);
  }

  try {
    const endpoint = mode === "video"
      ? `/api/jobs/${jobId}/sd-generate-video/${index}`
      : `/api/jobs/${jobId}/sd-generate/${index}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "생성 실패");
    }

    statusEl.innerHTML = `<div class="text-xs text-green-400 mb-2">슬롯 ${index} ${label} 생성 완료</div>`;
    _lastDetailStatus = null;  // 강제 전체 리렌더
    await refreshJobDetail(jobId);
  } catch (e) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">슬롯 ${index} 생성 실패: ${e.message}</div>`;
    const loader = document.getElementById(`slot-loading-${index}`);
    if (loader) loader.remove();
  }
}

let _activePromptJobId = null;
let _activePromptIndex = null;

function togglePromptEdit(jobId, index) {
  const area = document.getElementById("prompt-edit-area");
  if (!area) return;

  // 같은 슬롯 다시 누르면 닫기
  if (!area.classList.contains("hidden") && _activePromptIndex === index) {
    area.classList.add("hidden");
    _activePromptIndex = null;
    return;
  }

  _activePromptJobId = jobId;
  _activePromptIndex = index;
  document.getElementById("prompt-edit-index").textContent = index;

  // 레이아웃별 권장 사이즈 표시
  const sizeHint = document.getElementById("prompt-size-hint");
  if (sizeHint) {
    sizeHint.textContent = window._imgSizeLabel
      ? `${window._imgSizeLabel} (${window._imgSizeLabel.includes("1920") ? "9:16 세로" : "zone 비율"})`
      : "📐 1080×1920 (9:16 세로)";
  }

  const taKo = document.getElementById("prompt-text-ko");
  const taEn = document.getElementById("prompt-text-en");
  if (taKo) taKo.value = "";
  if (taEn) taEn.value = "";
  area.classList.remove("hidden");

  // 서버에서 이미지 프롬프트 가져오기
  fetch(`/api/jobs/${jobId}/script`)
    .then(r => r.json())
    .then(data => {
      const prompts = data.image_prompts || [];
      const taMotion = document.getElementById("prompt-text-motion");
      if (index - 1 < prompts.length && prompts[index - 1]) {
        const p = prompts[index - 1];
        if (typeof p === "object") {
          if (taKo) taKo.value = p.ko || "";
          if (taEn) taEn.value = p.en || "";
          if (taMotion) taMotion.value = p.motion || "";
        } else {
          if (taKo) taKo.value = "";
          if (taEn) taEn.value = String(p);
          if (taMotion) taMotion.value = "";
        }
      }
    })
    .catch(() => {});
}

function closePromptEdit() {
  const area = document.getElementById("prompt-edit-area");
  if (area) area.classList.add("hidden");
  _activePromptIndex = null;
}

async function saveImagePrompt() {
  if (!_activePromptJobId || !_activePromptIndex) return;
  const taKo = document.getElementById("prompt-text-ko");
  const taEn = document.getElementById("prompt-text-en");
  const taMotion = document.getElementById("prompt-text-motion");

  try {
    await fetch(`/api/jobs/${_activePromptJobId}/image-prompts/${_activePromptIndex}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ko: taKo ? taKo.value : "", en: taEn ? taEn.value : "", motion: taMotion ? taMotion.value : "" }),
    });
    const statusEl = document.getElementById("sd-status");
    if (statusEl) statusEl.innerHTML = `<div class="text-xs text-green-400 mb-2">슬롯 ${_activePromptIndex} 프롬프트 저장됨</div>`;
  } catch (e) {
    console.error("프롬프트 저장 실패:", e);
  }
}

async function agentGenerateFromEdit() {
  if (!_activePromptJobId || !_activePromptIndex) return;
  const taEn = document.getElementById("prompt-text-en");
  const prompt = taEn ? taEn.value.trim() : "";
  if (!prompt) return;

  // 먼저 저장
  await saveImagePrompt();
  // 에이전트 생성
  await agentGenerateSingle(_activePromptJobId, _activePromptIndex);
}

async function regenerateFromEdit() {
  if (!_activePromptJobId || !_activePromptIndex) return;
  const taEn = document.getElementById("prompt-text-en");
  const prompt = taEn ? taEn.value.trim() : "";
  if (!prompt) return;

  // 먼저 저장
  await saveImagePrompt();
  // 채널 소스에 따라 Gemini/SD 자동 라우팅
  await sdRegenerateSingle(_activePromptJobId, _activePromptIndex, 'image');
}

async function agentGenerateSingle(jobId, index) {
  const statusEl = document.getElementById("sd-status");
  statusEl.innerHTML = `<div class="text-xs text-purple-400 mb-2">슬롯 ${index} AI 이미지 생성 중... (프롬프트 변환 → 생성 → 검토)</div>`;

  const slot = document.getElementById(`slot-${index}`);
  if (slot) {
    slot.querySelectorAll('.slot-loading').forEach(el => el.remove());
    const loader = document.createElement("div");
    loader.className = "slot-loading";
    loader.id = `slot-loading-${index}`;
    loader.innerHTML = `<div class="slot-spinner"></div><div class="slot-loading-text">AI 생성중</div>`;
    slot.appendChild(loader);
  }

  try {
    const res = await fetch(`/api/jobs/${jobId}/agent-generate/${index}`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "생성 실패");
    }
    const result = await res.json();
    const label = result.ok ? "완료" : "실패";
    const color = result.ok ? "green" : "red";
    statusEl.innerHTML = `<div class="text-xs text-${color}-400 mb-2">슬롯 ${index} ${label} (${result.attempts}회 시도) — ${result.feedback || ""}</div>`;
    // 변환된 SD 프롬프트 표시
    const sdEl = document.getElementById("prompt-edit-sd");
    const sdText = document.getElementById("prompt-edit-sd-text");
    if (sdEl && sdText && result.sd_prompt) {
      sdEl.style.display = "block";
      sdText.textContent = result.sd_prompt;
    }
    await refreshJobDetail(jobId);
  } catch (e) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">슬롯 ${index} 생성 실패: ${e.message}</div>`;
    const loader = document.getElementById(`slot-loading-${index}`);
    if (loader) loader.remove();
  }
}

async function agentGenerateAll(jobId) {
  const statusEl = document.getElementById("sd-status");
  const btn = document.getElementById("btn-agent-all");
  btn.disabled = true;
  btn.textContent = "생성 중...";

  // 프롬프트 개수 확인
  const promptRes = await fetch(`/api/jobs/${jobId}/sd-prompts`);
  const promptData = await promptRes.json();
  const imgPrompts = promptData.prompts || [];
  // image_prompts도 확인
  const scriptRes = await fetch(`/api/jobs/${jobId}/script`);
  const scriptData = await scriptRes.json();
  const totalSlots = (scriptData.script?.slides?.length || 1) - 1;

  let ok = 0, fail = 0;

  // 슬롯별 순차 생성 — 하나씩 완성되면 바로 UI 업데이트
  for (let i = 1; i <= totalSlots; i++) {
    const slot = document.getElementById(`slot-${i}`);
    if (slot) {
      slot.querySelectorAll('.slot-loading').forEach(el => el.remove());
      const loader = document.createElement("div");
      loader.className = "slot-loading";
      loader.id = `slot-loading-${i}`;
      loader.innerHTML = `<div class="slot-spinner"></div><div class="slot-loading-text">AI 생성중</div>`;
      slot.appendChild(loader);
    }
    statusEl.innerHTML = `<div class="text-xs text-purple-400 mb-2">${i}/${totalSlots} 생성 중... (${ok}장 완료)</div>`;

    try {
      const res = await fetch(`/api/jobs/${jobId}/agent-generate/${i}`, { method: "POST" });
      const result = await res.json();
      if (res.ok && result.ok) {
        ok++;
        // 슬롯 이미지 즉시 업데이트
        if (slot) {
          const loader = document.getElementById(`slot-loading-${i}`);
          if (loader) loader.remove();
          const imgUrl = `/api/jobs/${jobId}/backgrounds/bg_${i}.jpg?t=${Date.now()}`;
          let img = slot.querySelector("img");
          if (!img) {
            img = document.createElement("img");
            img.className = "w-full h-full object-cover rounded";
            slot.prepend(img);
          }
          img.src = imgUrl;
          slot.classList.add("has-image");
        }
      } else {
        fail++;
        const loader = document.getElementById(`slot-loading-${i}`);
        if (loader) loader.remove();
      }
    } catch (e) {
      fail++;
      const loader = document.getElementById(`slot-loading-${i}`);
      if (loader) loader.remove();
    }
  }

  let msg = `<span class="text-green-400">${ok}장 완료</span>`;
  if (fail > 0) msg += ` · <span class="text-red-400">${fail}장 실패</span>`;
  statusEl.innerHTML = `<div class="text-xs mb-2">${msg}</div>`;

  btn.textContent = "전체 이미지 생성";
  btn.disabled = false;
}

async function agentGenerateAllVideo(jobId) {
  const statusEl = document.getElementById("sd-status");
  const btn = document.getElementById("btn-agent-all-video");
  btn.disabled = true;
  btn.textContent = "생성 중...";

  // ComfyUI 상태 확인
  const sdRes = await fetch("/api/sd/status");
  const sdData = await sdRes.json();
  if (!sdData.available) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">ComfyUI 서버가 실행 중이 아닙니다</div>`;
    btn.textContent = "전체 영상 생성"; btn.disabled = false;
    return;
  }

  // 프롬프트 확인
  const promptRes = await fetch(`/api/jobs/${jobId}/sd-prompts`);
  const promptData = await promptRes.json();
  const prompts = promptData.prompts || [];

  const scriptRes = await fetch(`/api/jobs/${jobId}/script`);
  const scriptData = await scriptRes.json();
  const totalSlots = (scriptData.script?.slides?.length || 1) - 1;

  let ok = 0, fail = 0;

  for (let i = 1; i <= totalSlots; i++) {
    const prompt = (i - 1 < prompts.length) ? prompts[i - 1] : "";
    if (!prompt) { fail++; continue; }

    const slot = document.getElementById(`slot-${i}`);
    if (slot) {
      slot.querySelectorAll('.slot-loading').forEach(el => el.remove());
      const loader = document.createElement("div");
      loader.className = "slot-loading";
      loader.id = `slot-loading-${i}`;
      loader.innerHTML = `<div class="slot-spinner"></div><div class="slot-loading-text">영상 생성중</div>`;
      slot.appendChild(loader);
    }
    statusEl.innerHTML = `<div class="text-xs text-indigo-400 mb-2">${i}/${totalSlots} 영상 생성 중... (${ok}장 완료)</div>`;

    try {
      const res = await fetch(`/api/jobs/${jobId}/sd-generate-video/${i}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (res.ok) {
        ok++;
      } else {
        fail++;
      }
      const loader = document.getElementById(`slot-loading-${i}`);
      if (loader) loader.remove();
      // 슬롯 영상 미리보기 업데이트
      if (slot) {
        const vidUrl = `/api/jobs/${jobId}/backgrounds/bg_${i}.mp4?t=${Date.now()}`;
        const old = slot.querySelector("img, video");
        if (old) old.remove();
        const vid = document.createElement("video");
        vid.src = vidUrl;
        vid.autoplay = true;
        vid.loop = true;
        vid.muted = true;
        vid.playsInline = true;
        vid.style.cssText = "width:100%;height:100%;object-fit:cover;";
        slot.prepend(vid);
        slot.classList.add("has-image");
      }
    } catch (e) {
      fail++;
      const loader = document.getElementById(`slot-loading-${i}`);
      if (loader) loader.remove();
    }
  }

  let msg = `<span class="text-green-400">${ok}장 완료</span>`;
  if (fail > 0) msg += ` · <span class="text-red-400">${fail}장 실패</span>`;
  statusEl.innerHTML = `<div class="text-xs mb-2">${msg}</div>`;

  btn.textContent = "전체 영상 생성";
  btn.disabled = false;
}

async function generateImagePrompts(jobId) {
  const btn = document.getElementById("btn-gen-img-prompts");
  if (btn) { btn.disabled = true; btn.textContent = "생성 중..."; }

  try {
    const res = await fetch(`/api/jobs/${jobId}/generate-image-prompts`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "생성 실패");
    }
    await refreshJobDetail(jobId);
  } catch (e) {
    alert("이미지 프롬프트 생성 실패: " + e.message);
    if (btn) { btn.disabled = false; btn.textContent = "프롬프트 생성"; }
  }
}

// ─── Image Upload ───

function triggerUpload(jobId, index) {
  document.getElementById(`file-${index}`).click();
}

async function uploadSlideImage(jobId, index, input) {
  if (!input.files.length) return;

  const file = input.files[0];
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch(`/api/jobs/${jobId}/backgrounds/${index}`, {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      // 슬롯 UI 즉시 업데이트
      const slot = document.getElementById(`slot-${index}`);
      const url = URL.createObjectURL(file);
      slot.classList.add("has-image");
      // 기존 이미지 제거 후 추가
      const existingImg = slot.querySelector("img");
      if (existingImg) existingImg.remove();
      const img = document.createElement("img");
      img.src = url;
      img.alt = `bg_${index}`;
      slot.prepend(img);

      // UI만 갱신 (슬라이드 재렌더는 Phase B에서 처리)
      _lastDetailStatus = null;
      await refreshJobDetail(jobId);
    }
  } catch (e) {
    console.error("Upload failed:", e);
  }
}

// ─── Bulk Image Upload ───

async function bulkUploadImages(jobId, input) {
  if (!input.files.length) return;

  const files = Array.from(input.files);
  // 파일명 순 정렬 후 슬롯 1, 2, 3... 에 순서대로 할당
  files.sort((a, b) => a.name.localeCompare(b.name));

  for (let i = 0; i < files.length; i++) {
    const idx = i + 1;
    const formData = new FormData();
    formData.append("file", files[i]);
    await fetch(`/api/jobs/${jobId}/backgrounds/${idx}`, {
      method: "POST",
      body: formData,
    });
  }

  // UI만 갱신 (슬라이드 재렌더는 Phase B에서 처리)
  _lastDetailStatus = null;
  await refreshJobDetail(jobId);
}

// ─── Slot Drag & Drop (이미지 순서 변경) ───

let _dragSlotIdx = null;

function onSlotDragStart(e, jobId, idx) {
  _dragSlotIdx = idx;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", idx);
  e.currentTarget.style.opacity = "0.5";
}

function onSlotDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
}

function onSlotDragEnter(e) {
  e.preventDefault();
  const wrap = e.currentTarget;
  wrap.classList.add("slot-drag-over");
}

function onSlotDragLeave(e) {
  e.currentTarget.classList.remove("slot-drag-over");
}

async function onSlotDrop(e, jobId, targetIdx) {
  e.preventDefault();
  e.currentTarget.classList.remove("slot-drag-over");
  const sourceIdx = _dragSlotIdx;
  _dragSlotIdx = null;

  // 드래그 시작한 요소 opacity 복원
  document.querySelectorAll(".upload-slot-wrap").forEach(el => el.style.opacity = "");

  if (!sourceIdx || sourceIdx === targetIdx) return;

  // 서버에 swap 요청
  const res = await fetch(`/api/jobs/${jobId}/backgrounds/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a: sourceIdx, b: targetIdx }),
  });
  if (res.ok) {
    // swap 완료 → 작업 상세 다시 로드하여 슬롯 갱신
    await refreshJobDetail(jobId);
  }
}

// ─── Narration Upload ───

function switchNarrationMode(mode) {
  document.getElementById("narration-tts").classList.toggle("hidden", mode !== "tts");
  document.getElementById("narration-upload").classList.toggle("hidden", mode !== "upload");
  document.getElementById("btn-mode-tts").className =
    `px-3 py-1 rounded text-xs font-medium transition ${mode === "tts" ? "bg-orange-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`;
  document.getElementById("btn-mode-upload").className =
    `px-3 py-1 rounded text-xs font-medium transition ${mode === "upload" ? "bg-orange-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`;
}

async function uploadNarration(jobId, input) {
  if (!input.files.length) return;
  const file = input.files[0];
  const formData = new FormData();
  formData.append("file", file);

  const statusEl = document.getElementById("narration-status");
  statusEl.textContent = "업로드중...";
  statusEl.className = "text-xs text-gray-400";

  try {
    const res = await fetch(`/api/jobs/${jobId}/narration`, { method: "POST", body: formData });
    if (res.ok) {
      await refreshJobDetail(jobId);
    } else {
      statusEl.textContent = "업로드 실패";
      statusEl.className = "text-xs text-red-400";
    }
  } catch (e) {
    statusEl.textContent = "업로드 실패: " + e.message;
    statusEl.className = "text-xs text-red-400";
  }
}

async function deleteNarration(jobId) {
  try {
    await fetch(`/api/jobs/${jobId}/narration`, { method: "DELETE" });
    await refreshJobDetail(jobId);
  } catch (e) {
    console.error("Narration delete failed:", e);
  }
}

// ─── Script Edit (나레이션 대본 수정) ───

function switchScriptView(view, btn) {
  const slideView = document.getElementById("script-slide-view");
  const narrationView = document.getElementById("script-narration-view");
  if (!slideView || !narrationView) return;
  if (view === "narration") {
    slideView.classList.add("hidden");
    narrationView.classList.remove("hidden");
  } else {
    slideView.classList.remove("hidden");
    narrationView.classList.add("hidden");
  }
  document.querySelectorAll(".script-view-btn").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
}

function _flashMsg(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 1500);
}

function copySlideNarration(slideNum) {
  const ta = document.querySelector(`.narration-slide-input[data-slide="${slideNum}"]`);
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).then(() => {
    _flashMsg("narration-save-msg", `슬라이드 ${slideNum} 복사됨`);
  });
}

function copyAllNarration() {
  const textareas = document.querySelectorAll(".narration-slide-input");
  if (!textareas.length) return;
  const blocks = Array.from(textareas).map(ta => ta.value.trim());
  navigator.clipboard.writeText(blocks.join("\n\n")).then(() => {
    _flashMsg("narration-save-msg", "전체 복사됨");
  });
}

async function saveNarrationScript(jobId) {
  const textareas = document.querySelectorAll(".narration-slide-input");
  if (!textareas.length) return;
  // 슬라이드별 textarea → 줄 단위로 분리하여 sentences 배열 생성
  const sentences = [];
  textareas.forEach(ta => {
    const slideNum = parseInt(ta.dataset.slide || "0", 10);
    ta.value.split("\n").forEach(line => {
      const text = line.trim();
      if (text) sentences.push({ text, slide: slideNum });
    });
  });
  const btn = document.getElementById("btn-save-narration");
  btnLoading(btn, "저장중...");
  try {
    const res = await fetch(`/api/jobs/${jobId}/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentences }),
    });
    if (res.ok) {
      btnDone(btn, "저장 완료");
    } else {
      const err = await res.json();
      btnError(btn, "저장 실패");
      alert(err.detail || "저장 실패");
    }
  } catch (e) {
    btnError(btn, "요청 실패");
    alert("저장 요청 실패");
  }
}

// ─── Slide Script Edit (슬라이드 텍스트 수정) ───

async function saveSlideScript(jobId) {
  const mains = document.querySelectorAll(".slide-edit-main");
  const subs = document.querySelectorAll(".slide-edit-sub");
  if (!mains.length) return;
  const slides = Array.from(mains).map((el, i) => ({
    main: el.value.replace(/\n/g, "<br>"),
    sub: subs[i] ? subs[i].value.replace(/\n/g, "<br>") : "",
  }));
  const btn = document.getElementById("btn-save-slides");
  btnLoading(btn, "저장중...");
  try {
    const res = await fetch(`/api/jobs/${jobId}/slides`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slides }),
    });
    if (res.ok) {
      btnDone(btn, "저장 완료");
    } else {
      const err = await res.json();
      btnError(btn, "저장 실패");
      alert(err.detail || "저장 실패");
    }
  } catch (e) {
    btnError(btn, "요청 실패");
    alert("저장 요청 실패");
  }
}

// 슬라이드 텍스트 서식 도구 — 선택 영역에 HTML 태그 삽입
function slideFormatWrap(tag, attrs = "") {
  const ta = document.activeElement;
  if (!ta || (!ta.classList.contains("slide-edit-main") && !ta.classList.contains("slide-edit-sub"))) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const sel = ta.value.substring(start, end);
  if (!sel) return;
  const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
  const close = `</${tag}>`;
  ta.value = ta.value.substring(0, start) + open + sel + close + ta.value.substring(end);
  ta.focus();
  ta.setSelectionRange(start + open.length, start + open.length + sel.length);
}

function slideFormatHL() { slideFormatWrap("span", 'class="hl"'); }
function slideFormatBold() { slideFormatWrap("b"); }
function slideFormatItalic() { slideFormatWrap("i"); }
function slideFormatSize(size) { slideFormatWrap("span", `style="font-size:${size}"`); }
function slideFormatColor(color) { slideFormatWrap("span", `style="color:${color}"`); }
function slideInsertBR() {
  const ta = document.activeElement;
  if (!ta || (!ta.classList.contains("slide-edit-main") && !ta.classList.contains("slide-edit-sub"))) return;
  const pos = ta.selectionStart;
  ta.value = ta.value.substring(0, pos) + "\n" + ta.value.substring(pos);
  ta.focus();
  ta.setSelectionRange(pos + 1, pos + 1);
}

// ─── Retry / Reset Job ───

async function retryJob(jobId) {
  const _btn = event?.target;
  btnLoading(_btn, "재시도중...");
  try {
    const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    if (res.ok) {
      btnDone(_btn, "재시도 시작");
      await refreshJobDetail(jobId);
      loadAll();
    } else {
      const err = await res.json();
      btnError(_btn, "재시도 실패");
      alert(err.detail || "재시도 실패");
    }
  } catch (e) {
    btnError(_btn, "요청 실패");
    alert("재시도 요청 실패");
  }
}

async function resetToWaiting(jobId) {
  try {
    const res = await fetch(`/api/jobs/${jobId}/reset`, { method: "POST" });
    if (res.ok) {
      await refreshJobDetail(jobId);
      loadAll();
    } else {
      const err = await res.json();
      alert(err.detail || "되돌리기 실패");
    }
  } catch (e) {
    alert("되돌리기 요청 실패");
  }
}

// ─── Thumbnail ───

async function generateThumbnail(jobId) {
  const btn = document.getElementById("btn-gen-thumb");
  if (btn) { btn.textContent = "생성중..."; btn.disabled = true; }
  try {
    const res = await fetch(`/api/jobs/${jobId}/generate-thumbnail`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "생성 실패");
    }
    await refreshJobDetail(jobId);
  } catch (e) {
    alert("썸네일 생성 실패: " + e.message);
  }
  if (btn) { btn.textContent = "생성"; btn.disabled = false; }
}

async function uploadThumbnail(jobId, file) {
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch(`/api/jobs/${jobId}/thumbnail`, { method: "POST", body: formData });
    if (!res.ok) throw new Error("업로드 실패");
    await refreshJobDetail(jobId);
  } catch (e) {
    alert("썸네일 업로드 실패: " + e.message);
  }
}

// ─── Delete Job ───

async function deleteJob(jobId, status) {
  const msg = status === "running"
    ? "⚠️ 진행 중인 작업입니다. 정말 삭제하시겠습니까?"
    : "이 작업을 삭제하시겠습니까?";
  if (!confirm(msg)) return;
  try {
    await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    closeModal("job-detail-modal");
    loadAll();
  } catch (e) {
    alert("삭제 실패: " + e.message);
  }
}

// ─── Resume Job ───

async function resumeJob(jobId) {
  const btn = document.getElementById("btn-resume-job");
  btnLoading(btn, "영상 제작 중...");

  // 선택된 TTS 엔진 + 음성 + 속도
  const engineSelect = document.getElementById("tts-engine-select");
  const engine = engineSelect ? engineSelect.value : "edge-tts";

  const payload = { tts_engine: engine };

  if (engine === "gpt-sovits") {
    const refSel = document.getElementById("sovits-ref-select");
    const refText = document.getElementById("sovits-ref-text");
    payload.sovits_ref_voice = refSel ? refSel.value : "";
    payload.sovits_ref_text = refText ? refText.value : "";
  } else if (engine === "google-cloud") {
    const voiceSelect = document.getElementById("google-voice-select");
    const rateInput = document.getElementById("google-rate");
    payload.tts_voice = voiceSelect ? voiceSelect.value : "ko-KR-Wavenet-A";
    payload.tts_rate = rateInput ? rateInput.value : "0";
  } else {
    const voiceSelect = document.getElementById("tts-voice-select");
    const rateInput = document.getElementById("tts-rate");
    payload.tts_voice = voiceSelect ? voiceSelect.value : "";
    payload.tts_rate = rateInput ? rateInput.value : "0";
  }
  // Gemini TTS 스타일
  if (engine === "gemini-tts") {
    const styleEl = document.getElementById("gemini-tts-style-popup");
    if (styleEl) payload.gemini_tts_style = styleEl.value.trim();
  }

  try {
    const res = await fetch(`/api/jobs/${jobId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      _wizardStep = 4; // 영상 제작 시작 → step 4으로 이동
      await refreshJobDetail(jobId);
      loadAll();
    } else {
      const err = await res.json();
      alert(err.detail || "재개 실패");
    }
  } catch (e) {
    alert("재개 요청 실패");
  }
}

// ─── Run Channel ───

async function runChannel(channelId, btnEl) {
  const ch = channelsCache.find(c => c.id === channelId);
  const inputEl = document.getElementById(`req-${channelId}`);
  const customRequest = (inputEl?.value || "").trim();
  const request = customRequest || (ch?.default_topics || "").trim();
  if (!request) {
    alert("요청이 설정되지 않았습니다.\n채널을 클릭해서 요청을 추가하세요.");
    return;
  }

  // 실행 버튼 → 로딩 상태 (loadAll로 DOM이 교체되어도 유지되도록 전역 Set 사용)
  _runningChannels.add(channelId);
  _setRunBtnLoading(channelId, true);

  const prevJobCount = ch?.jobs?.length || 0;

  try {
    const useGemini = !!localStorage.getItem("gemini_draft_on");
    const bodyObj = { use_gemini_draft: useGemini };
    if (customRequest) bodyObj.request = customRequest;
    const fetchOpts = {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(bodyObj),
    };
    const res = await fetch(`/api/channels/${channelId}/run`, fetchOpts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert("실행 실패: " + (err.detail || res.statusText));
    } else {
      const data = await res.json();
      console.log("Channel run result:", data);
      // 태스크가 생성될 때까지 폴링
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        await loadAll();
        const updated = channelsCache.find(c => c.id === channelId);
        const newCount = updated?.jobs?.length || 0;
        if (newCount > prevJobCount) break;
      }
    }
  } catch (e) {
    alert("실행 실패: " + e.message);
  } finally {
    _runningChannels.delete(channelId);
    _setRunBtnLoading(channelId, false);
    loadAll();
  }
}

// 채널 실행 로딩 상태 관리 (loadAll 후 DOM 재생성되어도 유지)
const _runningChannels = new Set();
function _setRunBtnLoading(channelId, loading) {
  const btn = document.getElementById(`run-btn-${channelId}`);
  if (!btn) return;
  if (loading) {
    btn.textContent = "생성중...";
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed", "animate-pulse-btn");
  } else {
    btn.textContent = "자동";
    btn.disabled = false;
    btn.classList.remove("opacity-50", "cursor-not-allowed", "animate-pulse-btn");
  }
}

// ─── Header Status ───

function updateHeaderStatus() {
  const el = document.getElementById("header-queue-status");
  if (!el) return;
  let running = 0, queued = 0, waiting = 0;
  for (const ch of channelsCache) {
    running += ch.running_jobs || 0;
    queued += ch.queued_jobs || 0;
    waiting += ch.waiting_jobs || 0;
  }
  const parts = [];
  if (running > 0) parts.push(`<span class="text-orange-400 header-pulse">● ${running} 진행</span>`);
  if (queued > 0) parts.push(`<span class="text-blue-400">◌ ${queued} 대기</span>`);
  if (waiting > 0) parts.push(`<span class="text-yellow-400">◎ ${waiting} 이미지</span>`);
  el.innerHTML = parts.length > 0 ? parts.join("") : `<span class="text-gray-600">대기 없음</span>`;
}

// ─── Claude 사용량 ───
let _usageTimer = null;
async function fetchUsage() {
  try {
    const r = await fetch("/api/usage");
    if (!r.ok) return;
    const d = await r.json();
    const el = document.getElementById("claude-usage");
    if (el) el.textContent = d.session_pct != null ? `${d.session_pct}%` : "";
  } catch {}
}
function startUsagePolling() {
  fetchUsage();
  if (_usageTimer) clearInterval(_usageTimer);
  _usageTimer = setInterval(fetchUsage, 60_000);
}

async function runAllChannels() {
  const runnableChannels = channelsCache.filter(ch => (ch.default_topics || "").trim().length > 0);
  if (runnableChannels.length === 0) {
    alert("실행 가능한 채널이 없습니다. 채널 요청을 먼저 설정하세요.");
    return;
  }
  if (!confirm(`${runnableChannels.length}개 채널을 모두 실행하시겠습니까?`)) return;
  for (const ch of runnableChannels) {
    runChannel(ch.id, null);
  }
}

// ─── Gemini Draft 토글 ───
function onGeminiToggle(checked) {
  if (checked) {
    localStorage.setItem("gemini_draft_on", "1");
  } else {
    localStorage.removeItem("gemini_draft_on");
  }
}

// ─── Claude 프로세스 감지 (dashboard 응답에서 수신) ───
function _updateClaudeDot(active) {
  const dot = document.getElementById("claude-dot");
  const claudeEl = document.getElementById("header-claude-status");
  if (!dot || !claudeEl) return;
  if (active) {
    dot.classList.add("active");
    claudeEl.classList.remove("text-gray-500");
    claudeEl.classList.add("text-gray-300");
  } else {
    dot.classList.remove("active");
    claudeEl.classList.remove("text-gray-300");
    claudeEl.classList.add("text-gray-500");
  }
}

// ─── Polling ───

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadAll, POLL_INTERVAL);
}

// ─── 채널 내보내기/가져오기 ───

function exportChannels() {
  window.location.href = "/api/channels/export";
}

function importChannels(input) {
  const file = input.files[0];
  if (!file) return;
  if (!confirm("채널 데이터를 가져오시겠습니까?\n동일 ID 채널은 덮어씁니다.")) {
    input.value = "";
    return;
  }
  const form = new FormData();
  form.append("file", file);
  fetch("/api/channels/import", { method: "POST", body: form })
    .then(r => r.json())
    .then(data => {
      alert(`${data.imported}개 채널을 가져왔습니다.`);
      input.value = "";
      loadAll();
    })
    .catch(e => {
      alert("가져오기 실패: " + e.message);
      input.value = "";
    });
}

// ─── Modals ───

function openAddChannelModal() {
  document.getElementById("add-channel-modal").classList.remove("hidden");
}

async function submitAddChannel() {
  const name = document.getElementById("ch-name").value.trim();
  const handle = document.getElementById("ch-handle").value.trim();
  const desc = document.getElementById("ch-desc").value.trim();

  if (!name) { alert("채널 이름을 입력하세요"); return; }

  await fetch("/api/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, handle, description: desc }),
  });

  closeModal("add-channel-modal");
  document.getElementById("ch-name").value = "";
  document.getElementById("ch-handle").value = "";
  document.getElementById("ch-desc").value = "";
  loadAll();
}

// ─── Channel Settings ───

let _settingsChannelId = null;
async function openChannelSettings(channelId) {
  try {
  _settingsChannelId = channelId;
  console.log("openChannelSettings called:", channelId, "cache:", channelsCache.length);
  const ch = channelsCache.find(c => c.id === channelId);
  if (!ch) { console.error("Channel not found:", channelId); return; }

  // 그룹 정의 로드
  await _loadConfigGroups();

  // channelId를 먼저 세팅 (loadCharacterRefPreview 등이 참조)
  document.getElementById("channel-settings-modal").dataset.channelId = channelId;

  document.getElementById("cs-name").value = ch.name || "";
  document.getElementById("cs-handle").value = ch.handle || "";
  document.getElementById("cs-desc").value = ch.description || "";
  document.getElementById("cs-topics").value = ch.default_topics || "";
  let cfg = {};
  try { cfg = JSON.parse(ch.config || "{}"); } catch {}

  // 통합 지침: 3개 필드를 merge해서 표시
  document.getElementById("cs-instructions").value = mergeInstructions(
    ch.instructions || "", cfg.script_rules || "", cfg.roundup_rules || ""
  );

  // 활성 그룹 감지 및 UI 렌더
  _enabledGroups = _detectEnabledGroups(cfg);
  _renderGroupChips();

  // ── 기본 (basic) ──
  document.getElementById("cs-fixed-topic").checked = !!cfg.fixed_topic;
  document.getElementById("cs-use-subagent").checked = !!cfg.use_subagent;

  // ── 콘텐츠 (content) ──
  document.getElementById("cs-target-duration").value = cfg.target_duration || 60;
  document.getElementById("cs-target-duration-label").textContent = cfg.target_duration || 60;
  document.getElementById("cs-format").value = cfg.format || "single";
  document.getElementById("cs-dedup-hours").value = cfg.dedup_hours != null ? cfg.dedup_hours : 24;
  document.getElementById("cs-skip-web-search").checked = !!cfg.skip_web_search;
  document.getElementById("cs-auto-bg-source").value = cfg.auto_bg_source || "gemini";
  document.getElementById("cs-auto-video-source").value = cfg.auto_video_source || "none";
  toggleAutoBgSource();
  document.getElementById("cs-image-style").value = cfg.image_style || "mixed";

  // ── 슬라이드 스타일 (slide_style) ──
  document.getElementById("cs-slide-layout").value = cfg.slide_layout || "full";
  document.getElementById("cs-bg-display-mode").value = cfg.bg_display_mode || "zone";
  toggleBgDisplayMode();
  document.getElementById("cs-zone-ratio").value = cfg.slide_zone_ratio || "";
  document.getElementById("cs-main-zone").value = cfg.slide_main_zone || "top";
  document.getElementById("cs-sub-zone").value = cfg.slide_sub_zone || "bottom";
  document.getElementById("cs-text-bg").value = cfg.slide_text_bg != null ? cfg.slide_text_bg : 4;
  document.getElementById("cs-text-bg-label").textContent = cfg.slide_text_bg != null ? cfg.slide_text_bg : 4;
  document.getElementById("cs-main-text-enabled").checked = cfg.main_text_enabled !== false;
  document.getElementById("cs-sub-text-enabled").checked = cfg.sub_text_enabled !== false;
  document.getElementById("cs-sub-text-size").value = cfg.sub_text_size || 0;
  document.getElementById("cs-sub-text-size-label").textContent = cfg.sub_text_size || 0;
  document.getElementById("cs-slide-main-text-size").value = cfg.slide_main_text_size || 0;
  document.getElementById("cs-slide-main-text-size-label").textContent = cfg.slide_main_text_size || 0;
  document.getElementById("cs-slide-badge-size").value = cfg.slide_badge_size || 0;
  document.getElementById("cs-slide-badge-size-label").textContent = cfg.slide_badge_size || 0;
  document.getElementById("cs-slide-accent-color").value = cfg.slide_accent_color || "#ff6b35";
  document.getElementById("cs-slide-accent-color-text").value = cfg.slide_accent_color || "#ff6b35";
  document.getElementById("cs-slide-hl-color").value = cfg.slide_hl_color || "#ffd700";
  document.getElementById("cs-slide-hl-color-text").value = cfg.slide_hl_color || "#ffd700";
  document.getElementById("cs-slide-bg-gradient").value = cfg.slide_bg_gradient || "";
  updateSlidePreview();

  // ── 이미지 (image) ──
  document.getElementById("cs-bg-media-type").value = cfg.bg_media_type || "auto";
  document.getElementById("cs-first-slide-single-bg").checked = !!cfg.first_slide_single_bg;
  document.getElementById("cs-style-reference").checked = !!cfg.style_reference;
  document.getElementById("cs-veo-keep-audio").checked = !!cfg.veo_keep_audio;
  loadCharacterRefPreview();

  // ── 인트로/아웃트로 (intro_outro) ──
  _showChannelBg("intro", !!ch.has_intro_bg, channelId);
  _showChannelBg("outro", !!ch.has_outro_bg, channelId);
  document.getElementById("cs-intro-duration").value = cfg.intro_duration || 3;
  document.getElementById("cs-outro-duration").value = cfg.outro_duration || 3;
  document.getElementById("cs-intro-narration").value = cfg.intro_narration || "";
  document.getElementById("cs-outro-narration").value = cfg.outro_narration || "";
  const nDelay = cfg.narration_delay ?? 2;
  document.getElementById("cs-narration-delay").value = nDelay;
  document.getElementById("cs-narration-delay-label").textContent = nDelay;

  // ── TTS (tts) ──
  const _ttsEnabled = cfg.tts_enabled !== false;  // 기본 true
  document.getElementById("cs-tts-enabled").checked = _ttsEnabled;
  document.getElementById("cs-tts-settings").classList.toggle("hidden", !_ttsEnabled);
  document.getElementById("cs-tts-engine").value = cfg.tts_engine || "edge-tts";
  document.getElementById("cs-tts-voice").value = cfg.tts_voice || "ko-KR-SunHiNeural";
  const rateVal = parseInt((cfg.tts_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  document.getElementById("cs-tts-rate").value = rateVal;
  document.getElementById("cs-tts-rate-label").textContent = rateVal + "%";
  document.getElementById("cs-google-voice").value = cfg.google_voice || "ko-KR-Wavenet-A";
  const googleRate = parseInt((cfg.google_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  document.getElementById("cs-google-rate").value = googleRate;
  document.getElementById("cs-google-rate-label").textContent = googleRate + "%";
  document.getElementById("cs-sovits-ref-text").value = cfg.sovits_ref_text || "";
  const sovitsSpeed = cfg.sovits_speed || 1.0;
  document.getElementById("cs-sovits-speed").value = sovitsSpeed;
  document.getElementById("cs-sovits-speed-label").textContent = sovitsSpeed + "x";
  // ── Gemini TTS ──
  document.getElementById("cs-gemini-tts-style").value = cfg.gemini_tts_style || "";
  toggleTtsEngine();
  if (cfg.tts_engine === "gemini-tts") {
    _populateGeminiVoices();
    document.getElementById("cs-gemini-tts-voice").value = cfg.gemini_tts_voice || "Kore";
  }
  loadRefVoices(cfg.sovits_ref_voice || "");

  // ── RVC ──
  document.getElementById("cs-rvc-enabled").checked = !!cfg.rvc_enabled;
  document.getElementById("cs-rvc-pitch").value = cfg.rvc_pitch || 0;
  document.getElementById("cs-rvc-pitch-label").textContent = cfg.rvc_pitch || 0;
  document.getElementById("cs-rvc-index").value = cfg.rvc_index_influence || 0.5;
  document.getElementById("cs-rvc-index-label").textContent = cfg.rvc_index_influence || 0.5;
  toggleRvcSection();
  if (cfg.rvc_model) {
    loadRvcModels().then(() => {
      document.getElementById("cs-rvc-model").value = cfg.rvc_model;
    });
  }

  // ── BGM/SFX (audio_fx) ──
  document.getElementById("cs-bgm-enabled").checked = !!cfg.bgm_enabled;
  document.getElementById("cs-bgm-volume").value = cfg.bgm_volume || 10;
  document.getElementById("cs-bgm-volume-label").textContent = cfg.bgm_volume || 10;
  loadBgmFiles(cfg);
  document.getElementById("cs-subtitle-enabled").checked = !!cfg.subtitle_enabled;
  document.getElementById("cs-subtitle-font").value = cfg.subtitle_font || "Noto Sans KR";
  document.getElementById("cs-subtitle-size").value = cfg.subtitle_font_size || 48;
  document.getElementById("cs-subtitle-size-label").textContent = (cfg.subtitle_font_size || 48) + "px";
  document.getElementById("cs-subtitle-outline").value = cfg.subtitle_outline || 3;
  document.getElementById("cs-subtitle-outline-label").textContent = cfg.subtitle_outline || 3;
  document.getElementById("cs-subtitle-alignment").value = cfg.subtitle_alignment || 2;
  document.getElementById("cs-subtitle-margin").value = cfg.subtitle_margin_v || 100;
  document.getElementById("cs-subtitle-margin-label").textContent = (cfg.subtitle_margin_v || 100) + "px";
  toggleSubtitleSection();
  document.getElementById("cs-sfx-enabled").checked = !!cfg.sfx_enabled;
  document.getElementById("cs-sfx-volume").value = cfg.sfx_volume || 15;
  document.getElementById("cs-sfx-volume-label").textContent = cfg.sfx_volume || 15;
  const xfDur = cfg.crossfade_duration ?? 0.5;
  document.getElementById("cs-crossfade-duration").value = xfDur;
  document.getElementById("cs-crossfade-label").textContent = xfDur;
  loadTransitionOptions(cfg.crossfade_transition || "fade");
  loadSfxFiles(cfg);

  // ── 시장 데이터 (market_data) ──
  const mds = cfg.market_data_sources || [];
  document.querySelectorAll(".cs-market-source").forEach(cb => cb.checked = mds.includes(cb.value));

  // ── 프롬프트 (prompt) — 통합 지침으로 이동됨 ──

  // ── YouTube (youtube) ──
  document.getElementById("cs-gemini-api-key").value = cfg.gemini_api_key || "";
  document.getElementById("cs-yt-client-id").value = cfg.youtube_client_id || "";
  document.getElementById("cs-yt-client-secret").value = cfg.youtube_client_secret || "";
  document.getElementById("cs-yt-refresh-token").value = cfg.youtube_refresh_token || "";
  document.getElementById("cs-yt-privacy").value = cfg.youtube_privacy || "private";
  document.getElementById("cs-yt-upload-mode").value = cfg.youtube_upload_mode || "manual";

  // ── 스케줄 (schedule) ──
  document.getElementById("cs-schedule-enabled").checked = !!cfg.schedule_enabled;
  _renderScheduleTimes(cfg.schedule_times || []);
  const defaultDays = ["mon", "tue", "wed", "thu", "fri"];
  const scheduleDays = cfg.schedule_days || defaultDays;
  document.querySelectorAll(".cs-schedule-day").forEach(cb => {
    cb.checked = scheduleDays.includes(cb.value);
  });

  // 트렌드 소스 설정 (UI 제거됨, hidden input 호환용)
  document.getElementById("cs-trend-google").value = "";
  document.getElementById("cs-trend-youtube").value = "";
  document.getElementById("cs-youtube-api-key").value = "";

  // 복사 버튼
  const cloneBtn = document.getElementById("btn-clone-channel");
  if (ch.cloned_from) {
    cloneBtn.classList.add("hidden");
  } else {
    cloneBtn.classList.remove("hidden");
  }

  // 탭 바 렌더 + 첫 탭 선택
  _renderTabBar();
  document.getElementById("channel-settings-modal").classList.remove("hidden");
  } catch (e) { console.error("openChannelSettings ERROR:", e); alert("설정 열기 실패: " + e.message); }
}

async function saveChannelSettings() {
  const _btn = document.getElementById("btn-save-channel");
  btnLoading(_btn, "저장중...");

  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;

  const ch = channelsCache.find(c => c.id === channelId);
  let cfg = {};
  try { cfg = JSON.parse(ch?.config || "{}"); } catch {}

  // 헬퍼: UI 값이 있으면 덮어쓰기, 비어있으면 기존 값 유지
  const _setIfPresent = (key, val) => { if (val) cfg[key] = val; };

  // 통합 지침 split → 개별 필드
  const _split = splitInstructions(document.getElementById("cs-instructions").value);
  const _setOrDelete = (key, val) => { if (val) cfg[key] = val; else delete cfg[key]; };
  delete cfg.image_prompt_style;  // config에서 제거 (통합 지침 내 섹션으로 관리)
  _setOrDelete("script_rules", _split.script_rules);
  _setOrDelete("roundup_rules", _split.roundup_rules);

  cfg.image_style = document.getElementById("cs-image-style").value;
  cfg.format = document.getElementById("cs-format").value;
  cfg.bg_media_type = document.getElementById("cs-bg-media-type").value;
  cfg.first_slide_single_bg = document.getElementById("cs-first-slide-single-bg").checked;
  cfg.style_reference = document.getElementById("cs-style-reference").checked;
  cfg.veo_keep_audio = document.getElementById("cs-veo-keep-audio").checked;

  cfg.slide_layout = document.getElementById("cs-slide-layout").value;

  cfg.bg_display_mode = document.getElementById("cs-bg-display-mode").value;
  cfg.slide_zone_ratio = document.getElementById("cs-zone-ratio").value.trim();
  cfg.slide_main_zone = document.getElementById("cs-main-zone").value;
  cfg.slide_sub_zone = document.getElementById("cs-sub-zone").value;
  cfg.slide_text_bg = parseInt(document.getElementById("cs-text-bg").value) || 4;
  cfg.main_text_enabled = document.getElementById("cs-main-text-enabled").checked;
  cfg.sub_text_enabled = document.getElementById("cs-sub-text-enabled").checked;
  cfg.sub_text_size = parseInt(document.getElementById("cs-sub-text-size").value) || 0;
  cfg.auto_bg_source = document.getElementById("cs-auto-bg-source").value;
  cfg.auto_video_source = document.getElementById("cs-auto-video-source").value;
  cfg.production_mode = cfg.auto_bg_source === "manual" ? "manual" : "auto";
  _setIfPresent("gemini_api_key", document.getElementById("cs-gemini-api-key").value.trim());
  cfg.use_subagent = document.getElementById("cs-use-subagent").checked;

  // 기본 탭
  cfg.fixed_topic = document.getElementById("cs-fixed-topic").checked;
  // 콘텐츠 탭
  cfg.target_duration = parseInt(document.getElementById("cs-target-duration").value) || 60;
  cfg.skip_web_search = document.getElementById("cs-skip-web-search").checked;
  cfg.dedup_hours = parseInt(document.getElementById("cs-dedup-hours").value);
  cfg.market_data_sources = [...document.querySelectorAll(".cs-market-source:checked")].map(cb => cb.value);
  // 슬라이드 탭 — 스타일
  cfg.slide_main_text_size = parseInt(document.getElementById("cs-slide-main-text-size").value) || 0;
  cfg.slide_badge_size = parseInt(document.getElementById("cs-slide-badge-size").value) || 0;
  cfg.slide_accent_color = document.getElementById("cs-slide-accent-color-text").value.trim();
  cfg.slide_hl_color = document.getElementById("cs-slide-hl-color-text").value.trim();
  cfg.slide_bg_gradient = document.getElementById("cs-slide-bg-gradient").value.trim();

  // TTS 설정 저장
  cfg.tts_enabled = document.getElementById("cs-tts-enabled").checked;
  cfg.tts_engine = document.getElementById("cs-tts-engine").value;
  cfg.tts_voice = document.getElementById("cs-tts-voice").value;
  const rateN = parseInt(document.getElementById("cs-tts-rate").value) || 0;
  cfg.tts_rate = (rateN >= 0 ? "+" : "") + rateN + "%";
  // Google Cloud TTS
  cfg.google_voice = document.getElementById("cs-google-voice").value;
  const googleRateN = parseInt(document.getElementById("cs-google-rate").value) || 0;
  cfg.google_rate = (googleRateN >= 0 ? "+" : "") + googleRateN + "%";
  cfg.sovits_ref_voice = document.getElementById("cs-sovits-ref-voice").value;
  cfg.sovits_ref_text = document.getElementById("cs-sovits-ref-text").value.trim();
  cfg.sovits_speed = parseFloat(document.getElementById("cs-sovits-speed").value) || 1.0;
  // Gemini TTS
  cfg.gemini_tts_voice = document.getElementById("cs-gemini-tts-voice").value || "Kore";
  cfg.gemini_tts_style = document.getElementById("cs-gemini-tts-style").value.trim();

  // RVC 설정 저장
  cfg.rvc_enabled = document.getElementById("cs-rvc-enabled").checked;
  cfg.rvc_model = document.getElementById("cs-rvc-model").value;
  cfg.rvc_pitch = parseInt(document.getElementById("cs-rvc-pitch").value) || 0;
  cfg.rvc_index_influence = parseFloat(document.getElementById("cs-rvc-index").value) || 0.5;

  // BGM / 음향 설정 저장
  cfg.narration_delay = parseFloat(document.getElementById("cs-narration-delay").value) || 0;
  cfg.bgm_enabled = document.getElementById("cs-bgm-enabled").checked;
  cfg.bgm_file = document.getElementById("cs-bgm-file").value;
  cfg.bgm_volume = parseInt(document.getElementById("cs-bgm-volume").value) || 10;

  // 자막 설정 저장
  cfg.subtitle_enabled = document.getElementById("cs-subtitle-enabled").checked;
  cfg.subtitle_font = document.getElementById("cs-subtitle-font").value;
  cfg.subtitle_font_size = parseInt(document.getElementById("cs-subtitle-size").value) || 48;
  cfg.subtitle_outline = parseInt(document.getElementById("cs-subtitle-outline").value) || 3;
  cfg.subtitle_alignment = parseInt(document.getElementById("cs-subtitle-alignment").value) || 2;
  cfg.subtitle_margin_v = parseInt(document.getElementById("cs-subtitle-margin").value) || 100;

  // 효과음 설정 저장
  cfg.sfx_enabled = document.getElementById("cs-sfx-enabled").checked;
  cfg.sfx_volume = parseInt(document.getElementById("cs-sfx-volume").value) || 15;
  cfg.sfx_transition = document.getElementById("cs-sfx-transition").value;
  cfg.sfx_intro = document.getElementById("cs-sfx-intro").value;
  cfg.sfx_outro = document.getElementById("cs-sfx-outro").value;
  cfg.sfx_highlight = document.getElementById("cs-sfx-highlight").value;
  cfg.crossfade_duration = parseFloat(document.getElementById("cs-crossfade-duration").value) || 0;
  cfg.crossfade_transition = document.getElementById("cs-crossfade-transition").value || "fade";

  // 인트로/아웃트로 duration + 나레이션
  cfg.intro_duration = parseFloat(document.getElementById("cs-intro-duration").value) || 3;
  cfg.outro_duration = parseFloat(document.getElementById("cs-outro-duration").value) || 3;
  cfg.intro_narration = document.getElementById("cs-intro-narration").value.trim();
  cfg.outro_narration = document.getElementById("cs-outro-narration").value.trim();

  // 트렌드 소스 저장
  cfg.trend_sources = [];
  cfg.youtube_api_key = "";

  _setIfPresent("youtube_client_id", document.getElementById("cs-yt-client-id").value.trim());
  _setIfPresent("youtube_client_secret", document.getElementById("cs-yt-client-secret").value.trim());
  _setIfPresent("youtube_refresh_token", document.getElementById("cs-yt-refresh-token").value.trim());
  const ytPrivacy = document.getElementById("cs-yt-privacy").value;
  cfg.youtube_privacy = ytPrivacy;
  cfg.youtube_upload_mode = document.getElementById("cs-yt-upload-mode").value;

  // 스케줄 설정 저장
  cfg.schedule_enabled = document.getElementById("cs-schedule-enabled").checked;
  cfg.schedule_times = _getScheduleTimes();
  cfg.schedule_days = Array.from(document.querySelectorAll(".cs-schedule-day:checked"))
    .map(cb => cb.value);

  // 활성 그룹 저장 (always_on 제외, 사용자가 켠 그룹만)
  const optionalGroups = [];
  for (const gId of _enabledGroups) {
    const g = _configGroups?.groups?.find(x => x.id === gId);
    if (g && !g.always_on) optionalGroups.push(gId);
  }
  if (optionalGroups.length > 0) {
    cfg.enabled_groups = optionalGroups;
  } else {
    delete cfg.enabled_groups;
  }

  // 비활성 그룹의 필드는 제거 (기본값 사용)
  if (_configGroups) {
    for (const g of _configGroups.groups) {
      if (g.always_on) continue;
      if (!_enabledGroups.has(g.id)) {
        for (const field of g.fields) {
          delete cfg[field];
        }
      }
    }
  }

  await fetch(`/api/channels/${channelId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("cs-name").value.trim(),
      handle: document.getElementById("cs-handle").value.trim(),
      description: document.getElementById("cs-desc").value.trim(),
      default_topics: document.getElementById("cs-topics").value,
      instructions: _split.instructions,
      config: JSON.stringify(cfg),
    }),
  });

  btnDone(_btn, "저장 완료");
  setTimeout(() => {
    closeModal("channel-settings-modal");
    loadAll();
  }, 800);
}

// ─── Schedule Time Management ───

function _renderScheduleTimes(times) {
  const container = document.getElementById("cs-schedule-times");
  container.innerHTML = "";
  times.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "flex items-center gap-2";
    row.innerHTML = `
      <input type="time" value="${t}" class="cs-schedule-time bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm"
             onchange="this.value = this.value">
      <button onclick="this.parentElement.remove()"
              class="text-gray-500 hover:text-red-400 text-xs">삭제</button>
    `;
    container.appendChild(row);
  });
}

function addScheduleTime() {
  const container = document.getElementById("cs-schedule-times");
  const row = document.createElement("div");
  row.className = "flex items-center gap-2";
  row.innerHTML = `
    <input type="time" value="07:00" class="cs-schedule-time bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm">
    <button onclick="this.parentElement.remove()"
            class="text-gray-500 hover:text-red-400 text-xs">삭제</button>
  `;
  container.appendChild(row);
}

function _getScheduleTimes() {
  return Array.from(document.querySelectorAll(".cs-schedule-time"))
    .map(el => el.value)
    .filter(v => v);
}

async function deleteCurrentChannel() {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  if (!confirm("이 채널과 모든 작업을 삭제하시겠습니까?")) return;

  await fetch(`/api/channels/${channelId}`, { method: "DELETE" });
  closeModal("channel-settings-modal");
  loadAll();
}

async function cloneCurrentChannel() {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  const res = await fetch(`/api/channels/${channelId}/clone`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "복사 실패" }));
    alert(err.detail || "복사 실패");
    return;
  }
  const clone = await res.json();
  closeModal("channel-settings-modal");
  await loadAll();
  openChannelSettings(clone.id);
}

let _draggedChannelId = null;

function _initChannelDragDrop() {
  const list = document.getElementById("channel-list");
  const items = list.querySelectorAll(".channel-item[draggable]");

  items.forEach(item => {
    item.addEventListener("dragstart", e => {
      const tag = e.target.tagName.toLowerCase();
      if (tag === "textarea" || tag === "input") { e.preventDefault(); return; }
      _draggedChannelId = item.dataset.channelId;
      item.style.opacity = "0.4";
      e.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => {
      item.style.opacity = "1";
      _draggedChannelId = null;
      list.querySelectorAll(".channel-item").forEach(el => el.classList.remove("drag-over"));
    });
    item.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (item.dataset.channelId !== _draggedChannelId) {
        item.classList.add("drag-over");
      }
    });
    item.addEventListener("dragleave", () => {
      item.classList.remove("drag-over");
    });
    item.addEventListener("drop", async e => {
      e.preventDefault();
      item.classList.remove("drag-over");
      if (!_draggedChannelId || item.dataset.channelId === _draggedChannelId) return;
      // 현재 DOM 순서에서 새 순서 계산
      const allItems = [...list.querySelectorAll(".channel-item[draggable]")];
      const order = allItems.map(el => el.dataset.channelId);
      const fromIdx = order.indexOf(_draggedChannelId);
      const toIdx = order.indexOf(item.dataset.channelId);
      if (fromIdx < 0 || toIdx < 0) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, _draggedChannelId);
      await fetch("/api/channels/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order }),
      });
      loadAll();
    });
  });
}

async function deleteChannelJobs(channelId) {
  if (!confirm("이 채널의 모든 작업을 삭제하시겠습니까?")) return;
  const res = await fetch(`/api/jobs?channel_id=${channelId}`);
  const jobs = await res.json();
  for (const job of jobs) {
    await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
  }
  loadAll();
}

async function requestYoutubeToken() {
  const btn = document.getElementById("btn-yt-oauth");
  btn.textContent = "브라우저 확인...";
  btn.disabled = true;

  try {
    const clientId = document.getElementById("cs-yt-client-id").value.trim();
    const clientSecret = document.getElementById("cs-yt-client-secret").value.trim();
    if (!clientId || !clientSecret) {
      alert("Client ID와 Client Secret을 먼저 입력하세요");
      btn.textContent = "토큰 발급";
      btn.disabled = false;
      return;
    }
    const res = await fetch("/api/oauth/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret })
    });
    const data = await res.json();
    if (data.refresh_token) {
      document.getElementById("cs-yt-refresh-token").value = data.refresh_token;
      btn.textContent = "발급 완료";
    } else {
      alert("토큰 발급 실패: " + JSON.stringify(data));
      btn.textContent = "실패";
    }
  } catch (e) {
    alert("토큰 발급 에러: " + e.message);
    btn.textContent = "실패";
  }

  btn.disabled = false;
  setTimeout(() => { btn.textContent = "토큰 발급"; }, 3000);
}

// ─── Trend Preview (제거됨) ───

async function saveChannelSettingsSilent() {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;

  const ch = channelsCache.find(c => c.id === channelId);
  let cfg = {};
  try { cfg = JSON.parse(ch?.config || "{}"); } catch {}

  // 헬퍼: UI 값이 있으면 덮어쓰기, 비어있으면 기존 값 유지
  const _set = (key, val) => { if (val) cfg[key] = val; };

  // 통합 지침 split → 개별 필드
  const _splitS = splitInstructions(document.getElementById("cs-instructions").value);
  const _setOrDel = (key, val) => { if (val) cfg[key] = val; else delete cfg[key]; };
  delete cfg.image_prompt_style;  // config에서 제거
  _setOrDel("script_rules", _splitS.script_rules);
  _setOrDel("roundup_rules", _splitS.roundup_rules);

  cfg.image_style = document.getElementById("cs-image-style").value;
  cfg.format = document.getElementById("cs-format").value;
  cfg.bg_media_type = document.getElementById("cs-bg-media-type").value;
  cfg.first_slide_single_bg = document.getElementById("cs-first-slide-single-bg").checked;
  cfg.style_reference = document.getElementById("cs-style-reference").checked;
  cfg.veo_keep_audio = document.getElementById("cs-veo-keep-audio").checked;

  cfg.slide_layout = document.getElementById("cs-slide-layout").value;

  cfg.bg_display_mode = document.getElementById("cs-bg-display-mode").value;
  cfg.slide_zone_ratio = document.getElementById("cs-zone-ratio").value.trim();
  cfg.slide_main_zone = document.getElementById("cs-main-zone").value;
  cfg.slide_sub_zone = document.getElementById("cs-sub-zone").value;
  cfg.slide_text_bg = parseInt(document.getElementById("cs-text-bg").value) || 4;
  cfg.main_text_enabled = document.getElementById("cs-main-text-enabled").checked;
  cfg.sub_text_enabled = document.getElementById("cs-sub-text-enabled").checked;
  cfg.sub_text_size = parseInt(document.getElementById("cs-sub-text-size").value) || 0;
  cfg.auto_bg_source = document.getElementById("cs-auto-bg-source").value;
  cfg.auto_video_source = document.getElementById("cs-auto-video-source").value;
  cfg.production_mode = cfg.auto_bg_source === "manual" ? "manual" : "auto";
  _set("gemini_api_key", document.getElementById("cs-gemini-api-key").value.trim());
  cfg.use_subagent = document.getElementById("cs-use-subagent").checked;

  // 기본 탭
  cfg.fixed_topic = document.getElementById("cs-fixed-topic").checked;
  // 콘텐츠 탭
  cfg.target_duration = parseInt(document.getElementById("cs-target-duration").value) || 60;
  cfg.skip_web_search = document.getElementById("cs-skip-web-search").checked;
  cfg.dedup_hours = parseInt(document.getElementById("cs-dedup-hours").value);
  cfg.market_data_sources = [...document.querySelectorAll(".cs-market-source:checked")].map(cb => cb.value);
  // 슬라이드 탭
  cfg.slide_main_text_size = parseInt(document.getElementById("cs-slide-main-text-size").value) || 0;
  cfg.slide_badge_size = parseInt(document.getElementById("cs-slide-badge-size").value) || 0;
  cfg.slide_accent_color = document.getElementById("cs-slide-accent-color-text").value.trim();
  cfg.slide_hl_color = document.getElementById("cs-slide-hl-color-text").value.trim();
  cfg.slide_bg_gradient = document.getElementById("cs-slide-bg-gradient").value.trim();

  cfg.trend_sources = [];
  cfg.youtube_api_key = "";

  _set("youtube_client_id", document.getElementById("cs-yt-client-id").value.trim());
  _set("youtube_client_secret", document.getElementById("cs-yt-client-secret").value.trim());
  _set("youtube_refresh_token", document.getElementById("cs-yt-refresh-token").value.trim());
  cfg.youtube_privacy = document.getElementById("cs-yt-privacy").value;

  // 활성 그룹 저장
  const optionalGroups = [];
  for (const gId of _enabledGroups) {
    const g = _configGroups?.groups?.find(x => x.id === gId);
    if (g && !g.always_on) optionalGroups.push(gId);
  }
  if (optionalGroups.length > 0) {
    cfg.enabled_groups = optionalGroups;
  } else {
    delete cfg.enabled_groups;
  }

  // 비활성 그룹 필드 제거
  if (_configGroups) {
    for (const g of _configGroups.groups) {
      if (g.always_on) continue;
      if (!_enabledGroups.has(g.id)) {
        for (const field of g.fields) {
          delete cfg[field];
        }
      }
    }
  }

  await fetch(`/api/channels/${channelId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("cs-name").value.trim(),
      handle: document.getElementById("cs-handle").value.trim(),
      description: document.getElementById("cs-desc").value.trim(),
      default_topics: document.getElementById("cs-topics").value,
      instructions: _splitS.instructions,
      config: JSON.stringify(cfg),
    }),
  });

  // 캐시 갱신
  const dashRes = await fetch("/api/dashboard");
  channelsCache = await dashRes.json();
}

// ─── Prompt Defaults ───

let _promptDefaultsCache = null;

async function fillPromptDefault(textareaId, key) {
  if (!_promptDefaultsCache) {
    try {
      const res = await fetch("/api/prompt-defaults");
      _promptDefaultsCache = await res.json();
    } catch {
      alert("기본값을 불러올 수 없습니다");
      return;
    }
  }
  const val = _promptDefaultsCache[key] || "";
  document.getElementById(textareaId).value = val;
}

// ─── Manual Script Modal ───

let _manualSlides = [];
let _manualSentences = [];
let _manualImagePrompts = [];  // JSON 붙여넣기에서 온 원본 image_prompts
let _manualChannelId = null;
let _manualCategory = "";

function _buildManualPrompt(channelId) {
  const ch = channelsCache.find(c => c.id === channelId);
  const cfg = ch ? JSON.parse(ch.config || "{}") : {};
  const fmt = cfg.format || "single";
  const instructions = (ch && ch.instructions) ? ch.instructions : "";
  const slideLayout = cfg.slide_layout || "full";
  const imageStyle = cfg.image_style || "mixed";
  // image_prompt_style은 통합 지침(instructions) 내 섹션으로 관리
  const targetDuration = cfg.target_duration || 60;
  const scriptRules = (fmt === "roundup") ? (cfg.roundup_rules || "") : (cfg.script_rules || "");
  const bgMediaType = cfg.bg_media_type || "auto";
  const autoBgSource = cfg.auto_bg_source || "sd_image";

  const channelName = ch ? ch.name : "유튜브 쇼츠";
  let prompt = `너는 "${channelName}" 유튜브 쇼츠 콘텐츠 제작 전문가다.

사용자가 입력한 주제를 기반으로
유튜브 쇼츠 영상을 제작한다.

목표 영상 길이: ${targetDuration}초
`;

  if (instructions) {
    prompt += `
[채널 지침]

${instructions}
`;
  }

  // 대본 규칙 (script_rules)
  if (scriptRules) {
    prompt += `
[대본 규칙 — 반드시 준수]

${scriptRules}
`;
  } else {
    // 기본 규칙
    prompt += `
[대본 규칙]

- 슬라이드: ${targetDuration <= 30 ? '4~6개' : '6~8개'} (closing 제외, 시스템이 자동 추가)
- 문장: ${targetDuration <= 30 ? '8~12개, 총 160~200자' : '14~20개, 총 200~300자'}
- 슬라이드 1개당 문장 2~4개 (5개 이상 금지)
- ★ 배경 1개당 표시 시간: 이미지 ~5초, 영상(video) ~6초
  - 나레이션 길이를 배경 교체 타이밍에 맞출 것
  - 한국어 TTS 초당 ~4.5음절 기준
- 첫 슬라이드: 강력한 훅(Hook) 문장, category에 주제 태그
- closing 슬라이드는 생성하지 않음 (시스템이 자동 추가)
- 강조 키워드는 <span class="hl">...</span>으로 감싸기
- 채널 지침의 톤과 스타일을 반드시 따를 것
- bg_type: photo(장소/사물) | broll(시네마틱) | graph(인포그래픽) | logo(기업 건물)
- main/sub 텍스트가 이미지 프롬프트로 변환되므로 시각화 가능한 구체적 내용 필수`;

    if (fmt === "roundup") {
      prompt += `
- 라운드업 형식: 여러 뉴스를 한 영상에 묶어서 전달
- 첫 슬라이드: bg_type "overview", 주제 목록 소개`;
    }
  }

  const bgTypeDesc = imageStyle === 'photo' ? '모든 슬라이드 "photo" 고정 (실사 사진 스타일)'
    : imageStyle === 'infographic' ? '모든 슬라이드 "graph" 고정 (인포그래픽/일러스트/차트 스타일)'
    : imageStyle === 'anime' ? '모든 슬라이드 "photo" 고정 (애니메이션/디지털 일러스트 스타일)'
    : '슬라이드별 배경 유형 선택 (photo=실사, graph=인포그래픽, broll=B-roll, logo=로고)';
  const bgTypeVal = imageStyle === 'photo' || imageStyle === 'anime' ? 'photo'
    : imageStyle === 'infographic' ? 'graph' : '';
  const hasChannelRules = !!scriptRules;

  prompt += `

[슬라이드 텍스트 규칙]

메인 텍스트: 12~20자, 강한 키워드 중심, 강조는 <span class="hl">키워드</span>
보조 텍스트: 20~30자, 핵심 설명

bg_type: ${bgTypeDesc}
슬라이드 레이아웃: ${slideLayout}

[나레이션 규칙]

1. 전체 나레이션 읽기 시간이 ${targetDuration}초에 맞도록 조절
2. 채널 지침과 대본 규칙의 톤/말투/문장 길이를 반드시 따를 것
3. narration text는 TTS가 읽는 텍스트이므로 HTML 태그 금지, 순수 텍스트만
`;

  if (!hasChannelRules) {
    // 채널 대본 규칙이 없을 때만 기본 세부 규칙 추가
    prompt += `4. narration 항목 1개 = image_prompts 항목 1개 (반드시 같은 개수, 1:1 대응)
5. ★ 나레이션 1항목의 글자 수는 대응하는 배경 표시 시간에 맞출 것:
   - image 배경(~5초): 20~25자
   - video 배경(~6초): 25~30자
   - 12~17자처럼 짧으면 배경과 갭이 생김. 반드시 글자 수 지킬 것
`;
  }

  prompt += `
[출력 형식]

반드시 아래 JSON 형식으로만 출력한다.
설명문은 절대 출력하지 않는다.

{
  "topic": "",
  "youtube_title": "",
  "category": "",
  "slides": [
    {
      "bg_type": "${bgTypeVal}",
      "main_text": "핵심 <span class=\\"hl\\">강조</span> 텍스트",
      "sub_text": ""
    }
  ],
  "narration": [
    { "slide": 1, "text": "나레이션 텍스트" }
  ],
  "image_prompts": [
    { "slide": 1, "ko": "한국어 장면 묘사", "en": "English prompt 30-60 words", "media": "image", "motion": "" }
  ]
}

★ narration 개수 = image_prompts 개수 (같은 slide 번호끼리 순서대로 1:1 대응)
★ closing 슬라이드는 생성하지 않는다 (시스템이 자동 추가)

[필드 설명]
- category: 주제를 대표하는 태그
- image_prompts.ko: 배경 이미지 한국어 프롬프트 (구체적 장면 묘사)
- image_prompts.en: 영어 프롬프트 (subject+setting+lighting+camera+style 포함)
- image_prompts.media: "image" 또는 "video" — 정적 이미지(~5초) 또는 영상(~6초)
- image_prompts.motion: video일 때 카메라/피사체 움직임, image일 때 빈 문자열
`;

  if (!hasChannelRules) {
    // 채널 대본 규칙이 없을 때만 기본 media/motion/배경 규칙 추가
    prompt += `
[media 배치 규칙]
- 전체 프롬프트 중 25~35%만 "video" (과하면 산만해짐)
- ★★ graph/overview 타입 슬라이드는 반드시 전부 "image" (video 절대 금지)
- 같은 슬라이드 내 video는 최대 1개
- 나레이션 흐름에 맞춰 배치:
  설명/도입 → image | 행동/움직임/변화 → video | 결론/정리 → image

[motion 작성 규칙 — 장면을 구체적으로 연출]
★ "slow zoom in", "pan left" 같은 단순 카메라 동작만 쓰지 말 것.
★ 무엇이 어떻게 움직이는지, 장면이 어떻게 변하는지를 구체적으로 묘사해야 한다.

좋은 예:
- "steam rising slowly from a coffee cup while camera pushes in closer to the surface"
- "sunlight gradually shifting across a wooden desk, casting moving shadows over notebooks"
- "camera slowly orbits around scattered coffee beans as one bean rolls gently to the side"
- "rain drops sliding down a cafe window glass while blurred city lights glow in background"
- "person flipping a notebook page while camera dollies forward past the coffee cup"

나쁜 예 (너무 단순 — 금지):
- "slow zoom in" / "zoom out" / "pan left" / "pan right"

motion 구성 요소 (2~3개 조합할 것):
1. 카메라 동작: zoom in/out, pan, dolly, crane, orbit, tilt, tracking, push in
2. 피사체 동작: 물체가 움직이거나 변하는 모습 (흔들림, 흐름, 회전, 떨어짐, 펼쳐짐 등)
3. 환경 변화: 빛의 이동, 그림자, 연기/김, 바람, 물결 등

- ★ 매번 다른 motion 조합 사용 (같은 패턴 반복 금지)
- ★ en 프롬프트에도 motion 내용을 자연스럽게 포함할 것
[배경 프롬프트 개수 규칙]
${bgMediaType === "single" ? `
★ 슬라이드당 narration 1항목, image_prompts 1개씩만 생성한다.` : `
★ 슬라이드 나레이션 총 길이에 따라 배경 개수 결정:
  - ~5초(배경 1개) | ~10초(배경 2개) | ~15초(배경 3개)
  - 한 슬라이드에 배경 N개 → narration도 N항목 (같은 slide 번호)
  각 배경 프롬프트는 서로 다른 앵글/장면/스케일로 시각적 변화를 준다.`}
`;
  }

  prompt += `
[생성 요청 주제]

`;
  return prompt;
}

function openManualModal(channelId) {
  _manualChannelId = channelId;
  _manualCategory = "";
  _manualImagePrompts = [];
  _manualSlides = [{ main: "", sub: "", bg_type: "photo", image_prompt_ko: "", image_prompt_en: "" }];
  _manualSentences = [{ text: "", slide: 1 }];
  const jsonTA = document.getElementById("manual-json-input");
  if (jsonTA) jsonTA.value = "";
  document.getElementById("manual-modal").classList.remove("hidden");
  renderManualModal(channelId);
}

function copyManualPrompt(btnEl) {
  const text = _buildManualPrompt(_manualChannelId);
  const done = () => {
    btnEl.textContent = "✅ 복사됨";
    setTimeout(() => { btnEl.textContent = "지침 복사"; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => { _copyFallback(text); done(); });
  } else {
    _copyFallback(text); done();
  }
}

function toggleJsonPaste() {
  const el = document.getElementById("manual-json-paste-area");
  if (el.classList.contains("hidden")) {
    el.classList.remove("hidden");
    el.querySelector("textarea").focus();
  } else {
    el.classList.add("hidden");
  }
}

function applyJsonPaste() {
  let raw = document.getElementById("manual-json-input").value.trim();
  if (!raw) { alert("JSON을 붙여넣어 주세요."); return; }
  // markdown 코드블록 제거
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  // <span class="hl"> 등 HTML 속성의 이스케이프 안 된 따옴표 수정
  raw = raw.replace(/<span\s+class="hl">/g, '<span class=\\"hl\\">');
  try {
    const data = JSON.parse(raw);

    // topic, youtube_title
    if (data.topic) {
      const el = document.getElementById("manual-topic");
      if (el) el.value = data.topic;
    }
    if (data.youtube_title) {
      const el = document.getElementById("manual-yt-title");
      if (el) el.value = data.youtube_title;
    }

    // top-level category
    _manualCategory = data.category || "";

    // image_prompts (최상위 배열) → 원본 보존 + 슬라이드별 매핑
    const imgPrompts = Array.isArray(data.image_prompts) ? data.image_prompts : [];
    _manualImagePrompts = imgPrompts;

    // slides (closing 제외 — 제출 시 자동 추가됨)
    if (Array.isArray(data.slides) && data.slides.length > 0) {
      _manualSlides = data.slides.filter(s => (s.bg_type || "photo") !== "closing").map((s, i) => {
        const slideNum = i + 1;
        // image_prompts에서 이 슬라이드의 프롬프트들 찾기
        const slidePrompts = imgPrompts.filter(p => p.slide === slideNum);
        // 첫 번째 프롬프트의 ko/en을 슬라이드에 매핑 (기존 UI 호환)
        const firstP = slidePrompts[0] || {};
        return {
          main: s.main_text || s.main || "",
          sub: s.sub_text || s.sub || "",
          bg_type: s.bg_type || "photo",
          image_prompt_ko: s.image_prompt_ko || firstP.ko || "",
          image_prompt_en: s.image_prompt_en || firstP.en || "",
          image_prompts: slidePrompts.length > 0 ? slidePrompts : undefined,
        };
      });
    }

    // narration — 최상위 narration/sentences 우선, 없으면 slides 내부 narration 수집
    if (Array.isArray(data.narration) && data.narration.length > 0) {
      _manualSentences = data.narration.map(n => ({
        text: n.text || "",
        slide: n.slide || 1,
      }));
    } else if (Array.isArray(data.sentences) && data.sentences.length > 0) {
      _manualSentences = data.sentences.map(s => ({
        text: s.text || "",
        slide: s.slide || 1,
      }));
    } else if (Array.isArray(data.slides)) {
      // slides 내부 narration 배열에서 추출
      const collected = [];
      data.slides.forEach((s, i) => {
        const narr = s.narration || s.sentences || [];
        if (Array.isArray(narr)) {
          narr.forEach(n => collected.push({ text: n.text || "", slide: n.slide || (i + 1) }));
        }
      });
      if (collected.length > 0) _manualSentences = collected;
    }

    renderManualModal(_manualChannelId);

    // 다시 topic/title 값 복원 (renderManualModal이 input을 재생성하므로)
    if (data.topic) document.getElementById("manual-topic").value = data.topic;
    if (data.youtube_title) document.getElementById("manual-yt-title").value = data.youtube_title;
  } catch (e) {
    alert("JSON 파싱 오류: " + e.message);
  }
}

function renderManualModal(channelId) {
  const today = new Date().toISOString().slice(0, 10);
  const ch = channelsCache.find(c => c.id === channelId);

  let slidesHtml = _manualSlides.map((s, i) => `
    <div class="border border-gray-700 rounded-lg p-3 mb-2">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-bold text-orange-400">#${i + 1}</span>
        ${_manualSlides.length > 1 ? `<button onclick="removeManualSlide(${i}, '${channelId}')" class="text-xs text-gray-600 hover:text-red-400">삭제</button>` : ''}
      </div>
      <div class="mb-2">
        <label class="block text-xs text-gray-500 mb-1">bg_type</label>
        <select data-field="bg_type" data-idx="${i}"
                onchange="updateManualSlide(${i}, 'bg_type', this.value)"
                class="w-40 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">
          <option value="photo" ${s.bg_type === 'photo' ? 'selected' : ''}>photo</option>
          <option value="broll" ${s.bg_type === 'broll' ? 'selected' : ''}>broll</option>
          <option value="graph" ${s.bg_type === 'graph' ? 'selected' : ''}>graph</option>
          <option value="logo" ${s.bg_type === 'logo' ? 'selected' : ''}>logo</option>
        </select>
      </div>
      <div class="mb-2">
        <label class="block text-xs text-gray-500 mb-1">메인 텍스트</label>
        <input type="text" value="${esc(s.main)}" placeholder="메인 텍스트 (필수)"
               onchange="updateManualSlide(${i}, 'main', this.value)"
               class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">
      </div>
      <div class="mb-2">
        <label class="block text-xs text-gray-500 mb-1">보조 텍스트</label>
        <input type="text" value="${esc(s.sub)}" placeholder="보조 텍스트 (선택)"
               onchange="updateManualSlide(${i}, 'sub', this.value)"
               class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">
      </div>
      ${(() => {
        const slideNum = i + 1;
        const slidePrompts = _manualImagePrompts.filter(p => p.slide === slideNum);
        if (slidePrompts.length > 0) {
          return slidePrompts.map((p, pi) => {
            const mediaBadge = p.media === 'video'
              ? '<span class="text-purple-400 font-bold text-[10px] ml-1">VIDEO</span>'
              : '<span class="text-gray-500 text-[10px] ml-1">IMAGE</span>';
            return `<div class="grid grid-cols-2 gap-2 mb-1">
              <div>
                <label class="block text-xs text-gray-500 mb-1">배경 ${pi+1}/${slidePrompts.length} (한)${mediaBadge}</label>
                <textarea rows="2" onchange="_updateManualPrompt(${slideNum}, ${pi}, 'ko', this.value)"
                  class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">${esc(p.ko || '')}</textarea>
              </div>
              <div>
                <label class="block text-xs text-gray-500 mb-1">배경 ${pi+1}/${slidePrompts.length} (영)</label>
                <textarea rows="2" onchange="_updateManualPrompt(${slideNum}, ${pi}, 'en', this.value)"
                  class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">${esc(p.en || '')}</textarea>
              </div>
            </div>`;
          }).join('');
        }
        return `<div class="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label class="block text-xs text-gray-500 mb-1">이미지 프롬프트 (한)</label>
            <textarea rows="2" placeholder="배경 이미지 한국어 프롬프트"
                      onchange="updateManualSlide(${i}, 'image_prompt_ko', this.value)"
                      class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">${esc(s.image_prompt_ko || '')}</textarea>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">이미지 프롬프트 (영)</label>
            <textarea rows="2" placeholder="Background image English prompt"
                      onchange="updateManualSlide(${i}, 'image_prompt_en', this.value)"
                      class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">${esc(s.image_prompt_en || '')}</textarea>
          </div>
        </div>`;
      })()}
    </div>
  `).join("");

  let sentencesHtml = _manualSentences.map((sen, i) => `
    <div class="flex items-center gap-2 mb-2">
      <span class="text-xs text-gray-500 w-6 flex-shrink-0">${i + 1}.</span>
      <input type="text" value="${esc(sen.text)}" placeholder="나레이션 문장"
             onchange="updateManualSentence(${i}, 'text', this.value)"
             class="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">
      <div class="flex items-center gap-1 flex-shrink-0">
        <label class="text-xs text-gray-500">슬라이드</label>
        <input type="number" value="${sen.slide}" min="1" max="${_manualSlides.length}"
               onchange="updateManualSentence(${i}, 'slide', parseInt(this.value) || 1)"
               class="w-12 bg-gray-800 border border-gray-700 rounded px-1 py-1 text-xs text-center">
      </div>
      ${_manualSentences.length > 1 ? `<button onclick="removeManualSentence(${i}, '${channelId}')" class="text-xs text-gray-600 hover:text-red-400 flex-shrink-0">✕</button>` : ''}
    </div>
  `).join("");

  document.getElementById("manual-modal-content").innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-lg font-bold">수동 대본 작성</h3>
      <div class="flex items-center gap-2">
        <button onclick="copyManualPrompt(this)" class="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg transition">지침 복사</button>
        <button onclick="openModal('json-paste-modal')" class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded-lg transition">JSON 붙여넣기</button>
        <button onclick="closeModal('manual-modal')" class="text-gray-500 hover:text-white text-lg transition ml-1">&times;</button>
      </div>
    </div>
    <div class="space-y-3 overflow-y-auto pr-1" style="flex:1;min-height:0;">
      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2">
          <label class="block text-xs text-gray-400 mb-1">주제 (필수)</label>
          <input id="manual-topic" type="text" placeholder="예: 반도체 수출 역대 최고"
                 class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">뉴스 날짜</label>
          <input id="manual-date" type="date" value="${today}"
                 class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
        </div>
      </div>
      <div>
        <label class="block text-xs text-gray-400 mb-1">YouTube 제목 (필수)</label>
        <input id="manual-yt-title" type="text" placeholder="예: 반도체 수출 역대 최고치 경신!"
               class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
      </div>
      <div class="flex items-center gap-3 mt-1">
        <label class="flex items-center gap-1.5 text-sm cursor-pointer">
          <input id="manual-category-cb" type="checkbox" ${_manualCategory === '속보' ? 'checked' : ''}
                 onchange="_manualCategory = this.checked ? '속보' : ''"
                 class="w-4 h-4 rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-orange-500">
          <span class="text-gray-300">속보</span>
        </label>
      </div>

      <div class="border-t border-gray-800 pt-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-semibold text-gray-300">슬라이드</span>
          <button onclick="addManualSlide('${channelId}')"
                  class="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">+ 추가</button>
        </div>
        ${slidesHtml}
      </div>

      <div class="border-t border-gray-800 pt-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-semibold text-gray-300">나레이션 문장</span>
          <button onclick="addManualSentence('${channelId}')"
                  class="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">+ 추가</button>
        </div>
        ${sentencesHtml}
      </div>
    </div>
    <div class="flex justify-end gap-3 mt-4 pt-3 border-t border-gray-800">
      <button onclick="closeModal('manual-modal')" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">취소</button>
      <button onclick="submitManualJob('${channelId}')" class="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition">작업 생성</button>
    </div>
  `;
}

function updateManualSlide(idx, field, value) {
  _manualSlides[idx][field] = value;
}

function _updateManualPrompt(slideNum, promptIdx, field, value) {
  const slidePrompts = _manualImagePrompts.filter(p => p.slide === slideNum);
  if (slidePrompts[promptIdx]) {
    slidePrompts[promptIdx][field] = value;
  }
}

function updateManualSentence(idx, field, value) {
  _manualSentences[idx][field] = value;
}

function addManualSlide(channelId) {
  _manualSlides.push({ main: "", sub: "", bg_type: "photo", image_prompt_ko: "", image_prompt_en: "" });
  renderManualModal(channelId);
}

function removeManualSlide(idx, channelId) {
  _manualSlides.splice(idx, 1);
  renderManualModal(channelId);
}

function addManualSentence(channelId) {
  _manualSentences.push({ text: "", slide: 1 });
  renderManualModal(channelId);
}

function removeManualSentence(idx, channelId) {
  _manualSentences.splice(idx, 1);
  renderManualModal(channelId);
}

async function submitManualJob(channelId) {
  const topic = document.getElementById("manual-topic")?.value?.trim();
  const ytTitle = document.getElementById("manual-yt-title")?.value?.trim();
  const newsDate = document.getElementById("manual-date")?.value || new Date().toISOString().slice(0, 10);

  if (!topic) { alert("주제를 입력하세요."); return; }
  if (!ytTitle) { alert("YouTube 제목을 입력하세요."); return; }

  // 버튼 로딩 상태
  const _btn = event?.target;
  if (_btn) btnLoading(_btn, "생성중...");

  // 빈 메인 텍스트 검증
  for (let i = 0; i < _manualSlides.length; i++) {
    if (!_manualSlides[i].main.trim()) {
      alert(`슬라이드 #${i + 1}의 메인 텍스트를 입력하세요.`);
      return;
    }
  }
  for (let i = 0; i < _manualSentences.length; i++) {
    if (!_manualSentences[i].text.trim()) {
      alert(`문장 #${i + 1}의 내용을 입력하세요.`);
      return;
    }
  }

  // closing 제외 (채널에 클로징 배경이 있으면 Phase B에서 자동 처리)
  const slides = _manualSlides.filter(s => s.bg_type !== "closing").map(s => ({
    category: _manualCategory,
    main: s.main,
    sub: s.sub,
    bg_type: s.bg_type,
    image_prompt_ko: s.image_prompt_ko || "",
    image_prompt_en: s.image_prompt_en || "",
  }));

  const sentences = _manualSentences.map(s => ({
    text: s.text,
    slide: s.slide,
  }));

  // image_prompts 수집: JSON 붙여넣기 원본 우선, 없으면 슬라이드별 단일 프롬프트
  let imagePrompts = [];
  if (_manualImagePrompts.length > 0) {
    imagePrompts = _manualImagePrompts;
  } else {
    _manualSlides.forEach((s, i) => {
      if (s.image_prompt_en) {
        imagePrompts.push({
          ko: s.image_prompt_ko || "", en: s.image_prompt_en,
          media: "image", motion: "",
          slide: i + 1,
        });
      }
    });
  }

  const scriptJson = {
    news_date: newsDate,
    youtube_title: ytTitle,
    category: _manualCategory,
    slides: slides,
    sentences: sentences,
  };

  try {
    const res = await fetch("/api/jobs/create-manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        topic: topic,
        script_json: scriptJson,
        image_prompts: imagePrompts.length > 0 ? imagePrompts : undefined,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert("작업 생성 실패: " + (err.detail || res.statusText));
      return;
    }
    const data = await res.json();
    if (_btn) btnDone(_btn, "생성 완료");
    closeModal("manual-modal");
    await loadAll();
  } catch (e) {
    if (_btn) btnError(_btn, "생성 실패");
    alert("작업 생성 실패: " + e.message);
  }
}

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}
function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
  if (id === "job-detail-modal") currentDetailJobId = null;
}

// ─── Helpers ───

function formatTime(ts) {
  if (!ts) return "";
  return ts.replace("T", " ").slice(0, 16);
}

function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ─── News Browser ───

let _newsBrowserItems = [];  // 복사용 텍스트 배열
let _nbCache = {};           // API 캐시 {category: data}
let _nbSource = "news";      // 현재 소스 탭
let _nbCategory = "";        // 현재 뉴스 카테고리

function openNewsBrowser() {
  _nbCache = {};
  _nbSource = "news";
  _nbCategory = "";
  document.getElementById("news-browser-modal").classList.remove("hidden");
  _nbFetchAndRender("");
}

function _nbSwitchSource(src) {
  _nbSource = src;
  if (src === "news") {
    // 뉴스 탭: 현재 카테고리 캐시 있으면 바로 렌더, 없으면 fetch
    if (_nbCache[_nbCategory]) { _nbRender(_nbCache[_nbCategory]); }
    else { _nbFetchAndRender(_nbCategory); }
  } else {
    // 트렌드/유튜브: "" 캐시 사용 (항상 category="" 로 가져옴)
    if (_nbCache[""]) { _nbRender(_nbCache[""]); }
    else { _nbFetchAndRender(""); }
  }
}

async function _nbFetchAndRender(category) {
  _nbCategory = category;
  const container = document.getElementById("news-browser-content");
  container.innerHTML = _nbBuildHeader() + '<div class="text-gray-500 text-sm py-8 text-center">불러오는 중...</div>';
  _nbBindTabs(container);

  try {
    const res = await fetch("/api/news/browse?category=" + encodeURIComponent(category));
    if (!res.ok) throw new Error("서버 응답 오류 (" + res.status + ")");
    const data = await res.json();
    _nbCache[category] = data;
    _nbRender(data);
  } catch (e) {
    container.innerHTML = _nbBuildHeader()
      + '<div class="text-red-400 text-sm py-4 text-center">오류: ' + esc(e.message) + '</div>';
    _nbBindTabs(container);
  }
}

function _nbBuildHeader() {
  const sources = [
    { code: "news", label: "뉴스" },
  ];
  const srcTabs = sources.map(s =>
    '<button data-nb-src="' + s.code + '" class="px-4 py-1.5 text-sm font-medium rounded-lg transition '
    + (s.code === _nbSource ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white')
    + '">' + s.label + '</button>'
  ).join("");

  let sub = "";
  if (_nbSource === "news") {
    const cats = [
      { code: "", label: "종합" },
      { code: "BUSINESS", label: "경제" },
      { code: "TECHNOLOGY", label: "기술" },
      { code: "NATION", label: "국내" },
    ];
    sub = '<div class="flex gap-1.5 mt-3">' + cats.map(c =>
      '<button data-nb-cat="' + c.code + '" class="px-2.5 py-1 text-xs rounded transition '
      + (c.code === _nbCategory ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800')
      + '">' + c.label + '</button>'
    ).join("") + '</div>';
  }

  return '<div class="flex items-center justify-between mb-3">'
    + '<h3 class="text-lg font-bold">탐색</h3>'
    + '<button onclick="closeModal(\'news-browser-modal\')" class="text-gray-500 hover:text-white text-lg transition">&times;</button>'
    + '</div>'
    + '<div class="flex gap-2">' + srcTabs + '</div>'
    + sub;
}

function _nbRender(data) {
  const container = document.getElementById("news-browser-content");
  _newsBrowserItems = [];
  let idx = 0;
  let body = '<div class="space-y-1 overflow-y-auto mt-3 pr-1" style="flex:1; min-height:0;">';

  if (_nbSource === "news") {
    const news = data.google_news || [];
    if (news.length > 0) {
      for (const item of news) {
        _newsBrowserItems.push(item.title);
        body += '<div class="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-gray-800/50">'
          + '<button data-nb-copy="' + idx + '" class="text-gray-500 hover:text-orange-400 transition text-sm mt-0.5 shrink-0" title="복사">📋</button>'
          + '<div class="min-w-0"><div class="text-sm text-gray-200 leading-snug">' + esc(item.title) + '</div>'
          + (item.source ? '<div class="text-xs text-gray-500 mt-0.5">' + esc(item.source) + '</div>' : '')
          + '</div></div>';
        idx++;
      }
    } else {
      body += '<div class="text-gray-600 text-sm py-8 text-center">뉴스를 불러올 수 없습니다</div>';
    }
  } else if (_nbSource === "trends") {
    const trends = data.google_trends || [];
    if (trends.length > 0) {
      for (const kw of trends) {
        _newsBrowserItems.push(kw);
        body += '<div class="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-gray-800/50">'
          + '<button data-nb-copy="' + idx + '" class="text-gray-500 hover:text-orange-400 transition text-sm shrink-0" title="복사">📋</button>'
          + '<span class="text-sm text-gray-200">' + esc(kw) + '</span></div>';
        idx++;
      }
    } else {
      body += '<div class="text-gray-600 text-sm py-8 text-center">트렌드를 불러올 수 없습니다</div>';
    }
  } else if (_nbSource === "youtube") {
    const yt = data.youtube_trending || [];
    if (yt.length > 0) {
      for (const title of yt) {
        _newsBrowserItems.push(title);
        body += '<div class="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-gray-800/50">'
          + '<button data-nb-copy="' + idx + '" class="text-gray-500 hover:text-orange-400 transition text-sm shrink-0" title="복사">📋</button>'
          + '<span class="text-sm text-gray-200">' + esc(title) + '</span></div>';
        idx++;
      }
    } else {
      body += '<div class="text-gray-600 text-sm py-8 text-center">YouTube API 키가 설정된 채널이 없습니다</div>';
    }
  }

  body += '</div>';
  container.innerHTML = _nbBuildHeader() + body;
  _nbBindTabs(container);
  container.querySelectorAll("[data-nb-copy]").forEach(btn =>
    btn.addEventListener("click", () => _copyNewsItem(parseInt(btn.dataset.nbCopy), btn))
  );
}

function _nbBindTabs(container) {
  container.querySelectorAll("[data-nb-src]").forEach(btn =>
    btn.addEventListener("click", () => _nbSwitchSource(btn.dataset.nbSrc))
  );
  container.querySelectorAll("[data-nb-cat]").forEach(btn =>
    btn.addEventListener("click", () => {
      _nbCategory = btn.dataset.nbCat;
      if (_nbCache[_nbCategory]) { _nbRender(_nbCache[_nbCategory]); }
      else { _nbFetchAndRender(_nbCategory); }
    })
  );
}

function _copyNewsItem(idx, btnEl) {
  const text = _newsBrowserItems[idx];
  if (!text) return;
  const done = () => {
    btnEl.textContent = "✅";
    setTimeout(() => { btnEl.textContent = "📋"; }, 1000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      _copyFallback(text);
      done();
    });
  } else {
    _copyFallback(text);
    done();
  }
}

function _copyFallback(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}


/* ═══════════════════════════════════════════════════════════
   Admin Panel — DB 관리 모드
   ═══════════════════════════════════════════════════════════ */

let _adminMode = false;
let _adminData = { jobs: [], total: 0, page: 1, per_page: 50, total_pages: 1 };
let _adminSort = "created_at";
let _adminOrder = "desc";
let _adminSelected = new Set();
let _adminExpanded = new Set();
let _adminEditCtx = null; // { type: 'job'|'step', id }

function toggleAdminMode() {
  _adminMode = !_adminMode;
  const btn = document.getElementById("btn-admin-toggle");
  const cards = document.getElementById("job-cards");
  const panel = document.getElementById("admin-panel");
  if (_adminMode) {
    btn.classList.add("admin-active");
    cards.classList.add("hidden");
    panel.classList.remove("hidden");
    _adminInitChannelFilter();
    adminLoad();
  } else {
    btn.classList.remove("admin-active");
    cards.classList.remove("hidden");
    panel.classList.add("hidden");
  }
}

function _adminInitChannelFilter() {
  const sel = document.getElementById("admin-channel-filter");
  if (sel.options.length > 1) return;
  fetch("/api/channels").then(r => r.json()).then(chs => {
    chs.forEach(ch => {
      const opt = document.createElement("option");
      opt.value = ch.id;
      opt.textContent = `${ch.id} ${ch.name}`;
      sel.appendChild(opt);
    });
  });
}

async function adminLoad() {
  const q = document.getElementById("admin-search").value.trim();
  const status = document.getElementById("admin-status-filter").value;
  const channel = document.getElementById("admin-channel-filter").value;
  const dateFrom = document.getElementById("admin-date-from").value;
  const dateTo = document.getElementById("admin-date-to").value;

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  if (channel) params.set("channel_id", channel);
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  params.set("page", _adminData.page);
  params.set("per_page", _adminData.per_page);
  params.set("sort", _adminSort);
  params.set("order", _adminOrder);

  const res = await fetch("/api/admin/jobs?" + params.toString());
  _adminData = await res.json();
  _adminSelected.clear();
  _adminExpanded.clear();
  _adminRenderTable();
  _adminRenderPagination();
  _adminUpdateBulkBtn();
}

function adminSort(col) {
  if (_adminSort === col) {
    _adminOrder = _adminOrder === "desc" ? "asc" : "desc";
  } else {
    _adminSort = col;
    _adminOrder = "desc";
  }
  _adminData.page = 1;
  adminLoad();
}

function _adminRenderTable() {
  const tbody = document.getElementById("admin-tbody");
  if (!_adminData.jobs.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-gray-500 py-8">데이터 없음</td></tr>';
    document.getElementById("admin-check-all").checked = false;
    return;
  }
  let html = "";
  for (const j of _adminData.jobs) {
    const checked = _adminSelected.has(j.id) ? "checked" : "";
    const expanded = _adminExpanded.has(j.id);
    const topicShort = (j.topic || "").length > 40 ? j.topic.substring(0, 40) + "…" : (j.topic || "");
    const created = (j.created_at || "").replace("T", " ").substring(0, 16);
    const updated = (j.updated_at || "").replace("T", " ").substring(0, 16);
    html += `<tr class="${expanded ? 'admin-row-expanded' : ''}" data-jid="${j.id}">
      <td><input type="checkbox" ${checked} onchange="adminToggleOne('${j.id}', this.checked)"></td>
      <td class="font-mono text-gray-400 cursor-pointer" onclick="adminToggleExpand('${j.id}')">${j.id}</td>
      <td>${j.channel_id || ""}</td>
      <td class="max-w-[200px] truncate cursor-pointer" onclick="adminToggleExpand('${j.id}')" title="${(j.topic||'').replace(/"/g,'&quot;')}">${topicShort}</td>
      <td><span class="admin-status admin-status-${j.status || 'pending'}">${j.status || "pending"}</span></td>
      <td class="text-gray-500">${created}</td>
      <td class="text-gray-500">${updated}</td>
      <td>
        <button onclick="adminEditJob('${j.id}')" class="admin-btn" style="padding:2px 6px;">수정</button>
        <button onclick="adminDeleteOne('${j.id}')" class="admin-btn admin-btn-danger" style="padding:2px 6px;">삭제</button>
      </td>
    </tr>`;
    if (expanded) {
      html += `<tr class="admin-expand-row" data-expand="${j.id}"><td colspan="8"><div class="admin-expand-inner" id="admin-expand-${j.id}"><span class="text-gray-500 text-xs">로딩...</span></div></td></tr>`;
    }
  }
  tbody.innerHTML = html;
  document.getElementById("admin-check-all").checked = false;

  // 확장된 행 로드
  for (const jid of _adminExpanded) {
    _adminLoadExpand(jid);
  }
}

async function _adminLoadExpand(jobId) {
  const el = document.getElementById("admin-expand-" + jobId);
  if (!el) return;
  const res = await fetch("/api/admin/jobs/" + jobId);
  const job = await res.json();

  let html = '<div class="grid grid-cols-2 gap-3 mb-3">';
  // script_json
  html += '<div><div class="flex items-center gap-2 mb-1"><span class="text-xs text-gray-400 font-semibold">script_json</span>';
  html += `<button onclick="_adminCopyField(this, 'script_json', '${jobId}')" class="admin-btn" style="padding:1px 5px;font-size:10px;">복사</button></div>`;
  const sj = _adminPrettyJson(job.script_json);
  html += `<pre>${_adminEsc(sj)}</pre></div>`;
  // meta_json
  html += '<div><div class="flex items-center gap-2 mb-1"><span class="text-xs text-gray-400 font-semibold">meta_json</span>';
  html += `<button onclick="_adminCopyField(this, 'meta_json', '${jobId}')" class="admin-btn" style="padding:1px 5px;font-size:10px;">복사</button></div>`;
  const mj = _adminPrettyJson(job.meta_json);
  html += `<pre>${_adminEsc(mj)}</pre></div>`;
  html += '</div>';
  // output_path
  if (job.output_path) {
    html += `<div class="text-xs text-gray-500 mb-2">output_path: <span class="text-gray-300 font-mono">${_adminEsc(job.output_path)}</span></div>`;
  }
  // steps
  if (job.steps && job.steps.length) {
    html += '<div class="text-xs text-gray-400 font-semibold mb-1">Job Steps</div>';
    html += '<table class="admin-sub-table"><thead><tr><th>ID</th><th>Step</th><th>Order</th><th>Status</th><th>Error</th><th>시작</th><th>완료</th><th>작업</th></tr></thead><tbody>';
    for (const s of job.steps) {
      const err = (s.error_msg || "").length > 60 ? s.error_msg.substring(0, 60) + "…" : (s.error_msg || "—");
      html += `<tr>
        <td class="font-mono text-gray-500">${s.id}</td>
        <td>${s.step_name}</td>
        <td>${s.step_order}</td>
        <td><span class="admin-status admin-status-${s.status || 'pending'}">${s.status || "pending"}</span></td>
        <td class="max-w-[200px] truncate text-red-400" title="${_adminEsc(s.error_msg || '')}">${_adminEsc(err)}</td>
        <td class="text-gray-500">${(s.started_at || "—").replace("T"," ").substring(0,16)}</td>
        <td class="text-gray-500">${(s.completed_at || "—").replace("T"," ").substring(0,16)}</td>
        <td>
          <button onclick="adminEditStep(${s.id},'${jobId}')" class="admin-btn" style="padding:1px 5px;font-size:10px;">수정</button>
          <button onclick="adminDeleteStep(${s.id},'${jobId}')" class="admin-btn admin-btn-danger" style="padding:1px 5px;font-size:10px;">삭제</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  el.innerHTML = html;
}

function _adminPrettyJson(str) {
  if (!str) return "(없음)";
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

function _adminEsc(s) {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function _adminCopyField(btn, field, jobId) {
  const job = _adminData.jobs.find(j => j.id === jobId);
  const text = job ? (job[field] || "") : "";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text);
  } else {
    _copyFallback(text);
  }
  const orig = btn.textContent;
  btn.textContent = "OK";
  setTimeout(() => btn.textContent = orig, 800);
}

function adminToggleExpand(jobId) {
  if (_adminExpanded.has(jobId)) {
    _adminExpanded.delete(jobId);
  } else {
    _adminExpanded.add(jobId);
  }
  _adminRenderTable();
}

function adminToggleAll(checked) {
  _adminSelected.clear();
  if (checked) {
    _adminData.jobs.forEach(j => _adminSelected.add(j.id));
  }
  _adminRenderTable();
  _adminUpdateBulkBtn();
}

function adminToggleOne(jobId, checked) {
  if (checked) _adminSelected.add(jobId);
  else _adminSelected.delete(jobId);
  _adminUpdateBulkBtn();
}

function _adminUpdateBulkBtn() {
  const btn = document.getElementById("admin-bulk-delete-btn");
  const cnt = document.getElementById("admin-sel-count");
  cnt.textContent = _adminSelected.size;
  if (_adminSelected.size > 0) btn.classList.remove("hidden");
  else btn.classList.add("hidden");
}

async function adminBulkDelete() {
  if (!_adminSelected.size) return;
  if (!confirm(`${_adminSelected.size}개 작업을 삭제합니다. 복구 불가합니다.`)) return;
  await fetch("/api/admin/jobs", {
    method: "DELETE",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ job_ids: [..._adminSelected] })
  });
  adminLoad();
}

async function adminDeleteOne(jobId) {
  if (!confirm(`작업 ${jobId}를 삭제합니다.`)) return;
  await fetch("/api/admin/jobs", {
    method: "DELETE",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ job_ids: [jobId] })
  });
  adminLoad();
}

// 페이지네이션
function _adminRenderPagination() {
  const d = _adminData;
  document.getElementById("admin-page-info").textContent = `총 ${d.total}건 · ${d.page}/${d.total_pages} 페이지`;
  document.getElementById("admin-prev-btn").disabled = d.page <= 1;
  document.getElementById("admin-next-btn").disabled = d.page >= d.total_pages;
  const nums = document.getElementById("admin-page-nums");
  let html = "";
  const start = Math.max(1, d.page - 2);
  const end = Math.min(d.total_pages, d.page + 2);
  for (let i = start; i <= end; i++) {
    html += `<button onclick="adminGoPage(${i})" class="admin-btn${i===d.page?' !bg-indigo-700 !text-white':''}" style="padding:2px 8px;">${i}</button>`;
  }
  nums.innerHTML = html;
}

function adminPage(dir) {
  if (dir === "prev" && _adminData.page > 1) _adminData.page--;
  else if (dir === "next" && _adminData.page < _adminData.total_pages) _adminData.page++;
  adminLoad();
}
function adminGoPage(p) { _adminData.page = p; adminLoad(); }

// 수정 모달 — Job
async function adminEditJob(jobId) {
  const res = await fetch("/api/admin/jobs/" + jobId);
  const job = await res.json();
  _adminEditCtx = { type: "job", id: jobId };

  const statuses = ["pending","running","waiting_slides","queued","completed","failed","deleted"];
  let html = "";
  html += _adminField("topic", "주제", job.topic || "", "text");
  html += _adminField("category", "카테고리", job.category || "", "text");
  html += `<div><label class="block text-xs text-gray-400 mb-1">status</label>
    <select id="admin-edit-status" class="admin-input w-full">${statuses.map(s=>`<option value="${s}"${s===job.status?' selected':''}>${s}</option>`).join("")}</select></div>`;
  html += _adminField("channel_id", "채널 ID", job.channel_id || "", "text");
  html += _adminField("output_path", "output_path", job.output_path || "", "text");
  html += _adminJsonField("script_json", "script_json", job.script_json);
  html += _adminJsonField("meta_json", "meta_json", job.meta_json);

  document.getElementById("admin-edit-title").textContent = `수정: ${jobId}`;
  document.getElementById("admin-edit-body").innerHTML = html;
  document.getElementById("admin-edit-modal").classList.remove("hidden");
}

function _adminField(name, label, value, type) {
  return `<div><label class="block text-xs text-gray-400 mb-1">${label}</label>
    <input id="admin-edit-${name}" type="${type}" value="${_adminEsc(value)}" class="admin-input w-full"></div>`;
}

function _adminJsonField(name, label, value) {
  const pretty = _adminPrettyJson(value);
  return `<div><label class="block text-xs text-gray-400 mb-1">${label}</label>
    <textarea id="admin-edit-${name}" class="admin-input w-full font-mono" rows="8" style="resize:vertical;">${_adminEsc(pretty === "(없음)" ? "" : pretty)}</textarea>
    <div id="admin-edit-${name}-err" class="text-xs text-red-400 mt-1 hidden"></div></div>`;
}

async function adminEditSave() {
  if (!_adminEditCtx) return;
  if (_adminEditCtx.type === "job") {
    const body = {};
    ["topic","category","channel_id","output_path"].forEach(f => {
      body[f] = document.getElementById("admin-edit-" + f).value;
    });
    body.status = document.getElementById("admin-edit-status").value;
    // JSON 필드
    for (const jf of ["script_json", "meta_json"]) {
      const val = document.getElementById("admin-edit-" + jf).value.trim();
      const errEl = document.getElementById("admin-edit-" + jf + "-err");
      errEl.classList.add("hidden");
      if (val) {
        try { JSON.parse(val); } catch (e) {
          errEl.textContent = "JSON 형식 오류: " + e.message;
          errEl.classList.remove("hidden");
          return;
        }
      }
      body[jf] = val || null;
    }
    const res = await fetch("/api/admin/jobs/" + _adminEditCtx.id, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    });
    if (!res.ok) { alert("저장 실패: " + (await res.text())); return; }
  } else if (_adminEditCtx.type === "step") {
    const body = {};
    body.status = document.getElementById("admin-edit-status").value;
    body.error_msg = document.getElementById("admin-edit-error_msg").value;
    const odVal = document.getElementById("admin-edit-output_data").value.trim();
    body.output_data = odVal || null;
    const res = await fetch("/api/admin/steps/" + _adminEditCtx.id, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    });
    if (!res.ok) { alert("저장 실패: " + (await res.text())); return; }
  }
  closeModal("admin-edit-modal");
  adminLoad();
}

// 수정 모달 — Step
async function adminEditStep(stepId, jobId) {
  const res = await fetch("/api/admin/jobs/" + jobId);
  const job = await res.json();
  const step = (job.steps || []).find(s => s.id === stepId);
  if (!step) return;
  _adminEditCtx = { type: "step", id: stepId, jobId };

  const statuses = ["pending","running","completed","failed","skipped"];
  let html = "";
  html += `<div><label class="block text-xs text-gray-400 mb-1">step: ${step.step_name} (order: ${step.step_order})</label></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">status</label>
    <select id="admin-edit-status" class="admin-input w-full">${statuses.map(s=>`<option value="${s}"${s===step.status?' selected':''}>${s}</option>`).join("")}</select></div>`;
  html += _adminField("error_msg", "error_msg", step.error_msg || "", "text");
  html += `<div><label class="block text-xs text-gray-400 mb-1">output_data</label>
    <textarea id="admin-edit-output_data" class="admin-input w-full font-mono" rows="4" style="resize:vertical;">${_adminEsc(step.output_data || "")}</textarea></div>`;

  document.getElementById("admin-edit-title").textContent = `Step 수정: #${stepId}`;
  document.getElementById("admin-edit-body").innerHTML = html;
  document.getElementById("admin-edit-modal").classList.remove("hidden");
}

async function adminDeleteStep(stepId, jobId) {
  if (!confirm(`Step #${stepId}를 삭제합니다.`)) return;
  await fetch("/api/admin/steps/" + stepId, { method: "DELETE" });
  _adminLoadExpand(jobId);
}
