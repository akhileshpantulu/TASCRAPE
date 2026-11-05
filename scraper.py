#!/usr/bin/env python3
"""
TripAdvisor hotel review scraper.

Free, no paid APIs, no headless browser. Uses curl_cffi to impersonate a real
Chrome TLS/HTTP2 fingerprint and calls TripAdvisor's internal GraphQL endpoint
directly.

Flow per hotel:
  1. GET the hotel page (collects cookies such as TASession / datadome).
  2. POST to the GraphQL endpoint repeatedly, paging through reviews.
  3. Parse each review into a flat row.
All rows from all hotels are written to a single CSV with pandas.

Usage:
    python scraper.py
    python scraper.py --max-reviews 200 --language en
    python scraper.py --input hotels.txt --output tripadvisor_reviews.csv --proxies proxies.txt

-------------------------------------------------------------------------------
IF THE SCRAPER STOPS RETURNING REVIEWS, READ THIS FIRST
-------------------------------------------------------------------------------
TripAdvisor does not publish this API. It uses "persisted queries": instead of
sending a GraphQL query string, the website sends a short hash ID
(`preRegisteredQueryId`) that the server maps to a query it already knows.
When TripAdvisor redeploys its frontend, that hash, the variable names, or the
response shape can change. To refresh them:

  1. Open any hotel page in Chrome, open DevTools (F12) > Network tab.
  2. Filter by "graphql". Click "Next" on the reviews pager (or change the
     review sort / language filter) to trigger a review request.
  3. Find the POST request to .../data/graphql/ids whose response contains
     "reviewListPage" (or whatever holds the review objects).
  4. From the "Payload" tab copy:
        - extensions.preRegisteredQueryId   -> REVIEWS_QUERY_ID below
        - the "variables" object            -> build_reviews_payload() below
  5. From the "Response" tab, check the path to the review list and the field
     names -> REVIEW_LIST_PATHS and parse_review() below.
  6. If the request URL itself changed, update GRAPHQL_PATH below.

Search this file for "UPDATE HERE" to jump to every spot that may need edits.
-------------------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import itertools
import json
import logging
import random
import re
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

import pandas as pd
from curl_cffi import requests as cffi_requests

# =============================================================================
# Configuration
# =============================================================================

# UPDATE HERE: path of the GraphQL endpoint (appended to the hotel URL's own
# domain, so tripadvisor.co.uk URLs hit tripadvisor.co.uk/data/graphql/ids).
GRAPHQL_PATH = "/data/graphql/ids"

# UPDATE HERE: persisted query hash for the hotel reviews list. Copy the
# current value from DevTools as described in the module docstring.
REVIEWS_QUERY_ID = "ef1a9f94012220d3"

# Browser fingerprint to impersonate. Keep IMPERSONATE and USER_AGENT on the
# same Chrome major version: a Chrome 136 TLS fingerprint paired with a
# Chrome 120 User-Agent is an easy bot signal. If your installed curl_cffi
# lacks this target, run:
#   python -c "from curl_cffi.requests import BrowserType; print([b.value for b in BrowserType])"
# and pick the newest "chromeNNN" entry, then update USER_AGENT to match.
IMPERSONATE = "chrome136"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)

PAGE_SIZE = 20                     # reviews per GraphQL call (site uses 10-20)
HOTEL_DELAY_RANGE = (3.0, 7.0)     # seconds between hotels
PAGE_DELAY_RANGE = (1.5, 3.5)      # seconds between review pages of one hotel
BLOCK_COOLDOWN_SECONDS = 30        # wait after a 403/429 before the next hotel
REQUEST_TIMEOUT = 30               # seconds
MAX_TRANSIENT_RETRIES = 2          # retries for timeouts / 5xx on a single page

OUTPUT_COLUMNS = [
    "hotel_url",
    "location_id",
    "id",
    "title",
    "text",
    "rating",
    "publishedDate",
    "username",
    "tripType",
]

# UPDATE HERE: known paths (inside one GraphQL result object) to the list of
# reviews and to the total review count. If TripAdvisor renames these, add the
# new path to the front of the list. The scraper also falls back to a generic
# search for "a list of objects that look like reviews", so small changes may
# keep working without edits.
REVIEW_LIST_PATHS = [
    ("data", "locations", 0, "reviewListPage", "reviews"),
    ("data", "ReviewsProxy_getReviewListPageForLocation", 0, "reviews"),
]
TOTAL_COUNT_PATHS = [
    ("data", "locations", 0, "reviewListPage", "totalCount"),
    ("data", "ReviewsProxy_getReviewListPageForLocation", 0, "totalCount"),
]

DEBUG_DIR = Path("debug")

log = logging.getLogger("tripadvisor_scraper")


# =============================================================================
# Exceptions
# =============================================================================

class BlockedError(Exception):
    """Raised on HTTP 403 / 429 (bot protection or rate limiting)."""

    def __init__(self, status_code: int, url: str):
        super().__init__(f"HTTP {status_code} from {url}")
        self.status_code = status_code


class ScrapeError(Exception):
    """Any other failure that should skip the current hotel."""


# =============================================================================
# Input helpers
# =============================================================================

def read_lines(path: Path) -> list[str]:
    """Read non-empty, non-comment lines from a text file."""
    if not path.exists():
        return []
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            lines.append(line)
    return lines


def parse_location_id(url: str) -> int:
    """
    Extract the numeric location ID from a hotel URL.
    Hotel_Review-g60763-d93437-Reviews-... -> 93437
    """
    match = re.search(r"-d(\d+)(?:-|\.html|$)", url)
    if not match:
        raise ScrapeError(f"Could not find a '-d<number>-' location ID in URL: {url}")
    return int(match.group(1))


def base_url_of(url: str) -> str:
    """https://www.tripadvisor.co.uk/Hotel_Review-... -> https://www.tripadvisor.co.uk"""
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        raise ScrapeError(f"Not a valid absolute URL: {url}")
    if "tripadvisor." not in parsed.netloc:
        raise ScrapeError(f"Not a TripAdvisor URL: {url}")
    return f"{parsed.scheme}://{parsed.netloc}"


def proxy_cycle(proxies: list[str]) -> Iterator[str | None]:
    """Round-robin over the user's free proxy list, or yield None forever."""
    if not proxies:
        return itertools.repeat(None)
    shuffled = proxies[:]
    random.shuffle(shuffled)
    return itertools.cycle(shuffled)


# =============================================================================
# HTTP
# =============================================================================

def new_session(proxy: str | None) -> cffi_requests.Session:
    """A fresh session per hotel: clean cookies, and optionally a new proxy."""
    kwargs: dict[str, Any] = {"impersonate": IMPERSONATE, "timeout": REQUEST_TIMEOUT}
    if proxy:
        kwargs["proxies"] = {"http": proxy, "https": proxy}
    return cffi_requests.Session(**kwargs)


def page_headers() -> dict[str, str]:
    """Headers for a normal top-level page navigation."""
    return {
        "User-Agent": USER_AGENT,
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,image/apng,*/*;q=0.8"
        ),
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
    }


def graphql_headers(base_url: str, referer: str) -> dict[str, str]:
    """
    Headers the TripAdvisor frontend sends with GraphQL calls.

    UPDATE HERE if requests start failing with 4xx even though the page GET
    works: compare these with the Request Headers of the real call in DevTools.
    X-Requested-By is checked for presence; the site sends an opaque token and
    a random value has historically been accepted.
    """
    return {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        "Origin": base_url,
        "Referer": referer,
        "X-Requested-By": secrets.token_hex(16),
    }


def check_blocked(resp: Any, url: str) -> None:
    if resp.status_code in (403, 429):
        raise BlockedError(resp.status_code, url)


def request_with_retries(session: cffi_requests.Session, method: str, url: str, **kwargs: Any) -> Any:
    """
    Send a request, retrying only transient failures (network errors, 5xx).
    403/429 are never retried here: they bubble up as BlockedError so the main
    loop can cool down and move on, as required.
    """
    last_exc: Exception | None = None
    for attempt in range(1, MAX_TRANSIENT_RETRIES + 2):
        try:
            resp = session.request(method, url, **kwargs)
        except Exception as exc:  # curl_cffi raises its own RequestException types
            last_exc = exc
            log.warning("  network error (%s/%s) on %s: %s",
                        attempt, MAX_TRANSIENT_RETRIES + 1, url, exc)
        else:
            check_blocked(resp, url)
            if resp.status_code < 500:
                return resp
            last_exc = ScrapeError(f"HTTP {resp.status_code} from {url}")
            log.warning("  server error %s (%s/%s) on %s",
                        resp.status_code, attempt, MAX_TRANSIENT_RETRIES + 1, url)
        if attempt <= MAX_TRANSIENT_RETRIES:
            time.sleep(2 ** attempt + random.random())
    raise ScrapeError(f"Giving up on {url}: {last_exc}")


# =============================================================================
# GraphQL payload + response parsing
# =============================================================================

def build_reviews_payload(location_id: int, offset: int, limit: int, language: str | None) -> list[dict]:
    """
    UPDATE HERE: body of the reviews GraphQL request.

    TripAdvisor batches queries, so the body is a JSON *list* of
    {"variables": ..., "extensions": {"preRegisteredQueryId": ...}} objects.
    Copy the current "variables" from DevTools if this stops working.
    """
    filters = [{"axis": "LANGUAGE", "selections": [language]}] if language else []
    return [
        {
            "variables": {
                "locationId": location_id,
                "offset": offset,
                "filters": filters,
                "prefs": None,
                "initialPrefs": {},
                "limit": limit,
                "filterCacheKey": None,
                "prefsCacheKey": "hotelReviewPrefs",
                "needKeywords": False,
                "keywordVariant": "location_keywords_v2_llr_order_30_en",
            },
            "extensions": {"preRegisteredQueryId": REVIEWS_QUERY_ID},
        }
    ]


def dig(obj: Any, path: tuple) -> Any:
    """Follow a path of dict keys / list indexes; return None if any step is missing."""
    cur = obj
    for key in path:
        if isinstance(key, int):
            if not isinstance(cur, list) or len(cur) <= key:
                return None
        elif not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def looks_like_review_list(value: Any) -> bool:
    if not isinstance(value, list) or not value:
        return False
    dicts = [v for v in value if isinstance(v, dict)]
    if len(dicts) < max(1, len(value) // 2):
        return False
    hits = sum(1 for d in dicts if "id" in d and "rating" in d and ("text" in d or "title" in d))
    return hits >= max(1, len(dicts) // 2)


def find_review_list(obj: Any) -> list[dict] | None:
    """Depth-first search for the first list that looks like a list of reviews."""
    if looks_like_review_list(obj):
        return obj
    if isinstance(obj, dict):
        children = obj.values()
    elif isinstance(obj, list):
        children = obj
    else:
        return None
    for child in children:
        found = find_review_list(child)
        if found is not None:
            return found
    return None


def extract_reviews(payload: Any) -> tuple[list[dict], int | None]:
    """Return (raw review dicts, totalCount or None) from a GraphQL response body."""
    results = payload if isinstance(payload, list) else [payload]

    for result in results:
        if isinstance(result, dict) and result.get("errors"):
            log.warning("  GraphQL returned errors: %s",
                        json.dumps(result["errors"])[:500])

    for result in results:
        total = None
        for path in TOTAL_COUNT_PATHS:
            value = dig(result, path)
            if isinstance(value, int):
                total = value
                break
        for path in REVIEW_LIST_PATHS:
            reviews = dig(result, path)
            if isinstance(reviews, list):
                return reviews, total
        # Fallback: schema drifted, try to locate the reviews anywhere.
        reviews = find_review_list(result)
        if reviews is not None:
            log.debug("  reviews found via generic search (known paths missed)")
            return reviews, total

    return [], None


def first_present(d: dict, *paths: tuple) -> Any:
    for path in paths:
        value = dig(d, path)
        if value not in (None, ""):
            return value
    return None


def parse_review(raw: dict) -> dict:
    """
    UPDATE HERE: map one raw review object to output fields.
    Several candidate paths are tried for fields that have moved in the past.
    """
    return {
        "id": first_present(raw, ("id",), ("reviewId",)),
        "title": first_present(raw, ("title",)),
        "text": first_present(raw, ("text",), ("reviewText",)),
        "rating": first_present(raw, ("rating",), ("bubbleRating",)),
        "publishedDate": first_present(raw, ("publishedDate",), ("createdDate",), ("publishedDateTime",)),
        "username": first_present(
            raw,
            ("userProfile", "username"),
            ("userProfile", "displayName"),
            ("user", "username"),
            ("username",),
        ),
        "tripType": first_present(raw, ("tripInfo", "tripType"), ("tripType",)),
    }


def dump_debug(name: str, content: str) -> Path:
    DEBUG_DIR.mkdir(exist_ok=True)
    path = DEBUG_DIR / name
    path.write_text(content, encoding="utf-8")
    return path


# =============================================================================
# Scraping
# =============================================================================

def scrape_hotel(url: str, proxy: str | None, max_reviews: int | None, language: str | None) -> list[dict]:
    location_id = parse_location_id(url)
    base_url = base_url_of(url)
    graphql_url = base_url + GRAPHQL_PATH

    with new_session(proxy) as session:
        # Step 1: load the hotel page to pick up session cookies.
        resp = request_with_retries(session, "GET", url, headers=page_headers())
        if resp.status_code != 200:
            raise ScrapeError(f"Hotel page returned HTTP {resp.status_code}")
        log.info("  page loaded, %d cookies set", len(session.cookies))
        time.sleep(random.uniform(*PAGE_DELAY_RANGE))

        # Step 2: page through reviews via GraphQL.
        rows: list[dict] = []
        seen_ids: set = set()
        offset = 0
        total: int | None = None

        while True:
            body = build_reviews_payload(location_id, offset, PAGE_SIZE, language)
            resp = request_with_retries(
                session, "POST", graphql_url,
                headers=graphql_headers(base_url, url),
                data=json.dumps(body),
            )
            if resp.status_code != 200:
                path = dump_debug(f"{location_id}_offset{offset}_http{resp.status_code}.txt", resp.text)
                raise ScrapeError(f"GraphQL returned HTTP {resp.status_code} (body saved to {path})")

            try:
                payload = resp.json()
            except ValueError:
                path = dump_debug(f"{location_id}_offset{offset}_notjson.txt", resp.text)
                raise ScrapeError(f"GraphQL response was not JSON (saved to {path})")

            raw_reviews, page_total = extract_reviews(payload)
            if page_total is not None:
                total = page_total

            if not raw_reviews:
                if offset == 0:
                    path = dump_debug(f"{location_id}_offset0_noreviews.json", json.dumps(payload, indent=2))
                    log.warning(
                        "  no reviews in first GraphQL response. Either the hotel has no "
                        "reviews in this language, or REVIEWS_QUERY_ID / the payload is "
                        "outdated. Raw response saved to %s", path,
                    )
                break

            new_on_page = 0
            for raw in raw_reviews:
                if not isinstance(raw, dict):
                    continue
                row = parse_review(raw)
                key = row["id"] if row["id"] is not None else (row["title"], row["text"])
                if key in seen_ids:
                    continue
                seen_ids.add(key)
                rows.append({"hotel_url": url, "location_id": location_id, **row})
                new_on_page += 1

            log.info("  offset %d: +%d reviews (%d%s so far)", offset, new_on_page,
                     len(rows), f"/{total}" if total is not None else "")

            if new_on_page == 0:
                break  # server is repeating a page; stop to avoid an endless loop
            if max_reviews is not None and len(rows) >= max_reviews:
                rows = rows[:max_reviews]
                break
            offset += len(raw_reviews)
            if total is not None and offset >= total:
                break
            if len(raw_reviews) < PAGE_SIZE and total is None:
                break  # short page and no total: assume last page

            time.sleep(random.uniform(*PAGE_DELAY_RANGE))

    return rows


def save_csv(rows: list[dict], output: Path) -> None:
    df = pd.DataFrame(rows, columns=OUTPUT_COLUMNS)
    df.to_csv(output, index=False, encoding="utf-8-sig")  # utf-8-sig opens cleanly in Excel


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape TripAdvisor hotel reviews via GraphQL.")
    parser.add_argument("--input", default="hotels.txt", help="file with one hotel URL per line")
    parser.add_argument("--output", default="tripadvisor_reviews.csv", help="CSV output path")
    parser.add_argument("--proxies", default="proxies.txt",
                        help="optional file with one free proxy per line (rotated per hotel)")
    parser.add_argument("--max-reviews", type=int, default=None,
                        help="cap reviews per hotel (default: all)")
    parser.add_argument("--language", default="en",
                        help="review language filter, e.g. en, fr. Use 'all' for no filter")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout),
                  logging.FileHandler("scraper.log", encoding="utf-8")],
    )

    urls = list(dict.fromkeys(read_lines(Path(args.input))))  # dedupe, keep order
    if not urls:
        log.error("No hotel URLs found in %s. Add one URL per line and re-run.", args.input)
        return 1

    proxies = read_lines(Path(args.proxies))
    proxy_iter = proxy_cycle(proxies)
    language = None if args.language.lower() == "all" else args.language
    output = Path(args.output)

    log.info("Hotels: %d | proxies: %d | impersonate: %s | language: %s",
             len(urls), len(proxies), IMPERSONATE, language or "all")

    all_rows: list[dict] = []
    failed: list[str] = []

    try:
        for i, url in enumerate(urls, 1):
            proxy = next(proxy_iter)
            log.info("[%d/%d] %s%s", i, len(urls), url, f" via {proxy}" if proxy else "")
            try:
                rows = scrape_hotel(url, proxy, args.max_reviews, language)
                all_rows.extend(rows)
                log.info("  done: %d reviews", len(rows))
                save_csv(all_rows, output)  # checkpoint after every hotel
            except BlockedError as exc:
                failed.append(url)
                log.warning("  BLOCKED (%s). Waiting %ds before the next hotel.",
                            exc, BLOCK_COOLDOWN_SECONDS)
                time.sleep(BLOCK_COOLDOWN_SECONDS)
                continue
            except Exception as exc:  # never let one hotel kill the run
                failed.append(url)
                log.error("  FAILED: %s: %s", type(exc).__name__, exc)

            if i < len(urls):
                delay = random.uniform(*HOTEL_DELAY_RANGE)
                log.info("  sleeping %.1fs", delay)
                time.sleep(delay)
    except KeyboardInterrupt:
        log.warning("Interrupted by user, saving what we have.")

    save_csv(all_rows, output)
    log.info("Saved %d reviews to %s", len(all_rows), output)
    if failed:
        log.warning("%d hotel(s) failed or were blocked:", len(failed))
        for url in failed:
            log.warning("  %s", url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
