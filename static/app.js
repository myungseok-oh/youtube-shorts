/* ─── YouTube Shorts Dashboard JS ─── */

const POLL_INTERVAL = 4000;
let pollTimer = null;
let channelsCache = [];
let currentDetailJobId = null;
let _completedCollapsed = true;
let _selectMode = false;
let _selectedJobs = new Set();

const STEP_ICONS = {
  news_search: "\uD83D\uDD0D",
  script:      "\uD83D\uDCDD",
  slides:      "\uD83D\uDDBC\uFE0F",
  tts:         "\uD83D\uDD0A",
  render:      "\uD83C\uDFAC",
  qa:          "\u2705",
  upload:      "\uD83D\uDCE4",
};

const STEP_LABELS = {
  news_search: "검색",
  script:      "대본",
  slides:      "슬라이드",
  tts:         "TTS",
  render:      "영상합성",
  qa:          "QA",
  upload:      "업로드",
};

const STEP_ORDER = ["news_search", "script", "slides", "tts", "render", "qa", "upload"];

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

  // 모달 바깥 클릭으로 닫기
  document.getElementById("job-detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal("job-detail-modal");
  });
});

async function loadAll() {
  const res = await fetch("/api/dashboard");
  channelsCache = await res.json();
  renderChannels(channelsCache);
  renderMain(channelsCache);

  // 상세 팝업이 열려있으면 자동 갱신 (스킵 조건: waiting_slides, 영상 재생 중)
  if (currentDetailJobId && !document.getElementById("job-detail-modal").classList.contains("hidden")) {
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

function renderChannels(channels) {
  const list = document.getElementById("channel-list");
  list.innerHTML = channels.map(ch => {
    const hasRequest = (ch.default_topics || "").trim().length > 0;
    let statusText = "";
    if (ch.running_jobs > 0) statusText = `${ch.running_jobs}개 진행중`;
    else if (ch.queued_jobs > 0) statusText = `${ch.queued_jobs}개 큐 대기`;
    else if (ch.waiting_jobs > 0) statusText = `${ch.waiting_jobs}개 이미지 대기`;
    else if (ch.failed_jobs > 0) statusText = `${ch.failed_jobs}개 실패`;
    else if (ch.total_jobs > 0) statusText = `${ch.total_jobs}개 작업`;
    else if (!hasRequest) statusText = "요청 미설정";

    return `
      <div class="channel-item" draggable="true" data-channel-id="${ch.id}" onclick="openChannelSettings('${ch.id}')">
        <div class="flex items-center gap-2">
          <span class="drag-handle text-gray-600 cursor-grab text-xs select-none" title="드래그하여 순서 변경">⠿</span>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm">${esc(ch.name)}</div>
            <div class="text-xs text-gray-500 mt-1">${statusText}</div>
          </div>
        </div>
        <div class="flex justify-end mt-2 gap-2">
          <button onclick="event.stopPropagation(); deleteChannelJobs('${ch.id}')"
                  class="px-2 py-1 text-gray-600 hover:text-red-400 rounded text-xs transition" title="작업 삭제">초기화</button>
          <button id="run-btn-${ch.id}" onclick="event.stopPropagation(); runChannel('${ch.id}', this)"
                  class="px-3 py-1 bg-orange-600 hover:bg-orange-500 rounded text-xs font-medium transition">실행</button>
        </div>
      </div>
    `;
  }).join("");
  // 실행 중인 채널 버튼 로딩 상태 복원
  for (const cid of _runningChannels) {
    _setRunBtnLoading(cid, true);
  }
  // 드래그앤드롭 설정
  _initChannelDragDrop();
}

// ─── Main: 주제별 카드 ───

function renderMain(channels) {
  const container = document.getElementById("job-cards");

  // 모든 채널의 job을 모아서 표시
  const allJobs = [];
  for (const ch of channels) {
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
  if (job.status === "waiting_slides") activeStep = "이미지 업로드 필요";
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

  return `
    <div class="job-card ${isChecked ? 'ring-1 ring-orange-500' : ''}" onclick="${showCheck ? `toggleJobSelect('${job.id}')` : `openJobDetail('${job.id}')`}">
      <div class="flex items-start justify-between mb-2">
        ${showCheck ? `<input type="checkbox" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation(); toggleJobSelect('${job.id}')" class="mt-1 mr-2 accent-orange-500 flex-shrink-0">` : ''}
        <div class="font-medium text-sm leading-tight flex-1 mr-2"><span class="text-gray-500 text-xs mr-1">${jobNum}</span>${esc(job.topic)}</div>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="mb-1"><span class="channel-tag" style="background:${_channelColor(job.channelName)}">${esc(job.channelName || '')}</span></div>
      ${activeStep ? `<div class="text-xs text-gray-500 mb-2">${activeStep}</div>` : ""}
      <div class="w-full bg-gray-800 rounded-full h-1.5">
        <div class="h-1.5 rounded-full transition-all duration-500 ${job.status === 'failed' ? 'bg-red-500' : job.status === 'completed' ? 'bg-green-500' : job.status === 'waiting_slides' ? 'bg-yellow-500' : job.status === 'queued' ? 'bg-blue-500' : 'bg-orange-500'}"
             style="width: ${pct}%"></div>
      </div>
      <div class="flex items-center justify-between mt-2">
        <div class="text-xs text-gray-600">${formatTime(job.created_at)}</div>
        ${job.status !== "running"
          ? `<button onclick="event.stopPropagation(); deleteJob('${job.id}')" class="text-xs text-gray-600 hover:text-red-400 transition">삭제</button>`
          : ""}
      </div>
    </div>
  `;
}

// ─── Job Detail Popup ───

async function openJobDetail(jobId) {
  currentDetailJobId = jobId;
  _lastDetailStatus = null;
  _lastDetailHadScript = false;
  document.getElementById("job-detail-modal").classList.remove("hidden");
  document.getElementById("job-detail-content").innerHTML = `
    <div class="text-center py-8 text-gray-500">로딩중...</div>`;
  await refreshJobDetail(jobId);
}

let _lastDetailStatus = null;
let _lastDetailHadScript = false;

async function refreshJobDetail(jobId) {
  // 현재 활성 탭 기억
  const activePanel = document.querySelector('.tab-panel:not(.hidden)');
  const activePanelId = activePanel ? activePanel.id : null;

  try {
    const [scriptRes, stepsRes] = await Promise.all([
      fetch(`/api/jobs/${jobId}/script`),
      fetch(`/api/jobs/${jobId}/steps`),
    ]);
    const scriptData = await scriptRes.json();
    const stepsData = await stepsRes.json();

    const status = scriptData.status;
    const hasScript = !!scriptData.script;
    const isRunning = status === "running";
    const wasRunning = _lastDetailStatus === "running";
    const scriptChanged = hasScript !== _lastDetailHadScript;

    // running → running 동일 상태: 부분 갱신 (깜박임 방지)
    // 단, script 유무가 바뀌면 전체 리렌더
    if (isRunning && wasRunning && !scriptChanged && document.getElementById("pipeline-steps-live")) {
      _patchRunningDetail(scriptData, stepsData);
      _lastDetailStatus = status;
      return;
    }

    _lastDetailStatus = status;
    _lastDetailHadScript = hasScript;
    renderJobDetail(scriptData, stepsData);

    // 탭 복원
    if (activePanelId) {
      const panel = document.getElementById(activePanelId);
      if (panel) {
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        panel.classList.remove('hidden');
        const tabs = document.querySelectorAll('.tab-btn');
        const tabMap = {'tab-script': 0, 'tab-images': 1, 'tab-narration': 2};
        const idx = tabMap[activePanelId];
        if (idx !== undefined && tabs[idx]) tabs[idx].classList.add('active');
      }
    }
  } catch (e) {
    console.error("refreshJobDetail error:", e);
    document.getElementById("job-detail-content").innerHTML = `
      <div class="text-red-400 text-center py-8">데이터 로드 실패: ${e.message}</div>`;
  }
}

function _patchRunningDetail(scriptData, stepsData) {
  const steps = stepsData.steps || [];
  const { status, script, job_id } = scriptData;

  const stepStatus = {};
  for (const s of steps) stepStatus[s.step_name] = s.status || "pending";

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
        <div class="flex flex-col items-center py-4 gap-3 border-t border-gray-800 mt-3">
          <div class="text-sm font-semibold text-gray-300 w-full">영상 미리보기</div>
          <video class="video-preview" controls>
            <source src="/api/jobs/${job_id}/video" type="video/mp4">
          </video>
        </div>`;
    }
  }
}

function renderJobDetail(scriptData, stepsData) {
  const { job_id, topic, status, script, uploaded_backgrounds, has_narration, has_thumbnail, image_prompts, genspark_prompts, auto_bg_source, slide_layout } = scriptData;
  const jobId = job_id;
  window._bgSource = auto_bg_source || "sd_image";
  window._slideLayout = slide_layout || "full";
  window._jobStatus = status;
  const steps = stepsData.steps || [];

  // 단계별 상태 맵
  const stepStatus = {};
  for (const s of steps) {
    stepStatus[s.step_name] = s.status || "pending";
  }
  // waiting_slides 상태면 slides를 waiting으로 표시
  if (status === "waiting_slides") {
    stepStatus["slides"] = "waiting";
  }
  // 누락된 단계 보정: 가장 늦은 완료 단계 이전은 모두 completed
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

  // 본문 영역 (상태별)
  let bodyHtml = "";

  if (status === "running" && !script) {
    // Phase A 진행중 (대본 작성중)
    const runningStepA = steps.find(s => s.status === "running");
    const labelA = runningStepA ? (STEP_LABELS[runningStepA.step_name] || runningStepA.step_name) : "대본";
    bodyHtml = `<div id="running-status-msg" class="text-center py-8 text-gray-400">
      <span class="inline-block animate-pulse">⏳</span> ${esc(labelA)} 진행 중...
    </div>`;

  } else if (status === "waiting_slides" && script) {
    // 이미지 대기 — 핵심 UI
    bodyHtml = renderWaitingSlidesBody(job_id, topic, script, uploaded_backgrounds || {}, has_narration, image_prompts, genspark_prompts, steps);

  } else if (status === "running" && script) {
    // Phase B 진행중 — waiting_slides와 동일한 탭 UI + 진행 상태 배너
    bodyHtml = renderWaitingSlidesBody(job_id, topic, script, uploaded_backgrounds || {}, has_narration, image_prompts, genspark_prompts, steps);
    const runningStep = steps.find(s => s.status === "running");
    const runningLabel = runningStep ? (STEP_LABELS[runningStep.step_name] || runningStep.step_name) : "영상";
    const renderDone = stepStatus["render"] === "completed";
    const videoPreview = renderDone ? `
      <div class="flex flex-col items-center py-4 gap-3 border-t border-gray-800 mt-3">
        <div class="text-sm font-semibold text-gray-300 w-full">영상 미리보기</div>
        <video class="video-preview" controls>
          <source src="/api/jobs/${job_id}/video" type="video/mp4">
        </video>
      </div>` : "";
    bodyHtml = `
      <div id="running-status-msg" class="text-center py-3 text-gray-400 text-sm mb-3">
        <span class="inline-block animate-pulse">⏳</span> ${esc(runningLabel)} 진행 중...
      </div>
      ${bodyHtml}
      <div id="running-video-area">${videoPreview}</div>`;

  } else if (status === "completed") {
    bodyHtml = renderCompletedBody(job_id, topic, script, image_prompts, genspark_prompts, uploaded_backgrounds || {}, has_narration, steps, has_thumbnail);

  } else if (status === "failed") {
    const failedStep = steps.find(s => s.status === "failed");
    const failedStepName = failedStep ? failedStep.step_name : "";
    const errMsg = failedStep ? failedStep.error_msg : "알 수 없는 오류";
    // TTS 이후 단계 실패 → 재시도 가능 (이미지 대기로 되돌림)
    const canRetry = script && ["tts", "render", "upload"].includes(failedStepName);
    bodyHtml = `
      <div class="text-center py-6">
        <div class="text-red-400 text-lg mb-2">제작 실패</div>
        <div class="text-sm text-gray-500 mb-4">${esc(errMsg || "")}</div>
        <div class="flex justify-center gap-3">
          ${canRetry ? `<button onclick="retryJob('${jobId}')" class="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition">재시도</button>` : ''}
          <button onclick="resetToWaiting('${jobId}')" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition">이미지 대기로 되돌리기</button>
          <button onclick="deleteJob('${jobId}')" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-400 transition">삭제</button>
        </div>
      </div>`;

  } else {
    bodyHtml = `<div class="text-center py-8 text-gray-500">대기중</div>`;
  }

  document.getElementById("job-detail-content").innerHTML = `
    <div class="flex items-start justify-between mb-3">
      <div>
        <h3 class="text-lg font-bold">${esc(topic)}</h3>
        <span class="status-badge ${statusClass} mt-1 inline-block">${statusText}</span>
      </div>
      <button onclick="closeModal('job-detail-modal')" class="text-gray-500 hover:text-white text-lg transition">&times;</button>
    </div>
    <div class="pipeline-steps" id="pipeline-steps-live">${pipelineHtml}</div>
    ${bodyHtml}
  `;
}

function renderWaitingSlidesBody(jobId, topic, script, uploadedBgs, hasNarration, image_prompts, genspark_prompts, steps) {
  const slides = script.slides || [];
  const slideCount = slides.length;
  const bgCount = slideCount > 0 ? slideCount - 1 : 0;
  const uploadedCount = Object.keys(uploadedBgs).length;

  // ─── 탭 헤더 ───
  const tabsHtml = `
    <div class="tab-bar">
      <button class="tab-btn active" onclick="switchTab('tab-script', this)">대본</button>
      <button class="tab-btn" onclick="switchTab('tab-images', this)">배경 이미지 <span class="tab-badge">${uploadedCount}/${bgCount}</span></button>
      <button class="tab-btn" onclick="switchTab('tab-narration', this)">나레이션</button>
    </div>`;

  // ─── 탭 1: 대본 ───
  // 슬라이드 보기
  let slideView = `<div class="script-panel" id="script-slide-view">`;
  slides.forEach((s, i) => {
    const isClosing = i === slides.length - 1;
    slideView += `
      <div class="slide-item">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs font-bold text-orange-400">${i + 1}</span>
          <span class="text-xs text-gray-500">${esc(s.category || "")}</span>
        </div>
        <div class="text-sm text-gray-200">${s.main || ""}</div>
        ${s.sub ? `<div class="text-xs text-gray-500 mt-1">${s.sub}</div>` : ""}
        ${isClosing ? `<span class="text-xs text-gray-600">(클로징)</span>` : ""}
      </div>`;
  });
  slideView += `</div>`;

  // 나레이션(TTS) 대본 보기 (편집 가능)
  const sentences = script.sentences || [];
  let narrationView = `<div class="script-panel hidden" id="script-narration-view">`;
  let currentSlide = 0;
  sentences.forEach((sen, i) => {
    if (sen.slide !== currentSlide) {
      currentSlide = sen.slide;
      narrationView += `<div class="text-xs text-orange-400 font-bold mt-2 mb-1 ${i > 0 ? 'pt-2 border-t border-gray-800' : ''}">슬라이드 ${currentSlide}</div>`;
    }
    narrationView += `<div class="text-sm text-gray-300 py-0.5">
      <input type="text" class="narration-edit-input" data-sen-idx="${i}"
             value="${esc(sen.text)}" />
    </div>`;
  });
  narrationView += `<div class="mt-3 flex gap-2">
    <button onclick="saveNarrationScript('${jobId}')" id="btn-save-narration"
            class="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 rounded text-xs font-medium transition">저장</button>
    <span id="narration-save-msg" class="text-xs text-green-400 self-center hidden">저장 완료</span>
  </div>`;
  narrationView += `</div>`;

  const tab1 = `
    <div id="tab-script" class="tab-panel">
      <div class="flex gap-2 mb-2">
        <button class="script-view-btn active" onclick="switchScriptView('slide', this)">슬라이드</button>
        <button class="script-view-btn" onclick="switchScriptView('narration', this)">나레이션 대본</button>
      </div>
      <div class="mb-3">${slideView}${narrationView}</div>
    </div>`;

  // 이미지 생성 프롬프트 (배경 이미지 탭에 표시)
  const imgPrompts = image_prompts || [];
  const hasImgPrompts = imgPrompts.length > 0;
  let imgPromptsHtml = "";
  if (hasImgPrompts) {
    const items = imgPrompts.map((p, i) => {
      const ko = typeof p === "object" ? (p.ko || "") : "";
      const en = typeof p === "object" ? (p.en || "") : String(p);
      return `<div class="text-xs py-1 border-b border-gray-800">
        <span class="text-orange-400 font-bold mr-1">${i+1}.</span>
        ${ko ? `<span class="text-gray-300">${esc(ko)}</span><br>` : ""}
        <span class="text-gray-500">${esc(en)}</span>
      </div>`;
    }).join("");
    imgPromptsHtml = `<details class="mb-3" open>
      <summary class="flex items-center justify-between text-xs font-semibold text-gray-400 cursor-pointer mb-1">
        <span>이미지 생성 프롬프트 <span class="text-orange-400 font-normal">${(_slideLayout === "center" || _slideLayout === "top" || _slideLayout === "bottom") ? "📐 1080×960 (1:1)" : "📐 1080×1920 (9:16)"}</span></span>
        <button onclick="event.stopPropagation(); copyImagePrompts(this)" class="copy-icon-btn" title="복사">&#x1F4CB;</button>
      </summary>
      <div class="bg-gray-900 rounded p-2" id="image-prompts-box">${items}</div>
    </details>`;
  } else {
    imgPromptsHtml = `<div class="mb-3 flex items-center gap-2">
      <span class="text-xs text-gray-500">이미지 프롬프트 미생성</span>
      <button onclick="generateImagePrompts('${jobId}')" id="btn-gen-img-prompts"
              class="px-3 py-1 bg-orange-700 hover:bg-orange-600 rounded text-xs font-medium transition">프롬프트 생성</button>
    </div>`;
  }

  // ─── 탭 2: 배경 이미지 ───
  const bgTypes = (script.slides || []).map(s => s.bg_type || "photo");
  let slotsHtml = `<div class="upload-grid">`;
  for (let i = 1; i <= bgCount; i++) {
    const bgUrl = uploadedBgs[i] || null;
    const hasImage = bgUrl ? "has-image" : "";
    const bgType = bgTypes[i - 1] || "photo";
    const bgTypeLabel = {photo:"📷",broll:"🎬",graph:"📊",logo:"🏢",closing:"✕"}[bgType] || "📷";
    slotsHtml += `
      <div class="upload-slot-wrap" id="slot-wrap-${i}">
        <div class="upload-slot ${hasImage}" onclick="triggerUpload('${jobId}', ${i})" id="slot-${i}" title="슬라이드 ${i} (${bgType})" data-bg-type="${bgType}">
          ${bgUrl ? (bgUrl.includes('.mp4') || bgUrl.includes('.gif') ? `<video src="${bgUrl}" autoplay loop muted playsinline style="width:100%;height:100%;object-fit:cover;"></video>` : `<img src="${bgUrl}" alt="bg_${i}">`) : ""}
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
  slotsHtml += `</div>
    <div id="prompt-edit-area" class="prompt-edit-area hidden">
      <div class="prompt-edit-header">
        <span class="text-xs text-gray-400">슬롯 <span id="prompt-edit-index"></span> 이미지 프롬프트 <span id="prompt-size-hint" class="text-orange-400 ml-2"></span></span>
        <button onclick="closePromptEdit()" class="text-xs text-gray-500 hover:text-white">&times;</button>
      </div>
      <label class="text-xs text-gray-500 mb-1 block">한국어 설명</label>
      <textarea id="prompt-text-ko" rows="2" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-gray-300 resize-y mb-2"
                placeholder="한국어 장면 설명..."></textarea>
      <label class="text-xs text-gray-500 mb-1 block">English Prompt</label>
      <textarea id="prompt-text-en" rows="3" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-gray-300 resize-y"
                placeholder="English image generation prompt..."></textarea>
      <div class="flex gap-2 mt-2">
        <button onclick="saveImagePrompt()" class="prompt-save-btn">저장</button>
        <button onclick="regenerateFromEdit()" class="prompt-save-btn" style="background:rgba(147,51,234,0.2);color:#c084fc;">이미지 생성</button>
      </div>
      <div id="prompt-edit-sd" class="text-xs text-gray-600 mt-1" style="display:none">
        <span class="text-gray-500">변환된 SD 프롬프트:</span> <span id="prompt-edit-sd-text"></span>
      </div>
    </div>`;

  const tab2 = `
    <div id="tab-images" class="tab-panel hidden">
      <div class="btn-group-bar">
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
      ${imgPromptsHtml}
      ${slotsHtml}
    </div>`;

  // ─── 탭 3: 나레이션 ───
  // 채널 TTS 설정 가져오기
  const jobCh = channelsCache.find(c => c.jobs?.some(j => j.id === jobId));
  let chCfg = {};
  try { chCfg = JSON.parse(jobCh?.config || "{}"); } catch {}
  const chTtsEngine = chCfg.tts_engine || "edge-tts";
  const chTtsVoice = chCfg.tts_voice || "ko-KR-SunHiNeural";
  const chTtsRate = parseInt((chCfg.tts_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  const chSovitsRef = chCfg.sovits_ref_voice || "";
  const chSovitsText = chCfg.sovits_ref_text || "";

  const narrationMode = hasNarration ? "upload" : "tts";

  // TTS 실패 에러 메시지 확인
  const ttsStep = (steps || []).find(s => s.step_name === "tts");
  const ttsError = (ttsStep && ttsStep.status === "failed") ? ttsStep.error_msg : "";

  const tab3 = `
    <div id="tab-narration" class="tab-panel hidden">
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
            <option value="gpt-sovits" ${chTtsEngine === 'gpt-sovits' ? 'selected' : ''}>GPT-SoVITS</option>
          </select>
        </div>
        <div id="narration-edge-section" class="${chTtsEngine === 'gpt-sovits' ? 'hidden' : ''}">
          <div class="flex gap-2 items-center">
            <select id="tts-voice-select" class="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs">
              <option value="ko-KR-SunHiNeural" ${chTtsVoice === 'ko-KR-SunHiNeural' ? 'selected' : ''}>선히 (여성)</option>
              <option value="ko-KR-InJoonNeural" ${chTtsVoice === 'ko-KR-InJoonNeural' ? 'selected' : ''}>인준 (남성)</option>
              <option value="ko-KR-HyunsuNeural" ${chTtsVoice === 'ko-KR-HyunsuNeural' ? 'selected' : ''}>현수 (남성)</option>
              <option value="ko-KR-HyunsuMultilingualNeural" ${chTtsVoice === 'ko-KR-HyunsuMultilingualNeural' ? 'selected' : ''}>현수 멀티링구얼 (남성)</option>
              <option value="gtts" ${chTtsVoice === 'gtts' ? 'selected' : ''}>gTTS (구글 기본)</option>
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
            ${hasNarration ? '다시 업로드' : '파일 선택'}
          </button>
          <input type="file" accept="audio/*" class="hidden" id="narration-file"
                 onchange="uploadNarration('${jobId}', this)">
          <span id="narration-status" class="text-xs ${hasNarration ? 'text-green-400' : 'text-gray-500'}">
            ${hasNarration ? '업로드됨' : '음성 파일을 선택하세요 (mp3, wav 등)'}
          </span>
        </div>
        ${hasNarration ? `
        <div class="flex items-center gap-2 mt-2">
          <audio id="narration-preview" controls src="/api/jobs/${jobId}/narration" class="h-8 flex-1"></audio>
          <button onclick="deleteNarration('${jobId}')" class="text-xs text-gray-500 hover:text-red-400 transition">삭제</button>
        </div>` : ''}
      </div>
      <div class="flex items-center justify-between pt-4 border-t border-gray-800 mt-4">
        <div class="flex items-center gap-3">
          <span class="text-xs text-gray-500">${uploadedCount}/${bgCount}장 준비됨</span>
          <button onclick="deleteJob('${jobId}')" class="text-xs text-gray-500 hover:text-red-400 transition">삭제</button>
        </div>
        <button id="btn-resume-job" onclick="resumeJob('${jobId}')"
          class="px-6 py-2 ${window._jobStatus === 'running' ? 'bg-gray-600 opacity-50 cursor-not-allowed' : uploadedCount >= bgCount ? 'bg-orange-600 hover:bg-orange-500' : 'bg-gray-700 hover:bg-gray-600'} rounded-lg text-sm font-medium transition"
          ${window._jobStatus === 'running' ? 'disabled' : ''}>
          ${window._jobStatus === 'running' ? '영상 제작 중...' : '영상 제작 시작'}
        </button>
      </div>
    </div>`;

  return tabsHtml + tab1 + tab2 + tab3;
}

function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tabId).classList.remove('hidden');
  btn.classList.add('active');
  // 나레이션 탭 열릴 때 GPT-SoVITS 참조 음성 목록 로드
  if (tabId === 'tab-narration') {
    const eng = document.getElementById("tts-engine-select");
    if (eng && eng.value === "gpt-sovits") loadNarrationRefVoices();
  }
}

function switchScriptView(mode, btn) {
  const slideView = document.getElementById('script-slide-view');
  const narrationView = document.getElementById('script-narration-view');
  if (!slideView || !narrationView) return;
  document.querySelectorAll('.script-view-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (mode === 'narration') {
    slideView.classList.add('hidden');
    narrationView.classList.remove('hidden');
  } else {
    narrationView.classList.add('hidden');
    slideView.classList.remove('hidden');
  }
}

async function saveNarrationScript(jobId) {
  const inputs = document.querySelectorAll('.narration-edit-input');
  if (!inputs.length) return;
  const btn = document.getElementById('btn-save-narration');
  const msg = document.getElementById('narration-save-msg');
  btn.disabled = true; btn.textContent = '저장 중...';
  msg.classList.add('hidden');

  // 현재 script의 sentences 구조 유지하면서 text만 업데이트
  const detail = await fetch(`/api/jobs/${jobId}/script`).then(r => r.json());
  const sentences = (detail.script && detail.script.sentences) || [];
  inputs.forEach(inp => {
    const idx = parseInt(inp.dataset.senIdx);
    if (idx < sentences.length) sentences[idx].text = inp.value;
  });

  try {
    const res = await fetch(`/api/jobs/${jobId}/script`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentences })
    });
    if (!res.ok) throw new Error(await res.text());
    msg.textContent = '저장 완료';
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 3000);
  } catch (e) {
    msg.textContent = '저장 실패: ' + e.message;
    msg.classList.remove('hidden');
    msg.classList.replace('text-green-400', 'text-red-400');
  } finally {
    btn.disabled = false; btn.textContent = '저장';
  }
}

async function generateThumbnail(jobId) {
  const btn = document.getElementById('btn-gen-thumb');
  const status = document.getElementById(`thumb-status-${jobId}`);
  btn.disabled = true; btn.textContent = '생성 중...';
  status.textContent = '';
  try {
    const res = await fetch(`/api/jobs/${jobId}/generate-thumbnail`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    _lastDetailStatus = null;
    refreshJobDetail(jobId);
  } catch (e) {
    status.textContent = '썸네일 생성 실패: ' + e.message;
    status.className = 'text-xs mt-1 text-red-400';
  } finally {
    btn.disabled = false; btn.textContent = '재생성';
  }
}

async function uploadThumbnail(jobId, file) {
  if (!file) return;
  const status = document.getElementById(`thumb-status-${jobId}`);
  status.textContent = '업로드 중...';
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/jobs/${jobId}/thumbnail`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    _lastDetailStatus = null;
    refreshJobDetail(jobId);
  } catch (e) {
    status.textContent = '업로드 실패: ' + e.message;
    status.className = 'text-xs mt-1 text-red-400';
  }
}

function toggleNarrationEngine() {
  const engine = document.getElementById("tts-engine-select").value;
  const edgeSection = document.getElementById("narration-edge-section");
  const sovitsSection = document.getElementById("narration-sovits-section");
  if (engine === "gpt-sovits") {
    edgeSection?.classList.add("hidden");
    sovitsSection?.classList.remove("hidden");
    loadNarrationRefVoices();
  } else {
    edgeSection?.classList.remove("hidden");
    sovitsSection?.classList.add("hidden");
  }
}

async function loadNarrationRefVoices() {
  const sel = document.getElementById("sovits-ref-select");
  if (!sel) return;
  try {
    const res = await fetch("/api/ref-voices");
    const voices = await res.json();
    // 채널 설정에서 기본 참조 음성 가져오기
    const jobCh = channelsCache.find(c => c.jobs?.some(j => j.id === currentDetailJobId));
    let chCfg = {};
    try { chCfg = JSON.parse(jobCh?.config || "{}"); } catch {}
    const defaultRef = chCfg.sovits_ref_voice || "";

    sel.innerHTML = voices.map(v =>
      `<option value="${esc(v.filename)}" ${v.filename === defaultRef ? 'selected' : ''}>${esc(v.name)}</option>`
    ).join("");
  } catch {}
}

async function previewSovitsNarration() {
  const refSel = document.getElementById("sovits-ref-select");
  const refText = document.getElementById("sovits-ref-text");
  const statusEl = document.getElementById("sovits-status-narration");
  const btn = document.getElementById("btn-preview-sovits");
  if (!refSel?.value) { statusEl.textContent = "참조 음성을 선택하세요"; return; }
  btn.disabled = true; btn.textContent = "생성중...";
  statusEl.textContent = "";
  try {
    const res = await fetch("/api/tts/preview-sovits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref_voice: refSel.value, ref_text: refText?.value || "",
                             text: "안녕하세요, 오늘의 뉴스 브리핑을 시작하겠습니다." }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      statusEl.textContent = errData.detail || "미리듣기 실패 (GPT-SoVITS 서버 확인 필요)";
      return;
    }
    const blob = await res.blob();
    const audio = document.getElementById("voice-preview-popup");
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove("hidden");
    audio.play();
  } catch (e) { statusEl.textContent = "미리듣기 오류"; }
  finally { btn.disabled = false; btn.textContent = "미리듣기"; }
}

function renderCompletedBody(jobId, topic, script, image_prompts, genspark_prompts, uploadedBgs, hasNarration, steps, hasThumbnail) {
  const slides = script ? (script.slides || []) : [];
  const slideCount = slides.length;
  const bgCount = slideCount > 0 ? slideCount - 1 : 0;
  const uploadedCount = Object.keys(uploadedBgs || {}).length;

  // ─── 영상 미리보기 (상단 고정) ───
  const videoHtml = `
    <div class="flex flex-col items-center py-3 gap-3 border-b border-gray-800 mb-3">
      <div class="flex items-center justify-between w-full">
        <div class="text-sm font-semibold text-gray-300">완성 영상</div>
        <div class="flex gap-2">
          <a href="/api/jobs/${jobId}/video" download class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs transition">다운로드</a>
          <button onclick="manualUpload('${jobId}')" id="btn-manual-upload"
                  class="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-xs transition">YouTube 업로드</button>
          <button onclick="resetToWaiting('${jobId}')" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs text-gray-400 transition">재작업</button>
        </div>
      </div>
      <video class="video-preview" controls>
        <source src="/api/jobs/${jobId}/video" type="video/mp4">
      </video>
      <div id="upload-status-${jobId}" class="text-xs"></div>
    </div>`;

  // ─── 썸네일 미리보기 ───
  const thumbTs = Date.now();
  const thumbnailHtml = `
    <div class="border-b border-gray-800 pb-3 mb-3">
      <div class="flex items-center justify-between mb-2">
        <div class="text-sm font-semibold text-gray-300">썸네일</div>
        <div class="flex gap-2">
          <button onclick="generateThumbnail('${jobId}')" id="btn-gen-thumb"
                  class="px-3 py-1 bg-orange-700 hover:bg-orange-600 rounded text-xs transition">${hasThumbnail ? '재생성' : '생성'}</button>
          <label class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs transition cursor-pointer">
            교체 <input type="file" accept="image/*" class="hidden" onchange="uploadThumbnail('${jobId}', this.files[0])">
          </label>
        </div>
      </div>
      ${hasThumbnail
        ? `<img src="/api/jobs/${jobId}/thumbnail?t=${thumbTs}" class="w-full rounded" style="max-height:200px; object-fit:contain;" />`
        : `<div class="text-xs text-gray-500 py-4 text-center">썸네일 미생성 — "생성" 버튼을 클릭하세요</div>`}
      <div id="thumb-status-${jobId}" class="text-xs mt-1"></div>
    </div>`;

  // ─── 탭 헤더 ───
  const tabsHtml = `
    <div class="tab-bar">
      <button class="tab-btn active" onclick="switchTab('tab-script', this)">대본</button>
      <button class="tab-btn" onclick="switchTab('tab-images', this)">배경 이미지 <span class="tab-badge">${uploadedCount}/${bgCount}</span></button>
      <button class="tab-btn" onclick="switchTab('tab-narration', this)">나레이션</button>
    </div>`;

  // ─── 탭 1: 대본 ───
  let slideView = `<div class="script-panel" id="script-slide-view">`;
  slides.forEach((s, i) => {
    const isClosing = i === slides.length - 1;
    slideView += `
      <div class="slide-item">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs font-bold text-orange-400">${i + 1}</span>
          <span class="text-xs text-gray-500">${esc(s.category || "")}</span>
        </div>
        <div class="text-sm text-gray-200">${s.main || ""}</div>
        ${s.sub ? `<div class="text-xs text-gray-500 mt-1">${s.sub}</div>` : ""}
        ${isClosing ? `<span class="text-xs text-gray-600">(클로징)</span>` : ""}
      </div>`;
  });
  slideView += `</div>`;

  const sens = script ? (script.sentences || []) : [];
  let narrView = `<div class="script-panel hidden" id="script-narration-view">`;
  let curSlide = 0;
  sens.forEach((sen, i) => {
    if (sen.slide !== curSlide) {
      curSlide = sen.slide;
      narrView += `<div class="text-xs text-orange-400 font-bold mt-2 mb-1 ${i > 0 ? 'pt-2 border-t border-gray-800' : ''}">슬라이드 ${curSlide}</div>`;
    }
    narrView += `<div class="text-sm text-gray-300 py-0.5">
      <input type="text" class="narration-edit-input" data-sen-idx="${i}"
             value="${esc(sen.text)}" />
    </div>`;
  });
  narrView += `<div class="mt-3 flex gap-2">
    <button onclick="saveNarrationScript('${jobId}')" id="btn-save-narration"
            class="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 rounded text-xs font-medium transition">저장</button>
    <span id="narration-save-msg" class="text-xs text-green-400 self-center hidden">저장 완료</span>
  </div>`;
  narrView += `</div>`;

  const tab1 = `
    <div id="tab-script" class="tab-panel">
      <div class="flex gap-2 mb-2">
        <button class="script-view-btn active" onclick="switchScriptView('slide', this)">슬라이드</button>
        <button class="script-view-btn" onclick="switchScriptView('narration', this)">나레이션 대본</button>
      </div>
      <div class="mb-3">${slideView}${narrView}</div>
    </div>`;

  // ─── 탭 2: 배경 이미지 ───
  const imgPrompts = image_prompts || [];
  let imgPromptsHtml = "";
  if (imgPrompts.length > 0) {
    const items = imgPrompts.map((p, i) => {
      const ko = typeof p === "object" ? (p.ko || "") : "";
      const en = typeof p === "object" ? (p.en || "") : String(p);
      return `<div class="text-xs py-1 border-b border-gray-800">
        <span class="text-orange-400 font-bold mr-1">${i+1}.</span>
        ${ko ? `<span class="text-gray-300">${esc(ko)}</span><br>` : ""}
        <span class="text-gray-500">${esc(en)}</span>
      </div>`;
    }).join("");
    imgPromptsHtml = `<details class="mb-3">
      <summary class="flex items-center justify-between text-xs font-semibold text-gray-400 cursor-pointer mb-1">
        <span>이미지 생성 프롬프트 <span class="text-orange-400 font-normal">${(_slideLayout === "center" || _slideLayout === "top" || _slideLayout === "bottom") ? "📐 1080×960 (1:1)" : "📐 1080×1920 (9:16)"}</span></span>
        <button onclick="event.stopPropagation(); copyImagePrompts(this)" class="copy-icon-btn" title="복사">&#x1F4CB;</button>
      </summary>
      <div class="bg-gray-900 rounded p-2" id="image-prompts-box">${items}</div>
    </details>`;
  }

  const bgTypes2 = (script.slides || []).map(s => s.bg_type || "photo");
  let slotsHtml = `<div class="upload-grid">`;
  for (let i = 1; i <= bgCount; i++) {
    const bgUrl = (uploadedBgs || {})[i] || null;
    const hasImage = bgUrl ? "has-image" : "";
    const bgType = bgTypes2[i - 1] || "photo";
    const bgTypeLabel = {photo:"📷",broll:"🎬",graph:"📊",logo:"🏢",closing:"✕"}[bgType] || "📷";
    slotsHtml += `
      <div class="upload-slot-wrap" id="slot-wrap-${i}">
        <div class="upload-slot ${hasImage}" onclick="triggerUpload('${jobId}', ${i})" id="slot-${i}" title="슬라이드 ${i} (${bgType})" data-bg-type="${bgType}">
          ${bgUrl ? (bgUrl.includes('.mp4') || bgUrl.includes('.gif') ? `<video src="${bgUrl}" autoplay loop muted playsinline style="width:100%;height:100%;object-fit:cover;"></video>` : `<img src="${bgUrl}" alt="bg_${i}">`) : ""}
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
  slotsHtml += `</div>
    <div id="prompt-edit-area" class="prompt-edit-area hidden">
      <div class="prompt-edit-header">
        <span class="text-xs text-gray-400">슬롯 <span id="prompt-edit-index"></span> 이미지 프롬프트 <span id="prompt-size-hint" class="text-orange-400 ml-2"></span></span>
        <button onclick="closePromptEdit()" class="text-xs text-gray-500 hover:text-white">&times;</button>
      </div>
      <label class="text-xs text-gray-500 mb-1 block">한국어 설명</label>
      <textarea id="prompt-text-ko" rows="2" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-gray-300 resize-y mb-2"
                placeholder="한국어 장면 설명..."></textarea>
      <label class="text-xs text-gray-500 mb-1 block">English Prompt</label>
      <textarea id="prompt-text-en" rows="3" class="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-gray-300 resize-y"
                placeholder="English image generation prompt..."></textarea>
      <div class="flex gap-2 mt-2">
        <button onclick="saveImagePrompt()" class="prompt-save-btn">저장</button>
        <button onclick="regenerateFromEdit()" class="prompt-save-btn" style="background:rgba(147,51,234,0.2);color:#c084fc;">이미지 생성</button>
      </div>
    </div>`;

  const tab2 = `
    <div id="tab-images" class="tab-panel hidden">
      <div class="btn-group-bar">
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
      ${imgPromptsHtml}
      ${slotsHtml}
    </div>`;

  // ─── 탭 3: 나레이션 ───
  const jobCh = channelsCache.find(c => c.jobs?.some(j => j.id === jobId));
  let chCfg = {};
  try { chCfg = JSON.parse(jobCh?.config || "{}"); } catch {}
  const chTtsEngine = chCfg.tts_engine || "edge-tts";
  const chTtsVoice = chCfg.tts_voice || "ko-KR-SunHiNeural";
  const chTtsRate = parseInt((chCfg.tts_rate || "+0%").replace("%", "").replace("+", "")) || 0;
  const chSovitsText = chCfg.sovits_ref_text || "";
  const narrationMode = hasNarration ? "upload" : "tts";
  const ttsStep = (steps || []).find(s => s.step_name === "tts");
  const ttsError = (ttsStep && ttsStep.status === "failed") ? ttsStep.error_msg : "";

  const tab3 = `
    <div id="tab-narration" class="tab-panel hidden">
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
            <option value="gpt-sovits" ${chTtsEngine === 'gpt-sovits' ? 'selected' : ''}>GPT-SoVITS</option>
          </select>
        </div>
        <div id="narration-edge-section" class="${chTtsEngine === 'gpt-sovits' ? 'hidden' : ''}">
          <div class="flex gap-2 items-center">
            <select id="tts-voice-select" class="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs">
              <option value="ko-KR-SunHiNeural" ${chTtsVoice === 'ko-KR-SunHiNeural' ? 'selected' : ''}>선히 (여성)</option>
              <option value="ko-KR-InJoonNeural" ${chTtsVoice === 'ko-KR-InJoonNeural' ? 'selected' : ''}>인준 (남성)</option>
              <option value="ko-KR-HyunsuNeural" ${chTtsVoice === 'ko-KR-HyunsuNeural' ? 'selected' : ''}>현수 (남성)</option>
              <option value="ko-KR-HyunsuMultilingualNeural" ${chTtsVoice === 'ko-KR-HyunsuMultilingualNeural' ? 'selected' : ''}>현수 멀티링구얼 (남성)</option>
              <option value="gtts" ${chTtsVoice === 'gtts' ? 'selected' : ''}>gTTS (구글 기본)</option>
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
            ${hasNarration ? '다시 업로드' : '파일 선택'}
          </button>
          <input type="file" accept="audio/*" class="hidden" id="narration-file"
                 onchange="uploadNarration('${jobId}', this)">
          <span id="narration-status" class="text-xs ${hasNarration ? 'text-green-400' : 'text-gray-500'}">
            ${hasNarration ? '업로드됨' : '음성 파일을 선택하세요 (mp3, wav 등)'}
          </span>
        </div>
        ${hasNarration ? `
        <div class="flex items-center gap-2 mt-2">
          <audio id="narration-preview" controls src="/api/jobs/${jobId}/narration" class="h-8 flex-1"></audio>
          <button onclick="deleteNarration('${jobId}')" class="text-xs text-gray-500 hover:text-red-400 transition">삭제</button>
        </div>` : ''}
      </div>
      <div class="flex items-center justify-between pt-4 border-t border-gray-800 mt-4">
        <button onclick="deleteJob('${jobId}')" class="text-xs text-gray-500 hover:text-red-400 transition">작업 삭제</button>
        <button onclick="resetToWaiting('${jobId}')" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition">
          재작업 (이미지 대기로)
        </button>
      </div>
    </div>`;

  return videoHtml + thumbnailHtml + tabsHtml + tab1 + tab2 + tab3;
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

function updateRateLabel() {
  const val = document.getElementById("tts-rate").value;
  const sign = val >= 0 ? "+" : "";
  document.getElementById("tts-rate-label").textContent = `${sign}${val}%`;
}

async function previewVoice() {
  const voice = document.getElementById("tts-voice-select").value;
  const rate = document.getElementById("tts-rate").value;
  const btn = document.getElementById("btn-preview-voice");
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

// ─── Channel TTS Settings ───

function toggleAutoBgSource() {
  const mode = document.getElementById("cs-production-mode").value;
  const section = document.getElementById("auto-bg-source-section");
  if (mode === "auto") {
    section.classList.remove("hidden");
  } else {
    section.classList.add("hidden");
  }
  toggleGeminiSection();
}

function toggleGeminiSection() {
  const source = document.getElementById("cs-auto-bg-source").value;
  const section = document.getElementById("cs-gemini-section");
  if (section) {
    section.style.display = source === "gemini" ? "block" : "none";
  }
}

function toggleTtsEngine() {
  const engine = document.getElementById("cs-tts-engine").value;
  const edgeSection = document.getElementById("cs-tts-edge-section");
  const sovitsSection = document.getElementById("cs-tts-sovits-section");

  if (engine === "gpt-sovits") {
    edgeSection.classList.add("hidden");
    sovitsSection.classList.remove("hidden");
    checkSovitsStatus();
  } else {
    edgeSection.classList.remove("hidden");
    sovitsSection.classList.add("hidden");
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
  const voice = document.getElementById("cs-tts-voice").value;
  const btn = document.getElementById("btn-cs-preview-voice");
  const audio = document.getElementById("cs-voice-preview");

  btn.textContent = "생성중...";
  btn.disabled = true;

  try {
    const rateVal = document.getElementById("cs-tts-rate")?.value || 0;
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

  // 프롬프트 확인
  const promptRes = await fetch(`/api/jobs/${jobId}/sd-prompts`);
  const promptData = await promptRes.json();
  if (!promptData.prompts || promptData.prompts.length === 0) {
    statusEl.innerHTML = `<div class="text-xs text-yellow-400 mb-2">먼저 프롬프트를 생성하세요.</div>`;
    return;
  }

  btn.textContent = "생성중...";
  btn.disabled = true;
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

  // 프롬프트 존재 확인
  const promptRes = await fetch(`/api/jobs/${jobId}/sd-prompts`);
  const promptData = await promptRes.json();
  if (!promptData.prompts || promptData.prompts.length === 0) {
    statusEl.innerHTML = `<div class="text-xs text-yellow-400 mb-2">먼저 [SD 프롬프트 생성] 버튼을 눌러 프롬프트를 생성하세요.</div>`;
    return;
  }

  // ComfyUI 상태 확인
  const sdRes = await fetch("/api/sd/status");
  const sdData = await sdRes.json();
  if (!sdData.available) {
    statusEl.innerHTML = `<div class="text-xs text-red-400 mb-2">ComfyUI 서버가 실행 중이 아닙니다 (${sdData.host}:${sdData.port})</div>`;
    return;
  }

  btn.textContent = "생성중...";
  btn.disabled = true;
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
      if (index - 1 < prompts.length && prompts[index - 1]) {
        const p = prompts[index - 1];
        if (typeof p === "object") {
          if (taKo) taKo.value = p.ko || "";
          if (taEn) taEn.value = p.en || "";
        } else {
          if (taKo) taKo.value = "";
          if (taEn) taEn.value = String(p);
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

  try {
    await fetch(`/api/jobs/${_activePromptJobId}/image-prompts/${_activePromptIndex}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ko: taKo ? taKo.value : "", en: taEn ? taEn.value : "" }),
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

      // 자동 슬라이드 재렌더 + 새로고침
      await fetch(`/api/jobs/${jobId}/rerender-slides`, { method: "POST" });
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

  // 자동 슬라이드 재렌더
  await fetch(`/api/jobs/${jobId}/rerender-slides`, { method: "POST" });
  _lastDetailStatus = null;
  await refreshJobDetail(jobId);
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

// ─── Delete Job ───

async function deleteJob(jobId) {
  if (!confirm("이 작업을 삭제하시겠습니까?")) return;
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
  const request = (ch?.default_topics || "").trim();
  if (!request) {
    alert("요청이 설정되지 않았습니다.\n채널을 클릭해서 요청을 추가하세요.");
    return;
  }

  // 실행 버튼 → 로딩 상태 (loadAll로 DOM이 교체되어도 유지되도록 전역 Set 사용)
  _runningChannels.add(channelId);
  _setRunBtnLoading(channelId, true);

  const prevJobCount = ch?.jobs?.length || 0;

  try {
    const res = await fetch(`/api/channels/${channelId}/run`, { method: "POST" });
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
    btn.textContent = "실행";
    btn.disabled = false;
    btn.classList.remove("opacity-50", "cursor-not-allowed", "animate-pulse-btn");
  }
}

// ─── Polling ───

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadAll, POLL_INTERVAL);
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

async function openChannelSettings(channelId) {
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
  document.getElementById("cs-image-style").value = cfg.image_style || "mixed";
  document.getElementById("cs-format").value = cfg.format || "single";
  document.getElementById("cs-target-duration").value = String(cfg.target_duration || 60);
  document.getElementById("cs-slide-layout").value = cfg.slide_layout || "full";
  document.getElementById("cs-production-mode").value = cfg.production_mode || "manual";
  document.getElementById("cs-auto-bg-source").value = cfg.auto_bg_source || "sd_image";
  document.getElementById("cs-gemini-api-key").value = cfg.gemini_api_key || "";
  toggleAutoBgSource();
  toggleGeminiSection();
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
  document.getElementById("cs-sovits-ref-text").value = cfg.sovits_ref_text || "";
  const sovitsSpeed = cfg.sovits_speed || 1.0;
  document.getElementById("cs-sovits-speed").value = sovitsSpeed;
  document.getElementById("cs-sovits-speed-label").textContent = sovitsSpeed + "x";
  toggleTtsEngine();
  loadRefVoices(cfg.sovits_ref_voice || "");

  // 트렌드 소스 설정
  const trendSources = cfg.trend_sources || [];
  document.getElementById("cs-trend-google").checked = trendSources.includes("google_trends");
  document.getElementById("cs-trend-youtube").checked = trendSources.includes("youtube_trending");
  document.getElementById("cs-youtube-api-key").value = cfg.youtube_api_key || "";
  toggleYtApiKeyRow();
  // 미리보기 결과 초기화
  document.getElementById("trend-preview-result").classList.add("hidden");

  // 복사 버튼: 원본 채널(cloned_from이 없는)에서만 표시
  const cloneBtn = document.getElementById("btn-clone-channel");
  if (ch.cloned_from) {
    cloneBtn.classList.add("hidden");
  } else {
    cloneBtn.classList.remove("hidden");
  }

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
  cfg.image_style = document.getElementById("cs-image-style").value;
  cfg.format = document.getElementById("cs-format").value;
  cfg.target_duration = parseInt(document.getElementById("cs-target-duration").value) || 60;
  cfg.slide_layout = document.getElementById("cs-slide-layout").value;
  cfg.production_mode = document.getElementById("cs-production-mode").value;
  cfg.auto_bg_source = document.getElementById("cs-auto-bg-source").value;
  _setIfPresent("gemini_api_key", document.getElementById("cs-gemini-api-key").value.trim());

  // TTS 설정 저장
  cfg.tts_engine = document.getElementById("cs-tts-engine").value;
  cfg.tts_voice = document.getElementById("cs-tts-voice").value;
  const rateN = parseInt(document.getElementById("cs-tts-rate").value) || 0;
  cfg.tts_rate = (rateN >= 0 ? "+" : "") + rateN + "%";
  cfg.sovits_ref_voice = document.getElementById("cs-sovits-ref-voice").value;
  cfg.sovits_ref_text = document.getElementById("cs-sovits-ref-text").value.trim();
  cfg.sovits_speed = parseFloat(document.getElementById("cs-sovits-speed").value) || 1.0;

  // 트렌드 소스 저장
  const trendSources = [];
  if (document.getElementById("cs-trend-google").checked) trendSources.push("google_trends");
  if (document.getElementById("cs-trend-youtube").checked) trendSources.push("youtube_trending");
  cfg.trend_sources = trendSources;
  _setIfPresent("youtube_api_key", document.getElementById("cs-youtube-api-key").value.trim());

  _setIfPresent("youtube_client_id", document.getElementById("cs-yt-client-id").value.trim());
  _setIfPresent("youtube_client_secret", document.getElementById("cs-yt-client-secret").value.trim());
  _setIfPresent("youtube_refresh_token", document.getElementById("cs-yt-refresh-token").value.trim());
  const ytPrivacy = document.getElementById("cs-yt-privacy").value;
  cfg.youtube_privacy = ytPrivacy;
  cfg.youtube_upload_mode = document.getElementById("cs-yt-upload-mode").value;

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

// ─── Trend Preview ───

function toggleYtApiKeyRow() {
  const row = document.getElementById("cs-yt-apikey-row");
  if (document.getElementById("cs-trend-youtube").checked) {
    row.classList.remove("hidden");
  } else {
    row.classList.add("hidden");
  }
}

// YouTube 체크박스 토글 이벤트 (DOM 로드 후 연결)
document.addEventListener("DOMContentLoaded", () => {
  const cb = document.getElementById("cs-trend-youtube");
  if (cb) cb.addEventListener("change", toggleYtApiKeyRow);
});

async function previewTrends() {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;
  const btn = document.getElementById("btn-preview-trends");
  const resultEl = document.getElementById("trend-preview-result");

  // 먼저 현재 설정을 저장해야 API에서 올바른 소스를 읽음
  // → 대신 저장 없이 직접 소스를 체크해서 쿼리
  const sources = [];
  if (document.getElementById("cs-trend-google").checked) sources.push("google_trends");
  if (document.getElementById("cs-trend-youtube").checked) sources.push("youtube_trending");

  if (sources.length === 0) {
    resultEl.textContent = "트렌드 소스를 선택해주세요.";
    resultEl.classList.remove("hidden");
    return;
  }

  btn.textContent = "수집중...";
  btn.disabled = true;

  try {
    // 설정이 아직 저장 안됐을 수 있으므로 먼저 저장
    await saveChannelSettingsSilent();
    const res = await fetch(`/api/channels/${channelId}/trends`);
    const data = await res.json();

    if (data.formatted) {
      resultEl.textContent = data.formatted;
    } else {
      resultEl.textContent = data.message || "트렌드 데이터 없음";
    }
    resultEl.classList.remove("hidden");
  } catch (e) {
    resultEl.textContent = "수집 실패: " + e.message;
    resultEl.classList.remove("hidden");
  }

  btn.textContent = "현재 트렌드 미리보기";
  btn.disabled = false;
}

async function saveChannelSettingsSilent() {
  const modal = document.getElementById("channel-settings-modal");
  const channelId = modal.dataset.channelId;

  const ch = channelsCache.find(c => c.id === channelId);
  let cfg = {};
  try { cfg = JSON.parse(ch?.config || "{}"); } catch {}

  // 헬퍼: UI 값이 있으면 덮어쓰기, 비어있으면 기존 값 유지
  const _set = (key, val) => { if (val) cfg[key] = val; };

  _set("image_prompt_style", document.getElementById("cs-image-prompt-style").value.trim());
  cfg.image_style = document.getElementById("cs-image-style").value;
  cfg.format = document.getElementById("cs-format").value;
  cfg.target_duration = parseInt(document.getElementById("cs-target-duration").value) || 60;
  cfg.slide_layout = document.getElementById("cs-slide-layout").value;
  cfg.production_mode = document.getElementById("cs-production-mode").value;
  cfg.auto_bg_source = document.getElementById("cs-auto-bg-source").value;
  _set("gemini_api_key", document.getElementById("cs-gemini-api-key").value.trim());

  const trendSources = [];
  if (document.getElementById("cs-trend-google").checked) trendSources.push("google_trends");
  if (document.getElementById("cs-trend-youtube").checked) trendSources.push("youtube_trending");
  cfg.trend_sources = trendSources;
  _set("youtube_api_key", document.getElementById("cs-youtube-api-key").value.trim());

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
