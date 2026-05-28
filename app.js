const STORAGE_KEY = "self-calendar-mvp";
const SYNC_TOKEN_KEY = "self-calendar-sync-token";
const TIMER_STORAGE_KEY = "self-calendar-desktop-timer";
const API_BASE = window.location.origin;

let today = formatLocalDate(new Date());
const seed = {
  selectedDate: today,
  calendarMode: "week",
  habitMode: "day",
  habitDate: today,
  lastSeenToday: today,
  statusTags: [
    { id: "deep-focus", name: "深度专注", tone: "focus" },
    { id: "light-progress", name: "轻量推进", tone: "calm" },
    { id: "training", name: "体力训练", tone: "energy" },
    { id: "maintenance", name: "家务维护", tone: "calm" },
    { id: "recovery", name: "恢复休息", tone: "rest" },
    { id: "leisure", name: "娱乐放松", tone: "play" },
    { id: "distraction", name: "分心干扰", tone: "risk" }
  ],
  activeProjectId: "p1",
  projects: [
    {
      id: "p1",
      name: "Learn Python",
      estimate: 60,
      description: "系统学习 Python，并通过一个小项目完成巩固。",
      status: "in-progress",
      createdAt: new Date().toISOString(),
      tasks: [
        { id: "t1", name: "Python syntax basics", estimate: 8, notes: "基础语法、变量、控制流。", status: "in-progress" },
        { id: "t2", name: "Practice exercises", estimate: 12, notes: "用练习巩固语法。", status: "not-started" }
      ],
      aiMessages: []
    },
    {
      id: "p2",
      name: "Writing Project",
      estimate: 40,
      description: "完成一个中篇写作项目的初稿。",
      status: "in-progress",
      createdAt: new Date().toISOString(),
      tasks: [],
      aiMessages: []
    }
  ],
  planned: [],
  habits: [],
  habitLogs: [],
  reviewMessages: [],
  aiMemory: [],
  actual: [
    {
      id: "e1",
      date: today,
      projectId: "p1",
      title: "Watched basic syntax lessons",
      duration: 2,
      source: "手动记录",
      notes: "变量、条件判断、循环。",
      statusTag: "deep-focus"
    }
  ],
  dailyReviews: {}
};

let state = loadState();
let remoteSyncReady = false;
let cloudSyncStatus = "本地";
let aiUsageToday = null;
let timer = {
  secondsLeft: 25 * 60,
  totalSeconds: 25 * 60,
  interval: null,
  running: false,
  active: false,
  startedAt: null,
  pausedElapsedSeconds: 0,
  projectId: "",
  taskId: "",
  notes: ""
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(seed);
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return structuredClone(seed);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  syncStateToServer();
}

function normalizeState(input) {
  const merged = { ...structuredClone(seed), ...input };
  merged.dailyReviews ||= {};
  merged.habits ||= [];
  merged.habitLogs ||= [];
  merged.reviewMessages ||= [];
  merged.aiMemory ||= [];
  merged.statusTags = Array.isArray(merged.statusTags) && merged.statusTags.length ? merged.statusTags : structuredClone(seed.statusTags);
  merged.lastSeenToday ||= today;
  if (!["week", "month"].includes(merged.calendarMode)) {
    merged.calendarMode = "week";
  }
  if (!["day", "week", "month"].includes(merged.habitMode)) {
    merged.habitMode = "day";
  }
  merged.projects = (merged.projects || []).map((project) => ({
    ...project,
    estimate: Number.isFinite(Number(project.estimate)) && Number(project.estimate) > 0 ? Number(project.estimate) : null,
    tasks: project.tasks || [],
    aiMessages: project.aiMessages || []
  }));
  merged.planned ||= [];
  merged.actual ||= [];
  applyTodayRollover(merged);
  return merged;
}

function applyTodayRollover(targetState = state) {
  const nextToday = formatLocalDate(new Date());
  const previousToday = targetState.lastSeenToday || today;
  if (!targetState.selectedDate || (nextToday !== previousToday && targetState.selectedDate <= previousToday)) {
    targetState.selectedDate = nextToday;
  }
  if (!targetState.habitDate || (nextToday !== previousToday && targetState.habitDate <= previousToday)) {
    targetState.habitDate = nextToday;
  }
  targetState.lastSeenToday = nextToday;
  today = nextToday;
}

async function hydrateStateFromServer() {
  try {
    const response = await fetchState(`${API_BASE}/api/state`);
    if (!response.ok) return;
    const data = await response.json();
    const localHasData = hasUserData(state);
    const remoteHasData = data.exists && data.state && hasUserData(data.state);
    if (remoteHasData) {
      state = normalizeState(data.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } else {
      await syncStateToServer();
    }
    cloudSyncStatus = data.sync?.cloudEnabled ? (data.sync.cloudOk ? "云端" : "云端失败") : "本地";
    remoteSyncReady = true;
    renderCalendar();
    renderProjects();
    renderHabits();
  } catch {
    remoteSyncReady = false;
    cloudSyncStatus = "本地";
  }
}

function hasUserData(value) {
  return Boolean(
    value &&
      ((Array.isArray(value.projects) && value.projects.length > 0) ||
        (Array.isArray(value.planned) && value.planned.length > 0) ||
        (Array.isArray(value.actual) && value.actual.length > 0))
  );
}

async function syncStateToServer() {
  try {
    const response = await fetchState(`${API_BASE}/api/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    const data = response.ok ? await response.json() : null;
    cloudSyncStatus = data?.sync?.cloudEnabled ? (data.sync.cloudOk ? "云端" : "云端失败") : "已保存";
    remoteSyncReady = true;
  } catch {
    remoteSyncReady = false;
    cloudSyncStatus = "本地";
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

async function loadAiUsage() {
  try {
    const response = await fetch(`${API_BASE}/api/ai-usage`);
    if (!response.ok) return;
    const data = await response.json();
    aiUsageToday = data.today || null;
    renderAiUsage();
  } catch {
    aiUsageToday = null;
    renderAiUsage();
  }
}

function renderAiUsage() {
  const element = $("#aiUsageToday");
  if (!element) return;
  if (!aiUsageToday) {
    element.textContent = "--";
    return;
  }
  const total = Number(aiUsageToday.totalTokens || 0);
  const estimated = Number(aiUsageToday.estimatedTokens || 0) > 0;
  element.textContent = `${formatNumber(total)}${estimated ? "~" : ""}`;
  element.title = `输入 ${formatNumber(aiUsageToday.promptTokens || 0)} / 输出 ${formatNumber(aiUsageToday.completionTokens || 0)} / 请求 ${aiUsageToday.requests || 0}`;
}

function formatNumber(value) {
  return Math.round(Number(value || 0)).toLocaleString("zh-CN");
}

function id(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function hours(value) {
  const rounded = Math.round(Number(value || 0) * 10) / 10;
  return `${rounded}h`;
}

function optionalHours(value) {
  return Number(value) > 0 ? hours(value) : "不限";
}

function projectProgress(project) {
  return Number(project?.estimate) > 0 ? Math.min(100, Math.round((invested(project.id) / Number(project.estimate)) * 100)) : 0;
}

function projectById(projectId) {
  return state.projects.find((project) => project.id === projectId);
}

function taskById(projectId, taskId) {
  return projectById(projectId)?.tasks?.find((task) => task.id === taskId);
}

function projectColor(projectId) {
  const index = Math.max(0, state.projects.findIndex((project) => project.id === projectId));
  const palette = ["#2563eb", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#0891b2", "#4d7c0f", "#c2410c"];
  return palette[index % palette.length];
}

function statusTagById(tagId) {
  return state.statusTags.find((tag) => tag.id === tagId);
}

function statusTagName(tagId) {
  return statusTagById(tagId)?.name || "未标记";
}

function renderStatusTagOptions(selected = "") {
  return ['<option value="">状态标签</option>']
    .concat(state.statusTags.map((tag) => `<option value="${tag.id}" ${tag.id === selected ? "selected" : ""}>${escapeHtml(tag.name)}</option>`))
    .join("");
}

function inferStatusTag(task = {}, fallback = "light-progress") {
  const text = `${task.name || ""} ${task.notes || ""}`.toLowerCase();
  if (/训练|运动|引体|健身|跑|拉伸/.test(text)) return "training";
  if (/休息|恢复|睡|散步|放松/.test(text)) return "recovery";
  if (/游戏|娱乐|短视频|刷/.test(text)) return "leisure";
  if (/整理|家务|维护|清洁/.test(text)) return "maintenance";
  if (/写|编程|学习|研究|准备|设计|阅读/.test(text)) return "deep-focus";
  return fallback;
}

function invested(projectId) {
  return state.actual
    .filter((entry) => entry.projectId === projectId)
    .reduce((sum, entry) => sum + Number(entry.duration || 0), 0);
}

function plannedDuration(block) {
  if (block.duration) return Number(block.duration);
  if (!block.start || !block.end) return 0;
  const [sh, sm] = block.start.split(":").map(Number);
  const [eh, em] = block.end.split(":").map(Number);
  return Math.max(0, (eh * 60 + em - (sh * 60 + sm)) / 60);
}

function planTimeLabel(block) {
  return block.start && block.end ? `${block.start}-${block.end}` : "当天完成";
}

function plannedDurationLabel(block) {
  return block.start && block.end ? hours(plannedDuration(block)) : "弹性";
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

function monthDates(date) {
  const current = new Date(`${date}T00:00:00`);
  const first = new Date(current.getFullYear(), current.getMonth(), 1);
  const last = new Date(current.getFullYear(), current.getMonth() + 1, 0);
  const start = dateAdd(formatLocalDate(first), -((first.getDay() + 6) % 7));
  const endPad = 6 - ((last.getDay() + 6) % 7);
  const end = dateAdd(formatLocalDate(last), endPad);
  const days = [];
  for (let d = start; d <= end; d = dateAdd(d, 1)) days.push(d);
  return days;
}

function selectedPlanned() {
  return state.planned.filter((block) => block.date === state.selectedDate);
}

function selectedActual() {
  return state.actual.filter((entry) => entry.date === state.selectedDate);
}

function setView(view) {
  $$(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#calendarView").classList.toggle("active-view", view === "calendar");
  $("#projectsView").classList.toggle("active-view", view === "projects");
  $("#habitsView").classList.toggle("active-view", view === "habits");
}

function renderProjectOptions() {
  const options = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("");
  ["#planProject", "#actualProject", "#timerProject"].forEach((selector) => {
    const previous = $(selector).value;
    $(selector).innerHTML = options || '<option value="">先创建项目</option>';
    if (previous && state.projects.some((project) => project.id === previous)) {
      $(selector).value = previous;
    }
  });
  ["#planStatusTag", "#actualStatusTag"].forEach((selector) => {
    const element = $(selector);
    if (!element) return;
    const previous = element.value;
    element.innerHTML = renderStatusTagOptions(previous);
  });
  renderTaskOptions();
}

function renderTaskOptions() {
  [
    ["#planProject", "#planTask", true],
    ["#actualProject", "#actualTask", false],
    ["#timerProject", "#timerTask", false]
  ].forEach(([projectSelector, taskSelector, required]) => {
    const project = projectById($(projectSelector)?.value);
    const previous = $(taskSelector).value;
    const placeholder = required ? '<option value="">请选择细分任务</option>' : '<option value="">不关联细分任务</option>';
    const options = (project?.tasks || [])
      .map((task) => `<option value="${task.id}">${escapeHtml(task.name)}</option>`)
      .join("");
    $(taskSelector).innerHTML = placeholder + options;
    if (previous && project?.tasks?.some((task) => task.id === previous)) {
      $(taskSelector).value = previous;
    }
  });
}

function renderCalendar() {
  $("#selectedDate").value = state.selectedDate;
  $$(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.calendarMode === state.calendarMode));
  renderProjectOptions();

  const planned = selectedPlanned();
  const actual = selectedActual();
  $("#plannedTotal").textContent = hours(planned.reduce((sum, block) => sum + plannedDuration(block), 0));
  $("#actualTotal").textContent = hours(actual.reduce((sum, entry) => sum + Number(entry.duration || 0), 0));
  $("#todayActual").textContent = hours(
    state.actual.filter((entry) => entry.date === today).reduce((sum, entry) => sum + Number(entry.duration || 0), 0)
  );
  $("#activeProjects").textContent = state.projects.filter((project) => project.status === "in-progress").length;
  $("#syncStatus").textContent = cloudSyncStatus;
  renderAiUsage();

  $("#plannedList").innerHTML = planned.length ? planned.map(renderPlannedEntry).join("") : $("#emptyTemplate").innerHTML;
  $("#actualList").innerHTML = actual.length ? actual.map(renderActualEntry).join("") : $("#emptyTemplate").innerHTML;
  $("#plannedDistribution").innerHTML = renderDistribution(planned, plannedDuration);
  $("#actualDistribution").innerHTML = renderDistribution(actual, (entry) => Number(entry.duration || 0));
  $("#calendarRange").innerHTML = renderRangeCalendar();
  renderDailyReview();
}

function renderRangeCalendar() {
  const dates = state.calendarMode === "week" ? weekDates(state.selectedDate) : monthDates(state.selectedDate);
  return `
    <div class="calendar-grid ${state.calendarMode === "month" ? "month-grid" : ""}">
      ${dates.map(renderDateCell).join("")}
    </div>
  `;
}

function renderDateCell(date) {
  const planned = state.planned.filter((block) => block.date === date).sort((a, b) => (a.start || "99:99").localeCompare(b.start || "99:99"));
  const actual = state.actual.filter((entry) => entry.date === date);
  const plannedTotal = planned.reduce((sum, block) => sum + plannedDuration(block), 0);
  const actualTotal = actual.reduce((sum, entry) => sum + Number(entry.duration || 0), 0);
  return `
    <article class="date-cell ${date === state.selectedDate ? "selected" : ""}" data-select-date="${date}">
      <span class="date-cell-head">${formatDateShort(date)}</span>
      <span class="date-cell-total">计划 ${hours(plannedTotal)} / 实际 ${hours(actualTotal)}</span>
      <span class="date-cell-items">
        ${planned.slice(0, 4).map((block) => `<span class="range-plan-item" draggable="true" data-range-plan="${block.id}" style="--family:${projectColor(block.projectId)}">${escapeHtml(block.start || "当天")} ${escapeHtml(block.title)}</span>`).join("")}
        ${planned.length > 4 ? `<span>还有 ${planned.length - 4} 项</span>` : ""}
      </span>
    </article>
  `;
}

function renderPlannedEntry(block) {
  const project = projectById(block.projectId);
  const task = taskById(block.projectId, block.taskId);
  return `
    <article class="entry" style="--family:${projectColor(block.projectId)}">
      <div class="entry-title">
        <strong>${escapeHtml(block.title)}</strong>
        <span>${plannedDurationLabel(block)}</span>
      </div>
      <div class="entry-meta">
        <span>${escapeHtml(project?.name || "未匹配项目")}</span>
        ${task ? `<span>${escapeHtml(task.name)}</span>` : ""}
        <span>${planTimeLabel(block)}</span>
        ${block.statusTag ? `<span class="status-pill">${escapeHtml(statusTagName(block.statusTag))}</span>` : ""}
        <span>${escapeHtml(block.source || "manual")}</span>
      </div>
      ${block.notes ? `<p>${escapeHtml(block.notes)}</p>` : ""}
      <div class="entry-actions">
        <button class="secondary" data-copy-plan="${block.id}" type="button">转为实际</button>
        <button class="secondary danger" data-delete-plan="${block.id}" type="button">删除</button>
      </div>
    </article>
  `;
}

function renderActualEntry(entry) {
  const project = projectById(entry.projectId);
  const task = taskById(entry.projectId, entry.taskId);
  return `
    <article class="entry" style="--family:${projectColor(entry.projectId)}">
      <div class="entry-title">
        <strong>${escapeHtml(entry.title)}</strong>
        <span>${hours(entry.duration)}</span>
      </div>
      <div class="entry-meta">
        <span>${escapeHtml(project?.name || "未匹配项目")}</span>
        ${task ? `<span>${escapeHtml(task.name)}</span>` : ""}
        <span>${escapeHtml(entry.source || "manual")}</span>
        ${entry.statusTag ? `<span class="status-pill">${escapeHtml(statusTagName(entry.statusTag))}</span>` : ""}
      </div>
      ${entry.notes ? `<p>${escapeHtml(entry.notes)}</p>` : ""}
      <div class="entry-actions">
        <button class="secondary danger" data-delete-actual="${entry.id}" type="button">删除</button>
      </div>
    </article>
  `;
}

function renderDistribution(items, durationGetter) {
  const totals = new Map();
  items.forEach((item) => totals.set(item.projectId, (totals.get(item.projectId) || 0) + durationGetter(item)));
  const total = Array.from(totals.values()).reduce((sum, value) => sum + value, 0);
  if (!total) return "";
  return Array.from(totals.entries())
    .map(([projectId, value]) => {
      const project = projectById(projectId);
      const pct = Math.round((value / total) * 100);
      return `
        <div class="bar">
          <span>${escapeHtml(project?.name || "未匹配")}</span>
          <span class="bar-track"><span class="bar-fill" style="width: ${pct}%"></span></span>
          <span>${hours(value)}</span>
        </div>
      `;
    })
    .join("");
}

function renderProjects() {
  renderProjectOptions();
  $("#projectList").innerHTML = state.projects
    .map((project) => {
      const done = invested(project.id);
      const pct = projectProgress(project);
      return `
        <article class="project-card ${state.activeProjectId === project.id ? "active" : ""}" data-project="${project.id}" style="--family:${projectColor(project.id)}">
          <div class="project-card-title">
            <strong>${escapeHtml(project.name)}</strong>
            <span>${pct}%</span>
          </div>
          <div class="project-meta">
            <span>${Number(project.estimate) > 0 ? `${hours(done)} / ${hours(project.estimate)}` : `累计 ${hours(done)}`}</span>
            <span>${statusLabel(project.status)}</span>
          </div>
          <div class="progress"><span style="width: ${pct}%"></span></div>
        </article>
      `;
    })
    .join("");
  renderProjectDetail();
}

function renderHabits() {
  if (!$("#habitsView")) return;
  state.habitDate ||= today;
  $("#habitDate").value = state.habitDate;
  $$(".habit-mode-button").forEach((button) => button.classList.toggle("active", button.dataset.habitMode === state.habitMode));
  $("#habitTime").value ||= currentTimeValue();
  $("#habitSelect").innerHTML = state.habits.length
    ? state.habits.map((habit) => `<option value="${habit.id}">${escapeHtml(habit.name)}</option>`).join("")
    : '<option value="">先输入一个新习惯</option>';
  $("#habitList").innerHTML = state.habits.length
    ? state.habits
        .map((habit) => {
          const count = state.habitLogs.filter((log) => log.habitId === habit.id).length;
          return `<article class="habit-chip" style="--family:${habit.color}"><strong>${escapeHtml(habit.name)}</strong><span>${count} 次</span></article>`;
        })
        .join("")
    : '<p class="empty-state">还没有习惯。输入名称后第一次打卡会自动创建。</p>';
  const logs = habitLogsForMode();
  $("#habitCount").textContent = `${logs.length} 次`;
  $("#habitBoardTitle").textContent = habitBoardTitle();
  $("#habitTimeline").innerHTML = renderHabitTimeline();
}

function habitLogsForMode() {
  const dates = habitModeDates();
  const dateSet = new Set(dates);
  return state.habitLogs.filter((log) => dateSet.has(log.date));
}

function habitModeDates() {
  if (state.habitMode === "week") return weekDates(state.habitDate);
  if (state.habitMode === "month") return monthDates(state.habitDate);
  return [state.habitDate];
}

function habitBoardTitle() {
  if (state.habitMode === "day") return state.habitDate === today ? "今天" : state.habitDate;
  const dates = habitModeDates();
  return `${dates[0]} - ${dates.at(-1)}`;
}

function renderHabitTimeline() {
  const dates = habitModeDates();
  if (state.habitMode === "day") {
    return `<div class="habit-day-axis">${renderHabitAxis(state.habitDate, true)}</div>`;
  }
  return `
    <div class="habit-columns ${state.habitMode === "month" ? "habit-month-columns" : ""}">
      ${dates
        .map(
          (date) => `
            <div class="habit-column ${date === today ? "today" : ""}">
              <span class="habit-column-label">${formatDateShort(date)}</span>
              ${renderHabitAxis(date, false)}
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderHabitAxis(date, showLabels) {
  const logs = state.habitLogs
    .filter((log) => log.date === date)
    .sort((a, b) => a.time.localeCompare(b.time));
  return `
    <div class="habit-axis">
      ${showLabels ? Array.from({ length: 7 }, (_, index) => `<span class="habit-hour" style="top:${(index / 6) * 100}%">${String(index * 4).padStart(2, "0")}:00</span>`).join("") : ""}
      ${logs.map(renderHabitStamp).join("")}
    </div>
  `;
}

function renderHabitStamp(log) {
  const habit = state.habits.find((item) => item.id === log.habitId);
  return `
    <button class="habit-stamp" data-delete-habit-log="${log.id}" title="${escapeAttr(`${habit?.name || "习惯"} ${log.time}${log.notes ? ` · ${log.notes}` : ""}`)}" style="--stamp:${habit?.color || "var(--accent)"}; top:${timeToDayPercent(log.time)}%" type="button">
      <span>${escapeHtml((habit?.name || "?").slice(0, 1))}</span>
    </button>
  `;
}

function timeToDayPercent(time) {
  const [hour, minute] = (time || "00:00").split(":").map(Number);
  return Math.min(98, Math.max(2, ((hour * 60 + minute) / 1440) * 100));
}

function currentTimeValue() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function nextHabitColor() {
  return ["#2563eb", "#0f766e", "#f59e0b", "#ec4899", "#7c3aed", "#c2410c", "#0891b2", "#4d7c0f"][state.habits.length % 8];
}

function renderProjectDetail() {
  const project = projectById(state.activeProjectId);
  if (!project) {
    $("#projectDetail").innerHTML = '<p class="empty-state">选择一个项目查看详情，或者先创建你的第一个目标。</p>';
    return;
  }
  const done = invested(project.id);
  const remaining = Number(project.estimate) > 0 ? Math.max(0, Number(project.estimate) - done) : null;
  const pct = projectProgress(project);
  const entries = state.actual.filter((entry) => entry.projectId === project.id).slice(-5).reverse();
  const plans = state.planned.filter((entry) => entry.projectId === project.id).slice(-5).reverse();
  $("#projectDetail").innerHTML = `
    <div class="panel-head">
      <div>
        <h3>${escapeHtml(project.name)}</h3>
        <p>${escapeHtml(project.description || "暂无描述")}</p>
      </div>
      <button class="secondary danger" data-delete-project="${project.id}" type="button">删除</button>
    </div>
    <div class="stats">
      <div class="stat"><span>预计</span><strong>${optionalHours(project.estimate)}</strong></div>
      <div class="stat"><span>已投入</span><strong>${hours(done)}</strong></div>
      <div class="stat"><span>剩余</span><strong>${remaining === null ? "持续累计" : hours(remaining)}</strong></div>
    </div>
    <div class="progress" aria-label="项目进度"><span style="width: ${pct}%"></span></div>
    <section class="ai-workbench">
      <div class="ai-head">
        <div>
          <h3>AI 任务草稿</h3>
          <p>生成后可以继续对话修改，再保存为项目任务。</p>
        </div>
        <div class="detail-actions">
          <button id="generateTasks" type="button">生成/重写</button>
          <button class="secondary" id="acceptTasks" type="button">保存任务</button>
          <button class="secondary" id="scheduleTasks" type="button">智能安排到日历</button>
        </div>
      </div>
      <div id="aiMessages" class="ai-messages">${renderAiMessages(project)}</div>
      <form id="aiPromptForm" class="ai-prompt">
        <input id="aiPrompt" type="text" placeholder="例如：把任务切得更小一点，每块不要超过 1.5 小时" />
        <button type="submit">发送</button>
      </form>
      <form id="manualTaskForm" class="manual-task-form">
        <input id="manualTaskName" type="text" placeholder="细分任务名称" required />
        <input id="manualTaskEstimate" type="number" min="0.5" step="0.5" placeholder="小时" required />
        <textarea id="manualTaskNotes" placeholder="任务备注"></textarea>
        <button type="submit">添加细分任务</button>
      </form>
      <div id="taskList" class="task-list">${renderTasks(project)}</div>
    </section>
    <h3>最近实际记录</h3>
    <div class="entry-list">${entries.length ? entries.map(renderActualEntry).join("") : $("#emptyTemplate").innerHTML}</div>
    <h3>最近计划</h3>
    <div class="entry-list">${plans.length ? plans.map(renderPlannedEntry).join("") : $("#emptyTemplate").innerHTML}</div>
  `;
}

function renderAiMessages(project) {
  const messages = project.aiMessages || [];
  if (!messages.length) return '<p class="empty-state">还没有对话。先点“生成/重写”，或直接输入修改要求。</p>';
  return messages
    .slice(-12)
    .map(renderChatMessage)
    .join("");
}

function renderChatMessage(message) {
  return `<p class="ai-message ${message.role}"><strong>${message.role === "user" ? "你" : "AI"}</strong>${escapeHtml(message.content)}</p>`;
}

function reviewMessagesForDate(date) {
  return state.reviewMessages.filter((message) => message.date === date);
}

function appendProjectAssistantMessage(project, content = "") {
  project.aiMessages ||= [];
  const message = { role: "assistant", content, createdAt: new Date().toISOString() };
  project.aiMessages.push(message);
  return message;
}

function renderTasks(project) {
  if (!project.tasks?.length) return '<p class="empty-state">还没有任务拆解。</p>';
  return project.tasks
    .map(
      (task) => {
        const locked = task.editing ? "" : "disabled";
        return `
        <div class="task-row ${task.editing ? "editing" : ""}" data-task="${task.id}">
          <input value="${escapeAttr(task.name)}" aria-label="任务名称" ${locked} />
          <input type="number" min="0.5" step="0.5" value="${task.estimate}" aria-label="预计小时" ${locked} />
          <button class="secondary" data-edit-task="${task.id}" type="button">${task.editing ? "完成" : "编辑"}</button>
          <button class="secondary danger" data-delete-task="${task.id}" type="button">删除</button>
          <textarea aria-label="任务备注" ${locked}>${escapeHtml(task.notes || "")}</textarea>
        </div>
      `;
      }
    )
    .join("");
}

function addPlanned(data) {
  state.planned.push({ id: id("b"), source: "手动计划", ...data });
  saveAndRender();
}

function addActual(data) {
  state.actual.push({ id: id("e"), source: "手动记录", ...data });
  saveAndRender();
}

function renderDailyReview() {
  const review = state.dailyReviews?.[state.selectedDate];
  if (!review) {
    $("#reviewResult").innerHTML = '<p class="empty-state">完成一天后，可以在这里生成复盘。</p>';
  } else {
    $("#reviewResult").innerHTML = `
      <div class="review-score">
        <span>计划完成率</span>
        <strong>${review.completionRate}%</strong>
      </div>
      <p>${escapeHtml(review.summary)}</p>
      ${renderReviewList("做得不错", review.wins)}
      ${renderReviewList("偏差与原因", review.gaps)}
      ${renderReviewList("接下来风险", review.risks)}
      ${renderAdjustments(review.adjustments)}
      ${review.nextFocus ? `<p><strong>下一段重点：</strong>${escapeHtml(review.nextFocus)}</p>` : ""}
    `;
  }
  const messages = reviewMessagesForDate(state.selectedDate);
  $("#reviewMessages").innerHTML = messages.length
    ? messages.map(renderChatMessage).join("")
    : '<p class="empty-state">复盘对话会保存在这里，第二天可以继续接着聊。</p>';
}

function renderReviewList(title, items) {
  if (!items?.length) return "";
  return `
    <section class="review-section">
      <h4>${title}</h4>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
  `;
}

function renderAdjustments(items) {
  if (!items?.length) return "";
  return `
    <section class="review-section">
      <h4>未来计划调整草稿</h4>
      <div class="adjustment-list">
        ${items
          .map(
            (item) => `
              <article class="adjustment">
                <strong>${escapeHtml(item.title)}</strong>
                <p>${escapeHtml(item.reason)}</p>
                <p>${escapeHtml(item.suggestion)}</p>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

async function runDailyReview() {
  const context = buildReviewContext(state.selectedDate);
  const aiReview = await requestDailyReview(context);
  const review = aiReview || fallbackDailyReview(context);
  state.dailyReviews ||= {};
  state.dailyReviews[state.selectedDate] = review;
  appendReviewAssistantMessage(state.selectedDate, review.summary);
  rememberReview(state.selectedDate, review, context);
}

function appendReviewAssistantMessage(date, content) {
  state.reviewMessages.push({
    id: id("rm"),
    date,
    role: "assistant",
    content,
    createdAt: new Date().toISOString()
  });
}

function appendReviewUserMessage(date, content) {
  state.reviewMessages.push({
    id: id("rm"),
    date,
    role: "user",
    content,
    createdAt: new Date().toISOString()
  });
}

function rememberReview(date, review, context) {
  const actualByTag = context.statusSummary.actual.map((item) => `${item.tag} ${hours(item.hours)}`).join("，") || "暂无实际投入";
  const memory = `${date}：计划 ${hours(context.localMetrics.plannedHours)}，实际 ${hours(context.localMetrics.actualHours)}，完成率 ${review.completionRate}%。状态分布：${actualByTag}。下一段重点：${review.nextFocus || "保持记录。"}`;
  state.aiMemory = state.aiMemory.filter((item) => item.date !== date);
  state.aiMemory.push({ id: id("mem"), date, content: memory, createdAt: new Date().toISOString() });
  state.aiMemory = state.aiMemory.slice(-30);
}

function answerReviewPrompt(date, prompt) {
  const context = buildReviewContext(date);
  const memoryText = context.recentMemory.map((item) => item.content).slice(-5).join("\n");
  const tagText = context.statusSummary.actual.map((item) => `${item.tag} ${hours(item.hours)}`).join("，") || "今天还没有实际状态标签";
  if (/明天|调整|安排|计划/.test(prompt)) {
    return `我会参考最近记忆来调：${memoryText ? `\n${memoryText}\n` : ""}今天的实际状态是 ${tagText}。建议明天先保留 1-2 个最重要块，把“深度专注”放在精力最高的时段；如果今天娱乐/分心偏多，就不要用惩罚式补偿，把下一段计划切小一点。`;
  }
  if (/游戏|娱乐|分心|拖延/.test(prompt)) {
    return `可以把这类时间继续如实记成“娱乐放松”或“分心干扰”。复盘时我会看它和计划状态的差距，不把它简单当失败，而是判断它是不是恢复、逃避，还是计划排得太硬。今天记录到的状态是：${tagText}。`;
  }
  return `我已经把这段对话保存到 ${date} 的复盘里了。当前可参考的状态分布是：${tagText}。后面接入实时 AI 后，这些历史复盘和记忆摘要会一起作为上下文。`;
}

async function streamProjectChat(project, prompt) {
  project.aiMessages ||= [];
  project.aiMessages.push({ role: "user", content: prompt, createdAt: new Date().toISOString() });
  const assistant = appendProjectAssistantMessage(project, "");
  renderProjects();
  await streamSsePost(
    `${API_BASE}/api/ai-project-chat-stream`,
    {
      project,
      messages: project.aiMessages,
      planned: state.planned.slice(-80),
      actual: state.actual.slice(-80),
      statusTags: state.statusTags,
      aiMemory: state.aiMemory.slice(-20)
    },
    (text) => {
      assistant.content += text;
      renderProjects();
    }
  );
  loadAiUsage();
  if (!assistant.content.trim()) assistant.content = "我这边没有收到 AI 回复。";
}

async function streamReviewChat(date, prompt) {
  appendReviewUserMessage(date, prompt);
  const assistant = {
    id: id("rm"),
    date,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString()
  };
  state.reviewMessages.push(assistant);
  renderDailyReview();
  const context = buildReviewContext(date);
  await streamSsePost(
    `${API_BASE}/api/ai-review-chat-stream`,
    {
      ...context,
      aiMemory: state.aiMemory.slice(-20),
      messages: reviewMessagesForDate(date)
    },
    (text) => {
      assistant.content += text;
      renderDailyReview();
    }
  );
  loadAiUsage();
  if (!assistant.content.trim()) assistant.content = answerReviewPrompt(date, prompt);
}

async function streamSsePost(url, body, onDelta) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.body) throw new Error("AI stream unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    events.forEach((eventText) => {
      const event = parseSseEvent(eventText);
      if (event.event === "delta" && event.data?.text) onDelta(event.data.text);
      if (event.event === "error") streamError = event.data?.error || "AI stream failed.";
    });
    if (streamError) throw new Error(streamError);
  }
  if (!response.ok) throw new Error(streamError || "AI stream unavailable.");
}

function parseSseEvent(eventText) {
  const event = { event: "message", data: null };
  eventText.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("event:")) event.event = line.slice(6).trim();
    if (line.startsWith("data:")) {
      try {
        event.data = JSON.parse(line.slice(5).trim());
      } catch {
        event.data = null;
      }
    }
  });
  return event;
}

function buildReviewContext(date) {
  const todayPlanned = state.planned.filter((block) => block.date === date);
  const todayActual = state.actual.filter((entry) => entry.date === date);
  const plannedHours = todayPlanned.reduce((sum, block) => sum + plannedDuration(block), 0);
  const actualHours = todayActual.reduce((sum, entry) => sum + Number(entry.duration || 0), 0);
  const completionRate = plannedHours ? Math.round((actualHours / plannedHours) * 100) : actualHours ? 100 : 0;
  return {
    reviewDate: date,
    todayPlanned: summarizePlanned(todayPlanned),
    todayActual: summarizeActual(todayActual),
    pastActualSummary: summarizePastActual(date, 7),
    futurePlannedSummary: summarizeFuturePlanned(date, 7),
    projectSummary: summarizeProjects(),
    statusSummary: summarizeStatusTags(todayPlanned, todayActual),
    recentMemory: state.aiMemory.slice(-10),
    recentReviewMessages: state.reviewMessages.slice(-20),
    localMetrics: {
      plannedHours,
      actualHours,
      completionRate,
      plannedCount: todayPlanned.length,
      actualCount: todayActual.length
    }
  };
}

function summarizePlanned(blocks) {
  return blocks.map((block) => ({
    date: block.date,
    time: planTimeLabel(block),
    duration: plannedDuration(block),
    project: projectById(block.projectId)?.name || "未匹配项目",
    task: taskById(block.projectId, block.taskId)?.name || "",
    statusTag: statusTagName(block.statusTag),
    title: block.title,
    notes: block.notes || ""
  }));
}

function summarizeActual(entries) {
  return entries.map((entry) => ({
    date: entry.date,
    duration: Number(entry.duration || 0),
    project: projectById(entry.projectId)?.name || "未匹配项目",
    task: taskById(entry.projectId, entry.taskId)?.name || "",
    title: entry.title,
    statusTag: statusTagName(entry.statusTag),
    source: entry.source || "手动记录",
    notes: entry.notes || ""
  }));
}

function summarizeStatusTags(plannedBlocks, actualEntries) {
  return {
    planned: summarizeTagHours(plannedBlocks, plannedDuration),
    actual: summarizeTagHours(actualEntries, (entry) => Number(entry.duration || 0))
  };
}

function summarizeTagHours(items, durationGetter) {
  const totals = new Map();
  items.forEach((item) => {
    const label = statusTagName(item.statusTag);
    totals.set(label, Math.round(((totals.get(label) || 0) + durationGetter(item)) * 10) / 10);
  });
  return Array.from(totals.entries()).map(([tag, hoursValue]) => ({ tag, hours: hoursValue }));
}

function summarizePastActual(date, days) {
  const dates = Array.from({ length: days }, (_, index) => dateAdd(date, -days + index));
  return dates.map((itemDate) => {
    const entries = state.actual.filter((entry) => entry.date === itemDate);
    return {
      date: itemDate,
      totalHours: entries.reduce((sum, entry) => sum + Number(entry.duration || 0), 0),
      entries: summarizeActual(entries).slice(0, 8)
    };
  });
}

function summarizeFuturePlanned(date, days) {
  const dates = Array.from({ length: days }, (_, index) => dateAdd(date, index + 1));
  return dates.map((itemDate) => {
    const blocks = state.planned.filter((block) => block.date === itemDate);
    return {
      date: itemDate,
      totalHours: blocks.reduce((sum, block) => sum + plannedDuration(block), 0),
      blocks: summarizePlanned(blocks).slice(0, 10)
    };
  });
}

function summarizeProjects() {
  return state.projects.map((project) => {
    const done = invested(project.id);
    return {
      name: project.name,
      status: project.status,
      estimate: Number(project.estimate || 0),
      invested: done,
      remaining: Math.max(0, Number(project.estimate || 0) - done),
      progress: project.estimate ? Math.round((done / Number(project.estimate)) * 100) : 0
    };
  });
}

async function requestDailyReview(context) {
  try {
    const response = await fetch(`${API_BASE}/api/daily-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    loadAiUsage();
    return payload;
  } catch {
    return null;
  }
}

function fallbackDailyReview(context) {
  const metrics = context.localMetrics;
  return {
    completionRate: metrics.completionRate,
    summary: `今天计划 ${hours(metrics.plannedHours)}，实际完成 ${hours(metrics.actualHours)}。`,
    wins: metrics.actualHours > 0 ? ["今天已经留下了实际投入记录。"] : [],
    gaps: metrics.plannedHours > metrics.actualHours ? ["实际投入少于计划，建议看一下是任务过大还是时间块安排不合适。"] : [],
    risks: context.futurePlannedSummary.some((day) => day.totalHours > 6) ? ["未来 7 天里存在计划偏满的日期。"] : [],
    adjustments: [],
    nextFocus: "先保持明天最重要的一到两个时间块，避免把补偿计划排得过满。"
  };
}

function saveAndRender() {
  applyTodayRollover();
  saveState();
  renderCalendar();
  renderProjects();
  renderHabits();
}

async function generateTasks(project, instruction = "请生成第一版任务拆解。") {
  project.aiMessages ||= [];
  project.aiMessages.push({ role: "user", content: instruction === "请生成第一版任务拆解。" ? "请根据目标生成任务拆解。" : instruction });
  const ai = await requestAiTasks(project, instruction);
  if (ai.tasks.length) {
    project.tasks = ai.tasks.map((task) => ({
      id: id("t"),
      name: task.name,
      estimate: task.estimate,
      notes: task.notes || "",
      status: "not-started"
    }));
    normalizeTaskEstimates(project);
    project.aiMessages.push({ role: "assistant", content: ai.reply || "已更新任务草稿。" });
    return;
  }

  fallbackGenerateTasks(project);
  project.aiMessages.push({ role: "assistant", content: "AI 暂时不可用，已用本地规则生成一版任务草稿。" });
}

async function requestAiTasks(project, instruction) {
  try {
    const response = await fetch(`${API_BASE}/api/ai-breakdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: project.name,
        description: project.description || "",
        estimate: Number(project.estimate) || 10,
        tasks: project.tasks || [],
        messages: project.aiMessages || [],
        instruction
      })
    });
    if (!response.ok) return { tasks: [], reply: "" };
    const payload = await response.json();
    loadAiUsage();
    return payload;
  } catch {
    return { tasks: [], reply: "" };
  }
}

function collectTaskDraft() {
  const rows = $$("#taskList .task-row");
  if (!rows.length) return projectById(state.activeProjectId)?.tasks || [];
  return rows.map((row) => ({
    id: row.dataset.task,
    name: row.querySelector("input:first-child").value.trim(),
    estimate: Number(row.querySelector("input:nth-child(2)").value),
    notes: row.querySelector("textarea")?.value.trim() || ""
  }));
}

function readTaskRow(row, existingTask = {}) {
  return {
    ...existingTask,
    id: row.dataset.task || existingTask.id || id("t"),
    name: row.querySelector("input:first-child").value.trim(),
    estimate: Number(row.querySelector("input:nth-child(2)").value),
    notes: row.querySelector("textarea")?.value.trim() || "",
    status: existingTask.status || "in-progress"
  };
}

function fallbackGenerateTasks(project) {
  const phases = ["目标梳理与资料准备", "核心知识学习", "分阶段练习", "真实项目实践", "复盘、修正与收尾"];
  const weights = [0.12, 0.28, 0.24, 0.26, 0.1];
  const totalEstimate = Number(project.estimate) > 0 ? Number(project.estimate) : 10;
  project.tasks = phases.map((phase, index) => ({
    id: id("t"),
    name: `${project.name} - ${phase}`,
    estimate: Math.max(0.5, Math.round(totalEstimate * weights[index] * 2) / 2),
    notes: "",
    status: index === 0 ? "in-progress" : "not-started"
  }));
  normalizeTaskEstimates(project);
}

async function scheduleProjectTasks(project) {
  const tasks = collectTaskDraft().filter((task) => task.name && task.estimate > 0);
  if (!tasks.length) return "还没有可安排的任务。";
  const aiBlocks = await requestAiSchedule(project, tasks);
  const blocks = aiBlocks.length ? aiBlocks : fallbackSchedule(tasks);
  blocks.forEach((block) => {
    state.planned.push({
      id: id("b"),
      date: block.date,
      start: block.start,
      end: block.end,
      title: block.title,
      projectId: project.id,
      taskId: block.taskId || tasks.find((task) => task.name === block.title)?.id || "",
      statusTag: block.statusTag || inferStatusTag(tasks.find((task) => task.id === block.taskId || task.name === block.title)),
      notes: block.notes || "",
      source: aiBlocks.length ? "AI 智能排程" : "本地规则排程"
    });
  });
  return aiBlocks.length ? "已根据现有日程智能安排到计划日历。" : "AI 排程暂时不可用，已用本地空闲时间规则安排到日历。";
}

async function requestAiSchedule(project, tasks) {
  try {
    const response = await fetch(`${API_BASE}/api/ai-schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project,
        tasks,
        existingPlanned: state.planned.slice(-80),
        startDate: state.selectedDate,
        horizonDays: 14,
        preferences: "优先安排在 09:00-12:00 和 14:00-18:00。每个计划块附带合适的状态标签。"
      })
    });
    if (!response.ok) return [];
    const data = await response.json();
    loadAiUsage();
    return Array.isArray(data.blocks) ? data.blocks : [];
  } catch {
    return [];
  }
}

function fallbackSchedule(tasks) {
  const blocks = [];
  const windows = [
    ["09:00", "12:00"],
    ["14:00", "18:00"]
  ];
  let date = state.selectedDate;
  tasks.forEach((task) => {
    let remaining = Number(task.estimate || 0);
    while (remaining > 0) {
      const slot = findNextSlot(date, windows, Math.min(remaining, 2));
      blocks.push({
        date: slot.date,
        start: slot.start,
        end: slot.end,
        taskId: task.id,
        title: task.name,
        statusTag: inferStatusTag(task),
        notes: task.notes || ""
      });
      remaining = Math.round((remaining - slot.duration) * 10) / 10;
      date = slot.date;
    }
  });
  return blocks;
}

function findNextSlot(startDate, windows, preferredHours) {
  for (let offset = 0; offset < 30; offset += 1) {
    const date = dateAdd(startDate, offset);
    for (const [start, end] of windows) {
      const slot = firstFreeInWindow(date, start, end, preferredHours);
      if (slot) return slot;
    }
  }
  return { date: startDate, start: "19:00", end: "20:00", duration: 1 };
}

function firstFreeInWindow(date, start, end, preferredHours) {
  const existing = state.planned
    .filter((block) => block.date === date)
    .filter((block) => block.start && block.end)
    .map((block) => [timeToMinutes(block.start), timeToMinutes(block.end)])
    .sort((a, b) => a[0] - b[0]);
  let cursor = timeToMinutes(start);
  const windowEnd = timeToMinutes(end);
  const duration = Math.round(Math.min(preferredHours, 2) * 60);
  for (const [busyStart, busyEnd] of existing) {
    if (cursor + duration <= busyStart) return makeSlot(date, cursor, duration);
    cursor = Math.max(cursor, busyEnd);
  }
  if (cursor + duration <= windowEnd) return makeSlot(date, cursor, duration);
  return null;
}

function makeSlot(date, startMinutes, durationMinutes) {
  return {
    date,
    start: minutesToTime(startMinutes),
    end: minutesToTime(startMinutes + durationMinutes),
    duration: durationMinutes / 60
  };
}

function normalizeTaskEstimates(project) {
  if (!(Number(project.estimate) > 0)) return;
  const total = project.tasks.reduce((sum, task) => sum + Number(task.estimate), 0);
  const diff = Math.round((Number(project.estimate) - total) * 2) / 2;
  if (project.tasks.length && diff !== 0) {
    project.tasks[project.tasks.length - 1].estimate = Math.max(0.5, project.tasks.at(-1).estimate + diff);
  }
}

function exportIcs() {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Self Calendar//MVP//CN"];
  state.planned.forEach((block) => {
    const project = projectById(block.projectId);
    const allDay = !block.start || !block.end;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${block.id}@self-calendar`,
      `DTSTAMP:${toIcsDateTime(new Date())}`,
      allDay ? `DTSTART;VALUE=DATE:${block.date.replaceAll("-", "")}` : `DTSTART:${toLocalIcsDateTime(block.date, block.start)}`,
      allDay ? `DTEND;VALUE=DATE:${dateAdd(block.date, 1).replaceAll("-", "")}` : `DTEND:${toLocalIcsDateTime(block.date, block.end)}`,
      `SUMMARY:${escapeIcs(`${project?.name || "Project"} - ${block.title}`)}`,
      `DESCRIPTION:${escapeIcs(block.notes || "")}`,
      "END:VEVENT"
    );
  });
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "self-calendar-planned.ics";
  link.click();
  URL.revokeObjectURL(url);
}

function importIcs(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const events = String(reader.result).split("BEGIN:VEVENT").slice(1);
    events.forEach((eventText) => {
      const summary = readIcsField(eventText, "SUMMARY") || "Imported plan";
      const description = readIcsField(eventText, "DESCRIPTION") || "";
      const start = parseIcsDate(readIcsField(eventText, "DTSTART"));
      const end = parseIcsDate(readIcsField(eventText, "DTEND"));
      if (!start || !end || !state.projects.length) return;
      const matchedProject =
        state.projects.find((project) => summary.toLowerCase().includes(project.name.toLowerCase())) || state.projects[0];
      state.planned.push({
        id: id("b"),
        date: start.date,
        start: start.time,
        end: end.time,
        title: summary.replace(matchedProject.name, "").replace(/^[-: ]+/, "") || summary,
        projectId: matchedProject.id,
        notes: description,
        source: "imported from ICS"
      });
    });
    saveAndRender();
  };
  reader.readAsText(file);
}

function bindEvents() {
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.calendarMode = button.dataset.calendarMode;
      saveAndRender();
    });
  });
  $$(".habit-mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.habitMode = button.dataset.habitMode;
      saveAndRender();
    });
  });
  $("#selectedDate").addEventListener("change", (event) => {
    state.selectedDate = event.target.value;
    saveAndRender();
  });
  $("#habitDate").addEventListener("change", (event) => {
    state.habitDate = event.target.value;
    saveAndRender();
  });
  ["#planProject", "#actualProject", "#timerProject"].forEach((selector) => {
    $(selector).addEventListener("change", renderTaskOptions);
  });
  $("#projectForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const project = {
      id: id("p"),
      name: $("#projectName").value.trim(),
      estimate: $("#projectEstimate").value ? Number($("#projectEstimate").value) : null,
      status: $("#projectStatus").value,
      description: $("#projectDescription").value.trim(),
      createdAt: new Date().toISOString(),
      tasks: [],
      aiMessages: []
    };
    state.projects.push(project);
    state.activeProjectId = project.id;
    event.target.reset();
    saveAndRender();
  });
  $("#planForm").addEventListener("submit", (event) => {
    event.preventDefault();
    addPlanned({
      date: state.selectedDate,
      projectId: $("#planProject").value,
      taskId: $("#planTask").value,
      title: $("#planTitle").value.trim() || taskById($("#planProject").value, $("#planTask").value)?.name || "未命名计划",
      start: $("#planStart").value,
      end: $("#planEnd").value,
      statusTag: $("#planStatusTag").value,
      notes: $("#planNotes").value.trim()
    });
    event.target.reset();
  });
  $("#actualForm").addEventListener("submit", (event) => {
    event.preventDefault();
    addActual({
      date: state.selectedDate,
      projectId: $("#actualProject").value,
      taskId: $("#actualTask").value,
      title: $("#actualTitle").value.trim(),
      duration: Number($("#actualDuration").value),
      statusTag: $("#actualStatusTag").value,
      notes: $("#actualNotes").value.trim()
    });
    event.target.reset();
  });
  $("#habitForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const typedName = $("#habitName").value.trim();
    let habit = typedName ? state.habits.find((item) => item.name === typedName) : state.habits.find((item) => item.id === $("#habitSelect").value);
    if (!habit && typedName) {
      habit = { id: id("h"), name: typedName, color: nextHabitColor(), createdAt: new Date().toISOString() };
      state.habits.push(habit);
    }
    if (!habit) return;
    state.habitLogs.push({
      id: id("hl"),
      habitId: habit.id,
      date: state.habitDate || state.selectedDate || today,
      time: $("#habitTime").value || currentTimeValue(),
      notes: $("#habitNotes").value.trim()
    });
    $("#habitName").value = "";
    $("#habitNotes").value = "";
    $("#habitTime").value = currentTimeValue();
    saveAndRender();
  });
  document.body.addEventListener("submit", async (event) => {
    if (event.target.id === "manualTaskForm") {
      event.preventDefault();
      const project = projectById(state.activeProjectId);
      if (!project) return;
      project.tasks ||= [];
      project.tasks.push({
        id: id("t"),
        name: $("#manualTaskName").value.trim(),
        estimate: Number($("#manualTaskEstimate").value),
        notes: $("#manualTaskNotes").value.trim(),
        status: "not-started",
        editing: false
      });
      event.target.reset();
      saveAndRender();
      return;
    }
    if (event.target.id !== "aiPromptForm") return;
    event.preventDefault();
    const project = projectById(state.activeProjectId);
    const prompt = $("#aiPrompt").value.trim();
    if (!project || !prompt) return;
    $("#aiPrompt").value = "";
    try {
      await streamProjectChat(project, prompt);
    } catch (error) {
      project.aiMessages ||= [];
      if (!project.aiMessages.some((message) => message.role === "user" && message.content === prompt)) {
        project.aiMessages.push({ role: "user", content: prompt, createdAt: new Date().toISOString() });
      }
      const last = project.aiMessages.at(-1);
      const detail = error.message ? `（${error.message}）` : "";
      if (last?.role === "assistant" && !last.content.trim()) {
        last.content = `实时 AI 暂时连接失败${detail}。我先把你的问题保存下来。请检查豆包环境变量或稍后再试。`;
      } else {
        project.aiMessages.push({ role: "assistant", content: `实时 AI 暂时连接失败${detail}。我先把你的问题保存下来。请检查豆包环境变量或稍后再试。`, createdAt: new Date().toISOString() });
      }
    }
    saveAndRender();
  });
  $("#reviewPromptForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = $("#reviewPrompt").value.trim();
    if (!prompt) return;
    $("#reviewPrompt").value = "";
    try {
      await streamReviewChat(state.selectedDate, prompt);
    } catch (error) {
      if (!reviewMessagesForDate(state.selectedDate).some((message) => message.role === "user" && message.content === prompt)) {
        appendReviewUserMessage(state.selectedDate, prompt);
      }
      const last = reviewMessagesForDate(state.selectedDate).at(-1);
      if (last?.role === "assistant" && !last.content.trim()) {
        last.content = `实时 AI 暂时连接失败${error.message ? `（${error.message}）` : ""}。` + answerReviewPrompt(state.selectedDate, prompt);
      } else {
        appendReviewAssistantMessage(state.selectedDate, `实时 AI 暂时连接失败${error.message ? `（${error.message}）` : ""}。` + answerReviewPrompt(state.selectedDate, prompt));
      }
    }
    saveAndRender();
  });
  document.body.addEventListener("dragstart", (event) => {
    const planItem = event.target.closest("[data-range-plan]");
    if (!planItem) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", planItem.dataset.rangePlan);
    planItem.classList.add("dragging");
  });
  document.body.addEventListener("dragend", (event) => {
    event.target.closest("[data-range-plan]")?.classList.remove("dragging");
    $$(".date-cell.drag-over").forEach((cell) => cell.classList.remove("drag-over"));
  });
  document.body.addEventListener("dragover", (event) => {
    const dateCell = event.target.closest("[data-select-date]");
    if (!dateCell) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    dateCell.classList.add("drag-over");
  });
  document.body.addEventListener("dragleave", (event) => {
    const dateCell = event.target.closest("[data-select-date]");
    if (!dateCell || dateCell.contains(event.relatedTarget)) return;
    dateCell.classList.remove("drag-over");
  });
  document.body.addEventListener("drop", (event) => {
    const dateCell = event.target.closest("[data-select-date]");
    if (!dateCell) return;
    event.preventDefault();
    dateCell.classList.remove("drag-over");
    const planId = event.dataTransfer.getData("text/plain");
    const block = state.planned.find((item) => item.id === planId);
    if (!block || block.date === dateCell.dataset.selectDate) return;
    block.date = dateCell.dataset.selectDate;
    state.selectedDate = block.date;
    saveAndRender();
  });
  document.body.addEventListener("click", async (event) => {
    const target = event.target;
    const rangePlan = target.closest("[data-range-plan]");
    if (rangePlan) {
      const block = state.planned.find((item) => item.id === rangePlan.dataset.rangePlan);
      if (block) {
        state.selectedDate = block.date;
        const shouldDelete = window.confirm(`是否删除这个计划？\n\n${block.date} ${planTimeLabel(block)}\n${block.title}`);
        if (shouldDelete) {
          state.planned = state.planned.filter((item) => item.id !== block.id);
        }
        saveAndRender();
      }
      return;
    }
    const projectCard = target.closest("[data-project]");
    if (projectCard) {
      state.activeProjectId = projectCard.dataset.project;
      saveAndRender();
    }
    if (target.dataset.selectDate) {
      state.selectedDate = target.dataset.selectDate;
      saveAndRender();
    }
    if (target.dataset.deletePlan) {
      state.planned = state.planned.filter((block) => block.id !== target.dataset.deletePlan);
      saveAndRender();
    }
    if (target.dataset.deleteActual) {
      state.actual = state.actual.filter((entry) => entry.id !== target.dataset.deleteActual);
      saveAndRender();
    }
    if (target.dataset.deleteHabitLog) {
      state.habitLogs = state.habitLogs.filter((log) => log.id !== target.dataset.deleteHabitLog);
      saveAndRender();
    }
    if (target.dataset.copyPlan) {
      const block = state.planned.find((item) => item.id === target.dataset.copyPlan);
      if (block) {
        addActual({
          date: block.date,
          projectId: block.projectId,
          taskId: block.taskId,
          title: block.title,
          duration: plannedDuration(block),
          statusTag: block.statusTag,
          source: "由计划转为实际",
          notes: block.notes
        });
      }
    }
    if (target.dataset.deleteProject) {
      const projectId = target.dataset.deleteProject;
      state.projects = state.projects.filter((project) => project.id !== projectId);
      state.planned = state.planned.filter((block) => block.projectId !== projectId);
      state.actual = state.actual.filter((entry) => entry.projectId !== projectId);
      state.activeProjectId = state.projects[0]?.id || "";
      saveAndRender();
    }
    if (target.id === "generateTasks") {
      const project = projectById(state.activeProjectId);
      if (project) {
        target.textContent = "生成中...";
        target.disabled = true;
        await generateTasks(project);
        saveAndRender();
      }
    }
    if (target.id === "acceptTasks") {
      const project = projectById(state.activeProjectId);
      if (project) {
        project.tasks = collectTaskDraft().map((task) => ({ id: task.id || id("t"), ...task, editing: false, status: "in-progress" }));
        normalizeTaskEstimates(project);
        saveAndRender();
      }
    }
    if (target.dataset.editTask) {
      const project = projectById(state.activeProjectId);
      const row = target.closest(".task-row");
      const task = project?.tasks.find((item) => item.id === target.dataset.editTask);
      if (project && row && task) {
        if (task.editing) {
          Object.assign(task, readTaskRow(row, task), { editing: false });
        } else {
          task.editing = true;
        }
        saveAndRender();
      }
    }
    if (target.id === "scheduleTasks") {
      const project = projectById(state.activeProjectId);
      if (project) {
        target.textContent = "安排中...";
        target.disabled = true;
        const message = await scheduleProjectTasks(project);
        project.aiMessages ||= [];
        project.aiMessages.push({ role: "assistant", content: message });
        saveAndRender();
      }
    }
    if (target.dataset.deleteTask) {
      const project = projectById(state.activeProjectId);
      if (project) {
        project.tasks = project.tasks.filter((task) => task.id !== target.dataset.deleteTask);
        saveAndRender();
      }
    }
  });
  $("#exportIcs").addEventListener("click", exportIcs);
  $("#importIcs").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) importIcs(file);
  });
  $("#timerStart").addEventListener("click", startTimer);
  $("#timerPause").addEventListener("click", pauseTimer);
  $("#timerStop").addEventListener("click", () => stopTimer(true));
  $("#focusClose").addEventListener("click", hideFocusOverlay);
  $("#focusPause").addEventListener("click", toggleFocusPause);
  $("#focusSave").addEventListener("click", () => stopTimer(true));
  $("#focusDiscard").addEventListener("click", () => stopTimer(false));
  $("#focusNotes").addEventListener("input", (event) => {
    timer.notes = event.target.value;
    saveTimerState();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && timer.active) tickTimer();
    if (document.visibilityState === "hidden") saveTimerState();
  });
  window.addEventListener("focus", () => {
    if (timer.active) tickTimer();
  });
  window.addEventListener("pageshow", () => {
    if (timer.active) tickTimer();
  });
  $("#runDailyReview").addEventListener("click", async (event) => {
    event.target.textContent = "复盘中...";
    event.target.disabled = true;
    await runDailyReview();
    saveAndRender();
  });
  $("#timerMinutes").addEventListener("change", () => {
    if (!timer.active) {
      timer.secondsLeft = Number($("#timerMinutes").value || 25) * 60;
      timer.totalSeconds = timer.secondsLeft;
      updateTimerDisplay();
    }
  });
}

function startTimer() {
  if (timer.running) return;
  if (!timer.active) {
    timer.totalSeconds = Number($("#timerMinutes").value || 25) * 60;
    timer.secondsLeft = timer.totalSeconds;
    timer.projectId = $("#timerProject").value;
    timer.taskId = $("#timerTask").value;
    timer.pausedElapsedSeconds = 0;
    timer.notes = $("#focusNotes").value.trim();
    timer.active = true;
  }
  showFocusOverlay();
  timer.running = true;
  timer.startedAt = Date.now();
  saveTimerState();
  timer.interval = setInterval(tickTimer, 1000);
  tickTimer();
}

function pauseTimer() {
  updateTimerFromClock();
  clearInterval(timer.interval);
  timer.interval = null;
  timer.pausedElapsedSeconds = getTimerElapsedSeconds();
  timer.startedAt = null;
  timer.running = false;
  saveTimerState();
  updateFocusControls();
}

function stopTimer(saveElapsed = true) {
  updateTimerFromClock();
  const elapsedSeconds = getTimerElapsedSeconds();
  timer.notes = $("#focusNotes").value.trim();
  clearInterval(timer.interval);
  timer.interval = null;
  if (saveElapsed && elapsedSeconds > 0) {
    addActual({
      date: state.selectedDate,
      projectId: timer.projectId || $("#timerProject").value,
      taskId: timer.taskId || $("#timerTask").value,
      title: "番茄钟专注",
      duration: Math.round((elapsedSeconds / 3600) * 100) / 100,
      statusTag: inferStatusTag(taskById(timer.projectId || $("#timerProject").value, timer.taskId || $("#timerTask").value)),
      source: "pomodoro",
      notes: timer.notes || "由番茄钟自动记录。"
    });
  }
  timer.secondsLeft = Number($("#timerMinutes").value || 25) * 60;
  timer.totalSeconds = timer.secondsLeft;
  timer.active = false;
  timer.running = false;
  timer.startedAt = null;
  timer.pausedElapsedSeconds = 0;
  timer.projectId = "";
  timer.taskId = "";
  timer.notes = "";
  $("#focusNotes").value = "";
  hideFocusOverlay();
  localStorage.removeItem(TIMER_STORAGE_KEY);
  updateTimerDisplay();
}

function completeTimer() {
  stopTimer(true);
}

function updateTimerDisplay() {
  updateTimerFromClock();
  const minutes = Math.floor(timer.secondsLeft / 60).toString().padStart(2, "0");
  const seconds = Math.floor(timer.secondsLeft % 60).toString().padStart(2, "0");
  $("#timerDisplay").textContent = `${minutes}:${seconds}`;
  $("#focusTime").textContent = `${minutes}:${seconds}`;
  const elapsed = getTimerElapsedSeconds();
  const pct = timer.totalSeconds ? Math.min(100, Math.round((elapsed / timer.totalSeconds) * 100)) : 0;
  $("#focusPercent").textContent = `${pct}%`;
  $("#focusProgressBar").style.width = `${pct}%`;
  $("#focusRing").style.setProperty("--focus-progress", `${pct}%`);
  updateFocusControls();
}

function showFocusOverlay() {
  const project = projectById(timer.projectId || $("#timerProject").value);
  $("#focusProjectName").textContent = project?.name || "番茄钟";
  $("#focusNotes").value = timer.notes || $("#focusNotes").value || "";
  $("#focusOverlay").classList.add("active");
  $("#focusOverlay").setAttribute("aria-hidden", "false");
  updateTimerDisplay();
  setTimeout(() => $("#focusNotes").focus(), 80);
}

function hideFocusOverlay() {
  $("#focusOverlay").classList.remove("active");
  $("#focusOverlay").setAttribute("aria-hidden", "true");
}

function toggleFocusPause() {
  if (timer.running) {
    pauseTimer();
    return;
  }
  startTimer();
}

function updateFocusControls() {
  $("#focusPause").textContent = timer.running ? "暂停" : "继续";
}

function tickTimer() {
  updateTimerFromClock();
  updateTimerDisplay();
  saveTimerState();
  if (timer.secondsLeft <= 0) completeTimer();
}

function updateTimerFromClock() {
  if (!timer.active) return;
  timer.secondsLeft = Math.max(0, timer.totalSeconds - getTimerElapsedSeconds());
}

function getTimerElapsedSeconds() {
  const liveSeconds = timer.running && timer.startedAt ? Math.floor((Date.now() - timer.startedAt) / 1000) : 0;
  return Math.min(timer.totalSeconds, Math.max(0, Number(timer.pausedElapsedSeconds || 0) + liveSeconds));
}

function saveTimerState() {
  if (!timer.active) {
    localStorage.removeItem(TIMER_STORAGE_KEY);
    return;
  }
  localStorage.setItem(
    TIMER_STORAGE_KEY,
    JSON.stringify({
      secondsLeft: timer.secondsLeft,
      totalSeconds: timer.totalSeconds,
      running: timer.running,
      active: timer.active,
      startedAt: timer.startedAt,
      pausedElapsedSeconds: timer.pausedElapsedSeconds,
      projectId: timer.projectId,
      taskId: timer.taskId,
      notes: timer.notes
    })
  );
}

function restoreTimer() {
  const raw = localStorage.getItem(TIMER_STORAGE_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (!saved.active || !saved.totalSeconds) return;
    timer = {
      ...timer,
      ...saved,
      interval: null
    };
    $("#focusNotes").value = timer.notes || "";
    showFocusOverlay();
    if (timer.running) {
      timer.interval = setInterval(tickTimer, 1000);
      tickTimer();
    }
  } catch {
    localStorage.removeItem(TIMER_STORAGE_KEY);
  }
}

function timeToMinutes(time) {
  const [hoursPart, minutesPart] = time.split(":").map(Number);
  return hoursPart * 60 + minutesPart;
}

function minutesToTime(value) {
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

function formatDateShort(date) {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toIcsDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toLocalIcsDateTime(date, time) {
  return `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;
}

function parseIcsDate(value) {
  if (!value) return null;
  const clean = value.replace("Z", "");
  const date = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
  const time = `${clean.slice(9, 11)}:${clean.slice(11, 13)}`;
  return { date, time };
}

function readIcsField(text, field) {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(`${field}:`));
  return line ? unescapeIcs(line.slice(field.length + 1).trim()) : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function escapeIcs(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll(",", "\\,").replaceAll(";", "\\;").replaceAll("\n", "\\n");
}

function unescapeIcs(value) {
  return String(value || "").replaceAll("\\n", "\n").replaceAll("\\,", ",").replaceAll("\\;", ";").replaceAll("\\\\", "\\");
}

function statusLabel(status) {
  return {
    "not-started": "未开始",
    "in-progress": "进行中",
    paused: "暂停",
    completed: "完成"
  }[status] || status;
}

bindEvents();
renderCalendar();
renderProjects();
renderHabits();
updateTimerDisplay();
restoreTimer();
hydrateStateFromServer();
loadAiUsage();
setInterval(() => {
  const previousToday = today;
  applyTodayRollover();
  if (today !== previousToday) saveAndRender();
}, 60_000);
setInterval(loadAiUsage, 60_000);
