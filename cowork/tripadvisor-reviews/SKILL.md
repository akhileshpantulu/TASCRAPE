---
name: tripadvisor-reviews
description: Pull TripAdvisor hotel reviews for a list of assets (hotels) using the user's "TA Reviews" browser bookmark and Claude in Chrome, follow the bookmark's live per-asset progress tracker, and save the reviews as a CSV. Use when the user asks to scrape, pull, refresh, download or collect TripAdvisor reviews for one or more hotels or assets.
---

# TripAdvisor Reviews (bookmark-driven)

The scraping is done by the user's **TA Reviews** bookmark, running inside their own Chrome tab on tripadvisor.com. That matters: TripAdvisor blocks cloud servers with HTTP 403, but accepts requests from the user's normal browser. Never try to fetch TripAdvisor from the sandbox with Python, curl or web fetch; it will be blocked.

Your job is to drive the bookmark: prepare the asset list, open the right page, have the user click the bookmark once, follow the tracker, handle the one-time setup step, and save and summarize the results.

The bookmark is free and uses no paid APIs or proxies. If the user does not have it yet, they install it once by opening `install_bookmark.html` (in the working folder) in Chrome and dragging the green **TA Reviews** button onto the bookmarks bar.

## 1. Build the asset list

Sources, in order of preference:
1. Assets the user names in the request (names and/or TripAdvisor URLs).
2. `assets.txt` in the working folder: one asset per line, `Asset Name | URL`. Lines starting with `#` are comments.

Each URL must be a TripAdvisor hotel page containing `-d<digits>-` (for example `...Hotel_Review-g60763-d93437-Reviews-...`). If the user gives a name without a URL, find the hotel's TripAdvisor page in Chrome and show the user the URL you found before continuing.

Settle the review limit per asset: the user's number if given, otherwise all reviews. For a first run on a new setup, suggest 20 as a test.

Generate the link with the helper script in this skill's folder:

```bash
python scripts/make_link.py assets.txt                    # all assets
python scripts/make_link.py assets.txt --max 200          # with a limit
python scripts/make_link.py assets.txt --only "Hotel A, Hotel B"
python scripts/make_link.py --url "Hotel A | https://www.tripadvisor.com/Hotel_Review-..."   # ad hoc
```

It prints JSON with `link` (the first asset's page with the asset list attached after `#ta-config=`), `paste` (a fallback), `assets`, and `skipped` (invalid lines; tell the user about these). Confirm the asset names and limit with the user in one line, then continue.

## 2. Open the page and have the user click the bookmark

1. With Claude in Chrome, open the `link` from step 1 in a tab and let it load. If TripAdvisor shows a captcha or "are you human" check, ask the user to complete it.
2. Ask the user: **"Click the TA Reviews bookmark now."** The bookmark reads the asset list from the link, so no questions pop up. A "TA Review Tracker" panel appears in the top-right of the page.
3. If the user clicks and gets a pop-up asking for URLs instead (TripAdvisor dropped the `#ta-config` part of the link), tell them to paste the `paste` text from step 1 into that pop-up. Give it to them in a code block so it is easy to copy.

If you can run JavaScript in the page, you may instead run `window.__taConfig = <the paste JSON>;` in the tab before asking the user to click. The bookmark uses that too. You cannot click the bookmark for the user.

From now on, use this tab only for the run. Do not navigate, reload or close it until the run is finished: that stops the scraper. Ask the user to keep the tab visible, ideally in its own Chrome window; Chrome slows hidden tabs down.

## 3. Follow progress

Check every 20 to 30 seconds.

- If you can run JavaScript in the page, call `window.__taSummary()`. It returns JSON: `status`, `message`, `totalScraped`, `pageSize`, `csvFile`, `warnings`, and `assets` (each with `name`, `status`, `scraped`, `target`, `error`).
- Otherwise read the tracker panel (element `#ta-tracker`, whose `data-ta-status` attribute holds the overall status) from the page text or a screenshot. Each asset row shows its name, a status label and `scraped / target`.

Post a short progress update in chat when something changes, and at least every 2 minutes on long runs, as a compact table: asset, status, scraped / target. Do not post one per check if nothing changed.

Overall status:
- `running`: keep checking.
- `needs_setup` (orange banner "One-time setup..."): TripAdvisor changed its internal query and the bookmark needs to see one real reviews request. On the hotel page, scroll to the reviews section and click the next-page arrow or the "2" link of the reviews pager; take a screenshot first if you need to find it. Status returns to `running` once it has learned. If it is still `needs_setup` after two tries, change the review sort order or language filter instead. If that also fails, ask the user to click the next-page arrow.
- `aborted` (banner "Needs attention"): read the message, tell the user, offer to retry from step 2.
- `done` or `stopped`: go to step 4.

Asset statuses: `queued`, `running`, `done` ("No reviews" when it has none in the selected language), `blocked` (TripAdvisor returned 403/429 for that asset), `failed` (see the error), `skipped` (run stopped first).

To stop early: ask the user to click **Stop** on the tracker, or run `window.__taStop()`. Collected reviews are kept and downloaded.

## 4. Save the results

Chrome downloads the CSV to the user's Downloads folder as `tripadvisor_reviews_YYYYMMDD_HHMM.csv` (the exact name is `csvFile` in the summary, or the newest matching file). Columns: `asset_name, hotel_url, location_id, id, title, text, rating, publishedDate, stayDate, username, tripType`. Dates are `YYYY-MM-DD`; `stayDate` is often `YYYY-MM`.

- If you can access the Downloads folder, copy the file into `outputs/` in the working folder.
- Otherwise tell the user the file name and ask them to move it into `outputs/`, or to give you access to Downloads.
- If no download happened, ask the user to click **Download CSV** on the tracker.

If `outputs/master_reviews.csv` exists, append the new rows and drop duplicates on `location_id` + `id`, keeping the newest. Report how many new reviews were added per asset.

Check the CSV: if `publishedDate` is empty for an asset, or `warnings` mentions missing dates, tell the user. Ask them to open **Log** on the tracker, click **Copy sample review** and send it to whoever maintains the bookmark (or run `window.__taSample()` yourself and include its output). It shows the field names TripAdvisor used.

## 5. Summarize

Finish with:
- A table per asset: status and reviews collected.
- Blocked or failed assets, with the suggestion to re-run just those later (`--only`).
- Where the CSV is saved.
- An offer of next steps, such as average rating and trend by asset, common complaints and praise, or reviews by trip type.

## Troubleshooting

- Every asset `blocked`: TripAdvisor is rate-limiting this browser. Wait 15 to 30 minutes, browse a hotel page normally, and retry with fewer assets.
- Nothing happens when the user clicks the bookmark: confirm the tab is on a tripadvisor.com page. If it still does nothing, company browser policy may block bookmarklets.
- Old behaviour (a green log box instead of the tracker, or pop-ups despite the link): the user has an outdated bookmark. Have them delete it and reinstall from `install_bookmark.html`.
