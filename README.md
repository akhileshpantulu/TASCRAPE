# TripAdvisor Review Scraper

Free scraper for TripAdvisor hotel reviews. It uses `curl_cffi` to impersonate Chrome's TLS fingerprint and calls TripAdvisor's internal GraphQL endpoint directly. It uses no paid APIs, no paid proxies and no headless browser.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Usage

1. Put hotel URLs in `hotels.txt`, one per line, e.g.
   `https://www.tripadvisor.com/Hotel_Review-g60763-d93437-Reviews-Hotel_Name-New_York_City_New_York.html`
2. (Optional) Put free proxies in `proxies.txt`, one per line. They are rotated per hotel.
3. Run:

```bash
python scraper.py
```

Options:

| Flag | Default | Meaning |
|------|---------|---------|
| `--input` | `hotels.txt` | URL list |
| `--output` | `tripadvisor_reviews.csv` | CSV output |
| `--proxies` | `proxies.txt` | optional free proxy list |
| `--max-reviews N` | all | cap reviews per hotel |
| `--language en` | `en` | review language; `all` disables the filter |
| `-v` | off | debug logging |

The output CSV has these columns: `hotel_url, location_id, id, title, text, rating, publishedDate, username, tripType`. The CSV is rewritten after every hotel, so a crash keeps the reviews collected up to that point. Logs go to the console and to `scraper.log`.

## When it breaks

TripAdvisor's GraphQL API is undocumented and uses persisted query hashes that change on redeploys. If you get zero reviews, check `debug/` for the saved raw response, then follow the steps in the docstring at the top of `scraper.py` to copy the current `preRegisteredQueryId` and `variables` from Chrome DevTools. Every spot that may need editing is marked `UPDATE HERE`.

## No terminal? Use the browser bookmark version

TripAdvisor blocks most cloud servers (including Google Colab) with HTTP 403. The bookmarklet in `bookmarklet/` runs the same GraphQL requests from inside your own browser tab, using your own IP address and cookies.

1. Open `bookmarklet/install.html` in Chrome or Edge (double-click the file).
2. Drag the green **TA Reviews** button onto your bookmarks bar.
3. Go to tripadvisor.com, click the bookmark, paste hotel URLs separated by spaces, and wait. `tripadvisor_reviews.csv` downloads when it finishes.

If TripAdvisor changes its internal query ID (error `PersistedQueryNotFound`), the bookmarklet asks you to click the reviews "next page" arrow once. It copies the request the page itself sends, saves it in your browser, and reuses it for every hotel. To change the code, edit `bookmarklet/tripadvisor_bookmarklet.js` and rebuild with `node bookmarklet/build.js`.

## Claude Cowork workflow

The Cowork workflow is built on the bookmark. Claude prepares the asset list, opens the first hotel page with the list attached to the link (`#ta-config=...`), asks you to click **TA Reviews** once, then follows the tracker, handles the one-time setup click, saves the CSV and summarizes.

- `cowork/TripAdvisor-Reviews-Cowork.zip`: unzip, choose the folder as the Cowork working folder, fill in `assets.txt`, then paste `COWORK_SETUP_PROMPT.md` into Cowork.
- `cowork/tripadvisor-reviews-skill.zip`: the skill on its own, for uploading as a custom skill.
- `cowork/tripadvisor-reviews/SKILL.md`: the workflow Claude follows.
- `cowork/tripadvisor-reviews/scripts/make_link.py`: builds the link from `assets.txt`.

The bookmark takes its asset list from `window.__taConfig`, a `#ta-config=` link, or its pop-up (URLs or pasted JSON), and exposes `window.__taSummary()`, `window.__taSample()`, `window.__taStop()` and `window.__taDownload()`.

## Rebuilding the bookmark

After editing `bookmarklet/tripadvisor_bookmarklet.js`:

```bash
cd bookmarklet && npm install && cd ..
```
```bash
node bookmarklet/build.js && python cowork/package.py
```

This writes `bookmarklet/bookmark.txt` (the bookmark URL), `bookmarklet/install.html` and the Cowork zips.
