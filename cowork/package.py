"""Builds cowork/TripAdvisor-Reviews-Cowork.zip, the folder the user unzips and opens in Cowork.

Run after `node bookmarklet/build.js`:
    python cowork/package.py
"""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COWORK = ROOT / "cowork"
TOP = "TripAdvisor-Reviews-Cowork"

files = {
    f"{TOP}/tripadvisor-reviews/SKILL.md": COWORK / "tripadvisor-reviews" / "SKILL.md",
    f"{TOP}/tripadvisor-reviews/scripts/ta_scraper.js": COWORK / "tripadvisor-reviews" / "scripts" / "ta_scraper.js",
    f"{TOP}/assets.txt": COWORK / "assets.txt",
    f"{TOP}/COWORK_SETUP_PROMPT.md": COWORK / "COWORK_SETUP_PROMPT.md",
    f"{TOP}/install_bookmark.html": ROOT / "bookmarklet" / "install.html",
}

out = COWORK / f"{TOP}.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, src in files.items():
        z.write(src, arc)
    z.writestr(f"{TOP}/outputs/", "")
print(f"Wrote {out.relative_to(ROOT)}")

skill_zip = COWORK / "tripadvisor-reviews-skill.zip"
with zipfile.ZipFile(skill_zip, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, src in files.items():
        if arc.startswith(f"{TOP}/tripadvisor-reviews/"):
            z.write(src, arc[len(TOP) + 1:])
print(f"Wrote {skill_zip.relative_to(ROOT)}")
