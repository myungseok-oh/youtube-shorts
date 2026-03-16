/* ─── YouTube Shorts Dashboard JS ─── */

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
  if (status === "queued" || status === "completed") return 3;
  if (status === "running" && script) {
    // Phase B — check if slides step is done
    if (stepStatus["slides"] === "completed" || stepStatus["tts"] === "running" || stepStatus["tts"] === "completed" ||
        stepStatus["render"] === "running" || stepStatus["render"] === "completed") return 3;
    return 2;
  }
  if (status === "failed") {
    const failedStep = steps.find(s => s.status === "failed");
    const fn = failedStep ? failedStep.step_name : "";
    if (["synopsis", "visual_plan", "script"].includes(fn)) return 1;
    if (["slides", "tts"].includes(fn)) return 2;
    return 3;
  }
  return 1;
}

function renderWizardNav(step, scriptData, stepsData) {
  const { status, script, uploaded_backgrounds, image_prompts } = scriptData;
  const labels = ["대본 작성", "이미지 + 음성", "영상 제작"];
  const icons = ["📝", "🖼️", "🎬"];

  // determine "done" state for each step
  const hasScript = !!script;
  const slides = script?.slides || [];
  const _npc = (image_prompts || []).filter(p => (typeof p === "object" ? p.en : p)).length;
  const bgCount = _npc > 0 ? _npc : slides.filter(s => s.bg_type !== "closing").length;
  const uploadedCount = Object.keys(uploaded_backgrounds || {}).length;
  const stepStatuses = {};
  for (const s of (stepsData.steps || [])) stepStatuses[s.step_name] = s.status || "pending";
  const renderDone = stepStatuses["render"] === "completed";

  const isDone = [
    hasScript, // step 1 done
    hasScript && uploadedCount >= bgCount && bgCount > 0, // step 2 done
    renderDone || status === "completed", // step 3 done
  ];

  let html = '<div class="wizard-nav">';
  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      html += `<div class="wizard-step-arrow ${isDone[i - 1] ? 'done' : ''}">→</div>`;
    }
    const cls = (i + 1 === step) ? "active" : (isDone[i] ? "done" : "");
    html += `
      <div class="wizard-step-item ${cls}" onclick="navigateWizard(${i + 1})">
        <div class="wizard-step-num">${i + 1}</div>
        <div class="wizard-step-label">${icons[i]} ${labels[i]}</div>
      </div>`;
  }
  html += '</div>';
  return html;
}

function navigateWizard(step) {
  if (step < 1 || step > 3) return;
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

  // 나레이션 대본
  let narrationView = `<div class="script-panel hidden" id="script-narration-view">`;
  let currentSlide = 0;
  sentences.forEach((sen, i) => {
    if (sen.slide !== currentSlide) {
      currentSlide = sen.slide;
      narrationView += `<div class="text-xs text-orange-400 font-bold mt-2 mb-1 ${i > 0 ? 'pt-2 border-t border-gray-800' : ''}">슬라이드 ${currentSlide}</div>`;
    }
    narrationView += `<div class="text-sm text-gray-300 py-0.5">
      <input type="text" class="narration-edit-input" data-sen-idx="${i}" data-sen-slide="${sen.slide}"
             value="${esc(sen.text)}" />
    </div>`;
  });
  narrationView += `<div class="mt-3 flex gap-2">
    <button onclick="saveNarrationScript('${jobId}')" id="btn-save-narration"
            class="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 rounded text-xs font-medium transition">저장</button>
    <span id="narration-save-msg" class="text-xs text-green-400 self-center hidden">저장 완료</span>
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
            <button onclick="event.stopPropagation(); copyOnePrompt(this, \`${esc(copyText)}\`)" class="copy-icon-btn text-gray-600 hover:text-white flex-shrink-0" style="font-size:11px;padding:1px 3px;">&#x1F4CB;</button>
          </div>
        </div>
      </div>`;
    }).join("");
    const _videoCount = imgPrompts.filter(p => typeof p === "object" && p.media === "video").length;
    const _videoLabel = _videoCount > 0 ? ` <span class="text-purple-400 font-normal">🎥 ${_videoCount}video</span>` : "";
    imgPromptsHtml = `<details class="mb-2" open>
      <summary class="flex items-center justify-between text-xs font-semibold text-gray-400 cursor-pointer mb-1">
        <span>이미지 프롬프트 <span class="text-orange-400 font-normal">${(_slideLayout === "center" || _slideLayout === "top" || _slideLayout === "bottom") ? "📐 1080×960" : "📐 1080×1920"}</span>${_videoLabel}</span>
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
  const jobCh = channelsCache.find(c => c.jobs?.some(j => j.id === jobId));
  let chCfg = {};
  try { chCfg = JSON.parse(jobCh?.config || "{}"); } catch {}
  const chTtsEngine = chCfg.tts_engine || "edge-tts";
  const chTtsVoice = chCfg.tts_voice || "ko-KR-SunHiNeural";
  const chTtsRate = parseInt((chCfg.tts_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  const chGoogleVoice = chCfg.google_voice || "ko-KR-Wavenet-A";
  const chGoogleRate = parseInt((chCfg.google_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  const chSovitsText = chCfg.sovits_ref_text || "";
  const narrationMode = has_narration ? "upload" : "tts";

  const ttsStep = steps.find(s => s.step_name === "tts");
  const ttsError = (ttsStep && ttsStep.status === "failed") ? ttsStep.error_msg : "";

  const rightCol = `
    <div class="wizard-col" id="tab-narration">
      <div class="wizard-col-header">음성 / 나레이션</div>
      ${ttsError ? `<div class="text-xs text-red-400 bg-red-900/20 rounded p-2 mb-3">TTS 실패: ${esc(ttsError)}</div>` : ''}
      <div class="flex gap-2 mb-3">
        <button onclick="switchNarrationMode('tts')" id="btn-mode-tts"
                class="px-3 py-1.5 rounded text-xs font-medium transition ${narrationMode === 'tts' ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}">
          TTS 생성
        </button>
        <button onclick="switchNarrationMode('upload')" id="btn-mode-upload"
                class="px-3 py-1.5 rounded text-xs font-medium transition ${narrationMode === 'upload' ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}">
          음성 업로드
        </button>
      </div>
      <div id="narration-tts" class="${narrationMode === 'tts' ? '' : 'hidden'}">
        <div class="mb-3">
          <label class="text-xs text-gray-500 mb-1 block">TTS 엔진</label>
          <select id="tts-engine-select" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs"
                  onchange="toggleNarrationEngine()">
            <option value="edge-tts" ${chTtsEngine === 'edge-tts' ? 'selected' : ''}>Edge TTS</option>
            <option value="google-cloud" ${chTtsEngine === 'google-cloud' ? 'selected' : ''}>Google Cloud TTS</option>
            <option value="gpt-sovits" ${chTtsEngine === 'gpt-sovits' ? 'selected' : ''}>GPT-SoVITS</option>
          </select>
        </div>
        <div id="narration-edge-section" class="${chTtsEngine === 'edge-tts' ? '' : 'hidden'}">
          <div class="flex gap-2 items-center">
            <select id="tts-voice-select" class="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs">
              <option value="ko-KR-SunHiNeural" ${chTtsVoice === 'ko-KR-SunHiNeural' ? 'selected' : ''}>선히 (여성)</option>
              <option value="ko-KR-InJoonNeural" ${chTtsVoice === 'ko-KR-InJoonNeural' ? 'selected' : ''}>인준 (남성)</option>
              <option value="ko-KR-HyunsuNeural" ${chTtsVoice === 'ko-KR-HyunsuNeural' ? 'selected' : ''}>현수 (남성)</option>
              <option value="ko-KR-HyunsuMultilingualNeural" ${chTtsVoice === 'ko-KR-HyunsuMultilingualNeural' ? 'selected' : ''}>현수 멀티링구얼 (남성)</option>
            </select>
            <button onclick="previewVoice()" id="btn-preview-voice"
                    class="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition whitespace-nowrap">미리듣기</button>
          </div>
          <div class="flex items-center gap-2 mt-2">
            <span class="text-xs text-gray-500 w-8">속도</span>
            <input type="range" id="tts-rate" min="-30" max="50" value="${chTtsRate}" step="10"
                   class="flex-1 h-1 accent-orange-500" oninput="updateRateLabel()">
            <span id="tts-rate-label" class="text-xs text-gray-400 w-10 text-right">${chTtsRate}%</span>
          </div>
        </div>
        <div id="narration-google-section" class="${chTtsEngine === 'google-cloud' ? '' : 'hidden'}">
          <div class="flex gap-2 items-center">
            <select id="google-voice-select" class="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs">
              <option value="ko-KR-Wavenet-A" ${chGoogleVoice === 'ko-KR-Wavenet-A' ? 'selected' : ''}>Wavenet A (여성)</option>
              <option value="ko-KR-Wavenet-B" ${chGoogleVoice === 'ko-KR-Wavenet-B' ? 'selected' : ''}>Wavenet B (여성)</option>
              <option value="ko-KR-Wavenet-C" ${chGoogleVoice === 'ko-KR-Wavenet-C' ? 'selected' : ''}>Wavenet C (남성)</option>
              <option value="ko-KR-Wavenet-D" ${chGoogleVoice === 'ko-KR-Wavenet-D' ? 'selected' : ''}>Wavenet D (남성)</option>
              <option value="ko-KR-Neural2-A" ${chGoogleVoice === 'ko-KR-Neural2-A' ? 'selected' : ''}>Neural2 A (여성)</option>
              <option value="ko-KR-Neural2-B" ${chGoogleVoice === 'ko-KR-Neural2-B' ? 'selected' : ''}>Neural2 B (여성)</option>
              <option value="ko-KR-Neural2-C" ${chGoogleVoice === 'ko-KR-Neural2-C' ? 'selected' : ''}>Neural2 C (남성)</option>
            </select>
            <button onclick="previewVoice()" id="btn-preview-google-popup"
                    class="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition whitespace-nowrap">미리듣기</button>
          </div>
          <div class="flex items-center gap-2 mt-2">
            <span class="text-xs text-gray-500 w-8">속도</span>
            <input type="range" id="google-rate" min="-30" max="50" value="${chGoogleRate}" step="10"
                   class="flex-1 h-1 accent-orange-500" oninput="updateGoogleRateLabel()">
            <span id="google-rate-label" class="text-xs text-gray-400 w-10 text-right">${chGoogleRate}%</span>
          </div>
        </div>
        <div id="narration-sovits-section" class="${chTtsEngine === 'gpt-sovits' ? '' : 'hidden'}">
          <div class="mb-2">
            <label class="text-xs text-gray-500 mb-1 block">참조 음성</label>
            <div class="flex gap-2 items-center">
              <select id="sovits-ref-select" class="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs">
              </select>
              <button onclick="previewSovitsNarration()" id="btn-preview-sovits"
                      class="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition whitespace-nowrap">미리듣기</button>
            </div>
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">참조 텍스트 (선택)</label>
            <input type="text" id="sovits-ref-text" value="${esc(chSovitsText)}"
                   class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs"
                   placeholder="참조 음성의 텍스트 내용">
          </div>
          <div id="sovits-status-narration" class="text-xs mt-2"></div>
        </div>
        <audio id="voice-preview-popup" class="hidden mt-2"></audio>
      </div>
      <div id="narration-upload" class="${narrationMode === 'upload' ? '' : 'hidden'}">
        <div class="flex gap-2 items-center">
          <button onclick="document.getElementById('narration-file').click()"
                  class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition">
            ${has_narration ? '다시 업로드' : '파일 선택'}
          </button>
          <input type="file" accept="audio/*" class="hidden" id="narration-file"
                 onchange="uploadNarration('${jobId}', this)">
          <span id="narration-status" class="text-xs ${has_narration ? 'text-green-400' : 'text-gray-500'}">
            ${has_narration ? '업로드됨' : '음성 파일을 선택하세요'}
          </span>
        </div>
        ${has_narration ? `
        <div class="flex items-center gap-2 mt-2">
          <audio id="narration-preview" controls src="/api/jobs/${jobId}/narration" class="h-8 flex-1"></audio>
          <button onclick="deleteNarration('${jobId}')" class="text-xs text-gray-500 hover:text-red-400 transition">삭제</button>
        </div>` : ''}
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

function renderWizardStep3(jobId, scriptData, stepsData) {
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
    const isRunning = status === "running";
    rightBtn = `<div class="flex gap-2">
      <a href="/composer/${jobId}" target="_blank"
        class="px-4 py-2 bg-blue-700 hover:bg-blue-600 rounded-lg text-sm font-medium transition inline-block">
        영상 편집
      </a>
      <button id="btn-resume-job" onclick="resumeJob('${jobId}')"
        class="px-4 py-2 ${isRunning ? 'bg-gray-600 opacity-50 cursor-not-allowed' : uploadedCount >= bgCount ? 'bg-orange-600 hover:bg-orange-500' : 'bg-gray-700 hover:bg-gray-600'} rounded-lg text-sm font-medium transition"
        ${isRunning ? 'disabled' : ''}>
        ${isRunning ? '영상 제작 중...' : '영상 제작 →'}
      </button>
    </div>`;
  } else if (step === 3) {
    const renderDone = stepStatus["render"] === "completed" || status === "completed";
    if (renderDone) {
      rightBtn = `
        <div class="flex gap-2">
          <button onclick="resetToWaiting('${jobId}')" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition">재작업</button>
          <a href="/api/jobs/${jobId}/video" download class="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition inline-block">다운로드</a>
          <button onclick="manualUpload('${jobId}')" id="btn-manual-upload"
                  class="px-3 py-2 bg-red-700 hover:bg-red-600 rounded-lg text-xs font-medium transition">YouTube 업로드</button>
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

  // 파이프라인 단계 시각화
  let pipelineHtml = "";
  STEP_ORDER.forEach((name, idx) => {
    if (idx > 0) {
      const prevSt = stepStatus[STEP_ORDER[idx - 1]];
      let arrowClass = "step-arrow";
      if (prevSt === "completed" || prevSt === "skipped") arrowClass += " done";
      if (stepStatus[name] === "running") arrowClass += " active";
      pipelineHtml += `<div class="${arrowClass}">&#8594;</div>`;
    }
    const st = stepStatus[name] || "pending";
    pipelineHtml += `
      <div class="step-node step-${st}">
        <div class="step-dot">${STEP_ICONS[name]}</div>
        <div class="step-label">${STEP_LABELS[name]}</div>
      </div>`;
  });

  // Wizard body
  let bodyHtml = "";
  if (_wizardStep === 1) bodyHtml = renderWizardStep1(jobId, scriptData, stepsData);
  else if (_wizardStep === 2) bodyHtml = renderWizardStep2(jobId, scriptData, stepsData);
  else if (_wizardStep === 3) bodyHtml = renderWizardStep3(jobId, scriptData, stepsData);

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
    <div class="pipeline-steps" id="pipeline-steps-live">${pipelineHtml}</div>
    ${wizardNav}
    <div class="wizard-body">
      ${bodyHtml}
    </div>
    ${wizardFooter}
  `;

  // GPT-SoVITS 참조 음성 목록 로드
  _loadSovitsRefSelect();
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

async function manualUpload(jobId) {
  const btn = document.getElementById("btn-manual-upload");
  const statusEl = document.getElementById(`upload-status-${jobId}`);
  if (!confirm("YouTube에 업로드하시겠습니까?")) return;

  btn.disabled = true;
  btn.textContent = "업로드 중...";
  statusEl.innerHTML = `<span class="text-yellow-400">업로드 진행 중...</span>`;

  try {
    const res = await fetch(`/api/jobs/${jobId}/youtube-upload`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      throw new Error(err.detail || "업로드 실패");
    }
    const data = await res.json();
    statusEl.innerHTML = `<span class="text-green-400">업로드 완료! ID: ${data.video_id || ""}</span>`;
    btn.textContent = "업로드 완료";
  } catch (e) {
    statusEl.innerHTML = `<span class="text-red-400">실패: ${e.message}</span>`;
    btn.textContent = "YouTube 업로드";
    btn.disabled = false;
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
    }
    _updateVeoStatus(statusEl);
  } catch (e) {
    _veoInProgress.delete(bgIdx);
    if (slotWrap) slotWrap.classList.remove("veo-converting");
    alert(`영상화 요청 실패: ${e.message}`);
    btn.innerHTML = origText;
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
  btn.disabled = false;
}

function copyOnePrompt(btn, text) {
  navigator.clipboard.writeText(text.replace(/\\n/g, "\n")).then(() => {
    btn.innerHTML = "&#x2705;";
    setTimeout(() => { btn.innerHTML = "&#x1F4CB;"; }, 1500);
  });
}

function copyImagePrompts(btn) {
  const el = document.getElementById("image-prompts-box");
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
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

  edgeSection.classList.add("hidden");
  googleSection.classList.add("hidden");
  sovitsSection.classList.add("hidden");

  if (engine === "google-cloud") {
    googleSection.classList.remove("hidden");
  } else if (engine === "gpt-sovits") {
    sovitsSection.classList.remove("hidden");
    _loadSovitsRefSelect();
  } else {
    edgeSection.classList.remove("hidden");
  }
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

// ─── Channel Settings Tabs ───

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
    // 프롬프트 탭은 flex column으로 표시 (textarea가 남은 공간 채우도록)
    tab.style.display = (tabName === "prompt") ? "flex" : "block";
  }
  const btn = document.querySelector(`.cs-tab-btn[data-cs-tab="${tabName}"]`);
  if (btn) {
    btn.classList.add("text-orange-400", "border-b-2", "border-orange-400");
    btn.classList.remove("text-gray-500", "hover:text-gray-300");
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

// ─── Channel TTS Settings ───


function toggleAutoBgSource() {
  const mode = document.getElementById("cs-production-mode").value;
  const section = document.getElementById("auto-bg-source-section");
  if (mode === "auto") {
    section.classList.remove("hidden");
  } else {
    section.classList.add("hidden");
  }
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

  edgeSection.classList.add("hidden");
  googleSection.classList.add("hidden");
  sovitsSection.classList.add("hidden");

  if (engine === "google-cloud") {
    googleSection.classList.remove("hidden");
  } else if (engine === "gpt-sovits") {
    sovitsSection.classList.remove("hidden");
    checkSovitsStatus();
  } else {
    edgeSection.classList.remove("hidden");
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
    const ly = window._slideLayout || "full";
    sizeHint.textContent = (ly === "center" || ly === "top" || ly === "bottom")
      ? "📐 1080×960 (1:1 정사각형)"
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

async function saveNarrationScript(jobId) {
  const inputs = document.querySelectorAll(".narration-edit-input");
  if (!inputs.length) return;
  const sentences = Array.from(inputs).map(el => ({
    text: el.value,
    slide: parseInt(el.dataset.senSlide || "0", 10),
  }));
  const btn = document.getElementById("btn-save-narration");
  const msg = document.getElementById("narration-save-msg");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/jobs/${jobId}/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentences }),
    });
    if (res.ok) {
      if (msg) { msg.classList.remove("hidden"); setTimeout(() => msg.classList.add("hidden"), 2000); }
    } else {
      const err = await res.json();
      alert(err.detail || "저장 실패");
    }
  } catch (e) {
    alert("저장 요청 실패");
  } finally {
    if (btn) btn.disabled = false;
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
  const msg = document.getElementById("slide-save-msg");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/jobs/${jobId}/slides`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slides }),
    });
    if (res.ok) {
      if (msg) { msg.classList.remove("hidden"); setTimeout(() => msg.classList.add("hidden"), 2000); }
    } else {
      const err = await res.json();
      alert(err.detail || "저장 실패");
    }
  } catch (e) {
    alert("저장 요청 실패");
  } finally {
    if (btn) btn.disabled = false;
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
  try {
    const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    if (res.ok) {
      await refreshJobDetail(jobId);
      loadAll();
    } else {
      const err = await res.json();
      alert(err.detail || "재시도 실패");
    }
  } catch (e) {
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
  if (btn) {
    btn.textContent = "영상 제작 중...";
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
  }

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

  try {
    const res = await fetch(`/api/jobs/${jobId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      _wizardStep = 3; // 영상 제작 시작 → step 3으로 이동
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
    const fetchOpts = { method: "POST" };
    if (customRequest) {
      fetchOpts.headers = {"Content-Type": "application/json"};
      fetchOpts.body = JSON.stringify({request: customRequest});
    }
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
  _settingsChannelId = channelId;
  console.log("openChannelSettings called:", channelId, "cache:", channelsCache.length);
  const ch = channelsCache.find(c => c.id === channelId);
  if (!ch) { console.error("Channel not found:", channelId); return; }

  document.getElementById("cs-name").value = ch.name || "";
  document.getElementById("cs-handle").value = ch.handle || "";
  document.getElementById("cs-desc").value = ch.description || "";
  document.getElementById("cs-topics").value = ch.default_topics || "";
  document.getElementById("cs-instructions").value = ch.instructions || "";

  let cfg = {};
  try { cfg = JSON.parse(ch.config || "{}"); } catch {}

  document.getElementById("cs-image-prompt-style").value = cfg.image_prompt_style || "";
  document.getElementById("cs-image-scene-references").value = cfg.image_scene_references || "";
  document.getElementById("cs-script-rules").value = cfg.script_rules || "";
  document.getElementById("cs-roundup-rules").value = cfg.roundup_rules || "";
  document.getElementById("cs-image-style").value = cfg.image_style || "mixed";
  document.getElementById("cs-format").value = cfg.format || "single";
  document.getElementById("cs-bg-media-type").value = cfg.bg_media_type || "auto";
  document.getElementById("cs-first-slide-single-bg").checked = !!cfg.first_slide_single_bg;
  document.getElementById("cs-slide-layout").value = cfg.slide_layout || "full";

  document.getElementById("cs-bg-display-mode").value = cfg.bg_display_mode || "zone";
  toggleBgDisplayMode();
  document.getElementById("cs-zone-ratio").value = cfg.slide_zone_ratio || "";
  document.getElementById("cs-text-bg").value = cfg.slide_text_bg != null ? cfg.slide_text_bg : 4;
  document.getElementById("cs-text-bg-label").textContent = cfg.slide_text_bg != null ? cfg.slide_text_bg : 4;
  document.getElementById("cs-sub-text-size").value = cfg.sub_text_size || 0;
  document.getElementById("cs-sub-text-size-label").textContent = cfg.sub_text_size || 0;
  document.getElementById("cs-production-mode").value = cfg.production_mode || "manual";
  document.getElementById("cs-auto-bg-source").value = cfg.auto_bg_source || "sd_image";
  document.getElementById("cs-gemini-api-key").value = cfg.gemini_api_key || "";
  document.getElementById("cs-use-subagent").checked = !!cfg.use_subagent;
  toggleAutoBgSource();
  document.getElementById("cs-yt-client-id").value = cfg.youtube_client_id || "";
  document.getElementById("cs-yt-client-secret").value = cfg.youtube_client_secret || "";
  document.getElementById("cs-yt-refresh-token").value = cfg.youtube_refresh_token || "";
  document.getElementById("cs-yt-privacy").value = cfg.youtube_privacy || "private";
  document.getElementById("cs-yt-upload-mode").value = cfg.youtube_upload_mode || "manual";

  // TTS 설정
  document.getElementById("cs-tts-engine").value = cfg.tts_engine || "edge-tts";
  document.getElementById("cs-tts-voice").value = cfg.tts_voice || "ko-KR-SunHiNeural";
  const rateVal = parseInt((cfg.tts_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  document.getElementById("cs-tts-rate").value = rateVal;
  document.getElementById("cs-tts-rate-label").textContent = rateVal + "%";
  // Google Cloud TTS
  document.getElementById("cs-google-voice").value = cfg.google_voice || "ko-KR-Wavenet-A";
  const googleRate = parseInt((cfg.google_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  document.getElementById("cs-google-rate").value = googleRate;
  document.getElementById("cs-google-rate-label").textContent = googleRate + "%";
  toggleTtsEngine();
  document.getElementById("cs-sovits-ref-text").value = cfg.sovits_ref_text || "";
  const sovitsSpeed = cfg.sovits_speed || 1.0;
  document.getElementById("cs-sovits-speed").value = sovitsSpeed;
  document.getElementById("cs-sovits-speed-label").textContent = sovitsSpeed + "x";
  toggleTtsEngine();
  loadRefVoices(cfg.sovits_ref_voice || "");

  // BGM / 음향 설정
  const nDelay = cfg.narration_delay ?? 2;
  document.getElementById("cs-narration-delay").value = nDelay;
  document.getElementById("cs-narration-delay-label").textContent = nDelay;
  document.getElementById("cs-bgm-enabled").checked = !!cfg.bgm_enabled;
  document.getElementById("cs-bgm-volume").value = cfg.bgm_volume || 10;
  document.getElementById("cs-bgm-volume-label").textContent = cfg.bgm_volume || 10;
  loadBgmFiles(cfg);

  // 효과음 설정
  document.getElementById("cs-sfx-enabled").checked = !!cfg.sfx_enabled;
  document.getElementById("cs-sfx-volume").value = cfg.sfx_volume || 15;
  document.getElementById("cs-sfx-volume-label").textContent = cfg.sfx_volume || 15;
  const xfDur = cfg.crossfade_duration ?? 0.5;
  document.getElementById("cs-crossfade-duration").value = xfDur;
  document.getElementById("cs-crossfade-label").textContent = xfDur;
  loadTransitionOptions(cfg.crossfade_transition || "fade");
  loadSfxFiles(cfg);

  // 채널 고정 배경 이미지
  _showChannelBg("intro", !!ch.has_intro_bg, channelId);
  _showChannelBg("outro", !!ch.has_outro_bg, channelId);
  document.getElementById("cs-intro-duration").value = cfg.intro_duration || 3;
  document.getElementById("cs-outro-duration").value = cfg.outro_duration || 3;
  document.getElementById("cs-intro-narration").value = cfg.intro_narration || "";
  document.getElementById("cs-outro-narration").value = cfg.outro_narration || "";

  // 트렌드 소스 설정 (UI 제거됨, hidden input 호환용)
  document.getElementById("cs-trend-google").value = "";
  document.getElementById("cs-trend-youtube").value = "";
  document.getElementById("cs-youtube-api-key").value = "";

  // 복사 버튼: 원본 채널(cloned_from이 없는)에서만 표시
  const cloneBtn = document.getElementById("btn-clone-channel");
  if (ch.cloned_from) {
    cloneBtn.classList.add("hidden");
  } else {
    cloneBtn.classList.remove("hidden");
  }

  // 스케줄 설정
  document.getElementById("cs-schedule-enabled").checked = !!cfg.schedule_enabled;
  _renderScheduleTimes(cfg.schedule_times || []);
  const defaultDays = ["mon", "tue", "wed", "thu", "fri"];
  const scheduleDays = cfg.schedule_days || defaultDays;
  document.querySelectorAll(".cs-schedule-day").forEach(cb => {
    cb.checked = scheduleDays.includes(cb.value);
  });

  switchSettingsTab("basic");
  document.getElementById("channel-settings-modal").dataset.channelId = channelId;
  document.getElementById("channel-settings-modal").classList.remove("hidden");
}

async function saveChannelSettings() {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;

  const ch = channelsCache.find(c => c.id === channelId);
  let cfg = {};
  try { cfg = JSON.parse(ch?.config || "{}"); } catch {}

  // 헬퍼: UI 값이 있으면 덮어쓰기, 비어있으면 기존 값 유지
  const _setIfPresent = (key, val) => { if (val) cfg[key] = val; };

  // 영상 제작 방식 저장
  _setIfPresent("image_prompt_style", document.getElementById("cs-image-prompt-style").value.trim());

  // 프롬프트 지침 저장 (비어있으면 키 삭제 → 기본값 사용)
  const _setOrDelete = (key, val) => { if (val) cfg[key] = val; else delete cfg[key]; };
  _setOrDelete("image_scene_references", document.getElementById("cs-image-scene-references").value.trim());
  _setOrDelete("script_rules", document.getElementById("cs-script-rules").value.trim());
  _setOrDelete("roundup_rules", document.getElementById("cs-roundup-rules").value.trim());

  cfg.image_style = document.getElementById("cs-image-style").value;
  cfg.format = document.getElementById("cs-format").value;
  cfg.bg_media_type = document.getElementById("cs-bg-media-type").value;
  cfg.first_slide_single_bg = document.getElementById("cs-first-slide-single-bg").checked;

  cfg.slide_layout = document.getElementById("cs-slide-layout").value;

  cfg.bg_display_mode = document.getElementById("cs-bg-display-mode").value;
  cfg.slide_zone_ratio = document.getElementById("cs-zone-ratio").value.trim();
  cfg.slide_text_bg = parseInt(document.getElementById("cs-text-bg").value) || 4;
  cfg.sub_text_size = parseInt(document.getElementById("cs-sub-text-size").value) || 0;
  cfg.production_mode = document.getElementById("cs-production-mode").value;
  cfg.auto_bg_source = document.getElementById("cs-auto-bg-source").value;
  _setIfPresent("gemini_api_key", document.getElementById("cs-gemini-api-key").value.trim());
  cfg.use_subagent = document.getElementById("cs-use-subagent").checked;

  // TTS 설정 저장
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

  // BGM / 음향 설정 저장
  cfg.narration_delay = parseFloat(document.getElementById("cs-narration-delay").value) || 0;
  cfg.bgm_enabled = document.getElementById("cs-bgm-enabled").checked;
  cfg.bgm_file = document.getElementById("cs-bgm-file").value;
  cfg.bgm_volume = parseInt(document.getElementById("cs-bgm-volume").value) || 10;

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

  await fetch(`/api/channels/${channelId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("cs-name").value.trim(),
      handle: document.getElementById("cs-handle").value.trim(),
      description: document.getElementById("cs-desc").value.trim(),
      default_topics: document.getElementById("cs-topics").value,
      instructions: document.getElementById("cs-instructions").value,
      config: JSON.stringify(cfg),
    }),
  });

  closeModal("channel-settings-modal");
  loadAll();
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

  _set("image_prompt_style", document.getElementById("cs-image-prompt-style").value.trim());

  // 프롬프트 지침 저장
  const _setOrDel = (key, val) => { if (val) cfg[key] = val; else delete cfg[key]; };
  _setOrDel("image_scene_references", document.getElementById("cs-image-scene-references").value.trim());
  _setOrDel("script_rules", document.getElementById("cs-script-rules").value.trim());
  _setOrDel("roundup_rules", document.getElementById("cs-roundup-rules").value.trim());

  cfg.image_style = document.getElementById("cs-image-style").value;
  cfg.format = document.getElementById("cs-format").value;
  cfg.bg_media_type = document.getElementById("cs-bg-media-type").value;
  cfg.first_slide_single_bg = document.getElementById("cs-first-slide-single-bg").checked;

  cfg.slide_layout = document.getElementById("cs-slide-layout").value;

  cfg.bg_display_mode = document.getElementById("cs-bg-display-mode").value;
  cfg.slide_zone_ratio = document.getElementById("cs-zone-ratio").value.trim();
  cfg.slide_text_bg = parseInt(document.getElementById("cs-text-bg").value) || 4;
  cfg.sub_text_size = parseInt(document.getElementById("cs-sub-text-size").value) || 0;
  cfg.production_mode = document.getElementById("cs-production-mode").value;
  cfg.auto_bg_source = document.getElementById("cs-auto-bg-source").value;
  _set("gemini_api_key", document.getElementById("cs-gemini-api-key").value.trim());
  cfg.use_subagent = document.getElementById("cs-use-subagent").checked;

  cfg.trend_sources = [];
  cfg.youtube_api_key = "";

  _set("youtube_client_id", document.getElementById("cs-yt-client-id").value.trim());
  _set("youtube_client_secret", document.getElementById("cs-yt-client-secret").value.trim());
  _set("youtube_refresh_token", document.getElementById("cs-yt-refresh-token").value.trim());
  cfg.youtube_privacy = document.getElementById("cs-yt-privacy").value;

  await fetch(`/api/channels/${channelId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("cs-name").value.trim(),
      handle: document.getElementById("cs-handle").value.trim(),
      description: document.getElementById("cs-desc").value.trim(),
      default_topics: document.getElementById("cs-topics").value,
      instructions: document.getElementById("cs-instructions").value,
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
  const imagePromptStyle = cfg.image_prompt_style || "";
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

  prompt += `

[슬라이드 텍스트 규칙]

메인 텍스트: 12~20자, 강한 키워드 중심, 강조는 <span class="hl">키워드</span>
보조 텍스트: 20~30자, 핵심 설명

bg_type: ${imageStyle === 'photo' ? '모든 슬라이드 "photo" 고정 (실사 사진 스타일)' : imageStyle === 'infographic' ? '모든 슬라이드 "graph" 고정 (인포그래픽/일러스트/차트 스타일)' : imageStyle === 'anime' ? '모든 슬라이드 "photo" 고정 (애니메이션/디지털 일러스트 스타일)' : '슬라이드별 배경 유형 선택 (photo=실사, graph=인포그래픽, broll=B-roll, logo=로고)'}
슬라이드 레이아웃: ${slideLayout}${imagePromptStyle ? `

[이미지 프롬프트 스타일]
${imagePromptStyle}` : ''}

[나레이션 규칙]

1. narration 항목 1개 = image_prompts 항목 1개 (반드시 같은 개수, 1:1 대응)
2. 전체 나레이션 읽기 시간이 ${targetDuration}초에 맞도록 조절
3. 채널 지침에 맞는 자연스러운 톤
4. narration text는 TTS가 읽는 텍스트이므로 HTML 태그 금지, 순수 텍스트만
5. ★ 나레이션 1항목의 글자 수는 대응하는 배경 표시 시간에 맞출 것:
   - image 배경(~5초): 20~25자
   - video 배경(~6초): 25~30자
   - 12~17자처럼 짧으면 배경과 갭이 생김. 반드시 글자 수 지킬 것

[출력 형식]

반드시 아래 JSON 형식으로만 출력한다.
설명문은 절대 출력하지 않는다.

{
  "topic": "",
  "youtube_title": "",
  "category": "",
  "slides": [
    {
      "bg_type": "${imageStyle === 'photo' || imageStyle === 'anime' ? 'photo' : imageStyle === 'infographic' ? 'graph' : ''}",
      "main_text": "핵심 <span class=\\"hl\\">강조</span> 텍스트",
      "sub_text": ""
    }
  ],
  "narration": [
    { "slide": 1, "text": "첫 번째 배경에 맞는 나레이션 (~5초 분량)" },
    { "slide": 1, "text": "두 번째 배경에 맞는 나레이션 (~6초 분량)" }
  ],
  "image_prompts": [
    { "slide": 1, "ko": "한국어 장면 묘사", "en": "English prompt 30-60 words", "media": "image", "motion": "" },
    { "slide": 1, "ko": "같은 슬라이드 두번째 배경", "en": "Different angle prompt", "media": "video", "motion": "gentle pan left to right" }
  ]
}

★ narration 개수 = image_prompts 개수 (같은 slide 번호끼리 순서대로 1:1 대응)
★ closing 슬라이드는 생성하지 않는다 (시스템이 자동 추가)

[필드 설명]
- category: 주제를 대표하는 태그 (예: "경제","정치","코인","테크","사회","교양","과학" 등)
- image_prompts.ko: 배경 이미지 한국어 프롬프트 (30~50자, 구체적 장면 묘사)
- image_prompts.en: 영어 프롬프트 (30~60 words, subject+setting+lighting+camera+style 포함)
- image_prompts.media: "image" 또는 "video" — 정적 이미지(~5초) 또는 영상(~6초)
- image_prompts.motion: video일 때 카메라/피사체 움직임, image일 때 빈 문자열

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
  const raw = document.getElementById("manual-json-input").value.trim();
  if (!raw) { alert("JSON을 붙여넣어 주세요."); return; }
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

    // slides
    if (Array.isArray(data.slides) && data.slides.length > 0) {
      _manualSlides = data.slides.map((s, i) => {
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

    // narration
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

  // closing 슬라이드 자동 추가
  const slides = _manualSlides.map(s => ({
    category: _manualCategory,
    main: s.main,
    sub: s.sub,
    bg_type: s.bg_type,
    image_prompt_ko: s.image_prompt_ko || "",
    image_prompt_en: s.image_prompt_en || "",
  }));
  slides.push({ category: "", main: "", sub: "", bg_type: "closing", image_prompt_ko: "", image_prompt_en: "" });

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
    closeModal("manual-modal");
    await loadAll();
    openJobDetail(data.id);
  } catch (e) {
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
