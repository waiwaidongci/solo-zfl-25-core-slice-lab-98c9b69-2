// 批次检索与交付报告导出 —— 端到端复测脚本
// 用法：node test/retest.mjs
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3325;
const DATA_FILE = "/tmp/core-slices-retest.json";
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

let server = null;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: String(PORT), DATA_FILE },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout.on("data", d => { if (String(d).includes("listening")) resolve(); });
    server.stderr.on("data", d => process.stderr.write(d));
    server.on("error", reject);
    setTimeout(() => reject(new Error("server start timeout")), 5000);
  });
}
async function stopServer() {
  if (!server) return;
  await new Promise(resolve => {
    server.on("exit", resolve);
    server.kill("SIGTERM");
    setTimeout(() => { try { server.kill("SIGKILL"); } catch {} resolve(); }, 2000);
  });
  server = null;
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, options);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, body, contentType: ct };
}
function createSample(over) {
  return {
    batchId: over.batchId, project: over.project, owner: over.owner,
    borehole: "ZK-T", coreBox: "BX-T", depth: "10-11m",
    sliceId: over.sliceId, method: "薄片", dueDate: over.dueDate
  };
}

const today = new Date().toISOString().slice(0, 10);
const past = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

// ---------- 1. 启动 + 种子数据 ----------
rmSync(DATA_FILE, { force: true });
await startServer();
console.log("1) 初始数据");
{
  const r = await api("/api/batches");
  eq("种子批次可检索", r.status, 200);
  const seed = r.body.find(b => b.id === "B-2026-001");
  ok("种子批次存在", !!seed);
  ok("种子批次逾期（截止日已过、观察未完成）", seed && seed.overdueCount === 1, JSON.stringify(seed?.overdue));
  ok("下一步负责人=陆川、下一步=染色", seed && seed.next.owner === "陆川" && seed.next.step === "染色", JSON.stringify(seed?.next));
  eq("进度 0/1 = 0%", seed && seed.progress, 0);
}

// ---------- 2. 创建测试批次 ----------
console.log("2) 构造测试批次");
let readySampleId, readySlice;
{
  let r = await api("/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createSample({ batchId: "B-FUTURE", project: "南岭金矿", owner: "高媛", sliceId: "SL-F-1", dueDate: future }))
  });
  eq("创建未来批次样本 201", r.status, 201);

  r = await api("/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createSample({ batchId: "B-READY", project: "南岭金矿", owner: "许舟", sliceId: "SL-R-1", dueDate: past }))
  });
  eq("创建完成批次样本 201", r.status, 201);
  readySampleId = r.body.id; readySlice = "SL-R-1";

  const steps = ["取样", "切割", "研磨", "染色", "观察"];
  for (const step of steps) {
    r = await api(`/api/samples/${readySampleId}/slices/${readySlice}/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, note: step === "观察" ? "石英颗粒磨圆度良好，矿化微弱" : "步骤完成" })
    });
    eq(`推进步骤 ${step}`, r.status, 200);
  }
  r = await api(`/api/samples/${readySampleId}/deliver`, { method: "POST", body: "{}" });
  eq("标记交付", r.status, 200);
}

// ---------- 3. 筛选 ----------
console.log("3) 批次筛选");
{
  let r = await api("/api/batches?project=" + encodeURIComponent("铜矿"));
  eq("按项目关键字筛选", r.status, 200);
  ok("仅命中 B-2026-001", r.body.length === 1 && r.body[0].id === "B-2026-001", JSON.stringify(r.body.map(b => b.id)));

  r = await api("/api/batches?project=" + encodeURIComponent("金矿"));
  ok("项目命中多个批次", r.body.length === 2, `实际 ${r.body.length}`);

  r = await api("/api/batches?owner=" + encodeURIComponent("高媛"));
  ok("按负责人筛选", r.body.length === 1 && r.body[0].id === "B-FUTURE", JSON.stringify(r.body?.map?.(b => b.id)));

  r = await api("/api/batches?status=" + encodeURIComponent("已交付"));
  ok("按状态筛选=已交付 命中 B-READY", r.body.length === 1 && r.body[0].id === "B-READY", JSON.stringify(r.body?.map?.(b => b.id)));

  r = await api("/api/batches?status=" + encodeURIComponent("制片中"));
  ok("按状态筛选=制片中", Array.isArray(r.body) && r.body.every(b => b.status === "制片中"), JSON.stringify(r.body?.map?.(b => [b.id, b.status])));

  r = await api(`/api/batches?from=2000-01-01&to=${today}`);
  eq("宽日期范围有结果", r.status, 200);
  ok("宽日期范围覆盖全部3批", r.body.length === 3, `实际 ${r.body.length}`);
}

// ---------- 4. 非法条件 ----------
console.log("4) 非法筛选条件 → 400");
{
  let r = await api("/api/batches?status=" + encodeURIComponent("已完成"));
  eq("非法状态 400", r.status, 400);
  ok("错误码 invalid_status", r.body.error === "invalid_status", r.body.error);

  r = await api("/api/batches?from=2026-13-40");
  eq("非法日期 400", r.status, 400);
  ok("错误码 invalid_date", r.body.error === "invalid_date", r.body.error);

  r = await api("/api/batches?from=" + encodeURIComponent("09/01/2026"));
  eq("非 YYYY-MM-DD 日期 400", r.status, 400);

  for (const bad of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-06-31", "2026-00-10", "2026-07-00"]) {
    r = await api("/api/batches?from=" + bad);
    eq(`不存在的日期 ${bad} → 400`, r.status, 400, `实际 ${r.status}`);
    ok(`${bad} 错误码 invalid_date 且说明原因`, r.body.error === "invalid_date" && /真实存在|不存在|非法/.test(r.body.message || ""), JSON.stringify(r.body));
  }
  // 正常/真实日期通过校验（无数据时返回 404 no_results，而非 400；有数据 200）
  for (const good of ["2024-02-29", "2026-02-28", "2026-12-31", "2000-02-29", today]) {
    r = await api(`/api/batches?from=${good}&to=${good}`);
    ok(`真实日期 ${good} 不被判非法（status != 400）`, r.status !== 400, `实际 ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // 2023 非闰年：02-29 不存在；2024 闰年：02-29 存在
    const nonLeap = await api("/api/batches?from=2023-02-29");
    eq("非闰年 2023-02-29 → 400", nonLeap.status, 400);
    const leap = await api("/api/batches?from=2024-02-29&to=2024-02-29");
    ok("闰年 2024-02-29 通过校验（404 无结果而非 400）", leap.status === 404 && leap.body.error === "no_results", `实际 ${leap.status}`);
  }

  r = await api(`/api/batches?from=${future}&to=${past}`);
  eq("起止倒置 400", r.status, 400);
  ok("错误码 invalid_range", r.body.error === "invalid_range", r.body.error);

  r = await api("/api/batches?foo=bar");
  eq("不支持的参数 400", r.status, 400);
  ok("错误码 invalid_filter", r.body.error === "invalid_filter", r.body.error);
}

// ---------- 5. 无结果 ----------
console.log("5) 筛选无结果 → 404");
{
  let r = await api("/api/batches?project=" + encodeURIComponent("不存在的火星项目"));
  eq("无项目命中 404", r.status, 404);
  ok("错误码 no_results 且有中文提示", r.body.error === "no_results" && /未找到/.test(r.body.message), JSON.stringify(r.body));

  r = await api(`/api/batches?from=2099-01-01&to=2099-12-31`);
  eq("日期范围无结果 404", r.status, 404);
  ok("错误码 no_results", r.body.error === "no_results", r.body.error);

  r = await api("/api/batches?owner=" + encodeURIComponent("不存在的人"));
  eq("负责人无命中 404", r.status, 404);
}

// ---------- 6. 缺失切片 → 拒绝导出 ----------
console.log("6) 报告导出：缺失切片拒绝");
{
  let r = await api("/api/batches/B-2026-001/report");
  eq("未完成观察 → 422", r.status, 422);
  ok("错误码 missing_observations", r.body.error === "missing_observations", r.body.error);
  ok("列出缺失项 SL-001-A", Array.isArray(r.body.missing) && r.body.missing.some(m => m.sliceId === "SL-001-A"), JSON.stringify(r.body.missing));
  ok("缺失原因说明当前步骤", /研磨/.test(r.body.missing[0].reason), r.body.missing[0].reason);

  // 给 B-READY 再加一个尚未观察的切片 → 原本可导出变不可导出
  r = await api(`/api/samples/${readySampleId}/slices`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "SL-R-2", method: "未染色片" })
  });
  eq("新增切片 201", r.status, 201);
  r = await api("/api/batches/B-READY/report");
  eq("有一个新切片未观察 → 422", r.status, 422);
  ok("缺失项精确指向 SL-R-2", r.body.missing.length === 1 && r.body.missing[0].sliceId === "SL-R-2", JSON.stringify(r.body.missing));

  // 已到观察步骤但观察记录为空，同样拒绝
  r = await api(`/api/samples/${readySampleId}/slices/SL-R-2/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "观察", note: "" })
  });
  eq("记录观察步骤", r.status, 200);
  r = await api("/api/batches/B-READY/report");
  eq("观察记录为空仍 422", r.status, 422);
  ok("原因=观察记录为空", r.body.missing[0].reason === "观察记录为空", r.body.missing[0].reason);

  r = await api("/api/batches/NO-SUCH/report");
  eq("不存在批次 → 404", r.status, 404);
}

// ---------- 7. 补完 → 正常导出 ----------
console.log("7) 报告导出：正常导出 Markdown");
{
  let r = await api(`/api/samples/${readySampleId}/slices/SL-R-2/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "观察", note: "正交偏光下见细脉状黄铁矿" })
  });
  eq("补写观察记录", r.status, 200);

  r = await api("/api/batches/B-READY/report");
  eq("全部观察完成 → 200", r.status, 200);
  ok("Content-Type 为 markdown", /text\/markdown/.test(r.contentType), r.contentType);
  ok("含附件文件名", /filename/.test((await fetch(BASE + "/api/batches/B-READY/report")).headers.get("content-disposition") || ""));
  ok("报告含批次标题", /^# 批次交付报告 B-READY/m.test(r.body));
  ok("报告按批次汇总切片进度", /切片进度：2\/2（100%）/.test(r.body), r.body.slice(0, 300));
  ok("报告含观察结论", r.body.includes("石英颗粒磨圆度良好") && r.body.includes("细脉状黄铁矿"));
  ok("报告含负责人与状态", r.body.includes("许舟") && r.body.includes("已交付"));
}

// ---------- 7b. 全部到观察但记录为空 → 批次状态仍为待观察 ----------
console.log("7b) 空观察记录的批次状态");
{
  let r = await api("/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createSample({ batchId: "B-EMPTY-OBS", project: "西沟铀矿", owner: "沈默", sliceId: "SL-E-1", dueDate: future }))
  });
  const emptySampleId = r.body.id;
  eq("创建空观察批次样本 201", r.status, 201);

  // 切片只推进到“观察”，但不填写观察记录
  for (const step of ["取样", "切割", "研磨", "染色", "观察"]) {
    r = await api(`/api/samples/${emptySampleId}/slices/SL-E-1/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, note: "" })
    });
    eq(`空备注推进步骤 ${step}`, r.status, 200);
  }
  eq("样本状态=待观察", r.body.status, "待观察");

  // 再加一片同样到观察但记录为空
  r = await api(`/api/samples/${emptySampleId}/slices`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "SL-E-2", method: "光片" })
  });
  for (const step of ["切割", "研磨", "染色", "观察"]) {
    await api(`/api/samples/${emptySampleId}/slices/SL-E-2/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, note: "  " })
    });
  }

  r = await api("/api/batches?status=" + encodeURIComponent("待观察"));
  const target = r.body.find(b => b.id === "B-EMPTY-OBS");
  ok("批次可在“待观察”筛选中命中", !!target, JSON.stringify(r.body?.map?.(b => [b.id, b.status])));
  eq("全部切片到观察但记录为空：批次状态=待观察（非待切割）", target && target.status, "待观察");
  eq("观察完成进度仍为 0/2", target && target.observedSlices, 0);
  eq("总切片数 2", target && target.totalSlices, 2);

  r = await api("/api/batches/B-EMPTY-OBS/report");
  eq("观察记录为空仍拒绝导出 422", r.status, 422);
  ok("两片均列为缺失项", r.body.missing.length === 2 && r.body.missing.every(m => m.reason === "观察记录为空"), JSON.stringify(r.body.missing));
}

// ---------- 8. 非法写操作 ----------
console.log("8) 写操作校验");
{
  let r = await api("/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchId: "B-X", project: "x" })
  });
  eq("缺字段创建样本 → 400", r.status, 400);
  ok("提示具体字段", /字段缺失/.test(r.body.message), r.body.message);

  r = await api("/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createSample({ batchId: "B-X", project: "x", owner: "y", sliceId: "SL-X", dueDate: "2026/09/01" }))
  });
  eq("非法截止日 → 400", r.status, 400);

  r = await api(`/api/samples/${readySampleId}/slices/${readySlice}/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "抛光" })
  });
  eq("非法步骤 → 400", r.status, 400);
}

// ---------- 9. 页面 ----------
{
  const r = await api("/");
  eq("首页 200", r.status, 200);
  ok("页面含批次检索", r.body.includes("批次检索"));
  ok("页面含导出按钮逻辑", r.body.includes("导出交付报告"));
}

// ---------- 10. 重启持久化 ----------
console.log("9) 重启后数据保留");
await stopServer();
await sleep(300);
await startServer();
{
  const r = await api("/api/batches");
  eq("重启后仍可检索", r.status, 200);
  const ids = r.body.map(b => b.id).sort();
  ok("四个批次均保留", ids.length === 4 && ["B-2026-001", "B-EMPTY-OBS", "B-FUTURE", "B-READY"].every(x => ids.includes(x)), JSON.stringify(ids));
  const emptyObs = r.body.find(b => b.id === "B-EMPTY-OBS");
  ok("空观察批次重启后状态仍为待观察", emptyObs && emptyObs.status === "待观察", emptyObs && emptyObs.status);
  const ready = r.body.find(b => b.id === "B-READY");
  ok("观察进度保留 2/2", ready.observedSlices === 2 && ready.totalSlices === 2, JSON.stringify([ready.observedSlices, ready.totalSlices]));
  ok("已交付状态保留", ready.status === "已交付", ready.status);
  const seed = r.body.find(b => b.id === "B-2026-001");
  ok("种子批次逾期保留", seed.overdueCount === 1, JSON.stringify(seed.overdueCount));

  const rep = await api("/api/batches/B-READY/report");
  eq("重启后仍可正常导出", rep.status, 200);
}

await stopServer();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
