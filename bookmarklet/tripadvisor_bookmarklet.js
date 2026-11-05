/*
 * TripAdvisor review scraper with a per-asset progress tracker.
 *
 * One script, two ways to run it:
 *
 *   1. Bookmark: click the "TA Reviews" bookmark on a tripadvisor.com page.
 *      It asks for hotel URLs and a review limit.
 *
 *   2. Cowork / Claude in Chrome: set window.__taConfig first, then run this
 *      script in the page. No dialogs are shown. Example:
 *        window.__taConfig = {
 *          assets: [{ name: "Hotel A", url: "https://www.tripadvisor.com/Hotel_Review-g1-d123-Reviews-A.html" }],
 *          maxReviews: 500,          (optional, default: all)
 *          autoDownload: true        (optional, default: true)
 *        };
 *      Read progress with:  window.__taSummary()   (returns a JSON string)
 *      Stop early with:     window.__taStop()
 *      Re-download CSV:     window.__taDownload()
 *
 * Requests run inside your own browser tab, from your own IP address and with
 * your real cookies, which avoids the 403 blocks that hit cloud servers.
 *
 * Self-updating query: TripAdvisor's GraphQL API uses "persisted query" IDs
 * that change when the site is redeployed (error: PersistedQueryNotFound).
 * When that happens, the tracker shows a SETUP banner and window.__taSummary()
 * reports status "needs_setup". Clicking the reviews "next page" arrow on the
 * hotel page once lets the script copy the page's own request as a template.
 * The template is saved in localStorage on tripadvisor.com for later runs.
 *
 * Rebuild install.html and the Cowork skill copy after editing:
 *     node bookmarklet/build.js
 *
 * Do not put "//" line comments or multi-line template strings inside the
 * function body: the build step trims and joins lines.
 */
(async () => {
  const VERSION = "2.0";
  /* UPDATE HERE: fallback values, used only until a template is learned */
  const GRAPHQL_PATH = "/data/graphql/ids";
  const FALLBACK_QUERY_ID = "ef1a9f94012220d3";
  const STORE_KEY = "taReviewsTemplate.v1";
  const HOTEL_DELAY = [3000, 7000];
  const PAGE_DELAY = [1000, 2500];
  const BLOCK_COOLDOWN = 30000;
  const LEARN_TIMEOUT = 300000;
  const PAGE_SIZES = [100, 50, 20];
  const COLUMNS = ["asset_name", "hotel_url", "location_id", "id", "title", "text", "rating",
    "publishedDate", "username", "tripType"];

  if (!/tripadvisor\./.test(location.hostname)) {
    alert("Open a TripAdvisor hotel page first, then run the scraper again.");
    return;
  }
  if (window.__taState && window.__taState.status === "running") {
    alert("The scraper is already running in this tab.");
    return;
  }

  const realFetch = window.fetch.bind(window);
  const pageMatch = location.href.match(/-d(\d+)(?=[-.?#]|$)/);
  const pageLocId = pageMatch ? Number(pageMatch[1]) : null;

  /* ---------- inputs ---------- */
  const nameFromUrl = (url) => {
    const m = url.match(/-Reviews-([^-./?#]+)/);
    return m ? decodeURIComponent(m[1]).replace(/_/g, " ") : "";
  };
  const toAsset = (entry) => {
    const url = typeof entry === "string" ? entry.trim() : String((entry && entry.url) || "").trim();
    const m = url.match(/-d(\d+)(?=[-.\s?#]|$)/);
    if (!m) return null;
    const given = entry && typeof entry === "object" && entry.name ? String(entry.name).trim() : "";
    return { name: given || nameFromUrl(url) || "location " + m[1], url, id: Number(m[1]) };
  };

  const cfg = window.__taConfig && typeof window.__taConfig === "object" ? window.__taConfig : null;
  window.__taConfig = undefined;
  let entries;
  let maxReviews = Infinity;
  let autoDownload = true;
  if (cfg) {
    entries = Array.isArray(cfg.assets) ? cfg.assets : (Array.isArray(cfg.urls) ? cfg.urls : []);
    if (Number(cfg.maxReviews) > 0) maxReviews = Number(cfg.maxReviews);
    if (cfg.autoDownload === false) autoDownload = false;
  } else {
    const input = prompt(
      "Paste one or more TripAdvisor hotel URLs (separate them with spaces).\n" +
      "Leave empty to scrape the hotel on this page.", "");
    if (input === null) return;
    entries = (input.trim() || location.href).split(/\s+/).filter(Boolean);
    const maxText = prompt("Max reviews per hotel? Leave empty for all.", "");
    if (maxText === null) return;
    if (parseInt(maxText, 10) > 0) maxReviews = parseInt(maxText, 10);
  }
  const assets = [];
  const seenIds = new Set();
  for (const e of entries) {
    const a = toAsset(e);
    if (a && !seenIds.has(a.id)) { seenIds.add(a.id); assets.push(a); }
  }
  if (!assets.length) {
    const msg = "No hotel IDs found. Hotel URLs contain '-d' followed by a number, like -d93437-.";
    window.__taState = { version: VERSION, status: "error", message: msg, assets: [] };
    window.__taSummary = () => JSON.stringify(window.__taState);
    if (!cfg) alert(msg);
    return;
  }

  /* ---------- shared state (read by Claude via window.__taSummary) ---------- */
  const state = {
    version: VERSION,
    status: "running",
    message: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    maxReviews: maxReviews === Infinity ? null : maxReviews,
    queryId: null,
    pageSize: null,
    totalScraped: 0,
    csvFile: null,
    assets: assets.map((a) => ({ name: a.name, url: a.url, locationId: a.id, status: "queued",
      scraped: 0, target: null, totalOnSite: null, error: null })),
    log: [],
  };
  window.__taState = state;
  window.__taSummary = () => JSON.stringify({
    version: state.version, status: state.status, message: state.message,
    startedAt: state.startedAt, finishedAt: state.finishedAt, queryId: state.queryId,
    pageSize: state.pageSize, totalScraped: state.totalScraped, csvFile: state.csvFile,
    assets: state.assets.map((a) => ({ name: a.name, status: a.status, scraped: a.scraped,
      target: a.target, error: a.error })),
    recentLog: state.log.slice(-5),
  });
  let stopRequested = false;
  window.__taStop = () => { stopRequested = true; return "stop requested"; };

  /* ---------- tracker UI ---------- */
  const el = (tag, css, text) => {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  };
  const C = { green: "#00aa6c", ink: "#1a1a1a", muted: "#6b6b6b", track: "#e8ecea",
    red: "#c62828", amber: "#b26a00", blue: "#1565c0", line: "#e3e3e3" };
  const old = document.getElementById("ta-tracker");
  if (old) old.remove();
  const panel = el("div", ["position:fixed", "top:12px", "right:12px", "z-index:2147483647",
    "width:430px", "max-width:calc(100vw - 24px)", "max-height:80vh", "display:flex",
    "flex-direction:column", "background:#fff", "color:" + C.ink, "border:1px solid " + C.line,
    "border-radius:10px", "box-shadow:0 8px 28px rgba(0,0,0,.22)",
    "font:13px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"].join(";"));
  panel.id = "ta-tracker";
  const header = el("div", "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid " + C.line);
  const title = el("div", "font-weight:700;flex:1", "TA Review Tracker");
  const btnCss = "border:1px solid " + C.line + ";background:#fff;border-radius:6px;padding:3px 8px;font-size:12px;font-family:inherit;cursor:pointer;color:" + C.ink;
  const stopBtn = el("button", btnCss, "Stop");
  const dlBtn = el("button", btnCss, "Download CSV");
  const minBtn = el("button", btnCss, "–");
  const closeBtn = el("button", btnCss, "×");
  header.append(title, stopBtn, dlBtn, minBtn, closeBtn);

  const body = el("div", "overflow:auto;padding:10px 12px");
  const overallLabel = el("div", "display:flex;justify-content:space-between;font-weight:600;margin-bottom:4px");
  const overallLeft = el("span");
  const overallRight = el("span", "color:" + C.muted + ";font-weight:400");
  overallLabel.append(overallLeft, overallRight);
  const bar = (h) => {
    const track = el("div", "height:" + h + "px;background:" + C.track + ";border-radius:99px;overflow:hidden");
    const fill = el("div", "height:100%;width:0%;background:" + C.green + ";border-radius:99px;transition:width .3s");
    track.append(fill);
    return { track, fill };
  };
  const overall = bar(10);
  const stats = el("div", "color:" + C.muted + ";font-size:12px;margin:4px 0 10px");
  const banner = el("div", "display:none;background:#fff4e5;border:1px solid #f0c27b;color:#7a4b00;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-weight:600");
  const list = el("div", "display:flex;flex-direction:column;gap:10px");
  const logBox = el("details", "margin-top:12px;color:" + C.muted + ";font-size:12px");
  const logSummary = el("summary", "cursor:pointer", "Log");
  const logLines = el("div", "font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;max-height:140px;overflow:auto;margin-top:6px");
  logBox.append(logSummary, logLines);
  body.append(overallLabel, overall.track, stats, banner, list, logBox);
  panel.append(header, body);
  document.body.appendChild(panel);

  const STATUS_STYLE = {
    queued: ["Queued", C.muted], running: ["Running", C.blue], done: ["Done", C.green],
    blocked: ["Blocked", C.amber], failed: ["Failed", C.red], skipped: ["Skipped", C.muted],
  };
  const rows = state.assets.map((a) => {
    const wrap = el("div");
    const top = el("div", "display:flex;align-items:center;gap:8px;margin-bottom:4px");
    const name = el("div", "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600", a.name);
    name.title = a.url;
    const chip = el("span", "font-size:11px;font-weight:600;padding:1px 7px;border-radius:99px;border:1px solid currentColor");
    const count = el("span", "font-size:12px;color:" + C.muted + ";min-width:92px;text-align:right");
    top.append(name, chip, count);
    const b = bar(6);
    const err = el("div", "display:none;font-size:11px;color:" + C.red + ";margin-top:3px");
    wrap.append(top, b.track, err);
    list.append(wrap);
    return { chip, count, fill: b.fill, err };
  });

  const fmt = (n) => Number(n).toLocaleString();
  const fractionOf = (a) => {
    if (a.status === "done" || a.status === "failed" || a.status === "blocked" || a.status === "skipped") return 1;
    if (a.status === "running" && a.target) return Math.min(1, a.scraped / a.target);
    return 0;
  };
  const render = () => {
    state.assets.forEach((a, i) => {
      const r = rows[i];
      const [label, color] = STATUS_STYLE[a.status] || [a.status, C.muted];
      r.chip.textContent = a.status === "done" && a.scraped === 0 ? "No reviews" : label;
      r.chip.style.color = color;
      r.count.textContent = a.target != null ? fmt(a.scraped) + " / " + fmt(a.target) : (a.scraped ? fmt(a.scraped) : "");
      const pct = a.status === "done" ? 100 : a.target ? Math.min(100, (100 * a.scraped) / a.target) : 0;
      r.fill.style.width = pct + "%";
      r.fill.style.background = a.status === "failed" ? C.red : a.status === "blocked" ? C.amber : C.green;
      r.err.style.display = a.error ? "block" : "none";
      r.err.textContent = a.error || "";
    });
    const n = state.assets.length;
    const finished = state.assets.filter((a) => fractionOf(a) === 1).length;
    const frac = state.assets.reduce((s, a) => s + fractionOf(a), 0) / n;
    overall.fill.style.width = (state.status === "done" ? 100 : 100 * frac) + "%";
    overallLeft.textContent = state.status === "done" ? "Complete" :
      state.status === "stopped" ? "Stopped" : state.status === "aborted" ? "Needs attention" : "Overall";
    overallRight.textContent = finished + " / " + n + " assets";
    const mins = (Date.now() - Date.parse(state.startedAt)) / 60000;
    let line = fmt(state.totalScraped) + " reviews";
    if (mins > 0.1 && state.totalScraped) line += " · " + fmt(Math.round(state.totalScraped / mins)) + "/min";
    if (state.status === "running" && frac > 0.02 && frac < 1) line += " · ~" + Math.max(1, Math.round(mins / frac - mins)) + " min left";
    if (state.pageSize) line += " · " + state.pageSize + " per request";
    stats.textContent = line;
    banner.style.display = state.status === "needs_setup" || state.status === "aborted" ? "block" : "none";
    banner.textContent = state.message;
    const active = state.status === "running" || state.status === "needs_setup";
    stopBtn.style.display = active ? "" : "none";
    dlBtn.disabled = active || !state.totalScraped;
    dlBtn.style.opacity = dlBtn.disabled ? "0.45" : "1";
    dlBtn.style.cursor = dlBtn.disabled ? "default" : "pointer";
  };
  const say = (msg) => {
    const t = new Date().toLocaleTimeString();
    state.log.push(t + " " + msg);
    if (state.log.length > 300) state.log.shift();
    logLines.textContent = state.log.join("\n");
    logLines.scrollTop = logLines.scrollHeight;
  };
  stopBtn.onclick = () => { stopRequested = true; stopBtn.textContent = "Stopping…"; };
  minBtn.onclick = () => { body.style.display = body.style.display === "none" ? "" : "none"; };
  closeBtn.onclick = () => { panel.remove(); };
  render();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, "0")).join("");
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ---------- JSON helpers ---------- */
  const dig = (obj, path) => {
    let cur = obj;
    for (const k of path) {
      if (cur == null || typeof cur !== "object" || !(k in cur)) return undefined;
      cur = cur[k];
    }
    return cur;
  };
  const looksLikeReviews = (v) => {
    if (!Array.isArray(v) || !v.length) return false;
    const ds = v.filter((x) => x && typeof x === "object" && !Array.isArray(x));
    if (ds.length < Math.max(1, Math.floor(v.length / 2))) return false;
    const hits = ds.filter((d) => "id" in d && "rating" in d && ("text" in d || "title" in d)).length;
    return hits >= Math.max(1, Math.floor(ds.length / 2));
  };
  const findReviews = (obj) => {
    if (looksLikeReviews(obj)) return obj;
    if (obj && typeof obj === "object") {
      for (const child of Object.values(obj)) {
        const f = findReviews(child);
        if (f) return f;
      }
    }
    return null;
  };
  const findNumberKey = (obj, key) => {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj[key] === "number") return obj[key];
    for (const child of Object.values(obj)) {
      const f = findNumberKey(child, key);
      if (f != null) return f;
    }
    return null;
  };
  const replaceValue = (obj, from, to) => {
    if (Array.isArray(obj)) return obj.map((v) => replaceValue(v, from, to));
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = replaceValue(v, from, to);
      return out;
    }
    if (obj === from) return to;
    if (obj === String(from)) return String(to);
    return obj;
  };
  const setKey = (obj, key, value) => {
    let n = 0;
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        if (k === key && (typeof obj[k] === "number" || obj[k] == null)) { obj[k] = value; n++; }
        else n += setKey(obj[k], key, value);
      }
    }
    return n;
  };

  /* ---------- request template ---------- */
  const fallbackTemplate = {
    locId: -1,
    item: {
      variables: {
        locationId: -1, offset: 0, filters: [], prefs: null, initialPrefs: {}, limit: 20,
        filterCacheKey: null, prefsCacheKey: "hotelReviewPrefs", needKeywords: false,
        keywordVariant: "location_keywords_v2_llr_order_30_en",
      },
      extensions: { preRegisteredQueryId: FALLBACK_QUERY_ID },
    },
  };
  const loadTemplate = () => {
    try { const t = JSON.parse(localStorage.getItem(STORE_KEY)); if (t && t.item) return t; } catch (e) {}
    return null;
  };
  const saveTemplate = (t) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(t)); } catch (e) {} };
  const forgetTemplate = () => { try { localStorage.removeItem(STORE_KEY); } catch (e) {} };
  const queryIdOf = (t) => dig(t, ["item", "extensions", "preRegisteredQueryId"]) || "(inline query)";

  let template = loadTemplate() || fallbackTemplate;
  let verified = false;
  state.queryId = queryIdOf(template);
  const pageSizeOf = (t) => findNumberKey(t.item.variables, "limit") || 10;
  const buildBody = (t, hotelId, offset, limit) => {
    const item = clone(t.item);
    item.variables = replaceValue(item.variables, t.locId, hotelId);
    setKey(item.variables, "offset", offset);
    if (limit) setKey(item.variables, "limit", limit);
    return [item];
  };

  /* ---------- learning: watch the page's own GraphQL calls ---------- */
  const learn = async () => {
    if (pageLocId == null) {
      state.message = "Setup needed: open one of the hotel pages on TripAdvisor and run the scraper again.";
      return null;
    }
    let captured = null;
    const inspect = (bodyText, data) => {
      if (captured) return;
      let reqBody;
      try { reqBody = JSON.parse(bodyText); } catch (e) { return; }
      const items = Array.isArray(reqBody) ? reqBody : [reqBody];
      const datas = Array.isArray(data) ? data : [data];
      items.forEach((item, i) => {
        if (captured || !item || !item.variables) return;
        const resp = datas.length === items.length ? datas[i] : data;
        if (!findReviews(resp)) return;
        if (!JSON.stringify(item.variables).includes(String(pageLocId))) return;
        captured = { locId: pageLocId, item: clone(item) };
      });
    };
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const resp = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (/graphql/i.test(url)) {
          let bodyText = init && typeof init.body === "string" ? init.body : null;
          if (bodyText == null && input && typeof input.clone === "function") {
            bodyText = await input.clone().text().catch(() => null);
          }
          if (bodyText) resp.clone().json().then((d) => inspect(bodyText, d)).catch(() => {});
        }
      } catch (e) {}
      return resp;
    };
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    const origOpen = XHR && XHR.open;
    const origSend = XHR && XHR.send;
    if (XHR) {
      XHR.open = function (method, url) { this.__taUrl = String(url); return origOpen.apply(this, arguments); };
      XHR.send = function (b) {
        if (/graphql/i.test(this.__taUrl || "") && typeof b === "string") {
          this.addEventListener("load", () => {
            try { inspect(b, JSON.parse(this.responseText)); } catch (e) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    }

    state.status = "needs_setup";
    state.message = "One-time setup: scroll down to this hotel's reviews and click the NEXT PAGE arrow " +
      "(or page 2). If nothing happens, change the review sort or language filter.";
    say("waiting for a reviews request from the page");
    render();
    const deadline = Date.now() + LEARN_TIMEOUT;
    while (!captured && !stopRequested && Date.now() < deadline) await sleep(500);

    window.fetch = origFetch;
    if (XHR) { XHR.open = origOpen; XHR.send = origSend; }

    if (!captured) {
      state.message = stopRequested ? "Stopped during setup." :
        "Setup timed out: no reviews request seen. Reload this hotel page and run the scraper again.";
      return null;
    }
    saveTemplate(captured);
    state.status = "running";
    state.message = "";
    state.queryId = queryIdOf(captured);
    say("learned query ID " + state.queryId);
    render();
    return captured;
  };

  /* ---------- scraping ---------- */
  class Blocked extends Error {}
  class NeedsLearning extends Error {}
  class Stopped extends Error {}

  const extract = (b, quiet) => {
    const results = Array.isArray(b) ? b : [b];
    let notFound = false;
    for (const r of results) {
      if (r && r.errors) {
        const msg = JSON.stringify(r.errors);
        if (/PersistedQuery/i.test(msg)) notFound = true;
        else if (!quiet) say("GraphQL errors: " + msg.slice(0, 300));
      }
    }
    for (const r of results) {
      const l = findReviews(r);
      if (l) return { reviews: l, total: findNumberKey(r, "totalCount"), notFound };
    }
    return { reviews: [], total: null, notFound };
  };
  const first = (d, ...paths) => {
    for (const p of paths) { const v = dig(d, p); if (v != null && v !== "") return v; }
    return null;
  };
  /* UPDATE HERE: field mapping */
  const parse = (raw) => ({
    id: first(raw, ["id"], ["reviewId"]),
    title: first(raw, ["title"]),
    text: first(raw, ["text"], ["reviewText"]),
    rating: first(raw, ["rating"], ["bubbleRating"]),
    publishedDate: first(raw, ["publishedDate"], ["createdDate"], ["publishedDateTime"]),
    username: first(raw, ["userProfile", "username"], ["userProfile", "displayName"],
      ["user", "username"], ["username"]),
    tripType: first(raw, ["tripInfo", "tripType"], ["tripType"]),
  });

  let goodLimit = template.pageSize || null;
  const fetchPage = async (asset, offset, limit, quiet) => {
    const resp = await realFetch(GRAPHQL_PATH, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Requested-By": token() },
      body: JSON.stringify(buildBody(template, asset.id, offset, limit)),
    });
    if (resp.status === 403 || resp.status === 429) throw new Blocked("HTTP " + resp.status);
    let b = null;
    try { b = await resp.json(); } catch (e) {}
    if (!resp.ok && !b) return { reviews: [], total: null, notFound: false };
    return extract(b, quiet);
  };
  const firstPage = async (asset) => {
    const base = pageSizeOf(template);
    const sizes = goodLimit ? [goodLimit] : [...PAGE_SIZES.filter((n) => n > base), base];
    for (const limit of sizes) {
      const page = await fetchPage(asset, 0, limit, limit !== base);
      if (page.notFound) throw new NeedsLearning("query ID not recognized");
      if (page.reviews.length) {
        if (goodLimit !== limit) {
          goodLimit = limit;
          if (template !== fallbackTemplate) { template.pageSize = limit; saveTemplate(template); }
        }
        state.pageSize = limit;
        return { page, limit };
      }
      if (limit !== base) await sleep(rand(PAGE_DELAY));
    }
    if (!verified) throw new NeedsLearning("no reviews returned");
    return { page: { reviews: [], total: null }, limit: goodLimit || base };
  };

  const allRows = [];
  const scrapeAsset = async (asset, st) => {
    const out = [];
    const ids = new Set();
    let offset = 0;
    let { page, limit } = await firstPage(asset);
    try {
    while (true) {
      if (page.total != null) {
        st.totalOnSite = page.total;
        st.target = Math.min(page.total, maxReviews);
      }
      if (!page.reviews.length) break;
      let added = 0;
      for (const raw of page.reviews) {
        if (!raw || typeof raw !== "object") continue;
        const row = parse(raw);
        const key = row.id != null ? String(row.id) : row.title + "|" + row.text;
        if (ids.has(key)) continue;
        ids.add(key);
        out.push({ asset_name: asset.name, hotel_url: asset.url, location_id: asset.id, ...row });
        added++;
        if (out.length >= maxReviews) break;
      }
      st.scraped = out.length;
      state.totalScraped = allRows.length + out.length;
      render();
      if (!added || out.length >= maxReviews) break;
      offset += page.reviews.length;
      if (page.total != null && offset >= page.total) break;
      if (stopRequested) throw new Stopped();
      await sleep(rand(PAGE_DELAY));
      page = await fetchPage(asset, offset, limit);
    }
    } catch (e) { e.partial = out; throw e; }
    if (st.target == null || st.target > out.length) st.target = out.length;
    return out;
  };

  const toCsv = (rs) => {
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "﻿" + [COLUMNS.join(","), ...rs.map((r) => COLUMNS.map((c) => esc(r[c])).join(","))].join("\r\n");
  };
  const download = () => {
    if (!allRows.length) return "no rows";
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const file = "tripadvisor_reviews_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      "_" + pad(d.getHours()) + pad(d.getMinutes()) + ".csv";
    const blob = new Blob([toCsv(allRows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    state.csvFile = file;
    say("downloaded " + file);
    return file;
  };
  window.__taDownload = download;
  dlBtn.onclick = download;

  /* ---------- main loop ---------- */
  say("scraping " + assets.length + " asset(s)");
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const st = state.assets[i];
    if (stopRequested || state.status === "aborted") { st.status = "skipped"; continue; }
    st.status = "running";
    render();
    say("[" + (i + 1) + "/" + assets.length + "] " + asset.name);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await scrapeAsset(asset, st);
        allRows.push(...out);
        state.totalScraped = allRows.length;
        st.status = "done";
        if (out.length) verified = true;
        say("  done: " + out.length + " reviews");
        break;
      } catch (e) {
        if (e && e.partial && e.partial.length) {
          allRows.push(...e.partial);
          state.totalScraped = allRows.length;
          say("  kept " + e.partial.length + " reviews collected before the interruption");
        }
        if (e instanceof NeedsLearning && attempt === 0 && !verified) {
          say("  " + e.message);
          forgetTemplate();
          const t = await learn();
          if (!t) { state.status = "aborted"; st.status = "skipped"; break; }
          template = t;
          goodLimit = null;
          verified = true;
          continue;
        }
        if (e instanceof Stopped) {
          st.status = "skipped";
          st.error = "stopped by user";
          break;
        }
        if (e instanceof Blocked) {
          st.status = "blocked";
          st.error = e.message + ". Waited 30s and moved on.";
          say("  blocked: " + e.message);
          render();
          await sleep(BLOCK_COOLDOWN);
          break;
        }
        st.status = "failed";
        st.error = String((e && e.message) || e);
        say("  failed: " + st.error);
        break;
      }
    }
    render();
    if (i < assets.length - 1 && !stopRequested && state.status !== "aborted") await sleep(rand(HOTEL_DELAY));
  }

  if (state.status !== "aborted") state.status = stopRequested ? "stopped" : "done";
  state.finishedAt = new Date().toISOString();
  say("finished: " + allRows.length + " reviews");
  if (allRows.length && autoDownload) download();
  render();
})();
