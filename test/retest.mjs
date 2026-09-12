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
  // 交付动作在第 7 节（报告导出前）进行，以便第 6 节在此样本上新增切片
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

  r = await api("/api/batches?status=" + encodeURIComponent("待观察"));
  ok("按状态筛选=待观察 命中观察完成未交付的 B-READY", Array.isArray(r.body) && r.body.some(b => b.id === "B-READY" && b.status === "待观察"), JSON.stringify(r.body?.map?.(b => [b.id, b.status])));

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

  // 已到观察步骤但观察记录为空，同样拒绝：需按顺序推进到观察
  for (const step of ["切割", "研磨", "染色", "观察"]) {
    r = await api(`/api/samples/${readySampleId}/slices/SL-R-2/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, note: "" })
    });
    eq(`SL-R-2 顺序推进至 ${step}`, r.status, 200);
  }
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

  // 已交付样本不能新增切片（此时尚未交付，先验证未交付可加，交付后拒绝在下面断言）
  r = await api(`/api/samples/${readySampleId}/slices`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "SL-R-3", method: "光片" })
  });
  eq("未交付样本可继续新增切片 201", r.status, 201);
  // 立刻删除该切片对状态的影响：推进完成观察
  for (const step of ["切割", "研磨", "染色", "观察"]) {
    r = await api(`/api/samples/${readySampleId}/slices/SL-R-3/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, note: step === "观察" ? "第三片观察完成" : "步骤完成" })
    });
    eq(`SL-R-3 推进至 ${step}`, r.status, 200);
  }

  // 全部观察完成后交付
  r = await api(`/api/samples/${readySampleId}/deliver`, { method: "POST", body: "{}" });
  eq("全部观察完成后交付 200", r.status, 200);
  eq("交付状态=已交付", r.body.delivery, "已交付");
  const repeat = await api(`/api/samples/${readySampleId}/deliver`, { method: "POST", body: "{}" });
  eq("重复交付幂等 200", repeat.status, 200);
  eq("重复交付仍为已交付", repeat.body.delivery, "已交付");
  r = await api("/api/batches?status=" + encodeURIComponent("已交付"));
  ok("已交付筛选命中 B-READY", r.body.some(b => b.id === "B-READY"), JSON.stringify(r.body?.map?.(b => b.id)));

  // 已交付后新增切片被拒绝
  r = await api(`/api/samples/${readySampleId}/slices`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "SL-R-AFTER", method: "光片" })
  });
  eq("已交付样本新增切片 → 409", r.status, 409);
  ok("错误码 sample_delivered", r.body.error === "sample_delivered", r.body.error);
  const still = (await api("/api/samples")).body.find(s => s.id === readySampleId);
  eq("拒绝后切片数不变（仍为 3 片）", still.slices.length, 3);

  r = await api("/api/batches/B-READY/report");
  eq("全部观察完成 → 200", r.status, 200);
  ok("Content-Type 为 markdown", /text\/markdown/.test(r.contentType), r.contentType);
  ok("含附件文件名", /filename/.test((await fetch(BASE + "/api/batches/B-READY/report")).headers.get("content-disposition") || ""));
  ok("报告含批次标题", /^# 批次交付报告 B-READY/m.test(r.body));
  ok("报告按批次汇总切片进度", /切片进度：3\/3（100%）/.test(r.body), r.body.slice(0, 300));
  ok("报告含观察结论", r.body.includes("石英颗粒磨圆度良好") && r.body.includes("细脉状黄铁矿") && r.body.includes("第三片观察完成"));
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

// ---------- 7c. 步骤流转：正常顺序、跳步、回退 ----------
console.log("7c) 切片步骤顺序流转");
{
  const batches = await api("/api/batches");
  const future = batches.body.find(b => b.id === "B-FUTURE");
  const sampleId = future.samples[0].id;
  const sliceId = "SL-F-1";
  const before = future.samples[0].slices.find(s => s.id === sliceId);
  eq("测试切片初始步骤=取样", before.status, "取样");
  const logsBeforeCount = before.logs.length;

  let r = await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "观察", note: "想直接观察" })
  });
  eq("取样→观察（跳步）400", r.status, 400);
  ok("错误码 invalid_step_transition", r.body.error === "invalid_step_transition", r.body.error);
  ok("提示需按顺序推进", /顺序/.test(r.body.message), r.body.message);

  for (const bad of ["研磨", "染色"]) {
    r = await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: bad, note: "跳步" })
    });
    eq(`取样→${bad}（跳步）400`, r.status, 400);
  }

  let state = (await api("/api/batches")).body.find(b => b.id === "B-FUTURE").samples[0].slices.find(s => s.id === sliceId);
  eq("跳步被拒后状态仍是取样", state.status, "取样");
  eq("跳步被拒后日志条数不变", state.logs.length, logsBeforeCount);
  ok("跳步被拒后观察记录未写入", (state.observation || "") === "");

  r = await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "切割", note: "正常推进切割" })
  });
  eq("取样→切割（合法）200", r.status, 200);
  eq("切片状态推进为切割", r.body.slices.find(s => s.id === sliceId).status, "切割");

  r = await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "取样", note: "想回退" })
  });
  eq("切割→取样（回退）400", r.status, 400);
  ok("回退错误码 invalid_step_transition", r.body.error === "invalid_step_transition", r.body.error);
  ok("回退提示不可回退", /不可回退/.test(r.body.message), r.body.message);

  r = await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "观察", note: "再跳一步" })
  });
  eq("切割→观察（跳步）400", r.status, 400);

  state = (await api("/api/batches")).body.find(b => b.id === "B-FUTURE").samples[0].slices.find(s => s.id === sliceId);
  eq("非法流转后状态仍停留在切割", state.status, "切割");
  eq("非法流转未追加日志", state.logs.length, logsBeforeCount + 1);

  // 当前步骤补记备注：允许，不视为回退
  r = await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "切割", note: "补充切割参数" })
  });
  eq("切割→切割（同步骤补记）200", r.status, 200);
  eq("补记后状态仍为切割", r.body.slices.find(s => s.id === sliceId).status, "切割");

  // 合法走完后续流程
  for (const step of ["研磨", "染色", "观察"]) {
    r = await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, note: step === "观察" ? "完整流程后的观察结论" : "步骤完成" })
    });
    eq(`合法顺序推进至 ${step} 200`, r.status, 200);
  }
  state = (await api("/api/batches")).body.find(b => b.id === "B-FUTURE").samples[0].slices.find(s => s.id === sliceId);
  eq("走完流程状态为观察", state.status, "观察");
  ok("观察记录已保存", state.observation === "完整流程后的观察结论");

  // 到达观察后再回退仍被拒绝
  r = await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "研磨", note: "观察后想退回" })
  });
  eq("观察→研磨（回退）400", r.status, 400);
  state = (await api("/api/batches")).body.find(b => b.id === "B-FUTURE").samples[0].slices.find(s => s.id === sliceId);
  eq("回退被拒后观察结论保留", state.observation, "完整流程后的观察结论");
}

// ---------- 7d. 交付校验：空观察拒绝、完整观察可交付、重复交付幂等 ----------
console.log("7d) 标记交付前置校验");
async function advance(sampleId, sliceId, untilStep, note = "") {
  const order = ["取样", "切割", "研磨", "染色", "观察"];
  const target = order.indexOf(untilStep);
  for (let i = 1; i <= target; i++) {
    await api(`/api/samples/${sampleId}/slices/${sliceId}/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: order[i], note: untilStep === "观察" && i === target ? note : "步骤完成" })
    });
  }
}
{
  let r = await api("/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createSample({ batchId: "B-DELIVER", project: "北坡铁矿", owner: "何栖", sliceId: "SL-D-1", dueDate: future }))
  });
  const deliverSampleId = r.body.id;
  eq("创建待交付样本 201", r.status, 201);

  // 切片尚在制片早期 → 交付被拒
  r = await api(`/api/samples/${deliverSampleId}/deliver`, { method: "POST", body: "{}" });
  eq("未完成观察交付 → 422", r.status, 422);
  ok("错误码 delivery_blocked", r.body.error === "delivery_blocked", r.body.error);
  ok("列出未完成切片", Array.isArray(r.body.missing) && r.body.missing[0].sliceId === "SL-D-1", JSON.stringify(r.body.missing));

  const getSample = async () => (await api("/api/samples")).body.find(x => x.id === deliverSampleId);
  let s = await getSample();
  eq("被拒后 delivery 仍为未交付", s.delivery, "未交付");
  eq("被拒后样本状态保持制片中", s.status, "制片中");
  ok("被拒后批次仍非已交付", (await api("/api/batches?status=" + encodeURIComponent("已交付"))).body.every(b => b.id !== "B-DELIVER"));

  // 推进到观察但记录为空 → 仍拒绝
  await advance(deliverSampleId, "SL-D-1", "观察", "   ");
  r = await api(`/api/samples/${deliverSampleId}/deliver`, { method: "POST", body: "{}" });
  eq("全部到观察但记录为空 → 422", r.status, 422);
  ok("原因=观察记录为空", r.body.missing[0].reason === "观察记录为空", r.body.missing[0].reason);
  s = await getSample();
  eq("被拒后仍为未交付", s.delivery, "未交付");
  eq("样本状态仍为待观察", s.status, "待观察");

  // 补写第一片观察结论后，再加一片未完成观察 → 缺失项应精确为第二片
  r = await api(`/api/samples/${deliverSampleId}/slices/SL-D-1/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "观察", note: "第一片观察结论完整" })
  });
  eq("同步骤补写观察记录 200", r.status, 200);
  r = await api(`/api/samples/${deliverSampleId}/slices`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "SL-D-2", method: "光片" })
  });
  eq("新增第二片 201", r.status, 201);
  r = await api(`/api/samples/${deliverSampleId}/deliver`, { method: "POST", body: "{}" });
  eq("存在未完成观察的第二片 → 422", r.status, 422);
  ok("缺失项精确为 SL-D-2", r.body.missing.length === 1 && r.body.missing[0].sliceId === "SL-D-2", JSON.stringify(r.body.missing));
  s = await getSample();
  eq("被拒后第一片观察结论不受影响", s.slices.find(x => x.id === "SL-D-1").observation, "第一片观察结论完整");
  eq("被拒后仍为未交付", s.delivery, "未交付");

  // 补完第二片观察 → 交付成功
  await advance(deliverSampleId, "SL-D-2", "观察", "第二片观察结论完整");
  r = await api(`/api/samples/${deliverSampleId}/deliver`, { method: "POST", body: "{}" });
  eq("全部观察完成 → 交付 200", r.status, 200);
  eq("delivery=已交付", r.body.delivery, "已交付");
  eq("样本状态=已交付", r.body.status, "已交付");

  // 重复交付幂等
  r = await api(`/api/samples/${deliverSampleId}/deliver`, { method: "POST", body: "{}" });
  eq("重复交付 → 200", r.status, 200);
  eq("重复交付仍为已交付", r.body.delivery, "已交付");

  // 交付与报告闸门一致：交付成功后报告可导出
  r = await api("/api/batches/B-DELIVER/report");
  eq("已交付批次报告可导出 200", r.status, 200);
  ok("报告含两片观察结论", r.body.includes("第一片观察结论完整") && r.body.includes("第二片观察结论完整"));

  // 不存在样本交付 → 404
  r = await api("/api/samples/CORE-NOPE/deliver", { method: "POST", body: "{}" });
  eq("交付不存在样本 → 404", r.status, 404);
}

// ---------- 7e. 并发重复提交 ----------
console.log("7e) 切片步骤并发重复提交");
{
  let r = await api("/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createSample({ batchId: "B-CONCUR", project: "南坡钨矿", owner: "温简", sliceId: "SL-C-1", dueDate: future }))
  });
  const concSampleId = r.body.id;
  eq("创建并发测试样本 201", r.status, 201);
  const getSlice = async () => (await api("/api/samples")).body.find(s => s.id === concSampleId).slices.find(x => x.id === "SL-C-1");

  const initialLogs = (await getSlice()).logs.length;

  // 两个相同的“切割”推进请求同时发出
  const payload = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "切割", note: "并发切割请求" }) };
  const [a, b] = await Promise.all([
    api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, payload),
    api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, payload)
  ]);
  const statuses = [a.status, b.status].sort();
  eq("并发两请求：一次 200 一次 409", JSON.stringify(statuses), JSON.stringify([200, 409]));
  const rejected = [a, b].find(x => x.status === 409);
  ok("被拒请求错误码 duplicate_submission", rejected && rejected.body.error === "duplicate_submission", JSON.stringify([a.status, b.status, b.body]));
  ok("被拒请求有中文提示", rejected && /重复提交/.test(rejected.body.message), rejected && rejected.body.message);

  let slice = await getSlice();
  eq("状态只推进一次：切割", slice.status, "切割");
  eq("日志只增加一条", slice.logs.length, initialLogs + 1);
  eq("最后一条日志为切割", slice.logs[slice.logs.length - 1].step, "切割");

  // 三连并发同样只生效一次
  const p2 = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "研磨", note: "三连并发" }) };
  const three = await Promise.all([
    api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, p2),
    api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, p2),
    api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, p2)
  ]);
  eq("三连并发：恰好一次 200", three.filter(x => x.status === 200).length, 1);
  eq("三连并发：两次 409", three.filter(x => x.status === 409).length, 2);
  slice = await getSlice();
  eq("三连并发后状态=研磨", slice.status, "研磨");
  eq("三连并发后日志仍只再增加一条", slice.logs.length, initialLogs + 2);

  // 重复请求被拦后，顺序的正常推进仍可用
  for (const step of ["染色", "观察"]) {
    r = await api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, note: step === "观察" ? "并发复测后的观察结论" : "顺序推进" })
    });
    eq(`并发拦截后顺序推进 ${step} 仍 200`, r.status, 200);
  }
  slice = await getSlice();
  eq("最终状态=观察", slice.status, "观察");
  ok("观察结论保存", slice.observation === "并发复测后的观察结论");

  // 同步骤但备注不同：属于正常补记，不应被误判为重复
  const logsBefore = slice.logs.length;
  r = await api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "观察", note: "补充一条不同的观察备注" })
  });
  eq("同步骤不同备注补记 200", r.status, 200);
  slice = await getSlice();
  eq("补记日志增加一条", slice.logs.length, logsBefore + 1);

  // 并发跳步请求：两个都不得推进、不得写日志
  const p3 = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "取样", note: "并发回退" }) };
  const rb = await Promise.all([
    api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, p3),
    api(`/api/samples/${concSampleId}/slices/SL-C-1/logs`, p3)
  ]);
  ok("并发回退两请求都被拒", rb.every(x => x.status === 400), JSON.stringify(rb.map(x => x.status)));
  slice = await getSlice();
  eq("并发回退后状态仍为观察", slice.status, "观察");
  eq("并发回退未追加日志", slice.logs.length, logsBefore + 1);
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
  const expectedBatches = ["B-2026-001", "B-CONCUR", "B-DELIVER", "B-EMPTY-OBS", "B-FUTURE", "B-READY"];
  ok("六个批次均保留", ids.length === expectedBatches.length && expectedBatches.every(x => ids.includes(x)), JSON.stringify(ids));
  const emptyObs = r.body.find(b => b.id === "B-EMPTY-OBS");
  ok("空观察批次重启后状态仍为待观察", emptyObs && emptyObs.status === "待观察", emptyObs && emptyObs.status);
  const delivered = r.body.find(b => b.id === "B-DELIVER");
  ok("交付批次重启后仍为已交付", delivered && delivered.status === "已交付", delivered && delivered.status);
  const ready = r.body.find(b => b.id === "B-READY");
  ok("观察进度保留 3/3", ready.observedSlices === 3 && ready.totalSlices === 3, JSON.stringify([ready.observedSlices, ready.totalSlices]));
  ok("已交付状态保留", ready.status === "已交付", ready.status);
  const seed = r.body.find(b => b.id === "B-2026-001");
  ok("种子批次逾期保留", seed.overdueCount === 1, JSON.stringify(seed.overdueCount));

  const rep = await api("/api/batches/B-READY/report");
  eq("重启后仍可正常导出", rep.status, 200);
}

await stopServer();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
