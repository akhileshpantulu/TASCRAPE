I want to set up a reusable workflow for pulling TripAdvisor reviews for my hotel assets, using Claude in Chrome. The working folder contains:

- `tripadvisor-reviews/SKILL.md`: the workflow instructions
- `tripadvisor-reviews/scripts/ta_scraper.js`: the scraper that runs inside my Chrome tab and shows a progress tracker with a bar per asset
- `assets.txt`: my asset list, one per line as `Asset Name | TripAdvisor URL`
- `install_bookmark.html`: a backup bookmark version of the same scraper

Please do the following, in order:

1. Read `tripadvisor-reviews/SKILL.md` in full, and the first lines of `scripts/ta_scraper.js`. Follow SKILL.md whenever I ask for TripAdvisor reviews. Use `ta_scraper.js` exactly as provided; do not rewrite or shorten it.
2. Install the `tripadvisor-reviews` folder as a skill, unchanged, if you can do that from here. If you can't, tell me, and give me step-by-step instructions to upload it myself.
3. Check that Claude in Chrome is connected and that you can run JavaScript on a tripadvisor.com page. If not, tell me exactly what to enable.
4. Check whether you can read my Downloads folder, since the CSV downloads there. If not, tell me how to give you access.
5. Create an `outputs/` folder in the working folder if it does not exist.
6. Read `assets.txt` and list the assets you found. If it has no assets yet, stop here and ask me to fill it in.
7. Do a test run on the FIRST asset only, with a limit of 20 reviews, following SKILL.md. Post the progress table while it runs. When it finishes, save the CSV into `outputs/` and show me the first 5 rows.
8. Finish by telling me:
   - The phrases I can use later, such as "Pull TripAdvisor reviews for all assets", "Refresh reviews for <asset name>, max 200", and "Pull reviews for these hotels: <URLs>".
   - How to set this up as a weekly scheduled task in Cowork that pulls reviews for every asset in `assets.txt` and appends new ones to `outputs/master_reviews.csv`.

Important: never try to download TripAdvisor pages from the sandbox with Python, curl or web fetch. TripAdvisor blocks that. It only works by running the script inside my Chrome tab.
