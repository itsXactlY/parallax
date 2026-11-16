// Page quality on the real screens: every stylesheet loads, every lazy image has a box before
// it requests, every form field is addressable, and scrolling does not move the page.
// Run it with: python3 tests/run.py tests/ui/page-quality.mjs
// (the runner starts the app in mock mode on a fresh data folder and calls:
//  node tests/ui/page-quality.mjs <base-url> <out-dir> [width] [height])
//
// Chrome reports these as its own hints ("Page errors", "Improvements"): a stylesheet that 404s,
// an <img loading="lazy"> with no width/height that shifts the layout when its bytes land, and an
// <input> with neither id nor name that autofill cannot address.
//
// The address list is `routes` in src/content/site.ts. A page that 404s is a failure here, not a
// pass: the 404 screen has no images and no fields, so it would prove nothing about the real one.
import { launch } from "./browser.mjs";

const [base, out, W = "1440", H = "900"] = process.argv.slice(2);
const b = await launch({ width: Number(W), height: Number(H), out });

const PAGES = [
  "/", "/explore", "/community", "/image", "/video", "/audio", "/remix", "/cinema",
  "/shorts", "/ads", "/supercomputer", "/canvas", "/apps", "/apps/restyle", "/library",
  "/mcp", "/developer", "/pricing", "/enterprise", "/guide", "/settings", "/wallet",
  "/notifications", "/whats-new", "/search", "/login", "/join",
];

const probe = `(() => {
  const inputs = [...document.querySelectorAll("input, select, textarea")];
  const imgs = [...document.querySelectorAll("img")];
  const lazy = imgs.filter((i) => i.loading === "lazy");
  const naked = lazy.filter((i) => !i.getAttribute("width") && !i.getAttribute("height") && !i.style.aspectRatio);
  const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith("data:"));
  const sheets = [...document.querySelectorAll("link[rel=stylesheet]")].map((l) => l.href);
  const label = (i) => (i.tagName + " " + (i.type || "") + " " + String(i.className).slice(0, 40)).trim();
  const describe = (e) => (e.getAttribute("data-artwork") ? "artwork " + e.getAttribute("data-artwork") : label(e));
  return JSON.stringify({
    notFound: document.body.innerText.includes("Nothing at this address"),
    inputs: inputs.length,
    inputsNoId: inputs.filter((i) => !i.id && !i.name).map(label).slice(0, 4),
    lazy: lazy.length,
    lazyNoDims: naked.map(describe).slice(0, 4),
    broken: broken.map((i) => i.src).slice(0, 3),
    sheets,
    cls: +(window.__shifts || []).reduce((s, e) => s + e.value, 0).toFixed(4),
  });
})()`;

const watch = `(() => { window.__shifts = []; new PerformanceObserver((l) => window.__shifts.push(...l.getEntries())).observe({ type: "layout-shift", buffered: true }); })()`;
const settle = (ms) => b.evaluate(`new Promise((r) => setTimeout(r, ${ms}))`);

const problems = [];
for (const path of PAGES) {
  await b.goto(base + path);
  await b.evaluate(watch);
  await settle(700);
  const d = JSON.parse(await b.evaluate(probe));
  if (d.notFound) problems.push(`${path}: no page at this address (the 404 screen proved nothing)`);
  if (d.inputsNoId.length) problems.push(`${path}: input without id or name -> ${d.inputsNoId.join(", ")}`);
  if (d.lazyNoDims.length) problems.push(`${path}: lazy image without a box -> ${d.lazyNoDims.join(", ")}`);
  if (d.broken.length) problems.push(`${path}: image loaded but drew nothing -> ${d.broken.join(", ")}`);
  if (d.cls > 0.1) problems.push(`${path}: layout shift ${d.cls} over ${d.lazy} lazy images`);
  for (const href of d.sheets) {
    const code = await b.evaluate(`fetch(${JSON.stringify(href)}, { cache: "no-store" }).then((r) => r.status)`);
    if (code !== 200) problems.push(`${path}: stylesheet ${code} -> ${href}`);
  }
  console.log(`${path} ${d.inputs} inputs, ${d.lazy} lazy imgs (all boxed), cls ${d.cls}`);
}

// Signed in: the Supercomputer chat, and a search dialog that only exists once you are in.
await b.evaluate(`(async () => {
  await fetch("/api/auth/guest", { method: "POST" });
  const chats = await (await fetch("/api/super/chats", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  window.__chat = chats.chat.id;
})()`);
const chatId = await b.evaluate(`window.__chat`);

await b.goto(`${base}/supercomputer/c/${chatId}`);
await b.evaluate(watch);
await settle(900);
const chat = JSON.parse(await b.evaluate(probe));
if (chat.notFound) problems.push(`/supercomputer/c/<chat>: no page at this address`);
if (chat.inputsNoId.length) problems.push(`/supercomputer/c/<chat>: input without id or name -> ${chat.inputsNoId.join(", ")}`);
if (chat.lazyNoDims.length) problems.push(`/supercomputer/c/<chat>: lazy image without a box -> ${chat.lazyNoDims.join(", ")}`);
console.log(`/supercomputer/c/<chat> ${chat.inputs} inputs, ${chat.lazy} lazy imgs, cls ${chat.cls}`);

// The header's search button is desktop chrome; at phone size the search lives at /search,
// which the list above already walked.
if (Number(W) >= 900) {
  await b.click("button", "Search");
  await settle(500);
  const dialog = JSON.parse(await b.evaluate(probe));
  if (dialog.inputsNoId.length) problems.push(`/search dialog: input without id or name -> ${dialog.inputsNoId.join(", ")}`);
  console.log(`search dialog ${dialog.inputs} inputs`);
}

const logs = b.logs().filter((l) => /stylesheet|css|\b4\d\d\b|5\d\d\b/.test(l));
if (logs.length) problems.push(`console/network: ${logs.slice(0, 5).join("; ")}`);

await b.close();
if (problems.length) {
  console.log(`FAIL\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`PASS ${PAGES.length + 2} screens: stylesheets 200, lazy images boxed, form fields named, no layout shift`);
