// Local display preferences: the gateway's settings are not changed.
window.openUsageLayout = anchor => {
  closeProtoMenu();
  const box = el("div", "pop usage-layout");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", t("Layout"));
  const label = el("label", "", t("Minimum card width"));
  label.htmlFor = "usageCardWidth";
  const output = el("output");
  output.htmlFor = "usageCardWidth";
  label.append(output);
  const slider = el("input");
  slider.id = "usageCardWidth";
  slider.type = "range";
  slider.min = "280";
  slider.max = "560";
  slider.step = "20";
  const presets = el("div", "ul-presets");
  const measure = el("div", "ul-measure");
  measure.setAttribute("aria-live", "polite");
  const list = $("#subscriptionUsage");
  const update = () => {
    slider.value = usageCardMin;
    output.value = usageCardMin.toLocaleString(intlLang()) + " px";
    for (const button of presets.children) button.setAttribute("aria-pressed", String(Number(button.dataset.width) === usageCardMin));
    const card = list.querySelector(".subscription-card");
    measure.textContent = card && usagePacked ? t("Columns: {n} · Card width: {width} px", {
      n: usagePacked.n, width: Math.round(card.getBoundingClientRect().width).toLocaleString(intlLang()),
    }) : "";
  };
  let dirty = false;
  const save = () => { keep("usageCardMinWidth", usageCardMin); dirty = false; };
  slider.oninput = () => { dirty = true; setUsageCardMin(Number(slider.value)); update(); };
  slider.onchange = save;
  for (const [width, name] of [[280, "Compact"], [360, "Comfortable"], [440, "Spacious"]]) {
    const button = el("button", "ul-preset", t(name));
    button.type = "button";
    button.dataset.width = width;
    button.append(el("small", "", width + " px"));
    button.onclick = () => { setUsageCardMin(width); save(); update(); };
    presets.append(button);
  }
  box.append(label, slider, presets, measure, el("div", "ul-note", t("Cards share the available space; narrow windows use one column.")));
  update();
  document.body.append(box);
  placeMenu(box, anchor, "right");
  anchor.classList.add("open");
  anchor.setAttribute("aria-expanded", "true");
  const observer = new ResizeObserver(update);
  observer.observe(list);
  // Replacing cards on a refresh can leave the list the same size.
  const mutations = new MutationObserver(() => requestAnimationFrame(update));
  mutations.observe(list, { childList: true, attributes: true, attributeFilter: ["style"] });
  addEventListener("storage", update);
  const scroll = e => { if (scrollCloses(box, e)) closeProtoMenu(); };
  holdMenu(box, anchor, () => {}, scroll, () => {
    if (dirty) save();
    observer.disconnect();
    mutations.disconnect();
    removeEventListener("storage", update);
  });
  slider.focus(NO_SCROLL);
};
