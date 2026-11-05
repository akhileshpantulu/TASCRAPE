/*
 * TripAdvisor review scraper, browser bookmarklet version.
 *
 * Runs inside your own browser tab on tripadvisor.com, so requests come from
 * your own IP address and carry your real browser cookies. This avoids the
 * 403 blocks that hit cloud servers such as Google Colab.
 *
 * Self-updating query: TripAdvisor's GraphQL API uses "persisted query" IDs
 * that change when the site is redeployed (error: PersistedQueryNotFound).
 * When the saved ID stops working, this script asks you to click the reviews
 * "next page" button once. It watches the request the page itself sends,
 * copies that request as a template, saves it in the browser
 * (localStorage on tripadvisor.com), and reuses it for every hotel.
 *
 * Rebuild install.html after editing:  node bookmarklet/build.js
 *
 * Do not put "//" line comments inside the function body: the build step
 * strips whole-line block comments only, and the bookmarklet must stay valid.
 */
(async () => {
  /* UPDATE HERE: fallback values, used only until a template is learned */
  const GRAPHQL_PATH = "/data/graphql/ids";
  const FALLBACK_QUERY_ID = "ef1a9f94012220d3";
  const STORE_KEY = "taReviewsTemplate.v1";
  const HOTEL_DELAY = [3000, 7000];
  const PAGE_DELAY = [1500, 3500];
  const BLOCK_COOLDOWN = 30000;
  const LEARN_TIMEOUT = 180000;
  const COLUMNS = ["hotel_url", "location_id", "id", "title", "text", "rating",
    "publishedDate", "username", "tripType"];

  if (!/tripadvisor\./.test(location.hostname)) {
    alert("Open a TripAdvisor hotel page first, then click this bookmark again.");
    return;
  }
  if (window.__taReviewsRunning) {
    alert("The scraper is already running in this tab.");
    return;
  }
  window.__taReviewsRunning = true;

  const realFetch = window.fetch.bind(window);
  const pageMatch = location.href.match(/-d(\d+)(?=[-.?#]|$)/);
  const pageLocId = pageMatch ? Number(pageMatch[1]) : null;

  const input = prompt(
    "Paste one or more TripAdvisor hotel URLs (separate them with spaces).\n" +
    "Leave empty to scrape the hotel on this page.", "");
  if (input === null) { window.__taReviewsRunning = false; return; }
  const source = input.trim() || location.href;
  const seen = new Set();
  const hotels = [];
  for (const m of source.matchAll(/\S*?-d(\d+)(?=[-.\s?#]|$)\S*/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); hotels.push({ url: m[0], id: Number(m[1]) }); }
  }
  if (!hotels.length) {
    alert("No hotel IDs found. Hotel URLs contain '-d' followed by a number, like -d93437-.");
    window.__taReviewsRunning = false;
    return;
  }
  const maxText = prompt("Max reviews per hotel? Leave empty for all.", "");
  if (maxText === null) { window.__taReviewsRunning = false; return; }
  const maxReviews = parseInt(maxText, 10) > 0 ? parseInt(maxText, 10) : Infinity;

  const box = document.createElement("div");
  box.style.cssText = "position:fixed;top:10px;right:10px;z-index:2147483647;width:400px;" +
    "max-height:60vh;overflow:auto;background:#fff;color:#000;border:2px solid #00aa6c;" +
    "border-radius:8px;padding:10px;font:12px/1.4 monospace;box-shadow:0 4px 16px rgba(0,0,0,.3)";
  document.body.appendChild(box);
  const say = (msg, strong) => {
    const line = document.createElement("div");
    line.textContent = msg;
    if (strong) line.style.cssText = "font-weight:bold;color:#b00020;margin:4px 0";
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  };
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
  /* Replace every value equal to `from` (number or numeric string) with `to`. */
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
  /* Set every key named `key` to `value`; returns how many were set. */
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

  /* ---------- template: the request body we replay ---------- */
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

  let template = loadTemplate();
  let learnedThisRun = false;
  if (!template) template = fallbackTemplate;

  const pageSizeOf = (t) => findNumberKey(t.item.variables, "limit") || 10;
  const buildBody = (t, hotelId, offset) => {
    const item = clone(t.item);
    item.variables = replaceValue(item.variables, t.locId, hotelId);
    setKey(item.variables, "offset", offset);
    return [item];
  };

  /* ---------- learning: watch the page's own GraphQL calls ---------- */
  const learn = async () => {
    if (pageLocId == null) {
      say("The saved query is out of date and needs a one-time refresh.", true);
      say("Open one of your hotel pages on TripAdvisor, then click the bookmark again.", true);
      return null;
    }
    let captured = null;
    const inspect = (bodyText, data) => {
      if (captured) return;
      let body;
      try { body = JSON.parse(bodyText); } catch (e) { return; }
      const items = Array.isArray(body) ? body : [body];
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
      XHR.send = function (body) {
        if (/graphql/i.test(this.__taUrl || "") && typeof body === "string") {
          this.addEventListener("load", () => {
            try { inspect(body, JSON.parse(this.responseText)); } catch (e) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    }

    say("ONE-TIME SETUP: TripAdvisor changed its internal query.", true);
    say("Scroll down to this hotel's reviews and click the NEXT PAGE arrow (or page 2). " +
      "If that does nothing, change the review sort or language filter. Waiting up to 3 minutes...", true);
    const deadline = Date.now() + LEARN_TIMEOUT;
    while (!captured && Date.now() < deadline) await sleep(500);

    window.fetch = origFetch;
    if (XHR) { XHR.open = origOpen; XHR.send = origSend; }

    if (!captured) {
      say("Did not see a reviews request. Reload this hotel page and try again. " +
        "If the review page change reloads the whole page, tell whoever maintains this script.", true);
      return null;
    }
    if (!setKey(clone(captured.item.variables), "offset", 0)) {
      say("Warning: the captured query has no 'offset' field, so only the first page per hotel can be fetched.", true);
    }
    saveTemplate(captured);
    say("Learned query ID: " + queryIdOf(captured) + " (saved for next time)");
    return captured;
  };

  /* ---------- scraping ---------- */
  class Blocked extends Error {}
  class NeedsLearning extends Error {}

  const extract = (body) => {
    const results = Array.isArray(body) ? body : [body];
    let notFound = false;
    for (const r of results) {
      if (r && r.errors) {
        const msg = JSON.stringify(r.errors);
        if (/PersistedQuery/i.test(msg)) notFound = true;
        else say("  GraphQL errors: " + msg.slice(0, 300));
      }
    }
    let reviews = [];
    let total = null;
    for (const r of results) {
      const l = findReviews(r);
      if (l) { reviews = l; total = findNumberKey(r, "totalCount"); break; }
    }
    return { reviews, total, notFound };
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

  const scrapeHotel = async (hotel) => {
    const rows = [];
    const ids = new Set();
    const pageSize = pageSizeOf(template);
    let offset = 0;
    let total = null;
    while (true) {
      const resp = await realFetch(GRAPHQL_PATH, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Requested-By": token() },
        body: JSON.stringify(buildBody(template, hotel.id, offset)),
      });
      if (resp.status === 403 || resp.status === 429) throw new Blocked("HTTP " + resp.status);
      let body = null;
      try { body = await resp.json(); } catch (e) {}
      if (!resp.ok && !body) throw new Error("GraphQL returned HTTP " + resp.status);
      const { reviews, total: t, notFound } = extract(body);
      if (offset === 0 && (notFound || (!reviews.length && !learnedThisRun))) {
        throw new NeedsLearning(notFound ? "query ID not recognized" : "no reviews returned");
      }
      if (t != null) total = t;
      if (!reviews.length) {
        if (offset === 0) say("  No reviews returned for this hotel.");
        break;
      }
      let added = 0;
      for (const raw of reviews) {
        if (!raw || typeof raw !== "object") continue;
        const row = parse(raw);
        const key = row.id != null ? String(row.id) : row.title + "|" + row.text;
        if (ids.has(key)) continue;
        ids.add(key);
        rows.push({ hotel_url: hotel.url, location_id: hotel.id, ...row });
        added++;
      }
      say(`  offset ${offset}: +${added} (${rows.length}${total != null ? "/" + total : ""})`);
      if (!added) break;
      if (rows.length >= maxReviews) { rows.length = maxReviews; break; }
      offset += reviews.length;
      if (total != null && offset >= total) break;
      if (reviews.length < pageSize && total == null) break;
      await sleep(rand(PAGE_DELAY));
    }
    return rows;
  };

  const toCsv = (rows) => {
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "﻿" + [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => esc(r[c])).join(","))].join("\r\n");
  };
  const download = (rows) => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tripadvisor_reviews.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  say(`Scraping ${hotels.length} hotel(s). Keep this tab open.`);
  const all = [];
  const failed = [];
  let aborted = false;
  for (let i = 0; i < hotels.length && !aborted; i++) {
    const h = hotels[i];
    say(`[${i + 1}/${hotels.length}] location ${h.id}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rows = await scrapeHotel(h);
        all.push(...rows);
        say(`  done: ${rows.length} reviews`);
        if (rows.length && !learnedThisRun) learnedThisRun = true;
        break;
      } catch (e) {
        if (e instanceof NeedsLearning && attempt === 0 && !learnedThisRun) {
          say(`  ${e.message}`);
          forgetTemplate();
          const t = await learn();
          if (!t) { aborted = true; break; }
          template = t;
          learnedThisRun = true;
          continue;
        }
        failed.push(h.url);
        if (e instanceof Blocked) {
          say(`  BLOCKED (${e.message}). Waiting 30s before the next hotel.`);
          await sleep(BLOCK_COOLDOWN);
        } else {
          say(`  FAILED: ${e.message}`);
        }
        break;
      }
    }
    if (!aborted && i < hotels.length - 1) await sleep(rand(HOTEL_DELAY));
  }
  say(`Finished: ${all.length} reviews.` + (failed.length ? ` ${failed.length} hotel(s) failed.` : ""));
  if (all.length) { download(all); say("CSV downloaded: tripadvisor_reviews.csv"); }
  else say("Nothing to download.");
  window.__taReviewsRunning = false;
})();
