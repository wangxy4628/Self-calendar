const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
loadEnvFile(path.join(root, ".env"));

const port = Number(process.env.PORT || 5173);
const doubaoApiKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || "";
const doubaoModel = process.env.DOUBAO_MODEL || process.env.ARK_MODEL || "";
const doubaoUrl = process.env.DOUBAO_URL || "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const dataDir = path.join(root, "data");
const stateFile = path.join(dataDir, "state.json");
const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL || "");
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const supabaseTable = process.env.SUPABASE_STATE_TABLE || "self_calendar_state";
const supabaseStateId = process.env.SUPABASE_STATE_ID || "default";
const syncToken = process.env.SYNC_TOKEN || "";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

const routes = {
  "/api/ai-breakdown": handleAiBreakdown,
  "/api/ai-schedule": handleAiSchedule,
  "/api/daily-review": handleDailyReview,
  "/api/state": handleState
};

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && routes[req.url]) {
    await routes[req.url](req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`Self Calendar running at http://localhost:${port}`);
});

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separator = trimmed.indexOf("=");
    if (separator === -1) return;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

function normalizeSupabaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/$/, "");
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/rest\/v1\/?$/, "");
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function handleAiBreakdown(req, res) {
  try {
    const body = await readJson(req);
    const system =
      "你是个人时间管理产品里的目标拆解助手。必须只使用简体中文。只返回 JSON，不要 markdown。" +
      'JSON 结构必须是 {"tasks":[{"name":"...","estimate":数字,"notes":"..."}],"reply":"一句简短中文说明"}。' +
      "任务预计小时总和应尽量接近项目预计总小时。任务要具体、可执行、适合放进日历时间块。";
    const user = JSON.stringify({
      projectName: body.name,
      description: body.description || "",
      estimatedTotalHours: body.estimate,
      currentTasks: body.tasks || [],
      conversation: body.messages || [],
      instruction: body.instruction || "请生成第一版任务拆解。"
    });

    const parsed = await callDoubao(system, user);
    sendJson(res, 200, {
      tasks: sanitizeTasks(parsed.tasks, body.estimate),
      reply: String(parsed.reply || "已更新任务草稿。")
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "AI breakdown failed." });
  }
}

async function handleAiSchedule(req, res) {
  try {
    const body = await readJson(req);
    const system =
      "你是个人时间管理产品里的智能排程助手。必须只使用简体中文。只返回 JSON，不要 markdown。" +
      'JSON 结构必须是 {"blocks":[{"date":"YYYY-MM-DD","start":"HH:mm","end":"HH:mm","taskId":"原任务 id","title":"...","notes":"..."}],"reply":"一句简短中文说明"}。' +
      "只能生成计划时间块，不要生成实际记录。避开已有计划块。除非用户特别要求，单个任务块不要超过 2 小时。";
    const user = JSON.stringify({
      projectName: body.project?.name,
      projectDescription: body.project?.description || "",
      tasks: body.tasks || [],
      existingPlannedBlocks: body.existingPlanned || [],
      startDate: body.startDate,
      horizonDays: body.horizonDays || 14,
      preferences: body.preferences || "优先安排在 09:00-12:00 和 14:00-18:00。避免某一天排得过满。"
    });

    const parsed = await callDoubao(system, user);
    sendJson(res, 200, {
      blocks: sanitizeBlocks(parsed.blocks, body.tasks || []),
      reply: String(parsed.reply || "已根据现有日程生成计划块。")
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "AI schedule failed." });
  }
}

async function handleDailyReview(req, res) {
  try {
    const body = await readJson(req);
    const system =
      "你是个人时间管理产品里的每日复盘助手。必须只使用简体中文。只返回 JSON，不要 markdown。" +
      'JSON 结构必须是 {"completionRate":数字,"summary":"...","wins":["..."],"gaps":["..."],"risks":["..."],"adjustments":[{"title":"...","reason":"...","suggestion":"..."}],"nextFocus":"..."}。' +
      "请简洁、具体、可执行。不要声称已经修改未来日历，只能把调整作为草稿建议。";
    const user = JSON.stringify({
      reviewDate: body.reviewDate,
      todayPlanned: body.todayPlanned || [],
      todayActual: body.todayActual || [],
      pastActualSummary: body.pastActualSummary || [],
      futurePlannedSummary: body.futurePlannedSummary || [],
      projectSummary: body.projectSummary || [],
      localMetrics: body.localMetrics || {}
    });

    const parsed = await callDoubao(system, user);
    sendJson(res, 200, sanitizeReview(parsed, body.localMetrics));
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Daily review failed." });
  }
}

async function handleState(req, res) {
  try {
    if (!isStateRequestAuthorized(req)) {
      sendJson(res, 401, { error: "Unauthorized state sync request." });
      return;
    }
    if (req.method === "GET") {
      const localState = readLocalState();
      const cloudResult = await readCloudState();
      const selectedState = chooseState(localState, cloudResult.state);
      if (selectedState && selectedState !== localState) {
        writeLocalState(selectedState);
      }
      sendJson(res, 200, {
        exists: Boolean(selectedState),
        state: selectedState,
        sync: {
          cloudEnabled: isCloudSyncConfigured(),
          cloudOk: cloudResult.ok,
          cloudError: cloudResult.error || null
        }
      });
      return;
    }

    const body = await readJson(req);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "State body must be an object." });
      return;
    }
    const stampedState = stampState(body);
    writeLocalState(stampedState);
    const cloudResult = await writeCloudState(stampedState);
    sendJson(res, 200, {
      ok: true,
      sync: {
        cloudEnabled: isCloudSyncConfigured(),
        cloudOk: cloudResult.ok,
        cloudError: cloudResult.error || null
      }
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "State sync failed." });
  }
}

function isStateRequestAuthorized(req) {
  if (!syncToken) return true;
  const headerToken = req.headers["x-sync-token"];
  const auth = req.headers.authorization || "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  return headerToken === syncToken || bearerToken === syncToken;
}

function readLocalState() {
  if (!fs.existsSync(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function writeLocalState(state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function stampState(state) {
  return {
    ...state,
    syncMeta: {
      ...(state.syncMeta || {}),
      localUpdatedAt: new Date().toISOString()
    }
  };
}

function chooseState(localState, cloudState) {
  if (!localState) return cloudState || null;
  if (!cloudState) return localState;
  const localTime = Date.parse(localState.syncMeta?.cloudUpdatedAt || localState.syncMeta?.localUpdatedAt || 0);
  const cloudTime = Date.parse(cloudState.syncMeta?.cloudUpdatedAt || cloudState.syncMeta?.localUpdatedAt || 0);
  return cloudTime > localTime ? cloudState : localState;
}

function isCloudSyncConfigured() {
  return Boolean(supabaseUrl && supabaseKey);
}

async function readCloudState() {
  if (!isCloudSyncConfigured()) return { ok: false, state: null, error: "Supabase is not configured." };
  try {
    const url = `${supabaseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}?id=eq.${encodeURIComponent(supabaseStateId)}&select=id,state,updated_at&limit=1`;
    const response = await fetch(url, { headers: supabaseHeaders() });
    if (!response.ok) return { ok: false, state: null, error: await response.text() };
    const rows = await response.json();
    if (!rows.length) return { ok: true, state: null, error: null };
    return {
      ok: true,
      state: {
        ...(rows[0].state || {}),
        syncMeta: {
          ...((rows[0].state || {}).syncMeta || {}),
          cloudUpdatedAt: rows[0].updated_at
        }
      },
      error: null
    };
  } catch (error) {
    return { ok: false, state: null, error: error.message || "Cloud read failed." };
  }
}

async function writeCloudState(state) {
  if (!isCloudSyncConfigured()) return { ok: false, error: "Supabase is not configured." };
  try {
    const cloudUpdatedAt = new Date().toISOString();
    const stateForCloud = {
      ...state,
      syncMeta: {
        ...(state.syncMeta || {}),
        cloudUpdatedAt
      }
    };
    const response = await fetch(`${supabaseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        id: supabaseStateId,
        state: stateForCloud,
        updated_at: cloudUpdatedAt
      })
    });
    if (!response.ok) return { ok: false, error: await response.text() };
    writeLocalState(stateForCloud);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message || "Cloud write failed." };
  }
}

function supabaseHeaders() {
  return {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };
}

async function callDoubao(system, user) {
  if (!doubaoApiKey || !doubaoModel) {
    const error = new Error("DOUBAO_API_KEY and DOUBAO_MODEL are required for live AI generation.");
    error.status = 503;
    throw error;
  }

  const completion = await fetch(doubaoUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${doubaoApiKey}`
    },
    body: JSON.stringify({
      model: doubaoModel,
      temperature: 0.35,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  const payload = await completion.json();
  if (!completion.ok) {
    const error = new Error(payload.error?.message || payload.message || "Doubao request failed.");
    error.status = completion.status;
    throw error;
  }

  return parseJsonFromText(payload.choices?.[0]?.message?.content || "");
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const filePath = path.join(root, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("AI response did not contain JSON.");
    }
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function sanitizeTasks(tasks, estimate) {
  if (!Array.isArray(tasks)) throw new Error("AI response did not include a tasks array.");
  const cleaned = tasks
    .map((task) => ({
      name: String(task.name || "").trim(),
      estimate: Math.max(0.5, Math.round(Number(task.estimate || 0) * 2) / 2),
      notes: String(task.notes || "").trim()
    }))
    .filter((task) => task.name && task.estimate > 0);

  if (!cleaned.length) throw new Error("AI response returned no usable tasks.");
  const total = cleaned.reduce((sum, task) => sum + task.estimate, 0);
  const diff = Math.round((Number(estimate || total) - total) * 2) / 2;
  cleaned[cleaned.length - 1].estimate = Math.max(0.5, cleaned[cleaned.length - 1].estimate + diff);
  return cleaned;
}

function sanitizeBlocks(blocks, tasks = []) {
  if (!Array.isArray(blocks)) throw new Error("AI response did not include a blocks array.");
  return blocks
    .map((block, index) => {
      const fallbackTask = tasks[Math.min(index, Math.max(0, tasks.length - 1))] || {};
      const title = String(block.title || "").trim();
      return {
        date: String(block.date || "").slice(0, 10),
        start: String(block.start || "").slice(0, 5),
        end: String(block.end || "").slice(0, 5),
        taskId: String(block.taskId || fallbackTask.id || "").trim(),
        title: title && !/^\?+$/.test(title) ? title : String(fallbackTask.name || "计划任务"),
        notes: String(block.notes || fallbackTask.notes || "").trim()
      };
    })
    .filter((block) => /^\d{4}-\d{2}-\d{2}$/.test(block.date) && /^\d{2}:\d{2}$/.test(block.start) && /^\d{2}:\d{2}$/.test(block.end) && block.title);
}

function sanitizeReview(review, metrics = {}) {
  return {
    completionRate: clampNumber(review.completionRate ?? metrics.completionRate ?? 0, 0, 200),
    summary: String(review.summary || "今天的计划和实际已完成复盘。").trim(),
    wins: sanitizeStringList(review.wins),
    gaps: sanitizeStringList(review.gaps),
    risks: sanitizeStringList(review.risks),
    adjustments: Array.isArray(review.adjustments)
      ? review.adjustments.slice(0, 5).map((item) => ({
          title: String(item.title || "调整建议").trim(),
          reason: String(item.reason || "").trim(),
          suggestion: String(item.suggestion || "").trim()
        }))
      : [],
    nextFocus: String(review.nextFocus || "").trim()
  };
}

function sanitizeStringList(list) {
  return Array.isArray(list) ? list.slice(0, 6).map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}
