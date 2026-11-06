// Windows share real time by default, or compare their own cycle progress.
// No account, vendor, live gateway or local config is read.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const { reach } = require("./reader.cjs");

const assets = process.env.MAGPIE_QUOTA_ASSETS || path.resolve(__dirname, "../assets");
const H = 3600e3, iso = (at) => new Date(at).toISOString();
const names = ["5 hours", "Weekly", "MCP · Monthly"];
function fixtures(now) {
  const windows = [5, 168, 720].map((hours, i) => ({ name: names[i], used: [30, 44, 8][i], resetsAt: iso(now + hours * H * .4) }));
  const lines = windows.map((window, i) => {
    const end = Date.parse(window.resetsAt), start = end - [5, 168, 720][i] * H;
    return { name: window.name, points: [0, .2, .4, .6].map((fraction, n) => ({ at: iso(start + fraction * (end - start)), left: 100 - window.used * n / 3, start: iso(start), resetsAt: iso(end) })) };
  });
  return {
    quotas: ["a@example.com", "b@example.com"].map(user => ({ provider: "codex", name: "Codex", icon: "openai", user, windows })),
    history: ["a@example.com", "b@example.com"].map(user => ({ provider: "codex", user, lines })),
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

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    for (const width of [1100, 420]) {
      test(`${engine} ${lang} ${width}: chosen windows share an axis and enlarged readings stay exact`, { timeout: 60000 }, async t => {
        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
        t.after(() => browser.close());
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const data = fixtures(Date.now());
        await page.route("**/*", serve(lang, data, width === 1100 ? "light" : "dark"));
        await page.goto("http://magpie.test/?view=usage");
        const curve = page.locator(".quota-curve").first();
        await curve.waitFor();
        const legend = curve.locator("button.qc-key");
        assert.equal(await legend.count(), 3, "the existing legend selects each window");
        const plot = curve.locator(".qc-plot"), axis = curve.locator(".qc-axis");
        const scale = curve.locator('.qc-scale-mode input');
        assert.equal(await scale.count(), 1, "the real time scale switch is available");
        assert.equal(await scale.isChecked(), true, "real time is the default");
        assert.ok(await curve.locator(".qc-even").count() > 1, "real time retains each window's reference pace");
        const realPaths = await curve.locator("path.qc-line").evaluateAll(es => es.map(e => e.getAttribute("d")));
        await scale.uncheck();
        assert.equal(await curve.locator(".qc-now").count(), 0, "different cycles have no common now position");
        assert.equal(await curve.locator(".qc-even").count(), 1, "one shared reference pace");
        assert.deepEqual(await curve.locator(".qc-even").evaluate(e => [e.getAttribute("x1"), e.getAttribute("y1"), e.getAttribute("x2"), e.getAttribute("y2")]), ["0", "0", "300", "60"]);
        const relativePaths = await curve.locator("path.qc-line").evaluateAll(es => es.map(e => ({ x: e.getBBox().x, width: e.getBBox().width, series: e.dataset.series })));
        for (const [i, bounds] of relativePaths.entries()) {
          assert.ok(Math.abs(bounds.x) < .2 && Math.abs(bounds.width - 180) < .2, "60% of every cycle occupies 60% of the same plot, even the 5-hour one");
          assert.equal(bounds.series, String(i));
        }
        await plot.click();
        await plot.press("Home");
        assert.deepEqual(await curve.locator(".qc-reading").evaluateAll(es => es.map(e => e.dataset.at)), data.history[0].lines.map(l => l.points[0].at), "cycle progress keeps each window's actual timestamp");
        await plot.press("End");
        assert.deepEqual(await curve.locator(".qc-reading").evaluateAll(es => es.map(e => e.dataset.at)), data.history[0].lines.map(l => l.points.at(-1).at));
        await curve.locator(".qc-close").click();
        await scale.check();
        assert.deepEqual(await curve.locator("path.qc-line").evaluateAll(es => es.map(e => e.getAttribute("d"))), realPaths, "real time restores the original geometry");
        assert.equal(await curve.locator(".qc-detail").isVisible(), false, "small plots have no extra readings or scale");
        const color = name => curve.locator(`path.qc-line[data-name="${name}"]`).evaluate(e => ({ series: e.dataset.series, stroke: e.style.stroke }));
        const weeklyColor = await color("Weekly"), monthAxis = await axis.textContent();
        const meters = await page.locator(".quota-windows").first().textContent();
        await legend.nth(2).click();
        assert.equal(await legend.nth(2).getAttribute("aria-pressed"), "false");
        assert.deepEqual(await curve.locator("path.qc-line").evaluateAll(es => es.map(e => e.dataset.name)), names.slice(0, 2));
        assert.notEqual(await axis.textContent(), monthAxis, "a hidden monthly window no longer stretches the axis");
        assert.deepEqual(await color("Weekly"), weeklyColor);
        await legend.nth(0).click();
        assert.deepEqual(await color("Weekly"), weeklyColor, "filtering the first series never recolors the next");
        await legend.nth(1).press("Space");
        assert.equal(await plot.isVisible(), false, "all windows off hides the plot but keeps its legend");
        assert.equal(await legend.count(), 3);
        await page.reload();
        await curve.waitFor();
        assert.deepEqual(await legend.evaluateAll(es => es.map(e => e.getAttribute("aria-pressed"))), ["false", "false", "false"], "hiding every window also survives reload");
        assert.equal(await plot.isVisible(), false);
        await legend.nth(0).press("Enter");
        const fiveAxis = await axis.textContent();
        assert.notEqual(fiveAxis, monthAxis);
        assert.equal(await plot.isVisible(), true);
        assert.equal(await page.locator(".quota-windows").first().textContent(), meters, "selection only filters the chart");
        await page.reload();
        await curve.waitFor();
        assert.deepEqual(await legend.evaluateAll(es => es.map(e => e.getAttribute("aria-pressed"))), ["true", "false", "false"], "selection survives reload");
        await page.locator(".quota-more").click();
        assert.deepEqual(await page.locator(".quota-curve").nth(1).locator("button.qc-key").evaluateAll(es => es.map(e => e.getAttribute("aria-pressed"))), ["true", "true", "true"], "another account keeps its own combination");
        await reach(page, plot);
        const scroll = await page.locator("#view-usage").evaluate(e => e.scrollTop);
        await plot.click();
        await curve.locator(".qc-detail").waitFor({ state: "visible" });
        assert.equal(await page.locator("#view-usage").evaluate(e => e.scrollTop), scroll, "enlarging keeps the reader's place");
        assert.deepEqual(await curve.locator(".qc-y-label").allTextContents(), ["100%", "50%", "0%"]);
        const bounds = await plot.boundingBox();
        await page.mouse.move(bounds.x + bounds.width * .38, bounds.y + bounds.height / 2);
        await curve.locator(".qc-reading").waitFor({ state: "visible" });
        const readAt = await curve.locator(".qc-reading").getAttribute("data-at");
        const point = data.history[0].lines[0].points.find(p => p.at === readAt);
        assert.ok(point, "a hover reads an actual sample, never an interpolated value");
        assert.ok((await curve.locator(".qc-reading").textContent()).includes(Math.round(point.left) + "%"));
        await plot.focus();
        assert.equal(await page.locator("#view-usage").evaluate(e => e.scrollTop), scroll, "focusing keeps the reader's place");
        await plot.press("Home");
        assert.equal(await curve.locator(".qc-reading").getAttribute("data-at"), data.history[0].lines[0].points[0].at);
        await plot.press("ArrowRight");
        assert.equal(await curve.locator(".qc-reading").getAttribute("data-at"), data.history[0].lines[0].points[1].at);
        await plot.press("End");
        assert.equal(await curve.locator(".qc-reading").getAttribute("data-at"), data.history[0].lines[0].points.at(-1).at);
        await legend.nth(1).click();
        assert.equal(await page.locator("#view-usage").evaluate(e => e.scrollTop), scroll, "selecting a second line keeps the reader's place");
        assert.equal(await plot.getAttribute("aria-expanded"), "true", "changing the selection keeps the detail open");
        await plot.click();
        assert.equal(await curve.locator(".qc-detail").isVisible(), false);
        assert.equal(await page.locator("#view-usage").evaluate(e => e.scrollTop), scroll, "selecting and inspecting never scroll the page");
        await plot.click();
        await page.locator("#usageReload").click();
        await page.waitForFunction(() => !document.querySelector("#usageReload.busy"));
        assert.deepEqual(await legend.evaluateAll(es => es.map(e => e.getAttribute("aria-pressed"))), ["true", "true", "false"], "a quota refresh keeps the chosen combination");
        assert.equal(await plot.getAttribute("aria-expanded"), "true", "a quota refresh keeps the plot enlarged");
        await plot.click();
        assert.equal(await curve.locator(".qc-detail").isVisible(), false);
        assert.deepEqual(await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth, curves: [...document.querySelectorAll(".quota-curve")].some(e => e.scrollWidth > e.clientWidth + 1) })), { page: false, curves: false });
        assert.deepEqual(errors, []);
        await scale.uncheck();
        await page.reload();
        await curve.waitFor();
        assert.equal(await scale.isChecked(), false, "scale choice survives reload");
        if (await page.locator(".quota-curve").count() < 2) await page.locator(".quota-more").click();
        assert.equal(await page.locator(".quota-curve").nth(1).locator('.qc-scale-mode input').isChecked(), true, "another account keeps the default real time scale");
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await plot.click();
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-${width}-quota-selection.png`) });
        }
      });
    }
    test(`${engine} ${lang}: a single legend entry needs no time-axis switch`, { timeout: 30000 }, async t => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await (await browser.newContext({ viewport: { width: 420, height: 900 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(5000);
      const data = fixtures(Date.now());
      const extraWindow = data.quotas[0].windows[1], extraLine = data.history[0].lines[1];
      data.quotas = [{ ...data.quotas[0], windows: data.quotas[0].windows.slice(0, 1) }];
      data.history = [{ ...data.history[0], lines: data.history[0].lines.slice(0, 1) }];
      await page.addInitScript(() => localStorage.setItem("magpie.quotaCurveRelative", JSON.stringify(["codex\na@example.com"])));
      await page.route("**/*", serve(lang, data));
      await page.goto("http://magpie.test/?view=usage");
      const curve = page.locator(".quota-curve").first(), scale = curve.locator('.qc-scale-mode input');
      await curve.waitFor();
      assert.equal(await curve.locator("button.qc-key").count(), 1);
      assert.equal(await curve.locator(".qc-scale-mode").isVisible(), false, "one available entry hides the control");
      assert.equal(await scale.isChecked(), true, "a hidden control cannot leave a saved cycle-progress mode active");
      assert.equal(await curve.locator(".qc-now").count(), 1);
      assert.equal(await curve.evaluate(e => e.classList.contains("qc-relative")), false);
      data.quotas[0].windows.push(extraWindow);
      data.history[0].lines.push(extraLine);
      await page.locator("#usageReload").click();
      await page.waitForFunction(() => !document.querySelector("#usageReload.busy"));
      await curve.locator(".qc-scale-mode").waitFor({ state: "visible" });
      const label = { en: "Use actual time", zh: "按实际时间", "zh-TW": "依實際時間", ja: "実時間軸を使用", de: "Reale Zeitachse" }[lang];
      assert.equal(await curve.locator(".qc-scale-mode span").textContent(), label);
      assert.equal(await scale.isChecked(), false, "the saved choice returns when there are multiple entries");
      await curve.locator("button.qc-key").nth(1).click();
      assert.equal(await curve.locator("path.qc-line").count(), 1);
      assert.equal(await curve.locator(".qc-scale-mode").isVisible(), true, "choosing one of several entries keeps the control available");
      data.quotas[0].windows.pop();
      data.history[0].lines.pop();
      await page.locator("#usageReload").click();
      await page.waitForFunction(() => !document.querySelector("#usageReload.busy"));
      await curve.locator(".qc-scale-mode").waitFor({ state: "hidden" });
      assert.equal(await curve.locator(".qc-now").count(), 1, "losing a window returns the single-entry plot to actual time");
    });
  }
  test(`${engine}: touch inspects an enlarged chart and Collapse closes it`, { timeout: 30000 }, async t => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 440, height: 1000 }, hasTouch: true, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.route("**/*", serve("zh", fixtures(Date.now())));
    await page.goto("http://magpie.test/?view=usage");
    const curve = page.locator(".quota-curve").first(), plot = curve.locator(".qc-plot");
    await plot.tap();
    await curve.locator(".qc-detail").waitFor();
    await plot.tap();
    assert.equal(await plot.getAttribute("aria-expanded"), "true", "a touch reads a sample without closing the chart");
    assert.equal(await curve.locator(".qc-reading").count(), 3);
    await curve.getByRole("button", { name: "收起", exact: true }).tap();
    assert.equal(await plot.getAttribute("aria-expanded"), "false");
    assert.equal(await curve.locator(".qc-detail").isVisible(), false);
  });
  test(`${engine}: filtering a recorded cycle preserves its historical meters`, { timeout: 30000 }, async t => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 980, height: 900 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(5000);
    const now = Date.now(), data = fixtures(now), D = 24 * H;
    data.history[0].lines[2].points.unshift(...[[-50, 60], [-31, 20]].map(([days, left]) => ({ at: iso(now + days * D), left, start: iso(now - 60 * D), resetsAt: iso(now - 30 * D) })));
    await page.route("**/*", serve("en", data));
    await page.goto("http://magpie.test/?view=usage");
    const curve = page.locator(".quota-curve").first(), month = curve.locator('button.qc-key[data-name="MCP · Monthly"]');
    await month.click();
    await curve.locator('.qc-scale-mode input').uncheck();
    await curve.getByRole("button", { name: "Choose a recorded cycle" }).click();
    await page.locator(".sess-menu .pm-item").nth(1).click();
    const meters = page.locator(".quota-windows").first();
    await meters.getByText("Loading…", { exact: true }).waitFor({ state: "hidden" });
    const snapshot = await meters.textContent(), axis = await curve.locator(".qc-axis").textContent();
    assert.equal(await month.getAttribute("aria-pressed"), "false", "the current selection also applies to history");
    assert.equal(await curve.locator(".qc-plot").isVisible(), false, "missing historical windows are never fabricated");
    await month.click();
    assert.equal(await curve.locator("path.qc-line").getAttribute("data-name"), "MCP · Monthly");
    assert.equal(await curve.locator(".qc-key b").textContent(), "20%");
    assert.equal(await curve.locator(".qc-axis").textContent(), axis, "an explicitly selected historical cycle keeps its dates");
    assert.equal(await meters.textContent(), snapshot, "choosing plotted windows never replaces historical meters with current ones");
    assert.equal(await curve.locator(".qc-scale-mode").isVisible(), false, "a historical snapshot with only one entry also hides the switch");
    assert.equal(await curve.locator(".qc-even").count(), 1);
    assert.equal(await curve.locator("path.qc-line").getAttribute("data-name"), "MCP · Monthly");
    assert.equal(await meters.textContent(), snapshot, "the hidden switch preserves historical meters");
    assert.match(await curve.locator("path.qc-line").getAttribute("d"), /^M100\.0 /, "the recorded historical start supplies the cycle origin");
    await curve.getByRole("button", { name: "Choose a recorded cycle" }).click();
    await page.locator(".sess-menu .pm-item").first().click();
    await curve.locator(".qc-scale-mode").waitFor({ state: "visible" });
    assert.equal(await curve.locator('.qc-scale-mode input').isChecked(), false, "returning to the current multi-entry view restores its saved mode");
  });
  test(`${engine}: cycle progress uses complete recorded bounds even under the two-day view`, { timeout: 30000 }, async t => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 980, height: 900 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(5000);
    const now = Date.now(), data = fixtures(now);
    for (const p of data.history[0].lines[2].points) delete p.start;
    // An older 5-hour cycle never gets folded onto the current one.
    data.history[0].lines[0].points.unshift({ at: iso(now - 8 * H), left: 10, start: iso(now - 10 * H), resetsAt: iso(now - 5 * H) });
    await page.addInitScript(() => localStorage.setItem("magpie.quotaRange", "2d"));
    await page.route("**/*", serve("en", data));
    await page.goto("http://magpie.test/?view=usage");
    const curve = page.locator(".quota-curve").first(), scale = curve.locator('.qc-scale-mode input');
    await curve.waitFor();
    assert.equal(await curve.locator(".qc-range").textContent(), "2 days");
    const realAxis = await curve.locator(".qc-axis").textContent();
    await scale.uncheck();
    assert.equal(await curve.locator(".qc-range").textContent(), "Cycle");
    assert.deepEqual(await curve.locator(".qc-axis span").allTextContents(), ["Cycle start", "Cycle end"]);
    assert.equal(await curve.locator(".qc-scale-note").isVisible(), true, "unknown complete bounds are explained");
    assert.deepEqual(await curve.locator("path.qc-line").evaluateAll(es => es.map(e => e.dataset.name)), names.slice(0, 2), "missing starts are never replaced by the first sample");
    const five = curve.locator('path.qc-line[data-name="5 hours"]');
    assert.equal((await five.getAttribute("d")).match(/M/g).length, 1, "only the current short cycle is drawn");
    await curve.locator('button.qc-key[data-name="MCP · Monthly"]').click();
    assert.equal(await curve.locator(".qc-scale-note").isVisible(), false);
    await scale.check();
    assert.equal(await curve.locator(".qc-range").textContent(), "2 days");
    assert.equal(await curve.locator(".qc-axis").textContent(), realAxis);
  });
}
