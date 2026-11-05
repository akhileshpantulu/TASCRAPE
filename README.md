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
