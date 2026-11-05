// Builds, from bookmarklet/tripadvisor_bookmarklet.js:
//   bookmarklet/bookmark.txt   the javascript: URL to paste into a bookmark
//   bookmarklet/install.html   drag-to-bookmarks install page
//
// Usage: node bookmarklet/build.js
// Minifies with terser when it is installed (npm install terser), which makes
// the bookmark about half the size. Without terser it falls back to stripping
// comments and whitespace.
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const src = fs.readFileSync(path.join(dir, "tripadvisor_bookmarklet.js"), "utf8");

const basicStrip = (code) => code
  .replace(/^\/\*[\s\S]*?\*\/\s*/, "")
  .split("\n")
  .filter((l) => !/^\s*\/\*.*\*\/\s*$/.test(l))
  .map((l) => l.trim())
  .filter(Boolean)
  .join("\n");

// Percent-encode only what a javascript: URL needs: "%" (would be decoded),
// "#" (fragment), whitespace other than plain spaces, backslash and
// non-ASCII characters. Everything else stays readable.
const encodeBookmarklet = (code) => "javascript:" + code.replace(/[%#\\\r\n\t\u0080-￿]/g,
  (c) => encodeURIComponent(c));

(async () => {
  let code;
  let how;
  try {
    const { minify } = require("terser");
    const out = await minify(src, { compress: { passes: 2 }, mangle: true, format: { comments: false, ascii_only: true } });
    code = out.code;
    how = "terser";
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
    code = basicStrip(src);
    how = "basic strip (install terser for a smaller bookmark)";
  }
  code = code.replace(/;?\s*$/, "") + ";void 0";
  new Function(code); // must still parse

  const href = encodeBookmarklet(code);
  // Round-trip check: what the browser decodes must equal the code.
  if (decodeURIComponent(href.slice("javascript:".length)) !== code) throw new Error("encoding round-trip failed");
  fs.writeFileSync(path.join(dir, "bookmark.txt"), href + "\n");

  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TripAdvisor Review Scraper</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 760px; margin: 32px auto; padding: 0 16px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 24px; } h2 { font-size: 18px; margin-top: 32px; }
  .bm { display: inline-block; padding: 10px 18px; background: #00aa6c; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 600; cursor: grab; }
  textarea { width: 100%; height: 110px; font: 12px monospace; }
  button { padding: 6px 14px; font-size: 14px; cursor: pointer; }
  li { margin: 6px 0; } code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<h1>TripAdvisor Review Scraper</h1>
<p>Runs in your own browser, with a progress tracker for each hotel. No terminal, install or Python needed. Works in Chrome and Edge, and with the Claude Cowork workflow.</p>

<h2>1. Add the bookmark</h2>
<p>Show your bookmarks bar (<code>Ctrl+Shift+B</code>, or <code>Cmd+Shift+B</code> on Mac). Delete any older <b>TA Reviews</b> bookmark, then <b>drag this green button onto the bar</b>:</p>
<p><a class="bm" href="${escHtml(href)}">TA Reviews</a></p>
<p>If dragging does not work: right-click the bookmarks bar, choose <b>Add page</b>, name it <code>TA Reviews</code>, and paste the text below into the URL field.</p>
<textarea id="code" readonly>${escHtml(href)}</textarea>
<p><button onclick="navigator.clipboard.writeText(document.getElementById('code').value);this.textContent='Copied'">Copy</button></p>

<h2>2. Use it by hand</h2>
<ol>
  <li>Open one of your hotel pages on <a href="https://www.tripadvisor.com" target="_blank" rel="noopener">tripadvisor.com</a>.</li>
  <li>Click the <b>TA Reviews</b> bookmark.</li>
  <li>Paste your hotel URLs separated by spaces (or the asset list Claude gave you), or leave the box empty to scrape the hotel you are viewing.</li>
  <li>Enter a max number of reviews per hotel, or leave it empty for all.</li>
  <li>A tracker panel shows a progress bar for each hotel. Keep the tab open and visible; do not reload it or navigate away. When it finishes, the CSV downloads automatically.</li>
</ol>
<p>If an orange setup message appears, scroll to the hotel's reviews and click the next-page arrow once.</p>

<h2>3. Use it with Claude Cowork</h2>
<p>Claude opens your first hotel page with your asset list attached to the link. When it asks, click <b>TA Reviews</b> once. No questions pop up; Claude follows the tracker from there.</p>
</body>
</html>
`;
  fs.writeFileSync(path.join(dir, "install.html"), html);
  console.log(`Minified with ${how}`);
  console.log(`Wrote bookmark.txt and install.html (bookmark ${href.length} chars)`);
})().catch((e) => { console.error(e); process.exit(1); });
