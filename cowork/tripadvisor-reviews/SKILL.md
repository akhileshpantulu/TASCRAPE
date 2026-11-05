---
name: tripadvisor-reviews
description: Scrape TripAdvisor hotel reviews for a list of assets (hotels) through Claude in Chrome, show a live per-asset progress tracker in the browser, report progress in chat, and save the reviews as a CSV. Use when the user asks to scrape, pull, refresh, download or collect TripAdvisor reviews for one or more hotels or assets.
---

# TripAdvisor Reviews

Collects TripAdvisor reviews for the user's assets by running `scripts/ta_scraper.js` inside the user's own Chrome tab on tripadvisor.com. Running in the user's browser matters: TripAdvisor blocks cloud servers with HTTP 403, but accepts requests from the user's normal browser session. Never try to scrape TripAdvisor from the sandbox with Python, curl or web fetch; it will be blocked.

The script is free and uses no paid APIs or proxies. It draws a tracker panel on the page with a progress bar per asset, and exposes its state to you through `window.__taSummary()`.

## 1. Get the asset list

Use, in order of preference:
1. Assets the user names in the request (names and/or TripAdvisor URLs).
2. `assets.txt` in the working folder. One asset per line, `Asset Name | URL`. Lines starting with `#` are comments. A line with only a URL is fine; the name is then taken from the URL.

Each URL must be a TripAdvisor hotel page containing `-d<digits>-` (for example `...Hotel_Review-g60763-d93437-Reviews-...`). If an asset has a name but no URL, find its TripAdvisor hotel page URL by searching in Chrome, and show the user the URLs you found before scraping.

Also settle the review limit per asset: use the user's number if given, otherwise all reviews. For a first run on a new setup, suggest a limit of 20 as a test.

Briefly confirm the list (asset names and count) and the limit, then proceed without further questions.

## 2. Open the first hotel page

Using Claude in Chrome, open a tab on the FIRST asset's URL and wait for it to load. If TripAdvisor shows a captcha or "are you human" check, ask the user to complete it, then continue.

Use this tab only for the run. Do not navigate, reload or close it until the run is finished: that kills the scraper and loses unsaved results. If you need to browse, use a different tab.

Ask the user to keep this tab visible (for example in its own Chrome window) during long runs. Chrome slows down timers in hidden tabs, which makes the run much slower.

## 3. Start the scraper

Read `scripts/ta_scraper.js` from this skill's folder. Run JavaScript in the TripAdvisor tab, in a single call, consisting of a config line followed by the full, unmodified file contents:

```js
window.__taConfig = {
  assets: [
    { name: "Asset Name 1", url: "https://www.tripadvisor.com/Hotel_Review-...-d123-Reviews-..." },
    { name: "Asset Name 2", url: "https://www.tripadvisor.com/Hotel_Review-...-d456-Reviews-..." }
  ],
  maxReviews: 500,      // omit or null for all reviews
  autoDownload: true
};
/* ...entire contents of scripts/ta_scraper.js... */
```

The call should return `"TA scraper started"` right away; the scraping continues in the page. A "TA Review Tracker" panel appears in the top-right corner of the page.

If running JavaScript in the page is unavailable or refused (for example the code is too long), fall back to the bookmark:
1. Run only the `window.__taConfig = {...};` part.
2. Ask the user to click their **TA Reviews** bookmark on that tab. The bookmark contains the same script and will use the config you set, with no pop-up questions.
3. If they do not have the bookmark, they can install it by opening `install_bookmark.html` from the working folder in Chrome and dragging the green button to the bookmarks bar.

## 4. Monitor and report progress

Every 20 to 30 seconds, run `window.__taSummary()` in the tab. It returns JSON:

```json
{"status": "running", "message": "", "totalScraped": 230, "pageSize": 50, "csvFile": null,
 "assets": [{"name": "Asset 1", "status": "done", "scraped": 230, "target": 230, "error": null},
            {"name": "Asset 2", "status": "running", "scraped": 50, "target": 120, "error": null}],
 "recentLog": ["..."]}
```

Post a short progress update in chat when something changes, and at least every 2 minutes on long runs, as a compact table: asset, status, scraped / target. Do not post one per poll if nothing changed.

Act on `status`:
- `running`: keep polling.
- `needs_setup`: TripAdvisor changed its internal query ID and the script needs to see one real reviews request. On the hotel page, scroll down to the reviews section and click the next-page arrow or the "2" page link of the reviews pager. Take a screenshot first if you need to find it. Then keep polling; status returns to `running` once it has learned the request. If it is still `needs_setup` after two attempts, try changing the review sort order or language filter. If that fails too, ask the user to click the next-page arrow themselves.
- `aborted`: read `message`, tell the user, and offer to retry. Usually it means setup timed out; reload the first hotel page and start again from step 3.
- `done` or `stopped`: go to step 5.

If `warnings` in the summary is not empty (for example an asset with no review dates found), tell the user. Run `window.__taSample()` and include its output in your message: it is a trimmed copy of a raw review, showing the field names TripAdvisor used, which the script maintainer needs to fix the field mapping.

Per-asset statuses: `queued`, `running`, `done` (`scraped` 0 means the hotel has no reviews in the selected language), `blocked` (TripAdvisor returned 403/429 for that asset), `failed` (see `error`), `skipped` (run was stopped first).

To stop early, run `window.__taStop()`; the reviews collected so far are kept and downloaded.

## 5. Save the results

The CSV is downloaded by Chrome to the user's Downloads folder, with the name in `csvFile` (for example `tripadvisor_reviews_20261105_1430.csv`). Columns: `asset_name, hotel_url, location_id, id, title, text, rating, publishedDate, stayDate, username, tripType`. Dates are `YYYY-MM-DD`; `stayDate` is often only `YYYY-MM` because TripAdvisor shows the month of stay.

- If you have access to the Downloads folder, copy that file into `outputs/` in the working folder.
- Otherwise tell the user the file name and ask them to move it into the working folder's `outputs/` folder, or to give you access to Downloads.
- If the download did not happen, run `window.__taDownload()` to trigger it again.

If `outputs/master_reviews.csv` exists, append the new rows to it and drop duplicates on `location_id` + `id`, keeping the newest. Report how many new reviews were added per asset.

## 6. Summarize

Finish with:
- A table per asset: status and number of reviews collected.
- Any blocked or failed assets, with the suggestion to re-run just those later.
- Where the CSV is saved.
- An offer of next steps, such as average rating and rating trend by asset, common complaints and praise, or reviews by trip type.

## Troubleshooting

- Every asset `blocked`: TripAdvisor is rate-limiting this browser. Wait 15 to 30 minutes, browse a hotel page normally, and retry with fewer assets.
- The tracker never appears: confirm the tab is on a tripadvisor.com page, then retry step 3.
- Field values empty in the CSV: TripAdvisor changed its response format. Tell the user, and do not edit the script yourself; the field mapping is maintained in the source repository (`bookmarklet/tripadvisor_bookmarklet.js`, search for `UPDATE HERE`).
