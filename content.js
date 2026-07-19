// AutoNext — deliberately small: one progress bar, one NEXT point, one OK point.
(() => {
  if (window.__autoNextLoaded) return;
  window.__autoNextLoaded = true;

  const HOST = location.hostname || "file";
  const KEY = "autonext:" + HOST;
  const PICK_DONE_KEY = "autonext:pickDone";
  const POLL_MS = 500;
  const CLICK_COOLDOWN_MS = 3000;
  const FRAME_PATH = location.origin + location.pathname;
  const FRAME_IS_TOP = window === window.top;

  const DEFAULTS = {
    barSelector: null,
    nextPoint: null,
    okSelector: null,
    okPoint: null,
    ownerPath: null,
    ownerIsTop: null,
  };

  let cfg = null;
  let lastProgress = null;
  let progressWasComplete = false;
  let lastNextClickAt = 0;
  let okLastClickAt = 0;
  let okVisiblePrev = false;
  let okClickedForAppearance = false;
  let note = "";
  let noteUntil = 0;

  let nextMarker = null;
  let okMarker = null;
  let instruction = null;
  let badge = null;

  let picking = false;
  let pickOverlay = null;
  let pickLabel = null;
  let pickTip = null;
  let pickChain = [];
  let pickIndex = 0;
  let pickX = 0;
  let pickY = 0;

  const store = chrome.storage.local;

  function setImportant(el, name, value) {
    if (el) el.style.setProperty(name, value, "important");
  }

  function ownerMatches(value = cfg) {
    if (!value) return false;
    // Old multi-feature configurations had no owner. Re-picking the progress
    // bar upgrades them and guarantees that only one frame owns the overlays.
    if (value.ownerPath == null) return false;
    return value.ownerPath === FRAME_PATH && value.ownerIsTop === FRAME_IS_TOP;
  }

  function saveCfg(cb) {
    store.set({ [KEY]: cfg }, cb);
  }

  function loadCfg() {
    store.get(KEY, (data) => {
      cfg = data[KEY] || null;
      syncPersistentUi();
      updateBadge();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[KEY]) {
      cfg = changes[KEY].newValue || null;
      syncPersistentUi();
      updateBadge();
    }
    if (changes[PICK_DONE_KEY] && picking) stopPicking();
  });

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let selector = node.tagName.toLowerCase();
      const classes = [...node.classList]
        .filter((name) => /^[A-Za-z_-][\w-]*$/.test(name))
        .slice(0, 2);
      if (classes.length) selector += "." + classes.map((name) => CSS.escape(name)).join(".");
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(selector);
      if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
      node = parent;
    }
    return parts.join(" > ");
  }

  function markerCss(color, fill, glow) {
    return [
      "all:initial!important",
      "box-sizing:border-box!important",
      "position:fixed!important",
      "z-index:2147483647!important",
      "width:46px!important",
      "height:46px!important",
      "margin:-23px 0 0 -23px!important",
      `border:4px solid ${color}!important`,
      "border-radius:50%!important",
      `background:${fill}!important`,
      `box-shadow:0 0 0 3px #111,0 0 24px 8px ${glow}!important`,
      "display:none!important",
      "visibility:visible!important",
      "opacity:1!important",
      "cursor:grab!important",
      "pointer-events:auto!important",
      "touch-action:none!important",
      "user-select:none!important",
      "font:800 11px/38px system-ui,sans-serif!important",
      "color:#fff!important",
      "text-align:center!important",
    ].join(";");
  }

  function createMarker(target) {
    const isOk = target === "ok";
    const marker = document.createElement("div");
    marker.textContent = isOk ? "OK" : "NEXT";
    marker.style.cssText = isOk
      ? markerCss("#38bdf8", "rgba(56,189,248,.4)", "rgba(56,189,248,.9)")
      : markerCss("#ff9d00", "rgba(255,157,0,.4)", "rgba(255,157,0,.9)");
    document.documentElement.appendChild(marker);

    let dragging = false;
    marker.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      setImportant(marker, "cursor", "grabbing");
      marker.setPointerCapture(event.pointerId);
    });
    marker.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      positionMarker(marker, event.clientX, event.clientY);
    });
    marker.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      setImportant(marker, "cursor", "grab");
      saveMarkerPoint(target, event.clientX, event.clientY);
    });
    return marker;
  }

  function ensureMarkers() {
    if (!nextMarker) nextMarker = createMarker("next");
    if (!okMarker) okMarker = createMarker("ok");
  }

  function positionMarker(marker, x, y) {
    setImportant(marker, "left", x + "px");
    setImportant(marker, "top", y + "px");
  }

  function showMarker(marker, point) {
    if (!marker || !point) return;
    positionMarker(marker, point.fx * innerWidth, point.fy * innerHeight);
    setImportant(marker, "display", "block");
  }

  function hideMarker(marker) {
    setImportant(marker, "display", "none");
  }

  function withMarkersHidden(fn) {
    const nextVisible = nextMarker && nextMarker.style.getPropertyValue("display") !== "none";
    const okVisible = okMarker && okMarker.style.getPropertyValue("display") !== "none";
    hideMarker(nextMarker);
    hideMarker(okMarker);
    try {
      return fn();
    } finally {
      if (nextVisible && cfg && cfg.nextPoint && ownerMatches()) showMarker(nextMarker, cfg.nextPoint);
      if (okVisible && cfg && cfg.okPoint && ownerMatches()) showMarker(okMarker, cfg.okPoint);
    }
  }

  function ensureInstruction() {
    if (instruction) return;
    instruction = document.createElement("div");
    instruction.style.cssText = [
      "all:initial!important",
      "box-sizing:border-box!important",
      "position:fixed!important",
      "top:12px!important",
      "left:50%!important",
      "transform:translateX(-50%)!important",
      "z-index:2147483647!important",
      "background:#181824!important",
      "color:#fff!important",
      "font:600 14px/1.4 system-ui,sans-serif!important",
      "padding:10px 18px!important",
      "border:2px solid #ff9d00!important",
      "border-radius:9px!important",
      "box-shadow:0 4px 18px rgba(0,0,0,.75)!important",
      "display:none!important",
      "pointer-events:none!important",
    ].join(";");
    document.documentElement.appendChild(instruction);
  }

  function showInstruction(target) {
    ensureInstruction();
    const isOk = target === "ok";
    instruction.textContent = isOk
      ? "Drag the BLUE OK marker onto the popup button. It will stay there."
      : "Drag the ORANGE NEXT marker onto the click spot. It will stay there.";
    setImportant(instruction, "border-color", isOk ? "#38bdf8" : "#ff9d00");
    setImportant(instruction, "display", "block");
  }

  function saveMarkerPoint(target, x, y) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    cfg.ownerPath = FRAME_PATH;
    cfg.ownerIsTop = FRAME_IS_TOP;
    const point = {
      fx: Math.max(0, Math.min(1, x / innerWidth)),
      fy: Math.max(0, Math.min(1, y / innerHeight)),
    };

    if (target === "next") {
      cfg.nextPoint = point;
      delete cfg.nextSelector;
      setNote("NEXT spot saved", 2500);
    } else {
      cfg.okPoint = point;
      const under = withMarkersHidden(() => document.elementFromPoint(x, y));
      cfg.okSelector =
        under && under !== document.body && under !== document.documentElement
          ? cssPath(under)
          : null;
      okLastClickAt = Date.now();
      okVisiblePrev = false;
      okClickedForAppearance = false;
      setNote(cfg.okSelector ? "OK spot saved" : "put blue marker on the visible OK button", 3000);
    }

    saveCfg(() => {
      setImportant(instruction, "display", "none");
      syncPersistentUi();
      updateBadge();
    });
  }

  function startMarkerSetup(target) {
    if (!cfg || !ownerMatches()) return false;
    ensureMarkers();
    const marker = target === "ok" ? okMarker : nextMarker;
    const point = target === "ok" ? cfg.okPoint : cfg.nextPoint;
    showMarker(marker, point || { fx: 0.5, fy: 0.5 });
    showInstruction(target);
    return true;
  }

  function syncPersistentUi() {
    ensureMarkers();
    if (!cfg || !ownerMatches()) {
      hideMarker(nextMarker);
      hideMarker(okMarker);
      return;
    }
    if (cfg.nextPoint) showMarker(nextMarker, cfg.nextPoint);
    else hideMarker(nextMarker);
    if (cfg.okPoint) showMarker(okMarker, cfg.okPoint);
    else hideMarker(okMarker);
  }

  function parseClock(value) {
    const parts = value.split(":").map(Number);
    if (parts.some((part) => !isFinite(part))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function progressCandidates() {
    if (!cfg || !cfg.barSelector) return null;
    let bar;
    try {
      bar = document.querySelector(cfg.barSelector);
    } catch (_) {
      return null;
    }
    if (!bar) return null;
    const values = [];

    const aria = bar.matches("[aria-valuenow]") ? bar : bar.querySelector("[aria-valuenow]");
    if (aria) {
      const now = parseFloat(aria.getAttribute("aria-valuenow"));
      let max = parseFloat(aria.getAttribute("aria-valuemax"));
      if (!isFinite(max) || max <= 0) max = 100;
      if (isFinite(now)) values.push((now / max) * 100);
    }

    const progress = bar.matches("progress") ? bar : bar.querySelector("progress");
    if (progress && progress.max > 0) values.push((progress.value / progress.max) * 100);

    const time = (bar.textContent || "").match(
      /(\d{1,2}(?::\d{2}){1,2})\s*\/\s*(\d{1,2}(?::\d{2}){1,2})/
    );
    if (time) {
      const current = parseClock(time[1]);
      const total = parseClock(time[2]);
      if (current != null && total > 0) values.push((current / total) * 100);
    }

    const percent = (bar.textContent || "").match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (percent) values.push(parseFloat(percent[1]));

    const rect = bar.getBoundingClientRect();
    if (rect.width > 1) {
      let widest = 0;
      const scan = (elements) => {
        for (const child of elements) {
          const childRect = child.getBoundingClientRect();
          if (childRect.height > 0 && childRect.width <= rect.width + 1) {
            widest = Math.max(widest, childRect.width);
          }
        }
      };
      scan(bar.children);
      for (const child of bar.children) scan(child.children);
      if (widest > 0) values.push((widest / rect.width) * 100);
      const parent = bar.parentElement;
      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        if (parentRect.width > 1) values.push((rect.width / parentRect.width) * 100);
      }
    }

    const valid = values.find((value) => isFinite(value));
    return valid == null ? null : Math.max(0, Math.min(100, valid));
  }

  function fullClick(el, x, y) {
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
    };
    for (const type of ["pointerover", "pointermove", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new EventClass(type, options));
    }
    try {
      el.click();
    } catch (_) {}
  }

  function clickPoint(point) {
    if (!point) return false;
    const x = point.fx * innerWidth;
    const y = point.fy * innerHeight;
    return withMarkersHidden(() => {
      const element = document.elementFromPoint(x, y);
      if (!element) return false;
      fullClick(element, x, y);
      return true;
    });
  }

  function clickNext() {
    if (!cfg || !cfg.nextPoint) return;
    if (clickPoint(cfg.nextPoint)) {
      lastNextClickAt = Date.now();
      setNote("clicked NEXT", 3000);
    } else {
      setNote("nothing under NEXT marker", 3000);
    }
  }

  function isVisibleWithoutMarkers(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    return withMarkersHidden(() => {
      const top = document.elementFromPoint(x, y);
      return !!top && (el.contains(top) || top.contains(el));
    });
  }

  function checkOk() {
    if (!cfg || !cfg.okSelector || !cfg.okPoint) return;
    let button;
    try {
      button = document.querySelector(cfg.okSelector);
    } catch (_) {
      button = null;
    }
    const visible = !!button && isVisibleWithoutMarkers(button);
    if (!visible) {
      okVisiblePrev = false;
      okClickedForAppearance = false;
      return;
    }
    if (!okVisiblePrev) {
      okVisiblePrev = true;
      okClickedForAppearance = false;
    }
    if (okClickedForAppearance || Date.now() - okLastClickAt < 1000) return;
    okClickedForAppearance = true;
    okLastClickAt = Date.now();
    if (clickPoint(cfg.okPoint)) setNote("clicked OK", 2500);
  }

  function tick() {
    if (!cfg || !ownerMatches()) return;
    checkOk();
    const progress = progressCandidates();
    lastProgress = progress;
    const complete = progress != null && Math.round(progress) >= 100;
    if (
      complete &&
      !progressWasComplete &&
      cfg.nextPoint &&
      Date.now() - lastNextClickAt > CLICK_COOLDOWN_MS
    ) {
      clickNext();
    }
    progressWasComplete = complete;
    updateBadge();
  }

  function ensureBadge() {
    if (badge) return;
    badge = document.createElement("div");
    badge.style.cssText = [
      "all:initial!important",
      "box-sizing:border-box!important",
      "position:fixed!important",
      "right:10px!important",
      "bottom:10px!important",
      "z-index:2147483645!important",
      "background:rgba(76,29,231,.9)!important",
      "color:#fff!important",
      "font:12px/1.4 system-ui,sans-serif!important",
      "padding:6px 11px!important",
      "border-radius:999px!important",
      "box-shadow:0 2px 9px rgba(0,0,0,.5)!important",
      "display:none!important",
      "pointer-events:none!important",
      "white-space:nowrap!important",
    ].join(";");
    document.documentElement.appendChild(badge);
  }

  function setNote(text, duration) {
    note = text;
    noteUntil = Date.now() + duration;
    updateBadge();
  }

  function updateBadge() {
    ensureBadge();
    if (!cfg || !ownerMatches() || (!cfg.barSelector && !cfg.nextPoint && !cfg.okPoint)) {
      setImportant(badge, "display", "none");
      return;
    }
    const progress = lastProgress == null ? "—" : Math.round(lastProgress) + "%";
    const currentNote = Date.now() < noteUntil ? " · " + note : "";
    badge.textContent = "AutoNext " + progress + currentNote;
    setImportant(badge, "display", "block");
  }

  function ensurePickerUi() {
    if (pickOverlay) return;
    pickOverlay = document.createElement("div");
    pickOverlay.style.cssText =
      "all:initial!important;box-sizing:border-box!important;position:fixed!important;z-index:2147483646!important;pointer-events:none!important;border:3px solid #7c4dff!important;background:rgba(124,77,255,.25)!important;box-shadow:0 0 18px rgba(124,77,255,.9)!important;border-radius:4px!important;display:none!important";
    pickLabel = document.createElement("div");
    pickLabel.style.cssText =
      "all:initial!important;box-sizing:border-box!important;position:fixed!important;top:12px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;background:#181824!important;color:#fff!important;font:600 14px/1.4 system-ui,sans-serif!important;padding:10px 18px!important;border:2px solid #7c4dff!important;border-radius:9px!important;box-shadow:0 4px 18px rgba(0,0,0,.75)!important;display:none!important;pointer-events:none!important";
    pickTip = document.createElement("div");
    pickTip.style.cssText =
      "all:initial!important;box-sizing:border-box!important;position:fixed!important;z-index:2147483647!important;background:#111120!important;color:#c4b5fd!important;font:12px/1.4 ui-monospace,Consolas,monospace!important;padding:4px 9px!important;border:1px solid #7c4dff!important;border-radius:6px!important;display:none!important;pointer-events:none!important;white-space:nowrap!important";
    document.documentElement.appendChild(pickOverlay);
    document.documentElement.appendChild(pickLabel);
    document.documentElement.appendChild(pickTip);
  }

  function isOurUi(el) {
    return (
      el === pickOverlay ||
      el === pickLabel ||
      el === pickTip ||
      el === nextMarker ||
      el === okMarker ||
      el === instruction ||
      el === badge
    );
  }

  function rebuildPickChain() {
    pickChain = (document.elementsFromPoint(pickX, pickY) || []).filter(
      (el) => !isOurUi(el) && el !== document.documentElement && el !== document.body
    );
    pickIndex = Math.max(0, Math.min(pickIndex, pickChain.length - 1));
  }

  function updatePickerUi() {
    const el = pickChain[pickIndex];
    if (!el) {
      setImportant(pickOverlay, "display", "none");
      setImportant(pickTip, "display", "none");
      return;
    }
    const rect = el.getBoundingClientRect();
    setImportant(pickOverlay, "left", rect.left - 2 + "px");
    setImportant(pickOverlay, "top", rect.top - 2 + "px");
    setImportant(pickOverlay, "width", rect.width + "px");
    setImportant(pickOverlay, "height", rect.height + "px");
    setImportant(pickOverlay, "display", "block");
    pickLabel.textContent = "Click the BLUE PROGRESS BAR · scroll to cycle nested elements · Esc cancels";
    setImportant(pickLabel, "display", "block");
    pickTip.textContent =
      el.tagName.toLowerCase() +
      (el.id ? "#" + el.id : "") +
      `  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    setImportant(pickTip, "left", Math.max(4, Math.min(pickX + 14, innerWidth - 230)) + "px");
    setImportant(pickTip, "top", Math.max(4, Math.min(pickY + 18, innerHeight - 30)) + "px");
    setImportant(pickTip, "display", "block");
  }

  function eat(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPickMove(event) {
    pickX = event.clientX;
    pickY = event.clientY;
    pickIndex = 0;
    rebuildPickChain();
    updatePickerUi();
  }

  function onPickWheel(event) {
    eat(event);
    pickIndex += event.deltaY > 0 ? 1 : -1;
    pickIndex = Math.max(0, Math.min(pickIndex, pickChain.length - 1));
    updatePickerUi();
  }

  function onPickUp(event) {
    eat(event);
    const el = pickChain[pickIndex];
    if (!el || isOurUi(el)) return;
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    cfg.barSelector = cssPath(el);
    cfg.ownerPath = FRAME_PATH;
    cfg.ownerIsTop = FRAME_IS_TOP;
    lastProgress = null;
    progressWasComplete = false;
    stopPicking();
    saveCfg(() => store.set({ [PICK_DONE_KEY]: Date.now() }));
    setNote("progress bar saved", 2500);
  }

  function onPickKey(event) {
    if (event.key === "Escape") {
      eat(event);
      stopPicking();
    }
  }

  function startPicking() {
    stopPicking();
    ensurePickerUi();
    picking = true;
    pickChain = [];
    pickIndex = 0;
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("mousedown", eat, true);
    document.addEventListener("mouseup", onPickUp, true);
    document.addEventListener("click", eat, true);
    document.addEventListener("wheel", onPickWheel, { capture: true, passive: false });
    document.addEventListener("keydown", onPickKey, true);
    document.documentElement.style.setProperty("cursor", "crosshair", "important");
  }

  function stopPicking() {
    picking = false;
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("mousedown", eat, true);
    document.removeEventListener("mouseup", onPickUp, true);
    document.removeEventListener("click", eat, true);
    document.removeEventListener("wheel", onPickWheel, { capture: true });
    document.removeEventListener("keydown", onPickKey, true);
    document.documentElement.style.removeProperty("cursor");
    setImportant(pickOverlay, "display", "none");
    setImportant(pickLabel, "display", "none");
    setImportant(pickTip, "display", "none");
  }

  function status() {
    const owns = ownerMatches();
    let barFound = false;
    if (owns && cfg && cfg.barSelector) {
      try {
        barFound = !!document.querySelector(cfg.barSelector);
      } catch (_) {}
    }
    return {
      ok: true,
      owner: owns,
      host: HOST,
      hasBar: !!(owns && cfg && cfg.barSelector),
      barFound,
      hasNext: !!(owns && cfg && cfg.nextPoint),
      hasOk: !!(owns && cfg && cfg.okPoint && cfg.okSelector),
      progress: owns ? lastProgress : null,
    };
  }

  function delayedResponse(sendResponse, value) {
    setTimeout(() => {
      try {
        sendResponse(value);
      } catch (_) {}
    }, 200);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message && message.type) {
      case "pickBar":
        startPicking();
        sendResponse({ ok: true });
        break;
      case "setMarker":
        if (cfg && ownerMatches()) {
          sendResponse({ ok: startMarkerSetup(message.target) });
        } else {
          return delayedResponse(sendResponse, { ok: false, needBar: true });
        }
        break;
      case "getStatus": {
        const current = status();
        if (current.owner) sendResponse(current);
        else return delayedResponse(sendResponse, current);
        break;
      }
      case "clear":
        if (cfg && ownerMatches()) {
          store.remove(KEY);
          cfg = null;
          lastProgress = null;
          progressWasComplete = false;
          hideMarker(nextMarker);
          hideMarker(okMarker);
          setImportant(badge, "display", "none");
          sendResponse({ ok: true });
        } else {
          return delayedResponse(sendResponse, { ok: false });
        }
        break;
    }
  });

  setInterval(tick, POLL_MS);
  loadCfg();
})();
