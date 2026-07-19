let tabId = null;

function send(message) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
}

function setMark(id, set, missingText = "not set") {
  const el = document.getElementById(id);
  el.textContent = set ? "✓ set" : missingText;
  el.className = set ? "mark set" : "mark";
}

async function refresh() {
  const state = await send({ type: "getStatus" });
  const status = document.getElementById("status");
  if (!state || !state.owner) {
    document.getElementById("host").textContent = "Course frame not connected";
    status.textContent = "Set the progress bar first. Reload the course page once if the picker does not appear.";
    setMark("barMark", false);
    setMark("nextMark", false);
    setMark("okMark", false, "optional");
    return;
  }

  document.getElementById("host").textContent = "Site: " + state.host;
  setMark("barMark", state.hasBar && state.barFound, state.hasBar ? "not on page" : "not set");
  setMark("nextMark", state.hasNext);
  setMark("okMark", state.hasOk, "optional");

  const fill = document.getElementById("progressFill");
  const progress = state.progress == null ? null : Math.max(0, Math.min(100, state.progress));
  fill.style.width = progress == null ? "0" : progress + "%";
  if (!state.hasBar) status.textContent = "Step 1: set the blue progress bar.";
  else if (!state.hasNext) status.textContent = "Step 2: set and drag the permanent orange NEXT marker.";
  else if (progress == null) status.textContent = "Ready. Waiting for the selected progress bar to move.";
  else status.textContent = `Ready. Progress ${Math.round(progress)}% — clicks orange NEXT once at 100%.`;
}

async function launchMarker(target) {
  const response = await send({ type: "setMarker", target });
  if (response && response.ok) window.close();
  else {
    document.getElementById("status").textContent =
      "Set the progress bar first. If it is already set, reload the course page once.";
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;

  document.getElementById("pickBar").addEventListener("click", async () => {
    const response = await send({ type: "pickBar" });
    if (response && response.ok) window.close();
    else document.getElementById("status").textContent = "Reload the course page once, then try again.";
  });
  document.getElementById("setNext").addEventListener("click", () => launchMarker("next"));
  document.getElementById("setOk").addEventListener("click", () => launchMarker("ok"));
  document.getElementById("clear").addEventListener("click", async () => {
    await send({ type: "clear" });
    refresh();
  });

  refresh();
  setInterval(refresh, 750);
}

init();
