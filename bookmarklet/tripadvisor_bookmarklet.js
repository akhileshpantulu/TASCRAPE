/*
 * TripAdvisor review scraper, browser bookmarklet version.
 *
 * Runs inside your own browser tab on tripadvisor.com, so requests come from
 * your own IP address and carry your real browser cookies. This avoids the
 * 403 blocks that hit cloud servers such as Google Colab.
 *
 * Same logic as scraper.py: same GraphQL endpoint, same persisted query ID,
 * same output columns. If TripAdvisor changes its internal API, update the
 * values marked "UPDATE HERE" (see the docstring at the top of scraper.py for
 * how to find the new values in Chrome DevTools), then rebuild with:
 *     node bookmarklet/build.js
 *
 * Do not put "//" line comments inside the function body: the build step
 * strips whole comment lines only, and the bookmarklet must stay valid JS.
 */
(async () => {
  /* UPDATE HERE: GraphQL path and persisted query ID */
  const GRAPHQL_PATH = "/data/graphql/ids";
  const REVIEWS_QUERY_ID = "ef1a9f94012220d3";
  const PAGE_SIZE = 20;
  const HOTEL_DELAY = [3000, 7000];
  const PAGE_DELAY = [1500, 3500];
  const BLOCK_COOLDOWN = 30000;
  const COLUMNS = ["hotel_url", "location_id", "id", "title", "text", "rating",
    "publishedDate", "username", "tripType"];

  if (!/tripadvisor\./.test(location.hostname)) {
    alert("Open any tripadvisor.com page first, then click this bookmark again.");
    return;
  }

  const input = prompt(
    "Paste one or more TripAdvisor hotel URLs (separate them with spaces).\n" +
    "Leave empty to scrape the hotel on this page.", "");
  if (input === null) return;
  const source = input.trim() || location.href;
  const seen = new Set();
  const hotels = [];
  for (const m of source.matchAll(/\S*?-d(\d+)(?=[-.\s]|$)\S*/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); hotels.push({ url: m[0], id: Number(m[1]) }); }
  }
  if (!hotels.length) {
    alert("No hotel location IDs found. Hotel URLs contain '-d' followed by a number, like -d93437-.");
    return;
  }
  const maxText = prompt("Max reviews per hotel? Leave empty for all.", "");
  if (maxText === null) return;
  const maxReviews = parseInt(maxText, 10) > 0 ? parseInt(maxText, 10) : Infinity;
  const allLanguages = confirm("Include reviews in ALL languages?\n\nOK = all languages, Cancel = English only");

  const box = document.createElement("div");
  box.style.cssText = "position:fixed;top:10px;right:10px;z-index:2147483647;width:380px;" +
    "max-height:60vh;overflow:auto;background:#fff;color:#000;border:2px solid #00aa6c;" +
    "border-radius:8px;padding:10px;font:12px/1.4 monospace;box-shadow:0 4px 16px rgba(0,0,0,.3)";
  document.body.appendChild(box);
  const say = (msg) => {
    const line = document.createElement("div");
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, "0")).join("");

  /* UPDATE HERE: request body, copied from DevTools "Payload" */
  const payload = (locationId, offset) => [{
    variables: {
      locationId, offset,
      filters: allLanguages ? [] : [{ axis: "LANGUAGE", selections: ["en"] }],
      prefs: null, initialPrefs: {}, limit: PAGE_SIZE, filterCacheKey: null,
      prefsCacheKey: "hotelReviewPrefs", needKeywords: false,
      keywordVariant: "location_keywords_v2_llr_order_30_en",
    },
    extensions: { preRegisteredQueryId: REVIEWS_QUERY_ID },
  }];

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
  /* UPDATE HERE: where the reviews live in the response */
  const REVIEW_PATHS = [["data", "locations", 0, "reviewListPage", "reviews"],
    ["data", "ReviewsProxy_getReviewListPageForLocation", 0, "reviews"]];
  const TOTAL_PATHS = [["data", "locations", 0, "reviewListPage", "totalCount"],
    ["data", "ReviewsProxy_getReviewListPageForLocation", 0, "totalCount"]];
  const extract = (body) => {
    const results = Array.isArray(body) ? body : [body];
    for (const r of results) {
      if (r && r.errors) say("  GraphQL errors: " + JSON.stringify(r.errors).slice(0, 300));
    }
    for (const r of results) {
      let total = null;
      for (const p of TOTAL_PATHS) { const t = dig(r, p); if (typeof t === "number") { total = t; break; } }
      for (const p of REVIEW_PATHS) { const l = dig(r, p); if (Array.isArray(l)) return { reviews: l, total }; }
      const l = findReviews(r);
      if (l) return { reviews: l, total };
    }
    return { reviews: [], total: null };
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

  class Blocked extends Error {}

  const scrapeHotel = async (hotel) => {
    const rows = [];
    const ids = new Set();
    let offset = 0;
    let total = null;
    while (true) {
      const resp = await fetch(GRAPHQL_PATH, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Requested-By": token() },
        body: JSON.stringify(payload(hotel.id, offset)),
      });
      if (resp.status === 403 || resp.status === 429) throw new Blocked("HTTP " + resp.status);
      if (!resp.ok) throw new Error("GraphQL returned HTTP " + resp.status);
      const body = await resp.json();
      const { reviews, total: t } = extract(body);
      if (t != null) total = t;
      if (!reviews.length) {
        if (offset === 0) {
          say("  No reviews returned. Either none in this language, or the query ID is outdated.");
          console.log("TripAdvisor raw response for location " + hotel.id, body);
        }
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
      if (reviews.length < PAGE_SIZE && total == null) break;
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
  for (let i = 0; i < hotels.length; i++) {
    const h = hotels[i];
    say(`[${i + 1}/${hotels.length}] location ${h.id}`);
    try {
      const rows = await scrapeHotel(h);
      all.push(...rows);
      say(`  done: ${rows.length} reviews`);
    } catch (e) {
      failed.push(h.url);
      if (e instanceof Blocked) {
        say(`  BLOCKED (${e.message}). Waiting 30s before the next hotel.`);
        await sleep(BLOCK_COOLDOWN);
        continue;
      }
      say(`  FAILED: ${e.message}`);
    }
    if (i < hotels.length - 1) await sleep(rand(HOTEL_DELAY));
  }
  say(`Finished: ${all.length} reviews.` + (failed.length ? ` ${failed.length} hotel(s) failed.` : ""));
  if (all.length) { download(all); say("CSV downloaded: tripadvisor_reviews.csv"); }
  else say("Nothing to download.");
})();
