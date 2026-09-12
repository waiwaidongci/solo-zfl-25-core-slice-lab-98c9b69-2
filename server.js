import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATA_FILE
  ? (process.env.DATA_FILE.startsWith("/") ? process.env.DATA_FILE : join(__dirname, process.env.DATA_FILE))
  : join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

const seed = {
  samples: [
    {
      id: "CORE-001",
      batchId: "B-2026-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      createdAt: "2026-06-12T10:00:00.000Z",
      dueDate: "2026-08-31",
      slices: [
        {
          id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨",
          logs: [
            { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" },
            { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }
          ]
        }
      ]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 旧数据迁移：补齐批次与日期字段
  let changed = false;
  for (const sample of db.samples || []) {
    if (!sample.batchId) { sample.batchId = "B-LEGACY"; changed = true; }
    if (!sample.createdAt) {
      sample.createdAt = sample.slices?.[0]?.logs?.[0]?.at || "2026-01-01T00:00:00.000Z";
      changed = true;
    }
    if (!sample.dueDate) { sample.dueDate = ""; changed = true; }
  }
  if (changed) await writeFile(dbPath, JSON.stringify(db, null, 2));
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

// ---- 业务规则 ----
function observationDone(slice) {
  return slice.status === "观察" && (slice.observation || "").trim() !== "";
}
function nextStepOf(slice) {
  if (observationDone(slice)) return null;
  if (slice.status === "观察") return "观察"; // 已到观察步骤但观察记录缺失
  const idx = taskSteps.indexOf(slice.status);
  return taskSteps[Math.min(idx + 1, taskSteps.length - 1)];
}
// 步骤流转：仅允许停留在当前步骤（补记备注）或推进到紧邻的下一步；跳步、回退均非法
function checkStepTransition(slice, target) {
  const fromIdx = taskSteps.indexOf(slice.status);
  const toIdx = taskSteps.indexOf(target);
  if (toIdx === fromIdx) return { ok: true, advance: false };
  if (toIdx === fromIdx + 1) return { ok: true, advance: true };
  const reason = toIdx < fromIdx
    ? `步骤不可回退：当前为「${slice.status}」，不能改回「${target}」`
    : `步骤不可跳步：需按 ${taskSteps.join("→")} 顺序推进，当前为「${slice.status}」，下一步应为「${taskSteps[fromIdx + 1]}」`;
  return { ok: false, reason };
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function isValidDateStr(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [, y, m, d] = v.match(/^(\d{4})-(\d{2})-(\d{2})$/).map(Number);
  // 回读构造日期的年月日分量，排除 02-30、04-31 这类被 Date 自动进位的不存在日期
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
// 批次计划完成日 = 组内最早的样本截止日；为空则视为无期限
function batchDueDate(samples) {
  const dates = samples.map(s => s.dueDate).filter(isValidDateStr).sort();
  return dates[0] || "";
}
function buildBatch(batchId, samples) {
  const today = todayStr();
  let totalSlices = 0;
  let observedSlices = 0;
  const owners = [];
  const projects = [];
  const pending = []; // 未完成观察的切片（含下一步信息）
  const overdue = [];
  for (const sample of samples) {
    if (!owners.includes(sample.owner)) owners.push(sample.owner);
    if (!projects.includes(sample.project)) projects.push(sample.project);
    for (const slice of sample.slices) {
      totalSlices += 1;
      const done = observationDone(slice);
      if (done) observedSlices += 1;
      const nextStep = nextStepOf(slice);
      if (!done) {
        pending.push({
          sampleId: sample.id,
          sliceId: slice.id,
          owner: sample.owner,
          currentStep: slice.status,
          nextStep
        });
      }
      if (!done && sample.dueDate && isValidDateStr(sample.dueDate) && sample.dueDate < today) {
        overdue.push({
          sampleId: sample.id,
          sliceId: slice.id,
          owner: sample.owner,
          dueDate: sample.dueDate,
          nextStep
        });
      }
    }
  }
  const delivered = samples.every(s => s.delivery === "已交付");
  // 状态聚合规则与样本（updateSampleStatus）保持一致：只看切片所处步骤，
  // 切片全部走到“观察”即视为待观察，即使观察记录尚未填写
  const sliceSteps = samples.flatMap(s => s.slices.map(c => c.status));
  let status;
  if (delivered) status = "已交付";
  else if (sliceSteps.length && sliceSteps.every(step => step === "观察")) status = "待观察";
  else if (sliceSteps.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) status = "制片中";
  else status = "待切割";

  // 下一步负责人：优先逾期项，其次取下一步流程最靠前的待办
  const stepRank = step => taskSteps.indexOf(step);
  const candidates = overdue.length ? overdue : pending;
  candidates.sort((a, b) => stepRank(a.nextStep) - stepRank(b.nextStep));
  const next = candidates[0]
    ? { owner: candidates[0].owner, step: candidates[0].nextStep, sampleId: candidates[0].sampleId, sliceId: candidates[0].sliceId, overdue: overdue.length > 0 }
    : null;

  const createdAt = samples.map(s => s.createdAt).sort()[0];
  return {
    id: batchId,
    project: projects.join("、"),
    projects,
    owners,
    status,
    createdAt,
    dueDate: batchDueDate(samples),
    sampleCount: samples.length,
    totalSlices,
    observedSlices,
    progress: totalSlices ? Math.round((observedSlices / totalSlices) * 100) : 0,
    overdue,
    overdueCount: overdue.length,
    next,
    samples: samples.map(s => ({
      id: s.id, project: s.project, borehole: s.borehole, coreBox: s.coreBox,
      depth: s.depth, owner: s.owner, status: s.status, delivery: s.delivery,
      createdAt: s.createdAt, dueDate: s.dueDate, slices: s.slices
    }))
  };
}
function allBatches(db) {
  const groups = new Map();
  for (const sample of db.samples) {
    if (!groups.has(sample.batchId)) groups.set(sample.batchId, []);
    groups.get(sample.batchId).push(sample);
  }
  return [...groups.entries()].map(([id, items]) => buildBatch(id, items))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function updateSampleStatus(sample) {
  if (sample.delivery === "已交付") {
    sample.status = "已交付";
    return;
  }
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) {
    sample.status = "待观察";
  } else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) {
    sample.status = "制片中";
  } else {
    sample.status = "待切割";
  }
}

function queryBatches(db, params) {
  const allowed = ["project", "owner", "status", "from", "to"];
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      return { error: 400, body: { error: "invalid_filter", message: `不支持的筛选条件：${key}` } };
    }
  }
  const { project, owner, status, from, to } = params;
  if (status !== undefined && status !== "" && !statuses.includes(status)) {
    return { error: 400, body: { error: "invalid_status", message: `状态非法：${status}，可选值为 ${statuses.join("、")}` } };
  }
  if ((from !== undefined && from !== "") && !isValidDateStr(from)) {
    return { error: 400, body: { error: "invalid_date", message: `起始日期非法：${from}，请使用真实存在的年月日（YYYY-MM-DD）` } };
  }
  if ((to !== undefined && to !== "") && !isValidDateStr(to)) {
    return { error: 400, body: { error: "invalid_date", message: `截止日期非法：${to}，请使用真实存在的年月日（YYYY-MM-DD）` } };
  }
  if (from && to && from > to) {
    return { error: 400, body: { error: "invalid_range", message: `日期范围非法：起始日期 ${from} 晚于截止日期 ${to}` } };
  }
  let batches = allBatches(db);
  if (project) batches = batches.filter(b => b.projects.some(p => p.toLowerCase().includes(project.toLowerCase())));
  if (owner) batches = batches.filter(b => b.owners.some(o => o.includes(owner)));
  if (status) batches = batches.filter(b => b.status === status);
  if (from) batches = batches.filter(b => (b.createdAt || "").slice(0, 10) >= from);
  if (to) batches = batches.filter(b => (b.createdAt || "").slice(0, 10) <= to);
  if (batches.length === 0) {
    return { error: 404, body: { error: "no_results", message: "未找到符合条件的批次" } };
  }
  return { error: 0, body: batches };
}

// 交付报告缺失项：任一切片未完成观察即拒绝导出
function missingObservations(batch) {
  const missing = [];
  for (const sample of batch.samples) {
    for (const slice of sample.slices) {
      if (!observationDone(slice)) {
        missing.push({
          sampleId: sample.id,
          project: sample.project,
          sliceId: slice.id,
          owner: sample.owner,
          currentStep: slice.status,
          reason: slice.status === "观察" ? "观察记录为空" : `尚未完成观察（当前步骤：${slice.status}）`
        });
      }
    }
  }
  return missing;
}
function renderReport(batch) {
  const lines = [];
  lines.push(`# 批次交付报告 ${batch.id}`);
  lines.push("");
  lines.push(`- 项目：${batch.project}`);
  lines.push(`- 批次状态：${batch.status}`);
  lines.push(`- 负责人：${batch.owners.join("、")}`);
  lines.push(`- 建批日期：${(batch.createdAt || "").slice(0, 10)}`);
  lines.push(`- 计划完成：${batch.dueDate || "未设定"}`);
  lines.push(`- 样本数：${batch.sampleCount}`);
  lines.push(`- 切片进度：${batch.observedSlices}/${batch.totalSlices}（${batch.progress}%）`);
  lines.push(`- 逾期项：${batch.overdueCount}`);
  lines.push("");
  lines.push("## 样本明细");
  for (const sample of batch.samples) {
    lines.push("");
    lines.push(`### ${sample.id} ${sample.project}`);
    lines.push(`- 钻孔：${sample.borehole} · 岩芯箱：${sample.coreBox} · 深度：${sample.depth}`);
    lines.push(`- 负责人：${sample.owner} · 状态：${sample.status} · 交付：${sample.delivery}`);
    for (const slice of sample.slices) {
      lines.push(`- ${slice.id}（${slice.method}）观察结论：${slice.observation || "—"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --danger:#a23b2e; --warn:#9a6a1b; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:360px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:60px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    .filters { display:grid; grid-template-columns:repeat(5,minmax(120px,1fr)) auto; gap:10px; align-items:end; margin-bottom:14px; }
    .filters label { margin:0 0 4px; }
    .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:22px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .bar { height:8px; border-radius:999px; background:#e6e9e1; overflow:hidden; } .bar > i { display:block; height:100%; background:var(--accent); }
    .alert { border:1px solid var(--danger); background:#fbecea; color:var(--danger); border-radius:8px; padding:10px 12px; margin-bottom:12px; font-size:14px; white-space:pre-line; }
    .overdue { color:var(--danger); font-weight:700; } .next { color:var(--warn); font-weight:700; }
    .slice { border-top:1px solid var(--line); padding-top:8px; margin-top:6px; font-size:13px; }
    details { margin-top:6px; } summary { cursor:pointer; font-weight:700; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    @media (max-width:1100px){ main{grid-template-columns:1fr;padding:16px;} .filters{grid-template-columns:1fr 1fr;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯切片工作台</h1><div class="meta">批次检索、切片进度与交付报告导出</div></div><button id="reload" class="ghost">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>批次号</label><input name="batchId" required placeholder="如 B-2026-009">
      <div class="row"><div style="flex:1"><label>项目</label><input name="project" required></div><div style="flex:1"><label>负责人</label><input name="owner" required></div></div>
      <label>钻孔编号</label><input name="borehole" required>
      <div class="row"><div style="flex:1"><label>岩芯箱号</label><input name="coreBox" required></div><div style="flex:1"><label>取样深度</label><input name="depth" required></div></div>
      <div class="row"><div style="flex:1"><label>初始切片编号</label><input name="sliceId" required></div><div style="flex:1"><label>计划完成日</label><input name="dueDate" type="date" required></div></div>
      <label>染色方法</label><input name="method" required>
      <button style="margin-top:12px">保存样本</button>
    </form>
    <section>
      <div class="panel">
        <h2>批次检索</h2>
        <div class="filters">
          <div><label>项目</label><input id="f-project" placeholder="项目关键字"></div>
          <div><label>负责人</label><input id="f-owner" placeholder="负责人"></div>
          <div><label>状态</label><select id="f-status"><option value="">全部</option>${statuses.map(s => `<option>${s}</option>`).join("")}</select></div>
          <div><label>起始日期</label><input id="f-from" type="date"></div>
          <div><label>截止日期</label><input id="f-to" type="date"></div>
          <div class="row"><button id="search">检索</button><button type="button" class="ghost" id="clear">清空</button></div>
        </div>
      </div>
      <div id="alert"></div>
      <div class="stats" id="stats"></div>
      <div class="grid" id="batches"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const statsEl = document.querySelector("#stats");
    const batchesEl = document.querySelector("#batches");
    const alertEl = document.querySelector("#alert");
    const filterIds = ["project", "owner", "status", "from", "to"];
    let batches = [];

    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    }
    function currentQuery() {
      const params = new URLSearchParams();
      for (const key of filterIds) {
        const v = document.querySelector("#f-" + key).value.trim();
        if (v) params.set(key, v);
      }
      return params;
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const isJson = (res.headers.get("content-type") || "").includes("application/json");
      const data = isJson ? await res.json() : await res.text();
      if (!res.ok) {
        const err = new Error((data && data.message) || (data && data.error) || "请求失败");
        err.payload = data;
        throw err;
      }
      return data;
    }
    function showAlert(message) {
      alertEl.innerHTML = message ? '<div class="alert">' + esc(message) + "</div>" : "";
    }
    function renderBatch(batch) {
      const nextHtml = batch.next
        ? '<div class="next">下一步：' + esc(batch.next.step) + " · 负责人 " + esc(batch.next.owner) + (batch.next.overdue ? "（已逾期）" : "") + "</div>"
        : '<div class="next">全部切片已完成观察，可导出交付报告</div>';
      const overdueHtml = batch.overdue.length
        ? '<div class="overdue">逾期切片 ' + batch.overdueCount + " 项：" + esc(batch.overdue.map(o => o.sliceId + "（" + o.owner + "，应完成 " + o.dueDate + "）").join("；")) + "</div>"
        : '<div class="meta">无逾期项</div>';
      const samplesHtml = batch.samples.map(sample =>
        '<details class="slice"><summary>' + esc(sample.id + " " + sample.project) + ' <span class="pill">' + esc(sample.status) + "</span></summary>"
        + '<div class="meta">' + esc([sample.borehole, sample.coreBox, sample.depth, sample.owner].join(" · ")) + "</div>"
        + '<div class="row" style="margin-top:6px"><input data-k="sliceId" placeholder="新切片编号" style="flex:1"><input data-k="method" placeholder="染色方法" style="flex:1"><button data-action="add-slice" data-sample="' + esc(sample.id) + '">添加切片</button></div>'
        + sample.slices.map(slice =>
            '<div class="slice"><b>' + esc(slice.id) + "</b><div class='meta'>" + esc(slice.method) + " · 当前步骤 " + esc(slice.status) + "</div>"
            + '<div class="row"><select data-k="step">' + steps.map(step => '<option' + (step === slice.status ? " selected" : "") + ">" + step + "</option>").join("") + '</select></div>'
            + '<textarea data-k="note" placeholder="步骤备注或观察结果"></textarea>'
            + '<div class="row"><button data-action="log" data-sample="' + esc(sample.id) + '" data-slice="' + esc(slice.id) + '">记录步骤</button>'
            + '<button class="ghost" data-action="deliver" data-sample="' + esc(sample.id) + '">标记交付</button></div></div>'
          ).join("")
        + "</details>"
      ).join("");
      return '<article class="card">'
        + '<div class="row" style="justify-content:space-between"><h2 style="margin:0">' + esc(batch.id) + "</h2><span class='pill'>" + esc(batch.status) + "</span></div>"
        + '<div class="meta">' + esc(batch.project) + " · 负责人 " + esc(batch.owners.join("、")) + "</div>"
        + '<div class="meta">建批 ' + esc((batch.createdAt || "").slice(0, 10)) + " · 计划完成 " + esc(batch.dueDate || "未设定") + " · 样本 " + batch.sampleCount + " 件</div>"
        + '<div>切片进度 ' + batch.observedSlices + "/" + batch.totalSlices + "（" + batch.progress + "%）</div>"
        + '<div class="bar"><i style="width:' + batch.progress + '%"></i></div>'
        + overdueHtml + nextHtml
        + '<div class="row"><button data-action="export" data-batch="' + esc(batch.id) + '">导出交付报告</button><span class="meta">仅在全部切片完成观察后可导出</span></div>'
        + samplesHtml
        + "</article>";
    }
    function render() {
      const totalSlices = batches.reduce((n, b) => n + b.totalSlices, 0);
      const observed = batches.reduce((n, b) => n + b.observedSlices, 0);
      const overdue = batches.reduce((n, b) => n + b.overdueCount, 0);
      const stats = [
        ["批次数", batches.length],
        ["切片完成", observed + "/" + totalSlices],
        ["逾期项", overdue],
        ["待交付批", batches.filter(b => b.status !== "已交付").length],
        ["已交付批", batches.filter(b => b.status === "已交付").length]
      ];
      statsEl.innerHTML = stats.map(([label, value]) => '<div class="stat"><span>' + label + '</span><strong>' + value + "</strong></div>").join("");
      batchesEl.innerHTML = batches.map(renderBatch).join("") || '<div class="panel meta">暂无批次</div>';
    }
    async function load() {
      const query = currentQuery().toString();
      try {
        batches = await api("/api/batches" + (query ? "?" + query : ""));
        showAlert("");
        render();
      } catch (err) {
        batches = [];
        render();
        showAlert(err.message);
      }
    }
    async function exportReport(batchId) {
      const res = await fetch("/api/batches/" + encodeURIComponent(batchId) + "/report");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        let message = data.message || "导出失败";
        if (data.error === "missing_observations" && Array.isArray(data.missing)) {
          message += "\\n缺失项：\\n" + data.missing.map(m => "· " + m.sampleId + " / " + m.sliceId + "（" + m.owner + "）" + m.reason).join("\\n");
        }
        showAlert(message);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "交付报告-" + batchId + ".md";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showAlert("");
    }
    document.querySelector("#reload").onclick = load;
    document.querySelector("#search").onclick = load;
    document.querySelector("#clear").onclick = () => {
      filterIds.forEach(key => { document.querySelector("#f-" + key).value = ""; });
      load();
    };
    document.querySelector("#f-status").onchange = load;
    batchesEl.addEventListener("click", async event => {
      const btn = event.target.closest("button[data-action]");
      if (!btn) return;
      const card = btn.closest("article");
      const read = k => { const el = card.querySelector('[data-k="' + k + '"]'); return el ? el.value.trim() : ""; };
      try {
        if (btn.dataset.action === "export") {
          await exportReport(btn.dataset.batch);
          return;
        }
        if (btn.dataset.action === "add-slice") {
          const row = btn.closest(".row");
          const id = row.querySelector('[data-k="sliceId"]').value.trim();
          const method = row.querySelector('[data-k="method"]').value.trim() || "未指定";
          if (!id) return showAlert("切片编号不能为空");
          await api("/api/samples/" + btn.dataset.sample + "/slices", { method: "POST", body: JSON.stringify({ id, method }) });
        } else if (btn.dataset.action === "log") {
          const sliceEl = btn.closest(".slice");
          await api("/api/samples/" + btn.dataset.sample + "/slices/" + btn.dataset.slice + "/logs", {
            method: "POST",
            body: JSON.stringify({
              step: sliceEl.querySelector('[data-k="step"]').value,
              note: sliceEl.querySelector('[data-k="note"]').value || "步骤完成"
            })
          });
        } else if (btn.dataset.action === "deliver") {
          await api("/api/samples/" + btn.dataset.sample + "/deliver", { method: "POST", body: "{}" });
        }
        await load();
      } catch (err) {
        showAlert(err.message);
      }
    });
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        const entries = Object.fromEntries(new FormData(form).entries());
        await api("/api/samples", { method: "POST", body: JSON.stringify(entries) });
        form.reset();
        showAlert("");
        await load();
      } catch (err) {
        showAlert(err.message);
      }
    };
    load();
  </script>
</body>
</html>`;

function validateSampleInput(input) {
  const required = ["batchId", "project", "borehole", "coreBox", "depth", "owner", "sliceId", "method", "dueDate"];
  for (const field of required) {
    if (!input[field] || String(input[field]).trim() === "") {
      return { error: 400, body: { error: "invalid_input", message: `字段缺失或为空：${field}` } };
    }
  }
  if (!isValidDateStr(input.dueDate)) {
    return { error: 400, body: { error: "invalid_date", message: `计划完成日格式非法：${input.dueDate}，应为 YYYY-MM-DD` } };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    // 批次检索
    if (req.method === "GET" && url.pathname === "/api/batches") {
      const result = queryBatches(db, Object.fromEntries(url.searchParams.entries()));
      return sendJson(res, result.error || 200, result.body);
    }
    // 批次交付报告导出
    const reportMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/report$/);
    if (reportMatch && req.method === "GET") {
      const batch = allBatches(db).find(b => b.id === decodeURIComponent(reportMatch[1]));
      if (!batch) return sendJson(res, 404, { error: "batch_not_found", message: "批次不存在" });
      const missing = missingObservations(batch);
      if (missing.length) {
        return sendJson(res, 422, {
          error: "missing_observations",
          message: `批次 ${batch.id} 有 ${missing.length} 个切片尚未完成观察，无法导出交付报告`,
          missing
        });
      }
      const report = renderReport(batch);
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`交付报告-${batch.id}.md`)}`
      });
      return res.end(report);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const invalid = validateSampleInput(input);
      if (invalid) return sendJson(res, invalid.error, invalid.body);
      if (db.samples.some(s => s.slices.some(c => c.id === input.sliceId))) {
        return sendJson(res, 409, { error: "duplicate_slice", message: `切片编号已存在：${input.sliceId}` });
      }
      const sample = {
        id: `CORE-${Date.now()}`,
        batchId: input.batchId.trim(),
        project: input.project, borehole: input.borehole, coreBox: input.coreBox,
        depth: input.depth, owner: input.owner,
        status: "待切割", delivery: "未交付",
        createdAt: new Date().toISOString(), dueDate: input.dueDate,
        slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }]
      };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found", message: "样本不存在" });
      const input = await body(req);
      if (!input.id || !String(input.id).trim()) {
        return sendJson(res, 400, { error: "invalid_input", message: "切片编号不能为空" });
      }
      if (db.samples.some(s => s.slices.some(c => c.id === input.id))) {
        return sendJson(res, 409, { error: "duplicate_slice", message: `切片编号已存在：${input.id}` });
      }
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === logMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found", message: "样本不存在" });
      const slice = sample.slices.find(item => item.id === logMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found", message: "切片不存在" });
      const input = await body(req);
      if (!taskSteps.includes(input.step)) {
        return sendJson(res, 400, { error: "invalid_step", message: `步骤非法：${input.step}，可选值为 ${taskSteps.join("、")}` });
      }
      // 校验顺序流转；非法时直接返回，切片状态与日志均保持不变
      const transition = checkStepTransition(slice, input.step);
      if (!transition.ok) {
        return sendJson(res, 400, { error: "invalid_step_transition", message: transition.reason });
      }
      slice.status = input.step;
      if (input.step === "观察") slice.observation = (input.note || "").trim() || slice.observation;
      slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found", message: "样本不存在" });
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    sendJson(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    sendJson(res, 500, { error: "server_error", message: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
