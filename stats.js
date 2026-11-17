(() => {
  "use strict";

  const playingCount = document.getElementById("stats-playing");
  const adventureCount = document.getElementById("stats-adventures");
  const online = location.protocol === "http:" || location.protocol === "https:";
  const pending = new Map();
  let adventure = null;
  let playing = false;
  let sending = false;
  let reading = false;

  function unavailable() {
    if (playingCount) playingCount.textContent = "\u2014";
    if (adventureCount) adventureCount.textContent = "\u2014";
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Stats request returned ${response.status}`);
    return response.json();
  }

  async function refresh() {
    if (!online || reading || document.hidden) return;
    reading = true;
    try {
      const data = await request("/api/stats");
      if (!Number.isSafeInteger(data.playingNow) || data.playingNow < 0 ||
          !Number.isSafeInteger(data.adventuresStarted) || data.adventuresStarted < 0 ||
          !["azure-blob", "azure-table", "memory"].includes(data.storage)) {
        throw new Error("Stats response has an invalid shape");
      }
      if (playingCount) playingCount.textContent = data.playingNow.toLocaleString();
      if (adventureCount) adventureCount.textContent = data.adventuresStarted.toLocaleString();
    } catch (error) {
      console.warn("Ocean shared stats unavailable:", error.message);
      unavailable();
    } finally {
      reading = false;
    }
  }

  async function sync() {
    if (!online || sending || pending.size === 0) return;
    sending = true;
    try {
      while (pending.size > 0) {
        const [id, value] = pending.entries().next().value;
        await request("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });
        if (pending.get(id) === value) pending.delete(id);
      }
      await refresh();
    } catch (error) {
      console.warn("Ocean presence update failed; retrying:", error.message);
      unavailable();
    } finally {
      sending = false;
    }
  }

  function presence(id, active) {
    if (!online || !id) return;
    pending.set(id, { sessionId: id, playing: active });
    void sync();
  }

  window.addEventListener("ocean:adventure", () => {
    presence(adventure, false);
    // This identifier exists only for this adventure in this tab's memory.
    adventure = crypto.randomUUID();
  });
  window.addEventListener("ocean:mode", (event) => {
    playing = event.detail.mode === "playing";
    presence(adventure, playing && !document.hidden);
  });
  document.addEventListener("visibilitychange", () => {
    presence(adventure, playing && !document.hidden);
    if (!document.hidden) void refresh();
  });
  window.addEventListener("pagehide", () => {
    if (!online || !adventure) return;
    fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: adventure, playing: false }),
      keepalive: true,
      credentials: "omit",
    }).catch((error) => console.warn("Presence release failed; the lease will expire:", error.message));
  });
  if (online) {
    void refresh();
    setInterval(() => { void refresh(); }, 15000);
    setInterval(() => {
      presence(adventure, playing && !document.hidden);
      void sync();
    }, 20000);
  } else {
    unavailable();
  }
})();
