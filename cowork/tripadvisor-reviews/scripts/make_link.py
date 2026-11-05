#!/usr/bin/env python3
"""Turn an asset list into the link Claude opens before the user clicks the TA Reviews bookmark.

The TA Reviews bookmark reads its asset list from a "#ta-config=<url-encoded JSON>"
suffix on the TripAdvisor page URL, so no pop-up questions are needed.

Usage:
    python make_link.py assets.txt
    python make_link.py assets.txt --max 200
    python make_link.py assets.txt --only "Hotel A, Hotel B"
    python make_link.py --url "Hotel A | https://www.tripadvisor.com/Hotel_Review-...-d123-Reviews-..."

Prints JSON with:
    link    open this in Chrome, then click the bookmark
    paste   fallback: text to paste into the bookmark's first pop-up
    assets  the parsed list
    skipped lines that were not valid TripAdvisor hotel URLs
"""
import argparse
import json
import re
import sys
from urllib.parse import quote

HOTEL_ID = re.compile(r"-d(\d+)(?=[-.?#\s]|$)")


def parse_line(line):
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    name, _, url = line.rpartition("|") if "|" in line else ("", "", line)
    name, url = name.strip(), url.strip()
    if not HOTEL_ID.search(url) or "tripadvisor." not in url:
        raise ValueError(line)
    if not name:
        m = re.search(r"-Reviews-([^-./?#]+)", url)
        name = m.group(1).replace("_", " ") if m else "location " + HOTEL_ID.search(url).group(1)
    return {"name": name, "url": url.split("#")[0]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("assets_file", nargs="?", help="assets.txt (Name | URL per line)")
    ap.add_argument("--url", action="append", default=[], help="an asset line given directly; repeatable")
    ap.add_argument("--max", type=int, default=None, help="max reviews per asset")
    ap.add_argument("--only", default=None, help="comma-separated asset names to include (case-insensitive)")
    args = ap.parse_args()

    lines = list(args.url)
    if args.assets_file:
        with open(args.assets_file, encoding="utf-8-sig") as f:
            lines += f.read().splitlines()

    assets, skipped, seen = [], [], set()
    for line in lines:
        try:
            a = parse_line(line)
        except ValueError:
            skipped.append(line.strip())
            continue
        if a is None:
            continue
        hid = HOTEL_ID.search(a["url"]).group(1)
        if hid not in seen:
            seen.add(hid)
            assets.append(a)

    if args.only:
        wanted = {w.strip().lower() for w in args.only.split(",") if w.strip()}
        assets = [a for a in assets if a["name"].lower() in wanted]

    if not assets:
        print(json.dumps({"error": "no valid assets", "skipped": skipped}, indent=2))
        sys.exit(1)

    cfg = {"assets": assets}
    if args.max:
        cfg["maxReviews"] = args.max
    compact = json.dumps(cfg, separators=(",", ":"), ensure_ascii=False)
    link = assets[0]["url"] + "#ta-config=" + quote(compact, safe="")
    print(json.dumps({"link": link, "paste": compact, "assets": assets, "skipped": skipped}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
