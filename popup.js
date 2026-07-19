let tabId = null;

function send(msg) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        // Swallow "no receiving end" errors (e.g. chrome:// pages).
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function setMark(id, ok, found) {
  const el = document.getElementById(id);
  if (ok) {
    el.className = "check";
    el.textContent = found ? "✓" : "✓ (not on page)";
  } else {
    el.className = "miss";
    el.textContent = "not set";
  }
}

async function refresh() {
  const s = await send({ type: "getStatus" });
  const status = document.getElementById("status");
  if (!s) {
    document.getElementById("host").textContent = "";
    status.textContent =
      "Can't reach this page. Open the course page (not a chrome:// tab) and reload it once after installing.";
    return;
  }
  document.getElementById("host").textContent = "Site: " + s.host;
  setMark("barMark", s.hasBar, s.barFound);
  setMark("stateMark", s.hasState, s.stateFound);
  setMark("nextMark", s.hasNext, s.nextFound);
  const setOpt = (id, on) => {
    const el = document.getElementById(id);
    el.className = on ? "check" : "opt";
    el.textContent = on ? "✓" : "optional";
  };
  setOpt("okMark", s.hasOk);
  setOpt("answerMark", s.hasAnswer);
  setOpt("submitMark", s.hasSubmit);
  setOpt("dropdownMark", s.hasDropdown);
  document.getElementById("stall").checked = !!s.stallRescue;

  // Highlight which trigger mode is active.
  document.getElementById("pickBar").classList.toggle("active", s.hasCfg && s.mode === "bar");
  document.getElementById("pickState").classList.toggle("active", s.hasCfg && s.mode === "state");
  // Threshold only matters in bar mode.
  document.getElementById("thresholdRow").style.display = s.mode === "state" ? "none" : "";

  document.getElementById("enabled").checked = s.enabled;
  if (document.activeElement !== document.getElementById("threshold")) {
    document.getElementById("threshold").value = s.threshold;
  }

  const hasTrigger = s.mode === "state" ? s.hasState : s.hasBar;
  const fill = document.getElementById("progressFill");
  if (!hasTrigger || !s.hasNext) {
    status.textContent = "Pick a trigger and the NEXT spot to arm auto-click.";
    fill.style.width = "0";
  } else if (!s.enabled) {
    status.textContent = "Paused. Flip the switch to resume.";
    fill.style.width = "0";
  } else if (s.mode === "state") {
    status.textContent = s.stateArmed
      ? "Armed. Watching the play/pause button — clicks NEXT when it changes."
      : "Learning the button's current state… (armed after ~5s)";
    fill.style.width = s.stateArmed ? "100%" : "0";
  } else if (s.progress == null) {
    status.textContent = "Armed. Waiting for the progress bar to move…";
    fill.style.width = "0";
  } else {
    status.textContent =
      "Armed. Progress: " + Math.round(s.progress) + "% — clicks NEXT at " + s.threshold + "%.";
    fill.style.width = s.progress + "%";
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;

  const pick = (target) => async () => {
    await send({ type: "pick", target });
    window.close();
  };
  document.getElementById("pickBar").addEventListener("click", pick("bar"));
  document.getElementById("pickState").addEventListener("click", pick("state"));
  document.getElementById("pickNext").addEventListener("click", pick("next"));
  document.getElementById("pickOk").addEventListener("click", pick("ok"));
  document.getElementById("pickAnswer").addEventListener("click", pick("answer"));
  document.getElementById("pickSubmit").addEventListener("click", pick("submit"));
  document.getElementById("pickDropdown").addEventListener("click", pick("dropdown"));
  document.getElementById("stall").addEventListener("change", (e) => {
    send({ type: "setStallRescue", on: e.target.checked });
  });
  document.getElementById("adjustNext").addEventListener("click", async () => {
    await send({ type: "adjustNext" });
    window.close();
  });
  document.getElementById("enabled").addEventListener("change", (e) => {
    send({ type: "setEnabled", enabled: e.target.checked });
  });
  document.getElementById("threshold").addEventListener("change", (e) => {
    send({ type: "setThreshold", threshold: Number(e.target.value) });
  });
  document.getElementById("clear").addEventListener("click", async () => {
    await send({ type: "clear" });
    refresh();
  });

  refresh();
  setInterval(refresh, 700);
}

init();
