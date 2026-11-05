I want to set up a reusable workflow for pulling TripAdvisor reviews for my hotel assets. The scraping is done by my "TA Reviews" browser bookmark; you drive it through Claude in Chrome. The working folder contains:

- `tripadvisor-reviews/SKILL.md`: the workflow instructions
- `tripadvisor-reviews/scripts/make_link.py`: turns my asset list into the link the bookmark reads
- `assets.txt`: my assets, one per line as `Asset Name | TripAdvisor URL`
- `install_bookmark.html`: installs the TA Reviews bookmark

Please do the following, in order:

1. Read `tripadvisor-reviews/SKILL.md` in full and follow it whenever I ask for TripAdvisor reviews. Do not change the workflow or the bookmark.
2. Install the `tripadvisor-reviews` folder as a skill, unchanged, if you can do that from here. If you can't, tell me, and give me step-by-step instructions to upload it myself.
3. Check that Claude in Chrome is connected and can open and read tripadvisor.com pages. If not, tell me exactly what to enable.
4. Ask me whether the TA Reviews bookmark is already on my bookmarks bar. If not, tell me to open `install_bookmark.html` in Chrome and drag the green button to the bar, and wait until I confirm.
5. Check whether you can read my Downloads folder, since the CSV downloads there. If not, tell me how to give you access.
6. Create an `outputs/` folder in the working folder if it does not exist.
7. Run `python tripadvisor-reviews/scripts/make_link.py assets.txt` and list the assets it found and any it skipped. If there are no assets yet, stop here and ask me to fill in `assets.txt`.
8. Do a test run on the FIRST asset only, with a limit of 20 reviews (`--only "<first asset name>" --max 20`), following SKILL.md: open the link in Chrome, tell me when to click the bookmark, post the progress table, and when it finishes save the CSV into `outputs/` and show me the first 5 rows, including the publishedDate column.
9. Finish by telling me:
   - The phrases I can use later, such as "Pull TripAdvisor reviews for all assets", "Refresh reviews for <asset name>, max 200", and "Pull reviews for these hotels: <URLs>".
   - How to set this up as a weekly scheduled task in Cowork that pulls reviews for every asset in `assets.txt` and appends new ones to `outputs/master_reviews.csv`, noting that I will need to click the bookmark when it runs.

Important: never try to download TripAdvisor pages from the sandbox with Python, curl or web fetch. TripAdvisor blocks that. It only works through the bookmark in my Chrome tab.
