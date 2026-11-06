const quotaCurveHidden = new Map(kept("quotaCurveHidden", []).filter(x => Array.isArray(x) && typeof x[0] === "string" && Array.isArray(x[1])));
const quotaCurveBig = new Set();
const quotaCurveRelative = new Set(kept("quotaCurveRelative", []).filter(x => typeof x === "string"));
addEventListener("storage", e => {
  if (e.key === "magpie.quotaCurveHidden") {
    quotaCurveHidden.clear();
    for (const entry of kept("quotaCurveHidden", [])) if (Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])) quotaCurveHidden.set(entry[0], entry[1]);
  } else if (e.key === "magpie.quotaCurveRelative") {
    quotaCurveRelative.clear();
    for (const key of kept("quotaCurveRelative", [])) if (typeof key === "string") quotaCurveRelative.add(key);
  } else return;
  renderQuotas();
});
// Each current (or selected historical) cycle gets its own full width.
// Keep the real samples and bounds for readouts, never synthetic dates.
function quotaRelativeLines(lines, now) {
  return lines.flatMap(line => {
    if (!Number.isFinite(line.points.at(-1)?.start)) return [];
    const cycle = line.cycle || quotaCycle(line, now);
    if (!Number.isFinite(cycle.start) || !Number.isFinite(cycle.reset) || !(cycle.reset > cycle.start)) return [];
    return [{ ...line, cycle, points: line.points.filter(p => p.at >= cycle.start && p.at < cycle.reset && p.at <= now) }];
  });
}
function drawQuotaRelative(g, lines, W, H) {
  drawQuotaPlot(g, [], 0, 1, W, H, -1);
  g.append(sv("line", { x1: 0, y1: 0, x2: W, y2: H, class: "qc-even qc-relative-even" }, { stroke: "var(--muted)" }));
  for (const line of lines) {
    const d = quotaPaths(line.points, line.cycle.start, line.cycle.reset, W, H);
    if (d) g.append(sv("path", { d, class: "qc-line", "data-name": line.name, "data-series": line.series }, { stroke: `var(--c${line.series + 1})` }));
  }
}
window.quotaCurveDraw = function(sub, lines) {
  const box = el("div", "quota-curve");
  const head = el("div", "qc-head");
  const range = el("button", "text qc-range");
  range.type = "button";
  const key = usageAcctKey(sub);
  const pace = el("span", "qc-pace");
  head.append(el("span", "", t("Left over time")), pace, range);
  const W = 300, H = 60;
  const g = sv("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "qc-plot", role: "img" });
  curveZoom(box, g);
  const chart = el("div", "qc-chart");
  chart.append(g);
  if (quotaCurveBig.has(key)) { box.classList.add("big"); g.setAttribute("aria-expanded", "true"); }
  box.onzoom = big => { if (big) quotaCurveBig.add(key); else quotaCurveBig.delete(key); box.draw(); };
  const hidden = () => new Set(quotaCurveHidden.get(key) || []);
  let detailState;
  const axis = el("div", "qc-axis");
  const legend = el("div", "qc-legend");
  const controls = el("div", "qc-controls");
  const scaleLabel = el("label", "qc-scale-mode");
  const scale = el("input");
  scale.type = "checkbox";
  scaleLabel.append(scale, el("span", "", t("Use actual time")));
  controls.append(legend, scaleLabel);
  const note = el("div", "qc-scale-note");
  scale.onchange = () => {
    if (scale.checked) quotaCurveRelative.delete(key); else quotaCurveRelative.add(key);
    keep("quotaCurveRelative", [...quotaCurveRelative]);
    box.draw();
  };
  box.curveTitle = () => box.classList.contains("qc-relative")
    ? t("Each window fills the plot with its own cycle. Dashed: an even pace from full to empty. Equal positions show equal cycle progress, not the same time.") : quotaCurveTitle();
  const drawLegend = (shown, now) => {
    legend.replaceChildren();
    shown.forEach((l) => {
      const k = el("button", "qc-key");
      k.type = "button";
      k.dataset.name = l.name;
      const s = l.series, color = `var(--c${s + 1})`;
      k.dataset.series = s;
      k.setAttribute("aria-pressed", String(!hidden().has(l.name)));
      const sw = el("i");
      sw.style.background = color;
      // colorblind mode shows this for the dot: the window's line in its dash
      const sample = sv("svg", { class: "qc-sample", viewBox: "0 0 22 6", "aria-hidden": "true" });
      sample.append(sv("line", { x1: 1, y1: 3, x2: 21, y2: 3, class: "qc-dash", "data-series": s }, { stroke: color }));
      const last = l.points[l.points.length - 1];
      if (!last) return;
      k.append(sw, sample, el("span", "", l.label), el("b", "", Math.round(last.left) + "%"));
      k.title = [t("{name}: {n} left, read {when}", { name: l.label, n: Math.round(last.left) + "%", when: quotaTimeText(last.at, now) }),
        "", t("Latest readings:"), ...quotaReadings(l, now)].join("\n");
      k.onclick = e => {
        e.stopPropagation();
        const off = hidden();
        if (off.has(l.name)) off.delete(l.name); else off.add(l.name);
        quotaCurveHidden.set(key, [...off]);
        keep("quotaCurveHidden", [...quotaCurveHidden]);
        box.draw();
        [...legend.children].find(b => b.dataset.name === l.name)?.focus(NO_SCROLL);
      };
      legend.append(k);
    });
  };
  box.draw = () => {
    const now = Date.now();
    const past = quotaPastCycles(lines, now);
    const history = quotaHistoryView(sub, lines, now);
    const picked = history?.picked;
    // Keep only readings of the selected cycle. In particular, a refill
    // at its end belongs to the next cycle, not this cycle's last figure.
    const shown = history?.shown || lines;
    const visible = shown.filter(l => !hidden().has(l.name) && l.points.length);
    // Count available legend entries, not the selected combination.
    scaleLabel.hidden = shown.filter(l => l.points.length).length < 2;
    const relative = !scaleLabel.hidden && quotaCurveRelative.has(key);
    scale.checked = !relative;
    box.classList.toggle("qc-relative", relative);
    const plotted = relative ? quotaRelativeLines(visible, now) : visible;
    const [x0, x1] = picked ? [picked.start, picked.end] : visible.length ? quotaSpan(visible, quotaRange, now) : [now - 1, now];
    if (relative) drawQuotaRelative(g, plotted, W, H);
    else drawQuotaPlot(g, plotted, x0, Math.max(x0 + 1, x1), W, H, now);
    g.style.display = plotted.length ? "" : "none";
    axis.hidden = !plotted.length;
    note.hidden = !relative || plotted.length === visible.length;
    note.textContent = note.hidden ? "" : t("Some windows have no recorded cycle bounds");
    detailState = { lines: plotted, x0: relative ? 0 : x0, x1: relative ? 1 : Math.max(x0 + 1, x1), now, W, H, relative };
    if (box.classList.contains("big")) quotaCurveDetail(box, g, detailState);
    else box.querySelector(".qc-detail")?.remove();
    box.title = box.curveTitle();
    scaleLabel.title = box.title;
    const r = picked ? t("Past cycle") : t(!relative && quotaRange === "2d" ? "2 days" : "Cycle");
    range.textContent = r;
    range.disabled = quotaRange !== "cycle" || !past.cycles.length;
    range.title = t("Choose a recorded cycle");
    range.setAttribute("aria-label", t("Choose a recorded cycle"));
    if (!range.disabled) range.append(svg(CHEV, 9, 1.6));
    range.onclick = (e) => {
      e.stopPropagation();
      if (range.classList.contains("open")) return closeProtoMenu();
      openProtoMenu(range, [{ v: "", name: "Cycle", note: "The current cycle, from the window's start to its reset" }, ...past.cycles.map((c) => ({
        v: c.id, name: quotaCycleDate(c.start) + " – " + quotaCycleDate(c.end), literalName: true, note: t("Recorded duration: {duration}", { duration: quotaCycleLength(c) }),
      }))], picked?.id || "", (id) => { if (id) quotaCyclePicks.set(key, id); else quotaCyclePicks.delete(key); renderQuotas(); }, "Choose a recorded cycle", "sess-menu");
    };
    g.setAttribute("aria-label", t("Left over time") + " · " + r + (relative ? " · " + box.title : ""));
    axis.replaceChildren(el("span", "", relative ? t("Cycle start") : picked ? quotaCycleDate(x0) : quotaTimeText(x0, now)), el("span", "", relative ? t("Cycle end") : picked ? quotaCycleDate(x1) : quotaTimeText(x1, now)));
    drawLegend(shown, now);
    // The window whose deadline is furthest off answers for the card: the
    // head has room for the pace a shape in 52px only hints at (#2079). It
    // is the window the legend's last key is, and a window with no readings
    // of the picked cycle carries a cycle of nothing to be asked about. A
    // past cycle picked has no pace to tell: it is over.
    let longest = null, latest = -Infinity;
    if (!picked) visible.forEach((l) => {
      const c = l.cycle || quotaCycle(l, now);
      if (c?.reset != null && c.reset > latest) { latest = c.reset; longest = l; }
    });
    const p = longest ? quotaEta(longest, now) : null;
    pace.textContent = p ? quotaEtaText(longest, now) : "";
    // which window it is, and the instant with its year, behind a line
    // that holds day and minute and is cut short rather than wrapped
    pace.title = p ? tipLines(visible.length > 1 ? longest.label : "", pace.textContent, p.out != null ? new Date(p.out).toLocaleString(intlLang()) : "") : "";
  };
  box.append(head, controls, chart, axis, note);
  box.draw();
  return box;
};

// Exact samples and a scale only while an allowance curve is enlarged.
// The compact plot and the tray's spark keep their original rendering.
let quotaDetailID = 0;
window.quotaCurveDetail = (box, g, state) => {
  let detail = box.querySelector(".qc-detail");
  if (!box.classList.contains("big") || !state.lines.length) { detail?.remove(); return; }
  if (!detail) {
    detail = el("div", "qc-detail");
    detail.id = "quota-detail-" + ++quotaDetailID;
    const scale = el("div", "qc-scale");
    scale.setAttribute("aria-hidden", "true");
    for (const value of [100, 50, 0]) scale.append(el("span", "qc-y-label", value + "%"));
    detail.append(scale, el("div", "qc-readings"));
    const close = el("button", "text qc-close", t("Collapse"));
    close.type = "button";
    close.onclick = e => { e.stopPropagation(); box.readTouch = false; g.dispatchEvent(new MouseEvent("click", { bubbles: true })); g.focus(NO_SCROLL); };
    detail.append(close);
    box.querySelector(".qc-chart").append(detail);
  }
  g.setAttribute("aria-describedby", detail.id);
  const { lines, x0, x1, now, W, H, relative } = state;
  const samples = lines.map(line => ({ ...line, points: relative ? line.points : line.points.filter(p => p.at >= x0 && p.at <= Math.min(x1, now)) }));
  const position = (line, point) => relative ? (point.at - line.cycle.start) / (line.cycle.reset - line.cycle.start) : point.at;
  const positions = [...new Set(samples.flatMap(line => line.points.map(p => position(line, p))))].sort((a, b) => a - b);
  const readings = detail.querySelector(".qc-readings");
  const nearest = (points, at, value) => {
    let lo = 0, hi = points.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (value(points[mid]) < at) lo = mid + 1; else hi = mid; }
    if (lo && (lo === points.length || at - value(points[lo - 1]) <= value(points[lo]) - at)) lo--;
    return lo;
  };
  let index = positions.length - 1;
  const inspect = at => {
    if (!box.classList.contains("big")) return;
    g.querySelectorAll(".qc-cursor, .qc-point").forEach(node => node.remove());
    readings.replaceChildren();
    if (!positions.length) { readings.textContent = t("No readings in this cycle"); return; }
    index = nearest(positions, at, value => value);
    const X = time => (time - x0) / (x1 - x0) * W;
    g.append(sv("line", { x1: X(positions[index]), x2: X(positions[index]), y1: 0, y2: H, class: "qc-cursor" }));
    for (const line of samples) {
      if (!line.points.length) continue;
      const point = line.points[nearest(line.points, positions[index], p => position(line, p))];
      const row = el("span", "qc-reading");
      row.dataset.at = new Date(point.at).toISOString();
      row.textContent = t("{name}: {n} left, read {when}", { name: line.label, n: point.left.toLocaleString(intlLang(), { maximumFractionDigits: 2 }) + "%", when: new Date(point.at).toLocaleString(intlLang()) });
      readings.append(row);
      g.append(sv("circle", { cx: X(position(line, point)), cy: H - to100(point.left) / 100 * H, r: 1.5, class: "qc-point" }, { fill: `var(--c${line.series + 1})` }));
    }
  };
  const pointer = e => {
    const rect = g.getBoundingClientRect();
    inspect(x0 + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * (x1 - x0));
  };
  g.onpointermove = pointer;
  g.onpointerdown = e => { box.readTouch = e.pointerType === "touch"; pointer(e); };
  g.onkeydown = e => {
    if (!box.classList.contains("big") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? positions.length - 1 : index + (e.key === "ArrowRight" ? 1 : -1);
    inspect(positions[Math.max(0, Math.min(positions.length - 1, next))]);
  };
  inspect(relative ? 1 : now);
};
