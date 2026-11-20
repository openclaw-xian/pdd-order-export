// worker-order.mjs — 单店「订单查询 + 批量导出」worker（ego 进程内）
const fs = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");

const JOB = globalThis.__JOB || {};
const t0 = Date.now();
const logLines = [];
const log = (...a) => {
  const line = "[t=" + ((Date.now() - t0) / 1000).toFixed(1) + "s] " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logLines.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = (JOB.root || "D:/对账账单").replace(/\\/g, "/").replace(/\/$/, "");
const PERIOD_DIR = ROOT + "/" + JOB.shop + "/" + JOB.periodDir;
const RESULT_PATH = JOB.resultPath;
const DOWNLOADS = path.join(os.homedir(), "Downloads");
const COOLDOWN_FILE = ROOT + "/_state/order-export-cooldowns.json";
const COOLDOWN_MS = Math.max(60, Number(JOB.cooldownSec || 300)) * 1000;

const pad2 = (n) => String(n).padStart(2, "0");
function localTodayIso() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function plusDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dtText(iso) {
  return iso + " 00:00:00";
}

let task = null;
let page = null;

async function writeResult(obj) {
  const out = { ...obj, shop: JOB.shop, from: JOB.from, to: JOB.to, elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)) };
  if (JOB.periodDir && obj.status === "done") await fs.mkdir(PERIOD_DIR, { recursive: true }).catch(() => {});
  if (RESULT_PATH) await fs.writeFile(RESULT_PATH, JSON.stringify(out, null, 1), "utf8").catch(() => {});
  if (JOB.logPath) await fs.writeFile(JOB.logPath, logLines.join("\n"), "utf8").catch(() => {});
  return out;
}

async function resolveSpace() {
  const spaces = await listTaskSpaces();
  const byProfile = spaces.find((s) => String(s.profileName || "") === String(JOB.profile || ""));
  const byName = spaces.find((s) => String(s.name || "") === JOB.shop);
  const entry = byProfile || byName;
  if (!entry) throw new Error("space_not_found_for:" + (JOB.profile || JOB.shop));
  task = entry.ownership === "user" ? await claimTaskSpace(entry.id)
    : entry.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(entry.id)
    : await taskSpace(entry.id);
}

async function readShopName(pg = page) {
  return pg.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const el = [...document.querySelectorAll(".user-name-text, .user-name-name")].find(vis);
    return el ? (el.innerText || "").trim() : "";
  }).catch(() => "");
}

async function discoverShops() {
  const spaces = await listTaskSpaces();
  const uniq = [];
  for (const s of spaces) {
    const pn = String(s.profileName || "");
    if (!pn || uniq.some((u) => u.profileName === pn)) continue;
    uniq.push({ profileName: pn, id: s.id });
  }
  const found = [];
  for (const u of uniq) {
    let t = null;
    try {
      const entry = (await listTaskSpaces()).find((s) => s.id === u.id);
      if (!entry) continue;
      t = entry.ownership === "user" ? await claimTaskSpace(entry.id)
        : entry.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(entry.id)
        : await taskSpace(entry.id);
      const pg = await t.newPage();
      await pg.goto("https://mms.pinduoduo.com/orders/list?tab=0", { timeout: 45000 }).catch(() => {});
      await pg.waitForTimeout(1200);
      const shop = await readShopName(pg);
      if (shop) found.push({ shop, profile: u.profileName });
      try { await pg.close(); } catch (e) {}
    } catch (e) {
      log("discover_err", u.profileName + ": " + String((e && e.message) || e));
    } finally {
      try { if (t) await t.finish({ keep: [] }); } catch (e) {}
    }
  }
  return found;
}

async function updateRegistry(found) {
  const regPath = JOB.storesConfig || ROOT + "/_stores.json";
  let reg = { version: 1, root: ROOT, stores: [] };
  try { reg = JSON.parse(await fs.readFile(regPath, "utf8")); } catch (e) {}
  if (!reg.stores) reg.stores = [];
  if (!reg.root) reg.root = ROOT;
  for (const f of found) {
    let e = reg.stores.find((s) => s.shop === f.shop);
    if (!e) { e = { shop: f.shop, profile: f.profile, enabled: true }; reg.stores.push(e); }
    else { e.profile = f.profile; if (e.enabled === undefined) e.enabled = true; }
  }
  await fs.mkdir(ROOT, { recursive: true }).catch(() => {});
  await fs.writeFile(regPath, JSON.stringify(reg, null, 2), "utf8");
}

async function ensureOrderListView() {
  // 必须停在「全部订单(近3个月)」页签
  const tabText = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    const t = [...document.querySelectorAll("div,span,a,li")].filter((e) => vis(e) && txt(e).startsWith("全部订单"))[0];
    if (!t) return null;
    const b = t.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), text: txt(t) };
  });
  const curUrl = await page.evaluate(() => location.href).catch(() => "");
  if (!curUrl.includes("tab=0") && tabText) {
    await page.mouse.click(tabText.x, tabText.y);
    await page.waitForTimeout(800);
    log("tab_clicked", tabText.text);
  }
  const afterUrl = await page.evaluate(() => location.href).catch(() => "");
  if (!afterUrl.includes("tab=0")) throw new Error("not_all_orders_tab:" + afterUrl);

  // 状态筛选必须是 订单状态=全部、售后状态=全部、超时状态=不限
  const filters = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const vals = [...document.querySelectorAll("input")].filter(vis).map((e) => e.value || "");
    return { all: vals.filter((v) => v === "全部").length, timeout: vals.includes("不限") };
  });
  log("status_filters", JSON.stringify(filters));
  if (filters.all < 2 || !filters.timeout) throw new Error("status_filter_not_all:" + JSON.stringify(filters));
  return true;
}

async function newPageSafe() {
  let tabs = [];
  try { tabs = await task.tabs(); } catch (e) {}
  if (tabs.length >= 7) {
    for (const t of tabs) {
      if (!t.label) continue;
      try { await task.page(t.label).close(); log("closed_agent_page", t.label); } catch (e) {}
    }
    tabs = await task.tabs().catch(() => []);
  }
  if (tabs.length >= 8) throw new Error("page_budget_full:请关闭多余标签页（当前 " + tabs.length + "/8）");
  return task.newPage();
}

async function openShopSpace() {
  let shopName = "";
  if (JOB.profile) {
    try {
      await resolveSpace();
      page = await newPageSafe();
      await page.goto("https://mms.pinduoduo.com/orders/list?tab=0", { timeout: 60000 });
      await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1200);
      shopName = await readShopName();
      log("profile", JOB.profile + " -> " + (shopName || "(未识别)"));
    } catch (e) {
      log("profile_unusable", String((e && e.message) || e));
      shopName = "";
    }
  }
  if (!shopName || shopName !== JOB.shop) {
    if (task) { try { await task.finish({ keep: [] }); } catch (e) {} task = null; page = null; }
    log("discover_for", JOB.shop);
    const found = await discoverShops();
    const hit = found.find((f) => f.shop === JOB.shop);
    if (hit) {
      JOB.profile = hit.profile;
      await updateRegistry([hit]);
      await resolveSpace();
      page = await newPageSafe();
      await page.goto("https://mms.pinduoduo.com/orders/list?tab=0", { timeout: 60000 });
      await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1200);
      shopName = await readShopName();
    }
    if (!hit || shopName !== JOB.shop) throw new Error("shop_not_logged_in:" + JOB.shop);
  }
  if (!page) page = await newPageSafe();
  return shopName;
}

// ---------- 日期面板 ----------
async function hasPanel() {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const cls = (e) => String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : (e.className || ""));
    return [...document.querySelectorAll("div")].some((e) => vis(e) && /RPR_outerPickerWrapper/.test(cls(e)));
  });
}

async function openPanel() {
  const dt = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const i = [...document.querySelectorAll("input")].filter(vis).find((e) => /请选择日期/.test(e.placeholder || "") || (e.value || "").includes("~"));
    if (!i) return null;
    const b = i.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  });
  if (!dt) throw new Error("date_input_not_found");
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    await page.mouse.click(dt.x, dt.y);
    await page.waitForTimeout(550);
    ok = await hasPanel();
  }
  return ok;
}

async function header() {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const wrap = [...document.querySelectorAll("div")].filter(vis).find((e) => /RPR_outerPickerWrapper/.test(String(e.className)));
    if (!wrap) return [];
    return [...wrap.querySelectorAll("[class*='RPR_headerSelector']")].filter(vis).map((e) => (e.innerText || "").trim());
  });
}

async function arrows() {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const cls = (e) => String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : (e.className || ""));
    const prev = [], next = [];
    for (const e of document.querySelectorAll("svg")) {
      if (!vis(e) || !/RPR_iconPrevNext/.test(cls(e))) continue;
      const b = e.getBoundingClientRect();
      const it = { x: Math.round(b.x), y: Math.round(b.y + b.height / 2), right: /RPR_right/.test(cls(e)) };
      (it.right ? next : prev).push(it);
    }
    prev.sort((a, b) => a.x - b.x);
    next.sort((a, b) => a.x - b.x);
    return { prev, next };
  });
}

function monthNum(text) {
  const m = (text || "").match(/(\d{1,2})月/);
  return m ? Number(m[1]) : null;
}

async function setPanel(side, targetMonth) {
  for (let step = 0; step < 24; step++) {
    let s = { open: await hasPanel(), headers: await header() };
    if (!s.open) { if (!(await openPanel())) throw new Error("panel_lost"); await sleep(400); s = { open: true, headers: await header() }; }
    if (s.headers.length < 2) { await sleep(400); continue; }
    const idx = side === "left" ? 0 : 1;
    const cur = monthNum(s.headers[idx]);
    if (cur === null) { await sleep(400); continue; }
    if (cur === targetMonth) return s;
    const a = await arrows();
    const click = side === "left" ? (cur < targetMonth ? a.next[0] : a.prev[0]) : (cur < targetMonth ? a.next[1] : a.prev[1]);
    if (!click) { await sleep(400); continue; }
    await page.mouse.click(click.x, click.y);
    await page.waitForTimeout(500);
  }
  throw new Error("month_switch_failed");
}

async function cellRect(tableIndex, day) {
  return page.evaluate(({ ti, d }) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").trim() : "");
    const cls = (e) => String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : (e.className || ""));
    const wrap = [...document.querySelectorAll("div")].filter(vis).find((e) => /RPR_outerPickerWrapper/.test(String(e.className)));
    if (!wrap) return null;
    const tables = [...wrap.querySelectorAll("[class*='RPR_tableWrapper']")];
    const table = tables[ti];
    if (!table) return null;
    const cells = [...table.querySelectorAll("td[class*='RPR_tdDay']")].filter((e) => {
      if (!vis(e)) return false;
      const t = (e.innerText || "").trim();
      return (t === d || t === ("0" + d).slice(-2)) && !/RPR_outOfMonth|RPR_disabled/.test(cls(e));
    });
    if (!cells.length) return null;
    const b = cells[0].getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  }, { ti: tableIndex, d: String(day) });
}

async function clickText(text) {
  const r = await page.evaluate((t) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled; };
    const txt = (e) => (e ? (e.innerText || "").trim() : "");
    const e = [...document.querySelectorAll("button,span,div,a")].filter((x) => vis(x) && txt(x) === t)
      .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  }, text);
  if (r) { await page.mouse.click(r.x, r.y); return true; }
  return false;
}

async function setDateRange() {
  const startMonth = Number(JOB.from.slice(5, 7));
  const startDay = Number(JOB.from.slice(8, 10));
  const endPlus = plusDays(JOB.to, 1);
  const endMonth = Number(endPlus.slice(5, 7));
  const endDay = Number(endPlus.slice(8, 10));
  const expected = dtText(JOB.from) + " ~ " + dtText(endPlus);

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!(await openPanel())) throw new Error("date_panel_not_open");
    await setPanel("left", startMonth);
    if (endMonth !== startMonth) await setPanel("right", endMonth);
    const startCell = await cellRect(0, startDay);
    if (!startCell) throw new Error("start_cell_not_found:" + startDay);
    await page.mouse.click(startCell.x, startCell.y);
    await page.waitForTimeout(350);
    const endTable = endMonth === startMonth ? 0 : 1;
    const endCell = await cellRect(endTable, endDay);
    if (!endCell) throw new Error("end_cell_not_found:" + endDay);
    await page.mouse.click(endCell.x, endCell.y);
    await page.waitForTimeout(350);
    await clickText("归零");
    await page.waitForTimeout(300);
    await clickText("确认");
    await page.waitForTimeout(500);
    const actual = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const i = [...document.querySelectorAll("input")].filter(vis).find((e) => /请选择日期/.test(e.placeholder || "") || (e.value || "").includes("~"));
      return i ? i.value : "";
    });
    log("date_actual", actual);
    if (actual === expected) return { expected, actual };
    log("date_retry", "attempt=" + attempt + " actual=" + actual);
    await page.waitForTimeout(800);
  }
  throw new Error("date_not_applied:" + expected);
}

async function queryCount() {
  await clickText("查询");
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    const el = [...document.querySelectorAll("div,span")].find((e) => vis(e) && /共查询到\s*(\d+)\s*个订单/.test(txt(e)));
    const m = el ? txt(el).match(/共查询到\s*(\d+)\s*个订单/) : null;
    return m ? Number(m[1]) : null;
  });
}

async function dismissPrompt() {
  const hit = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").trim() : "");
    const texts = ["我知道了", "知道了", "确定", "关闭提示", "关闭"];
    const cands = [...document.querySelectorAll("button,span,div")].filter((e) => vis(e) && texts.includes(txt(e)));
    if (!cands.length) return null;
    const t = cands[0];
    const b = t.getBoundingClientRect();
    return { text: txt(t), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  }).catch(() => null);
  if (!hit) return false;
  log("dismiss_prompt", hit.text);
  await page.mouse.click(hit.x, hit.y);
  await page.waitForTimeout(600);
  return true;
}

async function detectCaptcha() {
  return page.evaluate(() => {
    const t = (document.body.innerText || "").replace(/\s+/g, " ");
    return /请向右滑块完成拼图|滑块完成拼图|拖动滑块|滑块验证/.test(t);
  }).catch(() => false);
}

async function waitExportCooldown() {
  if (JOB.waitCooldown === false) return;
  let state = {};
  try { state = JSON.parse(await fs.readFile(COOLDOWN_FILE, "utf8")); } catch (e) {}
  const last = Number((state[JOB.shop] && state[JOB.shop].lastExportAt) || 0);
  const remain = last + COOLDOWN_MS - Date.now();
  if (remain > 0) {
    const waitMs = Math.min(remain + 3000, COOLDOWN_MS + 5000);
    log("cooldown_wait", Math.round(waitMs / 1000) + "s");
    await sleep(waitMs);
  }
}

async function markExportDone() {
  let state = {};
  try { state = JSON.parse(await fs.readFile(COOLDOWN_FILE, "utf8")); } catch (e) {}
  state[JOB.shop] = { lastExportAt: Date.now(), label: JOB.label, at: localStamp() };
  await fs.mkdir(path.dirname(COOLDOWN_FILE), { recursive: true }).catch(() => {});
  await fs.writeFile(COOLDOWN_FILE, JSON.stringify(state, null, 1), "utf8").catch(() => {});
}

async function findReportDownload(pg = page) {
  const expected = JOB.from + " 00:00 到 " + plusDays(JOB.to, 1) + " 00:00";
  return pg.evaluate(({ expected }) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    for (const e of document.querySelectorAll("div,span")) {
      if (!vis(e) || !txt(e).includes("拼单成功时间") || !txt(e).includes(expected)) continue;
      let node = e;
      for (let up = 0; up < 8 && node; up++, node = node.parentElement) {
        const btn = [...node.querySelectorAll("button,span,div,a")].find((b) => vis(b) && txt(b) === "下载报表");
        if (btn) {
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), expected };
        }
      }
    }
    return null;
  }, { expected }).catch(() => null);
}

async function exportOrders() {
  await clickText("批量导出");
  await page.waitForTimeout(1800);
  const modalOk = await page.evaluate(() => (document.body.innerText || "").includes("批量导出订单"));
  log("export_modal", modalOk);
  if (!modalOk) throw new Error("export_modal_not_open");
  await dismissPrompt();
  await waitExportCooldown();

  // 生成报表：标记按钮，用 page.click（鼠标点击弹窗按钮不稳定）
  let genState = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").trim() : "");
    const cands = [...document.querySelectorAll("button,span,div")].filter((e) => vis(e) && txt(e) === "生成报表");
    if (!cands.length) return { marked: false };
    const t = cands.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
    const btn = t.closest("button") || t;
    btn.setAttribute("data-ego-genreport", "1");
    const b = btn.getBoundingClientRect();
    return { marked: true, disabled: !!btn.disabled || btn.getAttribute("aria-disabled") === "true", cls: String(btn.className).slice(0, 80), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), modal: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300) };
  });
  log("gen_state", genState);
  for (let i = 0; i < 12 && genState.marked && genState.disabled; i++) {
    await sleep(1000);
    genState = await page.evaluate(() => {
      const t = document.querySelector('[data-ego-genreport="1"]');
      const btn = t && (t.closest("button") || t);
      if (!btn) return { marked: false };
      btn.setAttribute("data-ego-genreport", "1");
      const b = btn.getBoundingClientRect();
      return { marked: true, disabled: !!btn.disabled || btn.getAttribute("aria-disabled") === "true", cls: String(btn.className).slice(0, 80), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    });
  }
  const popP = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
  if (genState.marked) await page.click('css=[data-ego-genreport="1"]', { label: "generate report" }).catch(() => {});
  else await clickText("生成报表");
  await page.waitForTimeout(1500);
  if (await detectCaptcha()) throw new Error("captcha_required:拼多多弹出滑块验证");
  await dismissPrompt();
  const pop = await popP;
  await page.waitForTimeout(1200);
  let expPage = pop && pop.label ? pop : null;
  let reusedExisting = false;
  if (!expPage) {
    const tabs = await task.tabs();
    const hit = tabs.find((t) => String(t.url || "").includes("/orders/exportExcel"));
    if (hit && hit.label) expPage = task.page(hit.label);
    else if (hit) {
      log("export_page_nav_from_tab");
      await page.goto("https://mms.pinduoduo.com/orders/exportExcel?exportType=0", { timeout: 60000 });
      await page.waitForTimeout(1500);
      expPage = page;
    }
    log("tabs_after_export", tabs.map((t) => String(t.url || "").slice(0, 80)));
  }
  if (!expPage && genState.marked) {
    // page.click 偶发不触发：再用鼠标点一次按钮
    await page.mouse.click(genState.x, genState.y);
    await page.waitForTimeout(2500);
    if (await detectCaptcha()) throw new Error("captcha_required:拼多多弹出滑块验证");
    await dismissPrompt();
    const tabs2 = await task.tabs();
    const hit2 = tabs2.find((t) => String(t.url || "").includes("/orders/exportExcel"));
    if (hit2 && hit2.label) expPage = task.page(hit2.label);
    else if (hit2) {
      log("export_page_nav_from_tab2");
      await page.goto("https://mms.pinduoduo.com/orders/exportExcel?exportType=0", { timeout: 60000 });
      await page.waitForTimeout(1500);
      expPage = page;
    }
    log("tabs_after_mouse_export", tabs2.map((t) => String(t.url || "").slice(0, 80)));
  }
  if (!expPage) {
    // 生成页没开出来（被限频/预算拦截）：当前页直接打开导出页，复用同区间已有报表
    log("export_page_fallback_nav");
    await page.goto("https://mms.pinduoduo.com/orders/exportExcel?exportType=0", { timeout: 60000 });
    await page.waitForTimeout(1500);
    expPage = page;
    reusedExisting = true;
  }
  if (!expPage) {
    const toast = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
      const cls = (e) => String(e.className || "");
      const cands = [...document.querySelectorAll("div,span")].filter((e) => vis(e) && /toast|message|notification|Message/i.test(cls(e)) && txt(e)).map((e) => txt(e)).slice(0, 5);
      return cands.join(" | ");
    }).catch(() => "");
    log("export_toast", toast);
    if (/两次导出|间隔|5分钟|五分钟|频繁/.test(toast)) throw new Error("rate_limited:两次导出间隔需≥5分钟，请稍后重试");
    throw new Error("export_page_not_found");
  }
  await expPage.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
  await expPage.waitForTimeout(1500);
  if (!reusedExisting) await markExportDone();

  // 等「下载报表」；只点与本次日期范围匹配的报表
  let dlBtn = null;
  for (let i = 0; i < 30 && !dlBtn; i++) {
    dlBtn = await findReportDownload(expPage);
    if (!dlBtn) await expPage.waitForTimeout(1000);
  }
  if (!dlBtn) throw new Error("report_not_found_for_range:" + JOB.from + "~" + JOB.to);

  const before = await fs.readdir(DOWNLOADS).catch(() => []);
  await expPage.mouse.click(dlBtn.x, dlBtn.y);
  let added = null;
  for (let i = 0; i < 30 && !added; i++) {
    await expPage.waitForTimeout(1000);
    const after = await fs.readdir(DOWNLOADS).catch(() => []);
    added = after.find((f) => !before.includes(f) && f.includes("orders_export"));
  }
  if (!added) throw new Error("download_file_not_found");
  const src = path.join(DOWNLOADS, added);
  // 浏览器下载句柄会锁文件：先结束 task（关页面）释放句柄，再复制
  if (task) { try { await task.finish({ keep: [] }); } catch (e) {} task = null; page = null; expPage = null; }
  await sleep(1200);
  await fs.mkdir(PERIOD_DIR, { recursive: true }).catch(() => {});
  const dest = path.join(PERIOD_DIR, JOB.csvName);
  let usedDest = dest, usedName = JOB.csvName, targetLocked = false;
  let copied = false, lastErr = null, lastSize = -1;
  for (let i = 0; i < 40 && !copied; i++) {
    try {
      const st = await fs.stat(src);
      if (st.size > 0 && st.size === lastSize) {
        try {
          await fs.copyFile(src, dest);
          copied = true;
          break;
        } catch (e) {
          if (e && (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES")) {
            const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 14);
            const altName = JOB.csvName.replace(/\.csv$/i, ".new-" + stamp + ".csv");
            const altDest = path.join(PERIOD_DIR, altName);
            await fs.copyFile(src, altDest);
            usedDest = altDest;
            usedName = altName;
            targetLocked = true;
            copied = true;
            break;
          }
          lastErr = e;
        }
      }
      lastSize = st.size;
    } catch (e) { lastErr = e; }
    await sleep(500);
  }
  if (!copied) throw new Error("download_copy_failed:" + String((lastErr && lastErr.message) || lastErr).slice(0, 120));
  await fs.unlink(src).catch(() => {});
  return { srcName: added, dest: usedDest, csvName: usedName, targetLocked };
}

// ---------- CSV 元数据 ----------
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (q && text[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === "," && !q) { row.push(cur); cur = ""; }
    else if ((ch === "\n" || ch === "\r") && !q) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((c) => String(c).length > 0)) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => String(c).length > 0)) rows.push(row);
  return rows;
}

function csvHeaderIndex(header, names) {
  const norm = (x) => String(x || "").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
  for (const name of names) {
    const i = header.findIndex((h) => norm(h) === norm(name));
    if (i >= 0) return i;
  }
  for (const name of names) {
    const i = header.findIndex((h) => norm(h).includes(norm(name)));
    if (i >= 0) return i;
  }
  return -1;
}

function localStamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " +08:00";
}

async function writeOrderInfo(dest, count, fileName, srcName, targetLocked) {
  const raw = await fs.readFile(dest);
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = raw.toString("utf8").replace(/^\uFEFF/, "");
  const parsed = parseCsv(text);
  const header = parsed[0] || [];
  const dataRows = parsed.slice(1);
  const oid = csvHeaderIndex(header, ["订单号", "订单编号"]);
  const statusI = csvHeaderIndex(header, ["订单状态"]);
  const payI = csvHeaderIndex(header, ["用户实付金额(元)", "用户实付金额"]);
  const recvI = csvHeaderIndex(header, ["商家实收金额(元)", "商家实收金额"]);
  const timeI = csvHeaderIndex(header, ["订单成交时间", "订单下单时间", "成交时间", "下单时间"]);

  // 一单多行时按订单号取首行，避免金额/状态重复计数
  const orderMap = new Map();
  if (oid >= 0) {
    for (const row of dataRows) {
      const key = String(row[oid] || "").trim();
      if (key && !orderMap.has(key)) orderMap.set(key, row);
    }
  }
  const orderRows = oid >= 0 ? [...orderMap.values()] : dataRows;
  const uniq = oid >= 0 ? orderMap.size : dataRows.length;
  const multiRow = dataRows.length !== uniq;

  const sum = (i) => {
    if (i < 0) return null;
    let s = 0;
    for (const row of orderRows) {
      const n = Number(String(row[i] || "").replace(/,/g, ""));
      if (Number.isFinite(n)) s += n;
    }
    return Number(s.toFixed(2));
  };
  const statuses = {};
  if (statusI >= 0) {
    for (const row of orderRows) {
      const v = row[statusI] || "";
      statuses[v] = (statuses[v] || 0) + 1;
    }
  }
  let dateMin = "", dateMax = "";
  if (timeI >= 0) {
    for (const row of orderRows) {
      const d = String(row[timeI] || "").trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (!dateMin || d < dateMin) dateMin = d;
      if (!dateMax || d > dateMax) dateMax = d;
    }
  }
  const crypto = await import("node:crypto");
  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  const siblings = [];
  for (const name of ["账单信息.md", "推广花费.md"]) {
    try {
      await fs.access(PERIOD_DIR + "/" + name);
      siblings.push(name);
    } catch (e) {}
  }
  const libs = [
    "# 订单信息 · " + JOB.shop + " · " + JOB.label,
    "",
    "| 项 | 值 |",
    "|---|---|",
    "| 店铺 | " + JOB.shop + " |",
    "| 期间 | " + JOB.from + " ~ " + JOB.to + "（筛选 " + JOB.from + " 00:00:00 ~ " + plusDays(JOB.to, 1) + " 00:00:00） |",
    "| 报表类型 | 对账报表 |",
    "| 查询单量（页面） | " + count + " |",
    "| 订单数（去重订单号） | " + uniq + " |",
    "| CSV 数据行数 | " + dataRows.length + " |",
    "| 多行订单 | " + (multiRow ? "是（" + dataRows.length + " 行 / " + uniq + " 单，按首行汇总）" : "否") + " |",
    "| 数据日期范围 | " + (dateMin && dateMax ? dateMin + " ~ " + dateMax : "未读到") + " |",
    "| 用户实付合计（元） | " + (sum(payI) == null ? "未读到" : sum(payI)) + " |",
    "| 商家实收合计（元） | " + (sum(recvI) == null ? "未读到" : sum(recvI)) + " |",
    "| 文件 | `" + (fileName || JOB.csvName) + "` |",
    "| 文件大小 | " + raw.length + " 字节 |",
    "| SHA-256 | " + sha + " |",
    "| 编码 | " + (bom ? "UTF-8 BOM" : "UTF-8") + " |",
    "| 下载源文件 | " + (srcName || "未记录") + " |",
    "| 目标文件锁定 | " + (targetLocked ? "是（已写 .new 文件）" : "否") + " |",
    "| 来源 | 订单查询 → 批量导出 → 对账报表 → 下载报表 |",
    "| 导出时间 | " + localStamp() + " |",
    "",
    "## 列名",
    header.join(", "),
    "",
    "## 订单状态分布",
    ...Object.entries(statuses).map(([k, v]) => "- " + k + ": " + v),
  ];
  if (siblings.length) {
    libs.push("", "## 同期文件", ...siblings.map((x) => "- `" + x + "`"));
  }
  const md = libs.join("\n");
  await fs.writeFile(PERIOD_DIR + "/订单信息.md", md, "utf8");
  return { uniq, rows: dataRows.length, header, pay: sum(payI), recv: sum(recvI), statuses, sha, bytes: raw.length, bom, dateMin, dateMax, multiRow, source: srcName || "", targetLocked: !!targetLocked };
}

async function saveFailureEvidence(msg) {
  if (!page || !JOB.logPath) return null;
  const dir = path.dirname(JOB.logPath);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const base = path.join(dir, JOB.shop + "-failure-" + stamp);
  const out = { error: msg, at: localStamp(), url: "", body: "", tabs: [] };
  try { out.url = await page.evaluate(() => location.href); } catch (e) {}
  try { out.body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 1200)); } catch (e) {}
  try { if (task) out.tabs = (await task.tabs()).map((t) => String(t.url || "").slice(0, 120)); } catch (e) {}
  try { await page.screenshot({ path: base + ".png" }); out.screenshot = base + ".png"; } catch (e) {}
  await fs.writeFile(base + ".json", JSON.stringify(out, null, 1), "utf8").catch(() => {});
  return base + ".png";
}

async function discoverMode() {
  const found = await discoverShops();
  return { status: "discovered", shops: found };
}

async function doctor() {
  const shopName = await openShopSpace();
  await ensureOrderListView();
  const dateInfo = await setDateRange();
  const orders = await queryCount();
  return { status: "doctor_ok", shop: shopName, orders, dateText: dateInfo.actual };
}

async function main() {
  const shopName = await openShopSpace();
  if (!page) page = await newPageSafe();
  await ensureOrderListView();
  const dateInfo = await setDateRange();
  const count = await queryCount();
  log("query_count", count);
  if (count === null) throw new Error("order_count_not_found");
  const exp = await exportOrders();
  log("export_file", exp.dest);
  const meta = await writeOrderInfo(exp.dest, count, exp.csvName, exp.srcName, exp.targetLocked);
  if (meta.uniq !== count) {
    await fs.unlink(exp.dest).catch(() => {});
    await fs.unlink(PERIOD_DIR + "/订单信息.md").catch(() => {});
    throw new Error("count_mismatch:query=" + count + " csv=" + meta.uniq);
  }
  if (meta.dateMin && meta.dateMax && (meta.dateMin < JOB.from || meta.dateMax > JOB.to)) {
    await fs.unlink(exp.dest).catch(() => {});
    await fs.unlink(PERIOD_DIR + "/订单信息.md").catch(() => {});
    throw new Error("report_range_mismatch:csv=" + meta.dateMin + "~" + meta.dateMax + " expected=" + JOB.from + "~" + JOB.to);
  }
  return {
    status: "done",
    shop: shopName,
    orders: count,
    queryCount: count,
    csvRows: meta.rows,
    csvName: exp.csvName,
    targetLocked: exp.targetLocked,
    path: exp.dest,
    paySum: meta.pay,
    recvSum: meta.recv,
    sha256: meta.sha,
    dateText: dateInfo.actual,
    dateMin: meta.dateMin,
    dateMax: meta.dateMax,
    multiRow: meta.multiRow,
    source: meta.source,
  };
}

let result;
try {
  result = JOB.mode === "doctor" ? await doctor() : JOB.mode === "discover" ? await discoverMode() : await main();
  await writeResult({ ok: true, ...result });
} catch (e) {
  const msg = String((e && e.message) || e);
  log("ERROR", msg);
  const evidence = await saveFailureEvidence(msg);
  result = { status: "failed", error: msg, evidence };
  if (msg.includes("shop_not_logged_in") || msg.includes("space_not_found_for")) {
    let profiles = [];
    try { profiles = [...new Set((await listTaskSpaces()).map((s) => String(s.profileName || "")).filter(Boolean))]; } catch (e2) {}
    result.needs = { code: "shop_not_logged_in", question: "在 ego 的各个 profile 里没找到店铺「" + JOB.shop + "」，请登录该店后重跑。", availableProfiles: profiles };
  } else if (msg.includes("captcha_required")) {
    result.needs = {
      code: "captcha_required",
      question: "拼多多弹出了「请向右滑块完成拼图」验证。请在 ego 里手动完成滑块（或关闭后重试），完成/通过后再重跑；不要连续点导出。",
    };
  } else if (msg.includes("page_budget_full")) {
    result.needs = {
      code: "page_budget_full",
      question: "当前店铺标签页已占满 8 个（ego 页面预算）。请关闭该店铺里多余的标签页后再重跑。",
    };
  }
  await writeResult({ ok: false, ...result });
} finally {
  const keep = JOB.keepOpen === true || (result && result.status === "failed");
  if (task && keep) {
    console.log("PAGE_LEFT_OPEN=1");
  } else {
    try { if (task) await task.finish({ keep: [] }); } catch (e) {}
  }
}
console.log("WORKER_RESULT=" + JSON.stringify({ shop: JOB.shop, status: result && result.status, orders: result && result.orders, elapsed: ((Date.now() - t0) / 1000).toFixed(1) }));
