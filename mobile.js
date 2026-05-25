const API_BASE = window.location.origin;
const STORAGE_KEY = "self-calendar-mvp";
const SYNC_TOKEN_KEY = "self-calendar-sync-token";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const today = formatLocalDate(new Date());
let state = {
  selectedDate: today,
  calendarMode: "week",
  activeProjectId: "",
  projects: [],
  planned: [],
  actual: [],
  dailyReviews: {}
};
let syncStatus = "本地";
let activeProjectId = "";
let syncTimer = null;
let timer = {
  secondsLeft: 25 * 60,
  totalSeconds: 25 * 60,
  interval: null,
  running: false,
  projectId: "",
  taskId: "",
  notes: ""
};

function id(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateAdd(date, days) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return formatLocalDate(next);
}

function weekDates(date) {
  const current = new Date(`${date}T00:00:00`);
  const mondayOffset = (current.getDay() + 6) % 7;
  const monday = dateAdd(date, -mondayOffset);
  return Array.from({ length: 7 }, (_, index) => dateAdd(monday, index));
}

function hours(value) {
  const rounded = Math.round(Number(value || 0) * 10) / 10;
  return `${rounded}h`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function projectById(projectId) {
  return state.projects.find((project) => project.id === projectId);
}

function taskById(projectId, taskId) {
  return projectById(projectId)?.tasks?.find((task) => task.id === taskId);
}

function projectColor(projectId) {
  const index = Math.max(0, state.projects.findIndex((project) => project.id === projectId));
  return ["#2563eb", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#0891b2", "#4d7c0f", "#c2410c"][index % 8];
}

function plannedDuration(block) {
  const [sh, sm] = block.start.split(":").map(Number);
  const [eh, em] = block.end.split(":").map(Number);
  return Math.max(0, (eh * 60 + em - (sh * 60 + sm)) / 60);
}

function invested(projectId) {
  return state.actual
    .filter((entry) => entry.projectId === projectId)
    .reduce((sum, entry) => sum + Number(entry.duration || 0), 0);
}

function normalizeState(input) {
  return {
    ...state,
    ...input,
    projects: (input.projects || []).map((project) => ({
      ...project,
      tasks: project.tasks || [],
      aiMessages: project.aiMessages || []
    })),
    planned: input.planned || [],
    actual: input.actual || [],
    dailyReviews: input.dailyReviews || {}
  };
}

async function loadState() {
  try {
    const response = await fetchState(`${API_BASE}/api/state`);
    const data = await response.json();
    if (data.state) {
      state = normalizeState(data.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } else {
      const local = localStorage.getItem(STORAGE_KEY);
      if (local) state = normalizeState(JSON.parse(local));
    }
    syncStatus = data.sync?.cloudEnabled ? (data.sync.cloudOk ? "云端" : "云端失败") : "本地";
  } catch {
    const local = localStorage.getItem(STORAGE_KEY);
    if (local) state = normalizeState(JSON.parse(local));
    syncStatus = "本地";
  }
  render();
}

async function saveState() {
  saveLocalState();
  render();
  await syncStateNow();
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function syncStateSoon() {
  saveLocalState();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncStateNow().then(render);
  }, 350);
}

async function syncStateNow() {
  try {
    const response = await fetchState(`${API_BASE}/api/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    const data = await response.json();
    syncStatus = data.sync?.cloudEnabled ? (data.sync.cloudOk ? "云端" : "云端失败") : "已保存";
  } catch {
    syncStatus = "本地";
  }
}

async function fetchState(url, options = {}) {
  const token = localStorage.getItem(SYNC_TOKEN_KEY) || "";
  const headers = { ...(options.headers || {}) };
  if (token) headers["X-Sync-Token"] = token;
  let response = await fetch(url, { ...options, headers });
  if (response.status !== 401) return response;

  const nextToken = window.prompt("请输入 Self Calendar 同步 token");
  if (!nextToken) return response;
  localStorage.setItem(SYNC_TOKEN_KEY, nextToken.trim());
  headers["X-Sync-Token"] = nextToken.trim();
  response = await fetch(url, { ...options, headers });
  return response;
}

function render() {
  $("#syncPill").textContent = syncStatus;
  $("#mobileTitle").textContent = state.selectedDate === today ? "今天" : state.selectedDate;
  renderWeek();
  renderOptions();
  renderCalendar();
  renderProjects();
  renderReview();
}

function renderWeek() {
  $("#weekStrip").innerHTML = weekDates(state.selectedDate)
    .map((date) => {
      const d = new Date(`${date}T00:00:00`);
      return `
        <button class="day-chip ${date === state.selectedDate ? "active" : ""}" data-date="${date}" type="button">
          <small>${["日", "一", "二", "三", "四", "五", "六"][d.getDay()]}</small>
          <strong>${d.getDate()}</strong>
        </button>
      `;
    })
    .join("");
}

function renderOptions() {
  const projectOptions = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("");
  ["#mobilePlanProject", "#mobileActualProject", "#mobileTimerProject"].forEach((selector) => {
    const previous = $(selector).value;
    $(selector).innerHTML = projectOptions || '<option value="">先创建项目</option>';
    if (previous && state.projects.some((project) => project.id === previous)) $(selector).value = previous;
  });
  renderTaskOptions();
}

function renderTaskOptions() {
  [
    ["#mobilePlanProject", "#mobilePlanTask", true],
    ["#mobileActualProject", "#mobileActualTask", false],
    ["#mobileTimerProject", "#mobileTimerTask", false]
  ].forEach(([projectSelector, taskSelector, required]) => {
    const project = projectById($(projectSelector).value);
    const previous = $(taskSelector).value;
    const placeholder = required ? '<option value="">请选择细分任务</option>' : '<option value="">不关联细分任务</option>';
    const options = (project?.tasks || []).map((task) => `<option value="${task.id}">${escapeHtml(task.name)}</option>`).join("");
    $(taskSelector).innerHTML = placeholder + options;
    if (previous && project?.tasks?.some((task) => task.id === previous)) $(taskSelector).value = previous;
  });
}

function renderCalendar() {
  const planned = state.planned.filter((block) => block.date === state.selectedDate);
  const actual = state.actual.filter((entry) => entry.date === state.selectedDate);
  const plannedTotal = planned.reduce((sum, block) => sum + plannedDuration(block), 0);
  const actualTotal = actual.reduce((sum, entry) => sum + Number(entry.duration || 0), 0);
  $("#mobilePlannedTotal").textContent = hours(plannedTotal);
  $("#mobileActualTotal").textContent = hours(actualTotal);
  $("#mobileCompletion").textContent = `${plannedTotal ? Math.round((actualTotal / plannedTotal) * 100) : actualTotal ? 100 : 0}%`;
  $("#mobilePlannedList").innerHTML = planned.length ? planned.map(renderPlanItem).join("") : '<p class="empty">还没有计划。</p>';
  $("#mobileActualList").innerHTML = actual.length ? actual.map(renderActualItem).join("") : '<p class="empty">还没有实际记录。</p>';
}

function renderPlanItem(block) {
  const project = projectById(block.projectId);
  const task = taskById(block.projectId, block.taskId);
  return `
    <article class="mobile-item" style="--family:${projectColor(block.projectId)}">
      <strong>${escapeHtml(block.title)}</strong>
      <div class="mobile-meta">
        <span>${block.start}-${block.end}</span>
        <span>${hours(plannedDuration(block))}</span>
        <span>${escapeHtml(project?.name || "")}</span>
        ${task ? `<span>${escapeHtml(task.name)}</span>` : ""}
      </div>
    </article>
  `;
}

function renderActualItem(entry) {
  const project = projectById(entry.projectId);
  const task = taskById(entry.projectId, entry.taskId);
  return `
    <article class="mobile-item" style="--family:${projectColor(entry.projectId)}">
      <strong>${escapeHtml(entry.title)}</strong>
      <div class="mobile-meta">
        <span>${hours(entry.duration)}</span>
        <span>${escapeHtml(project?.name || "")}</span>
        ${task ? `<span>${escapeHtml(task.name)}</span>` : ""}
      </div>
    </article>
  `;
}

function renderProjects() {
  if (!activeProjectId && state.projects.length) activeProjectId = state.activeProjectId || state.projects[0].id;
  $("#mobileProjectList").innerHTML = state.projects.length
    ? state.projects.map(renderProjectItem).join("")
    : '<p class="empty">还没有项目。</p>';
  renderProjectDetail();
}

function renderProjectItem(project) {
  const done = invested(project.id);
  const pct = project.estimate ? Math.min(100, Math.round((done / project.estimate) * 100)) : 0;
  return `
    <article class="mobile-item project-mobile-item ${activeProjectId === project.id ? "active" : ""}" data-project="${project.id}" style="--family:${projectColor(project.id)}">
      <strong>${escapeHtml(project.name)}</strong>
      <div class="mobile-meta">
        <span>${hours(done)} / ${hours(project.estimate)}</span>
        <span>${project.tasks?.length || 0} 个任务</span>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
    </article>
  `;
}

function renderProjectDetail() {
  const project = projectById(activeProjectId);
  if (!project) {
    $("#mobileProjectDetail").innerHTML = '<p class="empty">点一个项目查看细分任务。</p>';
    return;
  }
  $("#mobileProjectDetail").innerHTML = `
    <div class="section-head">
      <div>
        <h2>${escapeHtml(project.name)}</h2>
        <p class="detail-subtitle">${hours(invested(project.id))} / ${hours(project.estimate)}</p>
      </div>
    </div>
    <form id="mobileTaskForm" class="mobile-form">
      <input id="mobileTaskName" type="text" placeholder="细分任务名称" required />
      <input id="mobileTaskEstimate" type="number" min="0.5" step="0.5" placeholder="预计小时" required />
      <textarea id="mobileTaskNotes" placeholder="备注"></textarea>
      <button type="submit">添加细分任务</button>
    </form>
    <div class="mobile-list">
      ${project.tasks?.length ? project.tasks.map((task) => renderTaskItem(project, task)).join("") : '<p class="empty">还没有细分任务。</p>'}
    </div>
  `;
}

function renderTaskItem(project, task) {
  return `
    <article class="mobile-task" style="--family:${projectColor(project.id)}">
      <strong>${escapeHtml(task.name)}</strong>
      <div class="mobile-meta">
        <span>${hours(task.estimate)}</span>
        <span>${task.status === "completed" ? "完成" : "进行中"}</span>
      </div>
      ${task.notes ? `<p>${escapeHtml(task.notes)}</p>` : ""}
    </article>
  `;
}

function renderReview() {
  const review = state.dailyReviews?.[state.selectedDate];
  $("#mobileReview").innerHTML = review
    ? `
      <p><strong>完成率 ${review.completionRate}%</strong></p>
      <p>${escapeHtml(review.summary)}</p>
      ${review.nextFocus ? `<p><strong>下一段重点：</strong>${escapeHtml(review.nextFocus)}</p>` : ""}
    `
    : '<p class="empty">这一天还没有复盘。</p>';
}

function bindEvents() {
  $$(".bottom-nav button").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".bottom-nav button").forEach((item) => item.classList.toggle("active", item === button));
      $$(".screen").forEach((screen) => screen.classList.toggle("active", screen.id === button.dataset.screen));
    });
  });
  document.body.addEventListener("click", (event) => {
    const dateButton = event.target.closest("[data-date]");
    if (dateButton) {
      state.selectedDate = dateButton.dataset.date;
      saveLocalState();
      render();
      syncStateSoon();
      return;
    }
    const projectCard = event.target.closest("[data-project]");
    if (projectCard) {
      activeProjectId = projectCard.dataset.project;
      state.activeProjectId = activeProjectId;
      renderProjects();
    }
  });
  document.body.addEventListener("submit", (event) => {
    if (event.target.id !== "mobileTaskForm") return;
    event.preventDefault();
    const project = projectById(activeProjectId);
    if (!project) return;
    project.tasks ||= [];
    project.tasks.push({
      id: id("t"),
      name: $("#mobileTaskName").value.trim(),
      estimate: Number($("#mobileTaskEstimate").value),
      notes: $("#mobileTaskNotes").value.trim(),
      status: "not-started",
      editing: false
    });
    event.target.reset();
    saveState();
  });
  $("#showPlanForm").addEventListener("click", () => $("#mobilePlanForm").classList.toggle("collapsed"));
  $("#showActualForm").addEventListener("click", () => $("#mobileActualForm").classList.toggle("collapsed"));
  $("#showProjectForm").addEventListener("click", () => $("#mobileProjectForm").classList.toggle("collapsed"));
  ["#mobilePlanProject", "#mobileActualProject", "#mobileTimerProject"].forEach((selector) => $(selector).addEventListener("change", renderTaskOptions));
  $("#mobilePlanForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const projectId = $("#mobilePlanProject").value;
    const taskId = $("#mobilePlanTask").value;
    state.planned.push({
      id: id("b"),
      date: state.selectedDate,
      projectId,
      taskId,
      title: $("#mobilePlanTitle").value.trim() || taskById(projectId, taskId)?.name || "未命名计划",
      start: $("#mobilePlanStart").value,
      end: $("#mobilePlanEnd").value,
      notes: $("#mobilePlanNotes").value.trim(),
      source: "手机计划"
    });
    event.target.reset();
    saveState();
  });
  $("#mobileActualForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.actual.push({
      id: id("e"),
      date: state.selectedDate,
      projectId: $("#mobileActualProject").value,
      taskId: $("#mobileActualTask").value,
      title: $("#mobileActualTitle").value.trim(),
      duration: Number($("#mobileActualDuration").value),
      notes: $("#mobileActualNotes").value.trim(),
      source: "手机记录"
    });
    event.target.reset();
    saveState();
  });
  $("#mobileProjectForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.projects.push({
      id: id("p"),
      name: $("#mobileProjectName").value.trim(),
      estimate: Number($("#mobileProjectEstimate").value),
      description: $("#mobileProjectDescription").value.trim(),
      status: "in-progress",
      createdAt: new Date().toISOString(),
      tasks: [],
      aiMessages: []
    });
    event.target.reset();
    saveState();
  });
  $("#mobileRunReview").addEventListener("click", () => {
    const planned = state.planned.filter((block) => block.date === state.selectedDate);
    const actual = state.actual.filter((entry) => entry.date === state.selectedDate);
    const plannedHours = planned.reduce((sum, block) => sum + plannedDuration(block), 0);
    const actualHours = actual.reduce((sum, entry) => sum + Number(entry.duration || 0), 0);
    state.dailyReviews ||= {};
    state.dailyReviews[state.selectedDate] = {
      completionRate: plannedHours ? Math.round((actualHours / plannedHours) * 100) : actualHours ? 100 : 0,
      summary: `今天计划 ${hours(plannedHours)}，实际完成 ${hours(actualHours)}。`,
      wins: actualHours ? ["今天已经留下了实际投入记录。"] : [],
      gaps: plannedHours > actualHours ? ["实际投入少于计划。"] : [],
      risks: [],
      adjustments: [],
      nextFocus: "明天优先保留最重要的一到两个时间块。"
    };
    saveState();
  });
  $("#mobileTimerStart").addEventListener("click", startMobileTimer);
  $("#mobileFocusClose").addEventListener("click", hideMobileFocus);
  $("#mobileFocusPause").addEventListener("click", toggleMobileTimer);
  $("#mobileFocusSave").addEventListener("click", () => stopMobileTimer(true));
  $("#mobileFocusDiscard").addEventListener("click", () => stopMobileTimer(false));
  $("#mobileFocusNotes").addEventListener("input", (event) => {
    timer.notes = event.target.value;
  });
}

bindEvents();
loadState();

function startMobileTimer() {
  if (timer.running) return;
  if (!timer.interval) {
    timer.totalSeconds = Number($("#mobileTimerMinutes").value || 25) * 60;
    timer.secondsLeft = timer.totalSeconds;
    timer.projectId = $("#mobileTimerProject").value;
    timer.taskId = $("#mobileTimerTask").value;
  }
  showMobileFocus();
  timer.running = true;
  timer.interval = setInterval(() => {
    timer.secondsLeft -= 1;
    updateMobileTimerDisplay();
    if (timer.secondsLeft <= 0) stopMobileTimer(true);
  }, 1000);
}

function pauseMobileTimer() {
  clearInterval(timer.interval);
  timer.interval = null;
  timer.running = false;
  updateMobileTimerDisplay();
}

function toggleMobileTimer() {
  if (timer.running) {
    pauseMobileTimer();
    return;
  }
  startMobileTimer();
}

function stopMobileTimer(saveElapsed) {
  const elapsedSeconds = timer.totalSeconds - timer.secondsLeft;
  timer.notes = $("#mobileFocusNotes").value.trim();
  pauseMobileTimer();
  if (saveElapsed && elapsedSeconds > 0) {
    state.actual.push({
      id: id("e"),
      date: state.selectedDate,
      projectId: timer.projectId || $("#mobileTimerProject").value,
      taskId: timer.taskId || $("#mobileTimerTask").value,
      title: "番茄钟专注",
      duration: Math.round((elapsedSeconds / 3600) * 100) / 100,
      notes: timer.notes || "由手机番茄钟自动记录。",
      source: "手机番茄钟"
    });
  }
  timer.secondsLeft = Number($("#mobileTimerMinutes").value || 25) * 60;
  timer.totalSeconds = timer.secondsLeft;
  timer.projectId = "";
  timer.taskId = "";
  timer.notes = "";
  $("#mobileFocusNotes").value = "";
  hideMobileFocus();
  saveState();
}

function showMobileFocus() {
  const project = projectById(timer.projectId || $("#mobileTimerProject").value);
  $("#mobileFocusProject").textContent = project?.name || "番茄钟";
  $("#mobileFocusOverlay").classList.add("active");
  $("#mobileFocusOverlay").setAttribute("aria-hidden", "false");
  updateMobileTimerDisplay();
}

function hideMobileFocus() {
  $("#mobileFocusOverlay").classList.remove("active");
  $("#mobileFocusOverlay").setAttribute("aria-hidden", "true");
}

function updateMobileTimerDisplay() {
  const minutes = Math.floor(timer.secondsLeft / 60).toString().padStart(2, "0");
  const seconds = Math.floor(timer.secondsLeft % 60).toString().padStart(2, "0");
  const elapsed = Math.max(0, timer.totalSeconds - timer.secondsLeft);
  const pct = timer.totalSeconds ? Math.min(100, Math.round((elapsed / timer.totalSeconds) * 100)) : 0;
  $("#mobileFocusTime").textContent = `${minutes}:${seconds}`;
  $("#mobileFocusPercent").textContent = `${pct}%`;
  $("#mobileFocusBar").style.width = `${pct}%`;
  $("#mobileFocusRing").style.setProperty("--focus-progress", `${pct}%`);
  $("#mobileFocusPause").textContent = timer.running ? "暂停" : "继续";
}
