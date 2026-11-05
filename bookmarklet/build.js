// Builds bookmarklet/install.html from tripadvisor_bookmarklet.js.
// Usage: node bookmarklet/build.js
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const src = fs.readFileSync(path.join(dir, "tripadvisor_bookmarklet.js"), "utf8");

// Drop the leading header comment and whole-line /* ... */ comments.
const body = src
  .replace(/^\/\*[\s\S]*?\*\/\s*/, "")
  .split("\n")
  .filter((l) => !/^\s*\/\*.*\*\/\s*$/.test(l))
  .map((l) => l.trim())
  .filter(Boolean)
  .join("\n");

const href = "javascript:" + encodeURIComponent(body);
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
<p>Runs in your own browser, so no terminal, install or Python is needed. Works in Chrome and Edge.</p>

<h2>1. Add the bookmark</h2>
<p>Show your bookmarks bar (<code>Ctrl+Shift+B</code>, or <code>Cmd+Shift+B</code> on Mac), then <b>drag this green button onto it</b>:</p>
<p><a class="bm" href="${escHtml(href)}">TA Reviews</a></p>
<p>If dragging does not work: right-click the bookmarks bar, choose <b>Add page</b>, name it <code>TA Reviews</code>, and paste the text below into the URL field.</p>
<textarea id="code" readonly>${escHtml(href)}</textarea>
<p><button onclick="navigator.clipboard.writeText(document.getElementById('code').value);this.textContent='Copied'">Copy</button></p>

<h2>2. Use it</h2>
<ol>
  <li>Open <a href="https://www.tripadvisor.com" target="_blank" rel="noopener">tripadvisor.com</a> (any page, or a hotel page).</li>
  <li>Click the <b>TA Reviews</b> bookmark.</li>
  <li>Paste your hotel URLs separated by spaces, or leave the box empty to scrape the hotel you are viewing.</li>
  <li>Answer the two questions (max reviews per hotel, languages).</li>
  <li>A green box in the corner shows progress. Keep the tab open. When it finishes, <code>tripadvisor_reviews.csv</code> downloads automatically.</li>
</ol>
<p>Start with one hotel and a limit of 20 to check it works.</p>
</body>
</html>
`;

fs.writeFileSync(path.join(dir, "install.html"), html);
console.log(`Wrote install.html (bookmarklet ${href.length} chars)`);
