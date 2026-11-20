// run.mjs — 多店「订单查询 + 批量导出」顺序调度器（普通 Node）
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG_PATH = process.argv[2];
if (!CFG_PATH) { console.error("用法: node run.mjs <config.json>"); process.exit(2); }
const CFG = JSON.parse(await fs.readFile(CFG_PATH, "utf8"));
const DOCTOR = !!CFG.doctor || CFG.mode === "doctor";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF_WORKER = path.join(SELF_DIR, "worker-order.mjs").replace(/\\/g, "/");
const HOME = os.homedir();
function findEgo() {
  const c = [path.join(HOME, ".local", "share", "ego", "active_version_dir", "ego-browser.exe"), path.join(HOME, ".local", "bin", "ego-browser.exe")];
  for (const x of c) if (existsSync(x)) return x;
  return "ego-browser";
}

const ROOT = String(CFG.root || process.env.PDD_BILLS_ROOT || "D:/pdd-bills").replace(/\\/g, "/").replace(/\/$/, "");
const EGO = String(CFG.ego || process.env.PDD_EGO_BROWSER || findEgo()).replace(/\\/g, "/");
const WORKER = String(CFG.worker || SELF_WORKER).replace(/\\/g, "/");
const STORES_CFG = String(CFG.storesConfig || path.join(ROOT, "_stores.json")).replace(/\\/g, "/");
const RUNTIME = String(CFG.runtimeDir || path.join(os.tmpdir(), "pdd-order-runtime")).replace(/\\/g, "/").replace(/\/$/, "");
const RUN_ID = "order-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const RUN_DIR = path.join(ROOT, "_runs", RUN_ID);
const RESULT_DIR = path.join(RUN_DIR, "results");
const LOG_DIR = path.join(RUN_DIR, "logs");
const CONCURRENCY = Math.max(1, Math.min(6, Number(CFG.concurrency || 1))); // 下载步骤由全局锁串行，查询/生成可并行

const from = String(CFG.from || "");
const to = String(CFG.to || "");
const issues = [];
const addIssue = (code, q, extra = {}) => issues.push({ code, question: q, ...extra });
const todayIso = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
if (!/^20\d\d-\d\d-\d\d$/.test(from) || !/^20\d\d-\d\d-\d\d$/.test(to)) addIssue("range_invalid", "from/to 必须是 YYYY-MM-DD", { from, to });
else if (from > to) addIssue("range_reversed", "起始日晚于结束日", { from, to });
else if (to > todayIso) addIssue("range_in_future", "结束日在未来（今天 " + todayIso + "）", { to, today: todayIso });
else {
  const spanDays = Math.round((new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000);
  const earliest = (() => {
    const d = new Date(todayIso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 92);
    return d.toISOString().slice(0, 10);
  })();
  if (spanDays > 92) addIssue("range_too_long", "当前 skill 只支持近 3 个月（≤92 天），当前 " + spanDays + " 天", { from, to, spanDays });
  else if (from < earliest) addIssue("range_older_than_3_months", "当前 skill 只支持「全部订单(近3个月)」；更早日期（" + from + "）请走 3个月前订单（未实现）", { from, earliest });
}

const rootOnC = /^[A-Za-z]:/.test(ROOT) && ROOT.slice(0, 1).toUpperCase() === "C" && !CFG.allowC;
if (!existsSync(ROOT)) {
  if (rootOnC) addIssue("root_on_c_drive", "账单根目录在 C 盘：" + ROOT + "，请改 root 或 allowC:true", { root: ROOT });
  else {
    try { await fs.mkdir(ROOT, { recursive: true }); console.log("ROOT_AUTO_CREATED=" + ROOT); }
    catch (e) { addIssue("root_create_failed", "无法创建根目录：" + ROOT, { root: ROOT }); }
  }
}
if (EGO !== "ego-browser" && !existsSync(EGO)) addIssue("ego_not_found", "ego-browser 不可用：" + EGO + "，请安装或配置 ego", { ego: EGO });

let stores = [];
let storesFromConfig = false;
if (CFG.shops && CFG.shops.length) {
  stores = CFG.shops.map((s) => (typeof s === "string" ? { shop: s } : s)).filter((s) => s && s.shop);
  storesFromConfig = true;
} else if (CFG.refreshStores) {
  stores = [];
  storesFromConfig = false;
} else if (existsSync(STORES_CFG)) {
  try {
    const reg = JSON.parse(await fs.readFile(STORES_CFG, "utf8"));
    const only = CFG.only && CFG.only.length ? CFG.only : null;
    stores = (reg.stores || []).filter((s) => s.enabled !== false && s.shop);
    if (only) stores = stores.filter((s) => only.includes(s.shop));
    storesFromConfig = true;
    if (!stores.length && !only) storesFromConfig = false;
  } catch (e) {
    storesFromConfig = true;
    addIssue("stores_config_invalid", "店铺清单不是合法 JSON：" + STORES_CFG, { path: STORES_CFG });
  }
}

const egoOk = EGO === "ego-browser" || existsSync(EGO);
if (!stores.length && !storesFromConfig && egoOk && !issues.some((i) => i.code === "ego_not_found")) {
  console.log("STORES_DISCOVERING=1");
  let disc = await runDiscovery();
  if (!(disc && disc.ok && disc.shops && disc.shops.length)) {
    console.log("STORES_DISCOVERY_RETRY");
    await sleep(1500);
    disc = await runDiscovery();
  }
  if (disc && disc.ok && disc.shops && disc.shops.length) {
    await saveStores(disc.shops);
    stores = disc.shops.map((s) => ({ shop: s.shop, profile: s.profile }));
    console.log("STORES_DISCOVERED=" + stores.length + " -> " + STORES_CFG);
  }
}

if (CFG.only && CFG.only.length) stores = stores.filter((s) => CFG.only.includes(s.shop));

if (!stores.length && !issues.some((i) => ["stores_config_invalid"].includes(i.code))) {
  addIssue("stores_config_missing", "没有可跑店铺：config 里给 shops、或提供 " + STORES_CFG + "；也可以先登录至少一家店让自动发现", { path: STORES_CFG });
}
if (issues.length) {
  console.log("PREFLIGHT=needs_user_input");
  console.log(JSON.stringify({ status: "needs_user_input", runId: RUN_ID, root: ROOT, issues }, null, 1));
  process.exit(3);
}

const f = from.split("-").map(Number);
const t = to.split("-").map(Number);
const monthEnd = new Date(t[0], t[1], 0).getDate();
const isWholeMonth = f[1] === t[1] && f[2] === 1 && t[2] === monthEnd;
const periodDir = isWholeMonth ? from.slice(0, 7) : from + "_" + to;
const label = isWholeMonth ? t[1] + "月" : f[1] + "月" + f[2] + "日-" + t[1] + "月" + t[2] + "日";
await fs.mkdir(RESULT_DIR, { recursive: true });
await fs.mkdir(LOG_DIR, { recursive: true });
await fs.mkdir(RUNTIME + "/" + RUN_ID, { recursive: true });

async function runOne(store, i, mode = "run") {
  const job = {
    shop: store.shop,
    profile: store.profile || null,
    from, to, root: ROOT,
    periodDir, label,
    csvName: store.shop + "-订单-" + label + ".csv",
    mode,
    resultPath: mode === "doctor" ? path.join(os.tmpdir(), "pdd-order-doctor-" + RUN_ID + "-" + i + ".json") : path.join(RESULT_DIR, store.shop + ".json"),
    keepOpen: !!CFG.keepOpen,
    waitCooldown: CFG.waitCooldown !== false,
    cooldownSec: Number(CFG.cooldownSec || 300),
    reuseExisting: !!CFG.reuseExisting,

    logPath: path.join(LOG_DIR, store.shop + ".log"),
    storesConfig: STORES_CFG,
  };
  const wrapper = RUNTIME + "/" + RUN_ID + "/job-" + i + ".mjs";
  await fs.writeFile(wrapper, "globalThis.__JOB = " + JSON.stringify(job) + ";\nawait import('file:///" + WORKER + "');\n", "utf8");
  const started = Date.now();
  const child = spawn(EGO, ["nodejs", "-e", "await import('file:///" + wrapper + "')"], { stdio: "ignore", windowsHide: true });
  const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, Number(CFG.jobTimeoutSec || 300) * 1000);
  await new Promise((res) => child.on("exit", res));
  clearTimeout(timer);
  let result = null;
  for (let k = 0; k < 12 && !result; k++) {
    try { result = JSON.parse(await fs.readFile(job.resultPath, "utf8")); } catch (e) { await sleep(300); }
  }
  if (!result) result = { ok: false, status: "failed", error: "no_result_file" };
  return { shop: store.shop, result, wallSec: Number(((Date.now() - started) / 1000).toFixed(1)) };
}

// 扫描 ego profiles 自动发现店铺（mode=discover）
async function runDiscovery() {
  const resultPath = path.join(os.tmpdir(), "pdd-order-discover-" + RUN_ID + ".json");
  const dir = RUNTIME + "/" + RUN_ID + "-discover";
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const job = { mode: "discover", root: ROOT, storesConfig: STORES_CFG, resultPath };
  const wrapper = dir + "/discover.mjs";
  await fs.writeFile(wrapper, "globalThis.__JOB = " + JSON.stringify(job) + ";\nawait import('file:///" + WORKER + "');\n", "utf8");
  const child = spawn(EGO, ["nodejs", "-e", "await import('file:///" + wrapper + "')"], { stdio: "ignore", windowsHide: true });
  const t = setTimeout(() => { try { child.kill(); } catch (e) {} }, 120000);
  await new Promise((res) => child.on("exit", res));
  clearTimeout(t);
  try { return JSON.parse(await fs.readFile(resultPath, "utf8")); } catch (e) { return { ok: false, shops: [] }; }
}

async function saveStores(shops) {
  let reg = { version: 1, root: ROOT, stores: [] };
  try { reg = JSON.parse(await fs.readFile(STORES_CFG, "utf8")); } catch (e) {}
  if (!reg.stores) reg.stores = [];
  if (!reg.root) reg.root = ROOT;
  for (const s of shops) {
    let e = reg.stores.find((x) => x.shop === s.shop);
    if (!e) { e = { shop: s.shop, profile: s.profile, enabled: true }; reg.stores.push(e); }
    else { e.profile = s.profile; if (e.enabled === undefined) e.enabled = true; }
  }
  await fs.mkdir(path.dirname(STORES_CFG), { recursive: true }).catch(() => {});
  await fs.writeFile(STORES_CFG, JSON.stringify(reg, null, 2), "utf8");
}

if (DOCTOR) {
  const rs = [];
  for (let i = 0; i < stores.length; i++) {
    const r = await runOne(stores[i], i, "doctor");
    rs.push(r);
    console.log("DOCTOR " + r.shop + " " + (r.result.status || "?") + " orders=" + (r.result.orders === undefined ? "-" : r.result.orders) + " wall=" + r.wallSec + "s");
  }
  const ok = rs.every((r) => r.result && r.result.ok);
  console.log("\nDOCTOR_RESULT=" + JSON.stringify({ ok, from, to, stores: rs }, null, 1));
  process.exit(ok ? 0 : 1);
}

const completed = new Array(stores.length);
const queue = stores.map((s, i) => ({ s, i }));
async function poolWorker() {
  while (queue.length) {
    const item = queue.shift();
    const r = await runOne(item.s, item.i);
    completed[item.i] = r;
    const s = r.result || {};
    console.log("DONE " + r.shop + " status=" + (s.status || "?") + " orders=" + (s.orders === undefined ? "-" : s.orders) + " wall=" + r.wallSec + "s" + (s.error ? " err=" + s.error : ""));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stores.length) }, () => poolWorker()));

const RETRIES = Math.max(0, Number(CFG.retries ?? 1));
const retryableRe = /export_page_not_found|page label not found|download_file_not_found|download_save_failed|download_copy_failed|reuse_download/;
for (let attempt = 1; attempt <= RETRIES; attempt++) {
  const idxs = completed
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c && x.c.result && x.c.result.status !== "done" && !x.c.result.needs && retryableRe.test(String(x.c.result.error || "")))
    .map((x) => x.i);
  if (!idxs.length) break;
  console.log("RETRY attempt=" + attempt + " stores=" + idxs.map((i) => stores[i].shop).join(","));
  for (const i of idxs) {
    await sleep(1500);
    const r = await runOne(stores[i], i);
    completed[i] = r;
    const s = r.result || {};
    console.log("RETRY_DONE " + r.shop + " status=" + (s.status || "?") + " orders=" + (s.orders === undefined ? "-" : s.orders) + " wall=" + r.wallSec + "s" + (s.error ? " err=" + s.error : ""));
  }
}
const report = {
  runId: RUN_ID, from, to, periodDir, label,
  createdAt: new Date().toISOString(),
  stores: completed.map((c) => ({
    shop: c.shop,
    status: c.result.status || "failed",
    ok: !!c.result.ok,
    orders: c.result.orders,
    csvRows: c.result.csvRows,
    csvName: c.result.csvName,
    path: c.result.path,
    paySum: c.result.paySum,
    recvSum: c.result.recvSum,
    sha256: c.result.sha256,
    evidence: c.result.evidence,
    error: c.result.error,
    needs: c.result.needs,
    wallSec: c.wallSec,
  })),
};
await fs.writeFile(path.join(RUN_DIR, "report.json"), JSON.stringify(report, null, 1), "utf8");
const lines = ["run=" + RUN_ID + " from=" + from + " to=" + to];
for (const s of report.stores) lines.push([s.shop.padEnd(10), s.status.padEnd(9), "orders=" + (s.orders === undefined ? "-" : s.orders), "wall=" + s.wallSec + "s", s.error || ""].join(" "));
await fs.writeFile(path.join(RUN_DIR, "summary.txt"), lines.join("\n"), "utf8");
console.log("\n" + lines.join("\n"));
console.log("REPORT=" + path.join(RUN_DIR, "report.json"));
const needs = report.stores.filter((s) => s.needs);
if (needs.length) {
  console.log("\nNEEDS=needs_user_action");
  for (const s of needs) console.log(s.shop + " [" + s.needs.code + "] " + s.needs.question);
  process.exit(4);
}
if (report.stores.some((s) => s.status === "failed")) {
  console.log("\nFAILED=job_failed");
  process.exit(5);
}
