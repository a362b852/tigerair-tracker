// 虎航票價追蹤：桃園 ↔ 日本、韓國，未來 180 天
//
// 安全設計：
// - 零外部套件，只用 Node 內建功能。
// - 只允許連到兩個網域：虎航票價 API、GitHub API（且只操作本 repo）。其他網址一律拒絕。
// - 不跟隨重新導向、每次請求有逾時、回應大小有上限。
// - 所有從 API 拿到的欄位都先驗證格式（機場代碼、日期、金額），驗證不過就丟掉，
//   通知與報表只用驗證後的資料，不會把外部文字原樣塞進 Issue。
// - 不讀取任何檔案或環境變數，除了本 repo 的 data/ 和 GitHub Actions 提供的 GITHUB_TOKEN / GITHUB_REPOSITORY。
//
// 用法：
//   node tracker.mjs                 正式執行（抓價、更新 data/、發通知）
//   node tracker.mjs --dry           試跑：抓價並印出結果，不寫檔、不發通知
//   node tracker.mjs --fixture f.json  用本機假資料代替 API（測試用）
//   node tracker.mjs --summary       強制發一次每日摘要

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

/* ============================ 設定 ============================ */

const ORIGIN = "TPE";
const DAYS_AHEAD = 180;
const SUMMARY_HOUR = 8; // 台北時間幾點之後發每日摘要
const TZ = "Asia/Taipei";

const DESTINATIONS = {
  // 日本
  NRT: "東京成田", HND: "東京羽田", KIX: "大阪關西", NGO: "名古屋", FUK: "福岡",
  CTS: "札幌新千歲", OKA: "沖繩那霸", SDJ: "仙台", KMQ: "小松", OKJ: "岡山",
  HIJ: "廣島", TAK: "高松", KOJ: "鹿兒島", KMJ: "熊本", FSZ: "靜岡",
  IBR: "茨城", HKD: "函館", AOJ: "青森", AXT: "秋田", KIJ: "新潟",
  MYJ: "松山(愛媛)", UBJ: "山口宇部", TOY: "富山", OIT: "大分", KKJ: "北九州",
  NGS: "長崎", MMY: "宮古島", ISG: "石垣島", SHM: "南紀白濱", HSG: "佐賀",
  KCZ: "高知", TKS: "德島", YGJ: "米子", IZO: "出雲", GAJ: "山形",
  FKS: "福島", HNA: "花卷", AKJ: "旭川", KUH: "釧路", OBO: "帶廣",
  // 韓國
  ICN: "首爾仁川", GMP: "首爾金浦", PUS: "釜山", CJU: "濟州", TAE: "大邱",
  CJJ: "清州", MWX: "務安", KWJ: "光州", YNY: "襄陽", RSU: "麗水", USN: "蔚山",
};

const KOREA = new Set(["ICN", "GMP", "PUS", "CJU", "TAE", "CJJ", "MWX", "KWJ", "YNY", "RSU", "USN"]);

const PRICE_API = (station) =>
  `https://api-book.tigerairtw.com/api/cms/station-daily-prices/${station}/TWD`;
const ALLOWED_HOSTS = new Set(["api-book.tigerairtw.com", "api.github.com"]);
const MAX_BYTES = 20 * 1024 * 1024;
const ISSUE_MARKER = "<!-- tigerair-tracker:notify -->";

// 同一城市的不同機場，來回組合可以混搭（例如成田去、羽田回）
const CITY = { NRT: "東京", HND: "東京", ICN: "首爾", GMP: "首爾" };
const cityOf = (code) => CITY[code] ?? code;

// 沒有 trips.json 時的預設行程
const DEFAULT_TRIPS = [{ 名稱: "5天", 天數: 5 }];

const STATE_FILE = new URL("./data/state.json", import.meta.url);
const REPORT_FILE = new URL("./REPORT.md", import.meta.url);
const TRIPS_FILE = new URL("./trips.json", import.meta.url);
const SITE_DIR = new URL("./docs/", import.meta.url);
const SITE_DATA_FILE = new URL("./docs/fares.json", import.meta.url);

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const FORCE_SUMMARY = args.includes("--summary");
const FIXTURE = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : null;
const NOW = args.includes("--now") ? new Date(args[args.indexOf("--now") + 1]) : new Date();

/* ============================ 小工具 ============================ */

const CODE_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function taipeiParts(d) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), time: `${p.hour}:${p.minute}` };
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const fmt = (n) => `$${Number(n).toLocaleString("en-US")}`;
const name = (code) => DESTINATIONS[code] ?? (code === ORIGIN ? "桃園" : code);
const routeLabel = (key) => {
  const [o, d] = key.split("-");
  return `${name(o)} → ${name(d)}`;
};

/** 唯一的對外連線入口：檢查網域、不跟隨轉址、逾時、大小上限。 */
async function safeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error(`拒絕連線到未允許的網址：${u.origin}`);
  }
  const res = await fetch(u, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`回應過大：${u.pathname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${u.hostname}${u.pathname}：${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/* ============================ 抓價 ============================ */

async function loadStation(station, fixture) {
  if (!CODE_RE.test(station)) throw new Error(`機場代碼格式錯誤：${station}`);
  if (fixture) return fixture[station] ?? [];
  const rows = await safeFetch(PRICE_API(station), {
    headers: { accept: "application/json", "user-agent": "personal-fare-tracker" },
  });
  if (!Array.isArray(rows)) throw new Error(`${station} 回應不是陣列，API 格式可能改了`);
  return rows;
}

/** 驗證並整理成 { "TPE-NRT": { "2026-11-01": 2999, ... } } */
function collect(rows, from, to, legs, seenOther) {
  let accepted = 0;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r.origin, d = r.destination;
    const date = typeof r.pricingDate === "string" ? r.pricingDate.slice(0, 10) : "";
    const amount = Number(r.pricingAmount);
    if (!CODE_RE.test(o ?? "") || !CODE_RE.test(d ?? "") || !DATE_RE.test(date)) continue;
    if (r.pricingCurrency !== "TWD" || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) continue;
    if (date < from || date > to) continue;
    const outbound = o === ORIGIN, inbound = d === ORIGIN;
    if (!outbound && !inbound) continue;
    const other = outbound ? d : o;
    if (!DESTINATIONS[other]) { seenOther.add(other); continue; }
    const key = `${o}-${d}`;
    const prev = legs[key]?.[date];
    (legs[key] ??= {})[date] = prev == null ? amount : Math.min(prev, amount);
    accepted++;
  }
  return accepted;
}

async function fetchAll(from, to) {
  const fixture = FIXTURE ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;
  const legs = {};
  const seenOther = new Set();
  const n = collect(await loadStation(ORIGIN, fixture), from, to, legs, seenOther);
  if (n === 0) throw new Error("桃園站沒有抓到任何日韓票價，API 格式可能改了，請檢查。");

  // 如果桃園站的資料只有去程，就再抓各目的地站補回程。
  const dests = [...new Set(Object.keys(legs).map((k) => k.split("-")).filter(([o]) => o === ORIGIN).map(([, d]) => d))];
  for (const d of dests) {
    if (legs[`${d}-${ORIGIN}`]) continue;
    if (!fixture) await new Promise((r) => setTimeout(r, 800)); // 放慢，避免打太快
    try {
      collect(await loadStation(d, fixture), from, to, legs, seenOther);
    } catch (e) {
      console.warn(`回程 ${d} 抓取失敗（略過）：${e.message}`);
    }
  }
  return { legs, seenOther: [...seenOther].sort() };
}

/* ============================ 分析 ============================ */

function cheapest(dates) {
  let best = null;
  for (const [date, price] of Object.entries(dates)) {
    if (!best || price < best.price || (price === best.price && date < best.date)) best = { date, price };
  }
  return best;
}

function analyse(legs, state, today) {
  const rows = [];
  const newLows = [];
  for (const key of Object.keys(legs).sort()) {
    const best = cheapest(legs[key]);
    if (!best) continue;
    const prevLow = state.lows[key];
    const yesterday = state.daily[key]?.[addDays(today, -1)];
    if (!prevLow) {
      state.lows[key] = { ...best, seenAt: today };
    } else if (best.price < prevLow.price) {
      newLows.push({ key, ...best, was: prevLow.price });
      state.lows[key] = { ...best, seenAt: today };
    }
    const daily = (state.daily[key] ??= {});
    daily[today] = daily[today] == null ? best.price : Math.min(daily[today], best.price);
    for (const d of Object.keys(daily)) if (d < addDays(today, -120)) delete daily[d];
    rows.push({ key, ...best, low: state.lows[key], yesterday });
  }
  return { rows, newLows };
}

/* ============================ 來回行程 ============================ */

/**
 * 讀 trips.json，格式：
 * [
 *   { "名稱": "5天", "天數": 5 },
 *   { "名稱": "跨年", "天數": "4-6", "最早出發": "2026-12-26", "最晚出發": "2027-01-02" }
 * ]
 * 天數算法：去程那天算第 1 天，回程那天算最後一天（5 天 = 5 天 4 夜）。
 */
function loadTrips() {
  const raw = existsSync(TRIPS_FILE) ? JSON.parse(readFileSync(TRIPS_FILE, "utf8")) : DEFAULT_TRIPS;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) throw new Error("trips.json 要是 1～10 個行程的陣列");
  const names = new Set();
  return raw.map((t, i) => {
    const where = `trips.json 第 ${i + 1} 個行程`;
    // 名稱只留中英文、數字、空白、-、_，避免塞進 Issue 時變成連結或標記
    const name = String(t?.名稱 ?? `行程${i + 1}`).replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 20);
    if (!name || names.has(name)) throw new Error(`${where}：名稱空白或重複`);
    names.add(name);
    const m = String(t.天數 ?? "").trim().match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);
    if (!m) throw new Error(`${where}：天數要寫成 5 或 "4-6"`);
    const minDays = Number(m[1]), maxDays = Number(m[2] ?? m[1]);
    if (minDays < 2 || maxDays > 30 || minDays > maxDays) throw new Error(`${where}：天數要在 2～30 之間`);
    const earliest = t.最早出發 ?? null, latest = t.最晚出發 ?? null;
    for (const d of [earliest, latest]) if (d !== null && !DATE_RE.test(d)) throw new Error(`${where}：日期格式要是 YYYY-MM-DD`);
    return { name, minDays, maxDays, earliest, latest };
  });
}

const tripDaysLabel = (t) => (t.minDays === t.maxDays ? `${t.minDays} 天` : `${t.minDays}～${t.maxDays} 天`);

/** 找出每個目的地（城市）在這個行程條件下最便宜的來回組合 */
function roundTrips(legs, trip, from, to) {
  const best = {};
  const outKeys = Object.keys(legs).filter((k) => k.startsWith(`${ORIGIN}-`));
  const inKeys = Object.keys(legs).filter((k) => k.endsWith(`-${ORIGIN}`));
  for (const ok of outKeys) {
    const x = ok.split("-")[1];
    const backs = inKeys.map((k) => k.split("-")[0]).filter((y) => cityOf(y) === cityOf(x));
    for (const [dep, outPrice] of Object.entries(legs[ok])) {
      if (dep < from || dep > to) continue;
      if (trip.earliest && dep < trip.earliest) continue;
      if (trip.latest && dep > trip.latest) continue;
      for (let n = trip.minDays; n <= trip.maxDays; n++) {
        const ret = addDays(dep, n - 1);
        for (const y of backs) {
          const retPrice = legs[`${y}-${ORIGIN}`]?.[ret];
          if (retPrice == null) continue;
          const total = outPrice + retPrice;
          const city = cityOf(x);
          const cur = best[city];
          if (!cur || total < cur.total || (total === cur.total && dep < cur.dep)) {
            best[city] = { city, x, y, dep, ret, days: n, outPrice, retPrice, total };
          }
        }
      }
    }
  }
  return Object.values(best).sort((a, b) => a.total - b.total);
}

const comboLabel = (c) => (c.x === c.y ? name(c.x) : `${name(c.x)}去 ${name(c.y)}回`);

function analyseTrips(legs, trips, state, from, to) {
  state.tripLows ??= {};
  const results = [];
  const newLows = [];
  for (const trip of trips) {
    const combos = roundTrips(legs, trip, from, to);
    for (const c of combos) {
      const key = `${trip.name}|${trip.minDays}-${trip.maxDays}|${trip.earliest ?? ""}|${trip.latest ?? ""}|${c.city}`;
      const prev = state.tripLows[key];
      if (!prev) state.tripLows[key] = { total: c.total, dep: c.dep };
      else if (c.total < prev.total) {
        newLows.push({ trip, ...c, was: prev.total });
        state.tripLows[key] = { total: c.total, dep: c.dep };
      }
      c.low = state.tripLows[key].total;
    }
    results.push({ trip, combos });
  }
  return { results, newLows };
}

/* ============================ 報表 ============================ */

function buildReport(legs, rows, seenOther, from, to, stamp, tripResults) {
  const out = [
    "# 虎航票價追蹤：桃園 ↔ 日本・韓國",
    "",
    `更新時間：${stamp}（台北）　出發日期範圍：${from} ～ ${to}`,
    "",
    "> 價格是虎航官網日曆上的單程最低票價（新台幣），**未含稅金與附加費用**，實際以官網訂票頁為準。",
    "",
  ];
  for (const { trip, combos } of tripResults) {
    const range = trip.earliest || trip.latest ? `，${trip.earliest ?? "今天"} ～ ${trip.latest ?? to} 出發` : "";
    out.push(`## 來回：${trip.name}（${tripDaysLabel(trip)}${range}）`, "");
    if (!combos.length) { out.push("目前沒有符合條件的來回組合。", ""); continue; }
    out.push("| 目的地 | 來回總價 | 去程 | 回程 | 天數 | 歷史最低 |", "|---|---:|---|---|---:|---:|");
    for (const c of combos.slice(0, 20)) {
      out.push(`| ${comboLabel(c)} | **${fmt(c.total)}** | ${c.dep}（${fmt(c.outPrice)}） | ${c.ret}（${fmt(c.retPrice)}） | ${c.days} | ${fmt(c.low)} |`);
    }
    out.push("");
  }
  const table = (title, filter) => {
    const list = rows.filter(filter).sort((a, b) => a.price - b.price);
    if (!list.length) return;
    out.push(`## ${title}`, "", "| 航線 | 目前最低 | 日期 | 歷史最低 | 和昨天比 |", "|---|---:|---|---:|---:|");
    for (const r of list) {
      const diff = r.yesterday == null ? "—" : r.price === r.yesterday ? "持平" : `${r.price < r.yesterday ? "▼" : "▲"} ${fmt(Math.abs(r.price - r.yesterday))}`;
      out.push(`| ${routeLabel(r.key)} | **${fmt(r.price)}** | ${r.date} | ${fmt(r.low.price)}（${r.low.date}） | ${diff} |`);
    }
    out.push("");
  };
  table("去程（桃園出發）", (r) => r.key.startsWith(`${ORIGIN}-`));
  table("回程（飛回桃園）", (r) => r.key.endsWith(`-${ORIGIN}`));

  out.push("## 各航線最便宜的 5 天", "");
  for (const key of Object.keys(legs).sort()) {
    const top = Object.entries(legs[key]).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5);
    out.push(`**${routeLabel(key)}**：${top.map(([d, p]) => `${d.slice(5)} ${fmt(p)}`).join("、")}`, "");
  }
  if (seenOther.length) out.push(`<sub>其他有出現但不在追蹤清單的機場：${seenOther.join("、")}</sub>`, "");
  return out.join("\n");
}

/** 給網站用的資料：每條航線一個陣列，第 i 格是 from 之後第 i 天的價格（沒有航班為 null） */
function buildSiteData(legs, state, from, to, stamp) {
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const prices = {};
  for (const key of Object.keys(legs).sort()) {
    const arr = new Array(span).fill(null);
    for (const [date, price] of Object.entries(legs[key])) {
      const i = Math.round((Date.parse(date) - Date.parse(from)) / 86_400_000);
      if (i >= 0 && i < span) arr[i] = price;
    }
    prices[key] = arr;
  }
  const airports = {};
  for (const key of Object.keys(legs)) {
    for (const code of key.split("-")) {
      if (code !== ORIGIN) airports[code] = { name: name(code), city: cityOf(code), country: KOREA.has(code) ? "KR" : "JP" };
    }
  }
  const lows = {};
  for (const key of Object.keys(legs)) if (state.lows[key]) lows[key] = { date: state.lows[key].date, price: state.lows[key].price };
  return { updated: stamp, from, to, origin: ORIGIN, airports, prices, lows };
}

function newLowMessage(newLows, tripLows, owner) {
  const lines = [ISSUE_MARKER, `@${owner} **偵測到新低價**`, ""];
  for (const n of [...tripLows].sort((a, b) => a.total - b.total)) {
    lines.push(`- 來回「${n.trip.name}」${comboLabel(n)}：**${fmt(n.total)}**（${n.dep} 去、${n.ret} 回，${n.days} 天），之前最低 ${fmt(n.was)}`);
  }
  for (const n of [...newLows].sort((a, b) => a.price - b.price)) {
    lines.push(`- 單程 ${routeLabel(n.key)}：**${fmt(n.price)}**（${n.date} 出發），之前最低 ${fmt(n.was)}`);
  }
  lines.push("", "（未含稅，請到虎航官網確認）");
  return lines.join("\n");
}

function summaryMessage(rows, tripResults, owner, today) {
  const lines = [ISSUE_MARKER, `@${owner} **每日摘要 ${today}**`, ""];
  for (const { trip, combos } of tripResults) {
    lines.push(`**來回「${trip.name}」（${tripDaysLabel(trip)}）最便宜 5 個：**`);
    if (!combos.length) lines.push("- 目前沒有符合條件的組合");
    for (const c of combos.slice(0, 5)) lines.push(`- ${comboLabel(c)}：${fmt(c.total)}（${c.dep} 去、${c.ret} 回）`);
    lines.push("");
  }
  const out = rows.filter((r) => r.key.startsWith(`${ORIGIN}-`)).sort((a, b) => a.price - b.price).slice(0, 5);
  lines.push("**單程桃園出發最便宜 5 條：**");
  for (const r of out) lines.push(`- ${routeLabel(r.key)}：${fmt(r.price)}（${r.date}）`);
  lines.push("", "完整表格請看 repo 裡的 REPORT.md。");
  return lines.join("\n");
}

/* ============================ GitHub Issue 通知 ============================ */

async function gh(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error("缺少 GITHUB_TOKEN 或 GITHUB_REPOSITORY");
  return safeFetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
  });
}

async function notify(state, body) {
  if (!state.issue) {
    const issue = await gh("/issues", {
      method: "POST",
      body: JSON.stringify({
        title: "虎航票價通知",
        body: `${ISSUE_MARKER}\n新低價和每日摘要都會以留言貼在這裡，GitHub 會寄信通知你。請不要關閉這個 Issue。`,
      }),
    });
    state.issue = issue.number;
  }
  await gh(`/issues/${state.issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

/* ============================ 主流程 ============================ */

async function main() {
  const tp = taipeiParts(NOW);
  const today = tp.date;
  const from = today, to = addDays(today, DAYS_AHEAD);
  const state = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : { lows: {}, daily: {}, issue: null, lastSummary: null };
  const firstRun = Object.keys(state.lows).length === 0;
  const trips = loadTrips(); // 先讀設定，格式錯就在抓價前停下

  const { legs, seenOther } = await fetchAll(from, to);
  const { rows, newLows } = analyse(legs, state, today);
  const { results: tripResults, newLows: tripLows } = analyseTrips(legs, trips, state, from, to);
  state.lastRun = `${today} ${tp.time}`;

  const owner = (process.env.GITHUB_REPOSITORY_OWNER ?? "").replace(/[^\w-]/g, "") || "owner";
  const messages = [];
  if ((newLows.length || tripLows.length) && !firstRun) messages.push(newLowMessage(newLows, tripLows, owner));
  const wantSummary = FORCE_SUMMARY || firstRun || (state.lastSummary !== today && tp.hour >= SUMMARY_HOUR);
  if (wantSummary) messages.push(summaryMessage(rows, tripResults, owner, today));

  const report = buildReport(legs, rows, seenOther, from, to, `${today} ${tp.time}`, tripResults);
  console.log(`抓到 ${Object.keys(legs).length} 條航線，單程新低 ${newLows.length}、來回新低 ${tripLows.length}，要發 ${messages.length} 則通知`);

  if (DRY) {
    console.log("\n----- 試跑：不寫檔、不發通知 -----\n");
    for (const m of messages) console.log(m, "\n");
    console.log(report);
    return;
  }

  let notifyError = null;
  try {
    for (const m of messages) await notify(state, m);
    if (wantSummary) state.lastSummary = today;
  } catch (e) {
    notifyError = e;
  }
  // 就算通知失敗也要存檔，避免下次重複開 Issue
  mkdirSync(new URL("./data/", import.meta.url), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + "\n");
  writeFileSync(REPORT_FILE, report + "\n");
  mkdirSync(SITE_DIR, { recursive: true });
  writeFileSync(SITE_DATA_FILE, JSON.stringify(buildSiteData(legs, state, from, to, `${today} ${tp.time}`)) + "\n");
  if (notifyError) throw new Error(`通知失敗：${notifyError.message}`);
}

main().catch((e) => {
  console.error(`執行失敗：${e.message}`);
  process.exit(1);
});
