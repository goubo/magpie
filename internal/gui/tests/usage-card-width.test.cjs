// Local card widths control both fallback CSS and the packed layout.
// No account, vendor, live gateway or local config is read.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const { reach } = require("./reader.cjs");

const assets = process.env.MAGPIE_LAYOUT_ASSETS || path.resolve(__dirname, "../assets");
const H = 3600e3, iso = (at) => new Date(at).toISOString();
const names = ["5 hours", "Weekly", "MCP · Monthly"];
function fixtures(now) {
  const windows = [5, 168].map((hours, i) => ({ name: names[i], used: 30 + i * 14, resetsAt: iso(now + hours * H * .4) }));
  const lines = windows.map((window, i) => {
    const end = Date.parse(window.resetsAt), start = end - [5,168][i] * H;
    return { name: window.name, points: [0,.2,.4,.6].map((fraction,n) => ({ at: iso(start + fraction * (end-start)), left: 100 - window.used*n/3, start: iso(start), resetsAt: iso(end) })) };
  });
  return {
    quotas: Array.from({length:6},(_,i) => ({provider:"vendor-"+i,name:"Vendor "+i,user:"reader@example.com",plan:"Coding Pro Annual · Extended weekly allowance and model-specific subscription",windows})),
    history: Array.from({length:6},(_,i) => ({provider:"vendor-"+i,user:"reader@example.com",lines})),
  };
}
function serve(lang, data, theme = "dark") {
  const settings = { lang, theme, quotaLeft: true, currency: "usd", codexNoCredits: ["a@example.com", "b@example.com"] };
  return async route => {
    const url = new URL(route.request().url()), json = body => route.fulfill({ json: body });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs=${JSON.stringify({ ...settings, web: true })};` });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/usage/quotas") return json(data.quotas);
    if (url.pathname === "/api/usage/quotas/history") return json(data.history);
    if (url.pathname === "/api/usage/quotas/history/holds") return json([]);
    if (url.pathname === "/api/usage") return json({ calls: 0, input: 0, output: 0, cost: 0, agents: [], models: [], accounts: [], series: [], days: [] });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)];
    try { return route.fulfill({ body: await fs.readFile(file), contentType }); } catch { return route.fulfill({ status: 404, body: "" }); }
  };
}

async function packed(page) {
  return page.evaluate(() => new Promise(resolve => {
    let last = "", frames = 0;
    const read = () => {
      const list = document.querySelector("#subscriptionUsage");
      const rects = [...list.children].map(e => { const r = e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; });
      const key = JSON.stringify(rects);
      if (list.classList.contains("packed") && key === last && ++frames >= 4) return resolve({
        columns: new Set(rects.map(r => r[0])).size,
        width: rects[0][2], container: list.clientWidth,
      });
      if (key !== last) { frames = 0; last = key; }
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  }));
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) for (const width of [1100, 420, 320]) {
    test(`${engine} ${lang} ${width}: local minimum width changes columns without losing the chart`, { timeout: 45000 }, async t => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [], writes = [];
      page.on("pageerror", e => errors.push(e.message));
      page.on("request", r => { if (r.method() !== "GET") writes.push(r.url()); });
      await page.addInitScript(() => localStorage.setItem("magpie.navLayout", "top"));
      await page.route("**/*", serve(lang, fixtures(Date.now()), width === 1100 ? "light" : "dark"));
      await page.goto("http://magpie.test/?view=usage");
      await page.locator(".quota-curve").first().waitFor();
      const initial = await packed(page);
      assert.ok(initial.width >= Math.min(360, initial.container) - 1, "default minimum is 360px, except a narrower container");
      const button = page.locator("#usageLayout");
      assert.equal(await button.isVisible(), true, "the allowances header offers layout settings");
      await button.click();
      const panel = page.locator(".usage-layout"), slider = panel.locator('input[type="range"]');
      await panel.waitFor();
      const labels = { en: "Layout", zh: "布局", "zh-TW": "版面配置", ja: "レイアウト", de: "Layout" };
      assert.equal(await panel.getAttribute("aria-label"), labels[lang]);
      assert.equal(await slider.inputValue(), "360");
      assert.equal(await button.getAttribute("aria-expanded"), "true");
      await panel.locator('[data-width="280"]').click();
      const compact = await packed(page);
      assert.ok(compact.width >= Math.min(280, compact.container) - 1);
      if (width === 1100) assert.ok(compact.columns > initial.columns, "a smaller minimum fits more columns");
      const scroll = await page.locator("#view-usage").evaluate(e => e.scrollTop);
      const curve = page.locator(".quota-curve").first();
      await slider.press("End");
      const spacious = await packed(page);
      assert.ok(spacious.width >= Math.min(560, spacious.container) - 1);
      assert.equal(spacious.columns, 1);
      assert.equal(await page.locator("#view-usage").evaluate(e => e.scrollTop), scroll, "changing width keeps the reader's position");
      assert.equal(await panel.locator("output").textContent(), "560 px");
      const measured = await panel.locator(".ul-measure").textContent();
      assert.ok(measured.includes(Math.round(spacious.width).toLocaleString(lang === "zh" ? "zh-CN" : lang)), `the measurement reports the actual packed card width: ${measured}, ${spacious.width}`);
      assert.equal(await curve.locator(".qc-plot").isVisible(), true);
      await slider.press("Escape");
      assert.equal(await panel.count(), 0);
      assert.equal(await button.getAttribute("aria-expanded"), "false");
      assert.equal(await button.evaluate(e => e === document.activeElement), true, "Escape restores focus");
      assert.equal(await page.evaluate(() => localStorage.getItem("magpie.usageCardMinWidth")), "560");
      await page.locator("#usageReload").click();
      await page.waitForFunction(() => !document.querySelector("#usageReload.busy"));
      assert.equal((await packed(page)).columns, 1, "a quota refresh retains the chosen minimum");
      await page.reload();
      await page.locator(".quota-curve").first().waitFor();
      assert.equal((await packed(page)).columns, 1, "reload retains the chosen minimum");
      await button.click();
      await panel.waitFor();
      assert.equal(await slider.inputValue(), "560");
      await panel.locator('[data-width="360"]').click();
      const back = await packed(page);
      assert.equal(back.columns, initial.columns, "restoring the default restores the layout");
      await button.click();
      await curve.locator(".qc-plot").click();
      await curve.locator(".qc-detail").waitFor();
      await button.click();
      await panel.locator('[data-width="440"]').click();
      await packed(page);
      assert.equal(await curve.locator(".qc-plot").getAttribute("aria-expanded"), "true", "repacking preserves the enlarged plot");
      assert.deepEqual(await page.evaluate(() => ({
        page: document.documentElement.scrollWidth > innerWidth,
        cards: [...document.querySelectorAll(".subscription-card")].some(e => e.scrollWidth > e.clientWidth + 1),
        popup: (() => { const b = document.querySelector(".usage-layout").getBoundingClientRect(); return b.left < 0 || b.right > innerWidth; })(),
      })), {page:false,cards:false,popup:false});
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, [], "display preferences do not write backend settings");
      if (process.env.ARTIFACT_DIR) {
        await fs.mkdir(process.env.ARTIFACT_DIR, {recursive:true});
        await page.screenshot({path:path.join(process.env.ARTIFACT_DIR,`${engine}-${lang}-${width}-card-width.png`)});
      }
    });
  }
  test(`${engine}: invalid saved widths fall back and another window follows local changes`, {timeout:45000}, async t => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({channel:"chromium"}));
    t.after(() => browser.close());
    const context = await browser.newContext({viewport:{width:1100,height:950},reducedMotion:"reduce"});
    const data = fixtures(Date.now());
    await context.route("**/*",serve("en",data));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => { localStorage.setItem("magpie.navLayout","top"); localStorage.setItem("magpie.usageCardMinWidth",'"400"'); });
    await page.goto("http://magpie.test/?view=usage");
    await page.locator(".quota-curve").first().waitFor();
    await page.locator("#usageLayout").click();
    const slider = page.locator("#usageCardWidth");
    assert.equal(await slider.inputValue(),"360","a stored string is not a valid numeric preference");
    await page.locator("#usageLayout").click();
    assert.equal(await page.evaluate(()=>localStorage.getItem("magpie.usageCardMinWidth")),'"400"',"opening settings does not overwrite an unreadable preference");
    const other = await context.newPage();
    await other.goto("http://magpie.test/?view=usage");
    await other.locator(".quota-curve").first().waitFor();
    await page.locator("#usageLayout").click();
    await page.locator('.usage-layout [data-width="440"]').click();
    await page.waitForFunction(()=>localStorage.getItem("magpie.usageCardMinWidth")==="440");
    await other.locator("#usageLayout").click();
    assert.equal(await other.locator("#usageCardWidth").inputValue(),"440");
    // A corrupt or out-of-range external update uses the same fallback.
    for (const value of [999, null, 300.5, {width:400}]) {
      await other.evaluate(value=>localStorage.setItem("magpie.usageCardMinWidth",JSON.stringify(value)),value);
      await page.waitForFunction(()=>document.querySelector("#usageCardWidth").value==="360");
    }
    await page.setViewportSize({width:1100,height:320});
    await page.locator("#usageLayout").click();
    const bounds = await page.locator(".usage-layout").boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 320, "the populated panel fits a short window");
    const cold = await context.newPage();
    cold.setDefaultTimeout(5000);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await cold.route("**/plugins/usage/layout.js", async route => {
      await gate;
      await route.fulfill({contentType:"text/javascript",body:await fs.readFile(path.join(assets,"plugins/usage/layout.js"))});
    });
    await cold.goto("http://magpie.test/?view=usage");
    await cold.locator(".quota-curve").first().waitFor();
    await cold.locator("#usageLayout").click();
    await cold.locator("#quotaTrend").click();
    await cold.locator(".sess-menu").waitFor();
    const loaded = cold.waitForResponse(r => new URL(r.url()).pathname.endsWith("/usage/layout.js"));
    release();
    await loaded;
    await cold.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await cold.locator(".usage-layout").count(),0,"a late module never replaces the menu the reader opened next");
    assert.equal(await cold.locator(".sess-menu").isVisible(),true);
    await cold.locator("#usageLayout").click();
    await cold.locator(".usage-layout").waitFor();
  });
}
