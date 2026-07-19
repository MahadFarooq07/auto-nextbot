// AutoNext content script.
// Runs in every frame (course players usually live inside an iframe).
// Config is stored per-hostname of the frame where the elements were picked.
//
// Two trigger modes:
//   "bar"   — measure a picked progress bar; fire when it reaches threshold.
//   "state" — watch a picked play/pause button; fire when its appearance
//             changes (pause icon flips back to play when the video ends).
//
// NEXT target is stored as BOTH a css selector and an exact viewport point,
// so it can be mapped anywhere on the page and adjusted with a drag marker.
(() => {
  if (window.__autoNextLoaded) return;
  window.__autoNextLoaded = true;

  const HOST = location.hostname || "file";
  const KEY = "autonext:" + HOST;
  const PICK_DONE_KEY = "autonext:pickDone"; // global signal so other frames exit pick mode
  const POLL_MS = 500;
  const CLICK_COOLDOWN_MS = 4000;
  // A state change must persist this many polls before firing (filters
  // hover/animation flickers on the play button).
  const STATE_STREAK = 2;
  // The previous appearance must have held at least this long before a change
  // counts as "the video ended" — so the flip right after clicking NEXT (new
  // slide starts playing) never re-triggers.
  const STATE_STABLE_MS = 5000;

  const DEFAULTS = {
    mode: "bar", // "bar" | "state"
    barSelector: null,
    stateSelector: null,
    nextSelector: null,
    nextPoint: null, // { fx, fy } as fractions of the viewport
    enabled: true,
    threshold: 99,
  };

  let cfg = null;
  let picking = null; // "bar" | "state" | "next" | null
  let overlay = null;
  let label = null;
  let badge = null;
  let tip = null;
  let marker = null;
  let adjusting = false;
  let dragging = false;
  let lastClickAt = 0;
  let lastProgress = null;
  let statusNote = "";
  let noteUntil = 0;
  // Bar mode: a candidate may only trigger after it has been seen LOW first.
  let seen = {};
  // State mode: current signature of the watched element, when it started
  // holding, and a pending (possibly new) signature being confirmed.
  let stateSig = null;
  let stateSigSince = 0;
  let statePend = null;
  let statePendN = 0;

  const store = chrome.storage.local;

  /* ---------------- config ---------------- */

  function loadCfg(cb) {
    store.get(KEY, (o) => {
      cfg = o[KEY] || null;
      cb && cb();
    });
  }

  function saveCfg(cb) {
    store.set({ [KEY]: cfg }, cb);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[KEY]) {
      cfg = changes[KEY].newValue || null;
      updateBadge();
    }
    // Another frame finished picking -> everyone leaves pick mode.
    if (changes[PICK_DONE_KEY] && picking) stopPicking();
  });

  /* ---------------- selector generation ---------------- */

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let sel = node.tagName.toLowerCase();
      const classes = [...node.classList]
        .filter((c) => /^[A-Za-z_-][\w-]*$/.test(c))
        .slice(0, 2);
      if (classes.length) sel += "." + classes.map((c) => CSS.escape(c)).join(".");
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((s) => s.tagName === node.tagName);
        if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /* ---------------- state signature (play/pause watching) ---------------- */

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
  }

  // Fingerprint of how the element currently looks. When the player flips the
  // pause icon back to play (video ended), class names / aria labels / the
  // inner SVG change and the signature changes with them.
  function stateSignature(el) {
    return JSON.stringify([
      el.getAttribute("class") || "",
      el.getAttribute("aria-label") || "",
      el.getAttribute("aria-pressed") || "",
      el.getAttribute("title") || "",
      el.getAttribute("data-state") || "",
      hashStr(el.innerHTML || ""),
    ]);
  }

  /* ---------------- progress measurement (bar mode) ---------------- */

  const clamp = (v) => Math.max(0, Math.min(100, v));

  function parseClock(str) {
    const p = str.split(":").map(Number);
    if (p.some((n) => !isFinite(n))) return null;
    return p.reduce((a, v) => a * 60 + v, 0);
  }

  // Returns several independent estimates of "how full is the bar", or null if
  // the bar element is missing. Keys: aria, progress, time, pct, child, self.
  function candidates() {
    if (!cfg || !cfg.barSelector) return null;
    const bar = document.querySelector(cfg.barSelector);
    if (!bar) return null;
    const out = {};

    const ariaEl = bar.matches("[aria-valuenow]") ? bar : bar.querySelector("[aria-valuenow]");
    if (ariaEl) {
      const now = parseFloat(ariaEl.getAttribute("aria-valuenow"));
      let max = parseFloat(ariaEl.getAttribute("aria-valuemax"));
      if (!isFinite(max) || max <= 0) max = 100;
      if (isFinite(now)) out.aria = clamp((now / max) * 100);
    }

    const progEl = bar.matches("progress") ? bar : bar.querySelector("progress");
    if (progEl && progEl.max > 0) out.progress = clamp((progEl.value / progEl.max) * 100);

    // Time text like "5:31 / 8:37" anywhere inside the picked element.
    const text = bar.textContent || "";
    const tm = text.match(/(\d{1,2}(?::\d{2}){1,2})\s*\/\s*(\d{1,2}(?::\d{2}){1,2})/);
    if (tm) {
      const cur = parseClock(tm[1]);
      const tot = parseClock(tm[2]);
      if (cur != null && tot > 0) out.time = clamp((cur / tot) * 100);
    }

    // Percent text like "87%".
    const pm = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (pm) out.pct = clamp(parseFloat(pm[1]));

    const rect = bar.getBoundingClientRect();

    // User picked the track: measure the widest child / grandchild (the fill).
    if (rect.width > 1) {
      let widest = 0;
      const scan = (els) => {
        for (const c of els) {
          const cr = c.getBoundingClientRect();
          if (cr.height > 0 && cr.width <= rect.width + 1) widest = Math.max(widest, cr.width);
        }
      };
      scan(bar.children);
      for (const c of bar.children) scan(c.children);
      if (widest > 0) out.child = clamp((widest / rect.width) * 100);
    }

    // User picked the fill itself: measure it against its parent.
    const parent = bar.parentElement;
    if (parent) {
      const pr = parent.getBoundingClientRect();
      if (pr.width > 1) out.self = clamp((rect.width / pr.width) * 100);
    }

    return out;
  }

  /* ---------------- clicking ---------------- */

  function fullClick(el, x, y) {
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
    };
    for (const type of ["pointerover", "pointermove", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, opts));
    }
    try {
      el.click();
    } catch (e) {}
  }

  function robustClick(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (e) {}
    const r = el.getBoundingClientRect();
    fullClick(el, r.left + r.width / 2, r.top + r.height / 2);
  }

  // Click at the mapped viewport point, whatever element lives there now.
  function clickAtPoint(fx, fy) {
    const x = fx * innerWidth;
    const y = fy * innerHeight;
    const markerWasVisible = marker && marker.style.display !== "none";
    if (markerWasVisible) marker.style.display = "none";
    const el = document.elementFromPoint(x, y);
    if (markerWasVisible) marker.style.display = "block";
    if (!el || el === document.body || el === document.documentElement) return false;
    fullClick(el, x, y);
    return true;
  }

  function fireNext() {
    let ok = false;
    // The point is exactly where the user placed the marker — prefer it.
    if (cfg.nextPoint) ok = clickAtPoint(cfg.nextPoint.fx, cfg.nextPoint.fy);
    if (!ok && cfg.nextSelector) {
      const btn = document.querySelector(cfg.nextSelector);
      if (btn) {
        robustClick(btn);
        ok = true;
      }
    }
    if (ok) {
      lastClickAt = Date.now();
      seen = {};
      statePend = null;
      statePendN = 0;
      setNote("clicked NEXT ✓", 3000);
    } else {
      setNote("next target not found", 3000);
    }
  }

  /* ---------------- main poll loop ---------------- */

  function tick() {
    if (!cfg) return;
    const hasNext = !!(cfg.nextSelector || cfg.nextPoint);
    const hasTrigger = cfg.mode === "state" ? !!cfg.stateSelector : !!cfg.barSelector;
    if (!hasNext || !hasTrigger) return;
    if (!cfg.enabled) {
      updateBadge();
      return;
    }

    let shouldFire = false;

    if (cfg.mode === "state") {
      const el = document.querySelector(cfg.stateSelector);
      if (!el) {
        setNote("play/pause button not found", 2000);
        updateBadge();
        return;
      }
      const sig = stateSignature(el);
      const now = Date.now();
      if (stateSig === null) {
        stateSig = sig;
        stateSigSince = now;
      } else if (sig === stateSig) {
        // Element looks the same as before — clear any half-confirmed change.
        statePend = null;
        statePendN = 0;
      } else {
        // Appearance changed; confirm it over STATE_STREAK polls first.
        if (statePend === sig) statePendN++;
        else {
          statePend = sig;
          statePendN = 1;
        }
        if (statePendN >= STATE_STREAK) {
          // Only a change away from a LONG-held state means "the video
          // ended" — brief states (right after our own NEXT click, or icon
          // flickers) are just adopted as the new current state.
          const longHeld = now - stateSigSince >= STATE_STABLE_MS;
          if (longHeld && now - lastClickAt <= CLICK_COOLDOWN_MS) {
            // Still in click cooldown: hold off adopting the new state so the
            // trigger isn't lost — retried next tick.
          } else {
            if (longHeld) shouldFire = true;
            stateSig = sig;
            stateSigSince = now - statePendN * POLL_MS;
            statePend = null;
            statePendN = 0;
          }
        }
      }
      lastProgress = null;
    } else {
      const cands = candidates();
      if (!cands) {
        setNote("bar not found", 2000);
        updateBadge();
        return;
      }

      const th = cfg.threshold ?? 99;
      const low = Math.min(th - 10, 90);
      const order = ["aria", "progress", "time", "pct", "child", "self"];

      let display = null;
      for (const k of order) {
        const v = cands[k];
        if (v == null) continue;
        if (display == null) display = v;
        if (v < low) seen[k] = true;
        if (seen[k] && v >= th) shouldFire = true;
      }
      // Prefer displaying a candidate that has actually moved.
      for (const k of order) {
        if (cands[k] != null && seen[k]) {
          display = cands[k];
          break;
        }
      }
      lastProgress = display;
    }

    if (shouldFire && Date.now() - lastClickAt > CLICK_COOLDOWN_MS) fireNext();
    updateBadge();
  }

  setInterval(tick, POLL_MS);

  /* ---------------- badge ---------------- */

  function ensureBadge() {
    if (badge || !document.body) return;
    badge = document.createElement("div");
    badge.style.cssText = [
      "position:fixed",
      "right:10px",
      "bottom:10px",
      "z-index:2147483647",
      "background:rgba(20,20,30,.85)",
      "color:#fff",
      "font:12px/1.4 system-ui,sans-serif",
      "padding:5px 10px",
      "border-radius:999px",
      "pointer-events:none",
      "box-shadow:0 2px 8px rgba(0,0,0,.4)",
      "display:none",
      "white-space:nowrap",
    ].join(";");
    document.body.appendChild(badge);
  }

  function setNote(text, ms) {
    statusNote = text;
    noteUntil = Date.now() + ms;
  }

  function updateBadge() {
    ensureBadge();
    if (!badge) return;
    const hasNext = !!(cfg && (cfg.nextSelector || cfg.nextPoint));
    const hasTrigger =
      !!cfg && (cfg.mode === "state" ? !!cfg.stateSelector : !!cfg.barSelector);
    if (!hasNext || !hasTrigger) {
      badge.style.display = "none";
      return;
    }
    badge.style.display = "block";
    const note = Date.now() < noteUntil ? " · " + statusNote : "";
    if (!cfg.enabled) {
      badge.textContent = "AutoNext ⏸ paused" + note;
      badge.style.background = "rgba(90,90,90,.85)";
    } else if (cfg.mode === "state") {
      const armed = stateSig !== null && Date.now() - stateSigSince >= STATE_STABLE_MS;
      badge.textContent =
        "AutoNext 👁 " + (armed ? "watching play/pause" : "learning button state…") + note;
      badge.style.background =
        note.includes("✓") ? "rgba(30,130,60,.9)" : "rgba(76,29,231,.88)";
    } else {
      const pct = lastProgress == null ? "—" : Math.round(lastProgress) + "%";
      badge.textContent = "AutoNext ▶ " + pct + note;
      badge.style.background =
        note.includes("✓") ? "rgba(30,130,60,.9)" : "rgba(76,29,231,.88)";
    }
  }

  /* ---------------- element picker ---------------- */

  function isOurs(el) {
    return el === overlay || el === label || el === badge || el === tip || el === marker;
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "z-index:2147483646",
      "pointer-events:none",
      "border:2px solid #4c1de7",
      "background:rgba(76,29,231,.18)",
      "border-radius:3px",
      "display:none",
      "transition:all .04s linear",
    ].join(";");
    label = document.createElement("div");
    label.style.cssText = [
      "position:fixed",
      "top:12px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "background:#1b1b2b",
      "color:#fff",
      "font:13px/1.4 system-ui,sans-serif",
      "padding:8px 16px",
      "border-radius:8px",
      "pointer-events:none",
      "box-shadow:0 4px 14px rgba(0,0,0,.5)",
      "display:none",
      "text-align:center",
      "max-width:80vw",
    ].join(";");
    tip = document.createElement("div");
    tip.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "background:#111120",
      "color:#a5b4fc",
      "font:11px/1.4 ui-monospace,Consolas,monospace",
      "padding:3px 8px",
      "border-radius:6px",
      "pointer-events:none",
      "box-shadow:0 2px 8px rgba(0,0,0,.5)",
      "display:none",
      "white-space:nowrap",
    ].join(";");
    document.body.appendChild(overlay);
    document.body.appendChild(label);
    document.body.appendChild(tip);
  }

  function descriptor(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = [...(el.classList || [])].slice(0, 2).join(".");
    if (cls) s += "." + cls;
    const r = el.getBoundingClientRect();
    return s + "  " + Math.round(r.width) + "×" + Math.round(r.height);
  }

  function highlight(el) {
    if (!el || isOurs(el)) {
      overlay.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = r.left - 2 + "px";
    overlay.style.top = r.top - 2 + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
  }

  // Depth-cycling picker state: all elements stacked under the cursor
  // (topmost first) — the scroll wheel cycles through them so nested /
  // covered elements can be selected exactly.
  let pickX = 0;
  let pickY = 0;
  let pickChain = [];
  let pickIdx = 0;

  function rebuildChain() {
    const stack = (document.elementsFromPoint(pickX, pickY) || []).filter(
      (el) => !isOurs(el) && el !== document.documentElement && el !== document.body
    );
    pickChain = stack;
    if (pickIdx >= pickChain.length) pickIdx = pickChain.length - 1;
    if (pickIdx < 0) pickIdx = 0;
  }

  function updatePickUI() {
    const el = pickChain[pickIdx];
    highlight(el);
    if (!el) {
      tip.style.display = "none";
      return;
    }
    tip.style.display = "block";
    tip.textContent =
      descriptor(el) +
      (pickChain.length > 1 ? `   [${pickIdx + 1}/${pickChain.length} — scroll to cycle]` : "");
    const tx = Math.min(pickX + 14, innerWidth - tip.offsetWidth - 8);
    const ty = Math.min(pickY + 18, innerHeight - tip.offsetHeight - 8);
    tip.style.left = Math.max(4, tx) + "px";
    tip.style.top = Math.max(4, ty) + "px";
  }

  function eat(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onPickMove(e) {
    pickX = e.clientX;
    pickY = e.clientY;
    rebuildChain();
    updatePickUI();
  }

  function onPickWheel(e) {
    eat(e);
    pickIdx += e.deltaY > 0 ? 1 : -1;
    pickIdx = Math.max(0, Math.min(pickChain.length - 1, pickIdx));
    updatePickUI();
  }

  function onPickUp(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = pickChain[pickIdx];
    if (!el || isOurs(el)) return;
    const sel = cssPath(el);
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    if (picking === "bar") {
      cfg.barSelector = sel;
      cfg.mode = "bar";
    } else if (picking === "state") {
      cfg.stateSelector = sel;
      cfg.mode = "state";
      stateSig = null;
      stateSigSince = 0;
      statePend = null;
      statePendN = 0;
    } else {
      cfg.nextSelector = sel;
      cfg.nextPoint = { fx: e.clientX / innerWidth, fy: e.clientY / innerHeight };
    }
    cfg.enabled = true;
    seen = {};
    lastProgress = null;
    stopPicking();
    saveCfg(() => store.set({ [PICK_DONE_KEY]: Date.now() }));
    setNote("saved", 2000);
    updateBadge();
    flash(el.getBoundingClientRect());
  }

  function onPickKey(e) {
    if (e.key === "Escape") {
      eat(e);
      stopPicking();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      eat(e);
      pickIdx += e.key === "ArrowDown" ? 1 : -1;
      pickIdx = Math.max(0, Math.min(pickChain.length - 1, pickIdx));
      updatePickUI();
    }
  }

  function flash(r) {
    const f = document.createElement("div");
    f.style.cssText = `position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 2}px;height:${r.height + 2}px;border:3px solid #22c55e;border-radius:4px;z-index:2147483647;pointer-events:none;transition:opacity .6s`;
    document.body.appendChild(f);
    setTimeout(() => (f.style.opacity = "0"), 500);
    setTimeout(() => f.remove(), 1200);
  }

  const PICK_LABELS = {
    bar: "Hover the PROGRESS BAR — scroll wheel cycles overlapping/nested elements",
    state: "Hover the PLAY/PAUSE button — scroll wheel cycles overlapping/nested elements",
    next: "Hover the NEXT button (or any spot to click) — scroll cycles elements",
  };

  function startPicking(target) {
    stopPicking();
    stopAdjust();
    ensureOverlay();
    picking = target;
    pickChain = [];
    pickIdx = 0;
    label.textContent = PICK_LABELS[target] + "  ·  click to select  ·  Esc cancels";
    label.style.display = "block";
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("mousedown", eat, true);
    document.addEventListener("mouseup", onPickUp, true);
    document.addEventListener("click", eat, true);
    document.addEventListener("keydown", onPickKey, true);
    document.addEventListener("wheel", onPickWheel, { capture: true, passive: false });
    document.documentElement.style.cursor = "crosshair";
    // Safety: auto-cancel after 60s.
    setTimeout(() => picking === target && stopPicking(), 60000);
  }

  function stopPicking() {
    picking = null;
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("mousedown", eat, true);
    document.removeEventListener("mouseup", onPickUp, true);
    document.removeEventListener("click", eat, true);
    document.removeEventListener("keydown", onPickKey, true);
    document.removeEventListener("wheel", onPickWheel, { capture: true });
    document.documentElement.style.cursor = "";
    if (overlay) overlay.style.display = "none";
    if (label) label.style.display = "none";
    if (tip) tip.style.display = "none";
  }

  /* ---------------- draggable NEXT marker ---------------- */

  function ensureMarker() {
    if (marker) return;
    marker = document.createElement("div");
    marker.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "width:34px",
      "height:34px",
      "margin:-17px 0 0 -17px",
      "border:3px solid #f59e0b",
      "border-radius:50%",
      "background:rgba(245,158,11,.25)",
      "box-shadow:0 0 0 2px rgba(0,0,0,.4),0 2px 10px rgba(0,0,0,.5)",
      "cursor:grab",
      "display:none",
      "touch-action:none",
    ].join(";");
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;background:#f59e0b;border-radius:50%;pointer-events:none";
    marker.appendChild(dot);
    document.body.appendChild(marker);

    marker.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      marker.style.cursor = "grabbing";
      marker.setPointerCapture(e.pointerId);
    });
    marker.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      setMarkerPos(e.clientX, e.clientY);
    });
    marker.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      marker.style.cursor = "grab";
      cfg = Object.assign({}, DEFAULTS, cfg || {});
      cfg.nextPoint = {
        fx: Math.max(0, Math.min(1, e.clientX / innerWidth)),
        fy: Math.max(0, Math.min(1, e.clientY / innerHeight)),
      };
      saveCfg(() => store.set({ [PICK_DONE_KEY]: Date.now() }));
      setNote("NEXT spot saved", 2000);
      updateBadge();
      flash({ left: e.clientX - 17, top: e.clientY - 17, width: 32, height: 32 });
    });
  }

  function setMarkerPos(x, y) {
    marker.style.left = x + "px";
    marker.style.top = y + "px";
  }

  function onAdjustKey(e) {
    if (e.key === "Escape") {
      eat(e);
      stopAdjust();
    }
  }

  function startAdjust() {
    stopPicking();
    ensureOverlay();
    ensureMarker();
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    // Seed the marker from the selector's position if no point exists yet.
    if (!cfg.nextPoint && cfg.nextSelector) {
      const btn = document.querySelector(cfg.nextSelector);
      if (btn) {
        const r = btn.getBoundingClientRect();
        cfg.nextPoint = {
          fx: (r.left + r.width / 2) / innerWidth,
          fy: (r.top + r.height / 2) / innerHeight,
        };
      }
    }
    if (!cfg.nextPoint) cfg.nextPoint = { fx: 0.5, fy: 0.5 };
    adjusting = true;
    marker.style.display = "block";
    setMarkerPos(cfg.nextPoint.fx * innerWidth, cfg.nextPoint.fy * innerHeight);
    label.textContent =
      "Drag the orange marker onto the NEXT button — release to save  ·  Esc closes";
    label.style.display = "block";
    document.addEventListener("keydown", onAdjustKey, true);
    // Safety: auto-close after 60s.
    setTimeout(() => adjusting && stopAdjust(), 60000);
  }

  function stopAdjust() {
    adjusting = false;
    dragging = false;
    document.removeEventListener("keydown", onAdjustKey, true);
    if (marker) marker.style.display = "none";
    if (label && !picking) label.style.display = "none";
  }

  /* ---------------- popup messaging ---------------- */

  function buildStatus() {
    const hasBar = !!(cfg && cfg.barSelector);
    const hasState = !!(cfg && cfg.stateSelector);
    const hasNextSel = !!(cfg && cfg.nextSelector);
    const hasPoint = !!(cfg && cfg.nextPoint);
    return {
      host: HOST,
      hasCfg: !!cfg,
      mode: (cfg && cfg.mode) || "bar",
      hasBar,
      hasState,
      hasNext: hasNextSel || hasPoint,
      hasPoint,
      barFound: hasBar ? !!document.querySelector(cfg.barSelector) : false,
      stateFound: hasState ? !!document.querySelector(cfg.stateSelector) : false,
      nextFound: hasPoint || (hasNextSel && !!document.querySelector(cfg.nextSelector)),
      stateArmed: stateSig !== null && Date.now() - stateSigSince >= STATE_STABLE_MS,
      enabled: !!(cfg && cfg.enabled),
      threshold: cfg ? cfg.threshold ?? 99 : 99,
      progress: lastProgress,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "pick":
        startPicking(msg.target);
        sendResponse({ ok: true });
        break;
      case "adjustNext":
        // Only the frame that owns config shows the marker (top frame as a
        // fallback when nothing has been picked yet) — otherwise every iframe
        // would pop its own marker.
        if (cfg || window === window.top) startAdjust();
        sendResponse({ ok: true });
        break;
      case "cancelPick":
        stopPicking();
        stopAdjust();
        sendResponse({ ok: true });
        break;
      case "getStatus": {
        const s = buildStatus();
        // Frames WITH config answer immediately so they win the race; frames
        // without config answer late as a fallback.
        if (cfg) {
          sendResponse(s);
        } else {
          setTimeout(() => {
            try {
              sendResponse(s);
            } catch (e) {}
          }, 200);
          return true;
        }
        break;
      }
      case "setEnabled":
        if (cfg) {
          cfg.enabled = !!msg.enabled;
          saveCfg();
          updateBadge();
        }
        sendResponse({ ok: true });
        break;
      case "setThreshold":
        if (cfg) {
          const t = Number(msg.threshold);
          if (isFinite(t) && t >= 50 && t <= 100) {
            cfg.threshold = t;
            saveCfg();
          }
        }
        sendResponse({ ok: true });
        break;
      case "clear":
        store.remove(KEY);
        cfg = null;
        seen = {};
        stateSig = null;
        stateSigSince = 0;
        statePend = null;
        statePendN = 0;
        lastProgress = null;
        stopAdjust();
        updateBadge();
        sendResponse({ ok: true });
        break;
    }
  });

  loadCfg(updateBadge);
})();
