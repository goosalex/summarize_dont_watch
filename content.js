(() => {
  if (window.__ytsumLoaded) return;
  window.__ytsumLoaded = true;
  if (location.hash === "#ytsum") return; // the extension's own background tab needs no UI

  const PREFIX = "s2:";
  const HOVER_DELAY = 350;
  const LOAD_TIMEOUT = 4 * 60 * 1000;
  const memory = new Map(); // id -> {summary} | {error, at, ttl}
  const loading = new Map(); // id -> timeout handle
  const bulk = new Set();

  const fresh = (e) => !!e && (!!e.summary || (!!e.error && Date.now() - e.at < (e.ttl || 0)));
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  const STALE = "Extension was reloaded. Reload this YouTube tab (F5) to use summaries again.";
  const localError = (id, msg) => memory.set(id, { error: msg, at: Date.now(), ttl: 60 * 1000 });

  function stateOf(id) {
    const e = memory.get(id);
    if (e && e.summary) return "done";
    if (loading.has(id)) return "loading";
    if (fresh(e)) return "error";
    return "none";
  }

  function settle(id, entry) {
    if (entry) memory.set(id, entry);
    clearTimeout(loading.get(id));
    loading.delete(id);
    bulk.delete(id);
    scan();
    updateButton();
    if (tipId === id && tipAnchor) showFor(tipAnchor, id, pinned);
  }

  function request(id, priority, force) {
    if (loading.has(id)) return;
    if (!alive()) {
      localError(id, STALE);
      return scan();
    }
    loading.set(
      id,
      setTimeout(() => {
        localError(id, "Timed out waiting for the summary.");
        settle(id);
      }, LOAD_TIMEOUT)
    );
    try {
      chrome.runtime.sendMessage({ type: "enqueue", ids: [id], priority, force }, () => void chrome.runtime.lastError);
    } catch {
      localError(id, STALE);
      settle(id);
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const [k, c] of Object.entries(changes)) {
        if (!k.startsWith(PREFIX)) continue;
        const id = k.slice(PREFIX.length);
        if (c.newValue) settle(id, c.newValue);
        else {
          memory.delete(id);
          scan();
        }
      }
    });
    chrome.storage.local.get(null).then((all) => {
      for (const [k, v] of Object.entries(all)) if (k.startsWith(PREFIX)) memory.set(k.slice(PREFIX.length), v);
      scan();
    });
  } catch {}

  // ---------- Helpers ----------
  function videoIdFromAnchor(a) {
    try {
      const u = new URL(a.href, location.origin);
      if (u.pathname !== "/watch") return null; // skips Shorts, channels, playlists
      const id = u.searchParams.get("v");
      return /^[\w-]{11}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function isLiveOrUpcoming(a) {
    const root =
      a.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model") || a;
    const txt = root.textContent || "";
    return /\b(LIVE|UPCOMING|Premieres?)\b/.test(txt) && !/\d+:\d\d/.test(txt);
  }

  const isThumb = (a) =>
    a.id === "thumbnail" || !!a.querySelector("yt-thumbnail-view-model, ytd-thumbnail, yt-image, img");

  // ---------- Badges on every thumbnail ----------
  const GLYPH = { none: "?", error: "?", done: "!", loading: "" };
  const TITLE = {
    none: "Summarize this video",
    error: "Failed. Click to retry",
    done: "Show summary",
    loading: "Summarizing…",
  };

  function scan() {
    for (const a of document.querySelectorAll("a[href*='/watch?v=']")) {
      if (!isThumb(a) || a.closest("#movie_player")) continue;
      let badge = a.querySelector(":scope > .ytsum-badge");
      const id = videoIdFromAnchor(a);
      if (a.__ytsumId !== id) {
        a.__ytsumId = id;
        a.__ytsumSkip = !id || isLiveOrUpcoming(a) || (a.offsetWidth > 0 && a.offsetWidth < 90);
      }
      if (a.__ytsumSkip) {
        if (badge) badge.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement("div");
        badge.className = "ytsum-badge";
        badge.setAttribute("role", "button");
        if (getComputedStyle(a).position === "static") a.style.position = "relative";
        a.appendChild(badge);
      }
      const st = stateOf(id);
      if (badge.dataset.id !== id) badge.dataset.id = id;
      if (badge.dataset.state !== st) {
        badge.dataset.state = st;
        badge.textContent = GLYPH[st];
        badge.title = TITLE[st];
      }
    }
  }

  // ---------- Summary popup ----------
  const tip = document.createElement("div");
  tip.id = "ytsum-tip";
  document.documentElement.appendChild(tip);
  let tipId = null;
  let tipAnchor = null;
  let pinned = false;
  let hoverTimer = null;
  let hideTimer = null;
  let hoverId = null;

  // Built from DOM nodes, not innerHTML: YouTube enforces Trusted Types.
  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function formatSummary(s) {
    const frag = document.createDocumentFragment();
    let list = null;
    s.split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((l, i) => {
        const t = l.replace(/^[-*•]\s+/, "");
        const isHeading = i > 0 && l.length < 40 && !/[.!?:]$/.test(l);
        if (i === 0) frag.appendChild(el("p", t, "lead"));
        else if (isHeading) {
          list = null;
          frag.appendChild(el("p", t, "h"));
        } else {
          if (!list) frag.appendChild((list = el("ul")));
          list.appendChild(el("li", t));
        }
      });
    return frag;
  }

  function message(text, hint) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el("p", text));
    if (hint) frag.appendChild(el("p", hint));
    return frag;
  }

  function position(a, compact) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const badge = a.querySelector(":scope > .ytsum-badge");
    const b = badge ? badge.getBoundingClientRect() : null;
    tip.style.maxHeight = Math.min(460, vh - 16) + "px";

    if (compact && b) {
      // Short status message: sits to the right of the button, never on top of it.
      tip.style.width = "max-content";
      tip.style.maxWidth = Math.min(280, vw - 16) + "px";
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      let left = b.right + 8;
      if (left + w > vw - 8) left = Math.max(8, b.left - w - 8);
      const top = b.top + (b.height - h) / 2;
      tip.style.left = left + "px";
      tip.style.top = Math.min(Math.max(8, top), vh - h - 8) + "px";
      return;
    }

    const r = a.getBoundingClientRect();
    const w = Math.min(400, vw - 16);
    tip.style.width = w + "px";
    tip.style.maxWidth = "none";
    let left = Math.min(Math.max(8, r.left), vw - w - 8);
    const h = tip.offsetHeight;
    let top = r.bottom + 4;
    if (top + h > vh - 8) top = r.top - h - 4; // flip above
    top = Math.min(Math.max(8, top), vh - h - 8);
    // If the popup would still cover the button, move it beside the button.
    if (b && left < b.right + 4 && left + w > b.left - 4 && top < b.bottom + 4 && top + h > b.top - 4) {
      if (b.right + 8 + w <= vw - 8) left = b.right + 8;
      else if (b.left - 8 - w >= 8) left = b.left - 8 - w;
      else top = Math.min(b.bottom + 8, vh - h - 8);
    }
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function showFor(a, id, pin) {
    const st = stateOf(id);
    const e = memory.get(id);
    let content;
    let cls = "";
    if (st === "done") content = formatSummary(e.summary);
    else if (st === "loading") (content = message("Summarizing in a background tab…")), (cls = "loading");
    else if (st === "error") (content = message(e.error, "Click the ? to retry.")), (cls = "err");
    else return hide();
    clearTimeout(hideTimer);
    hideTimer = null;
    const same = tipId === id && tip.classList.contains("show");
    tipId = id;
    tipAnchor = a;
    pinned = !!pin;
    tip.className = "show " + cls + (pinned ? " pinned" : "");
    tip.replaceChildren(content);
    if (!same) tip.scrollTop = 0;
    position(a, st !== "done");
  }

  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    clearTimeout(hoverTimer);
    tip.className = "";
    tipId = null;
    tipAnchor = null;
    pinned = false;
    hoverId = null;
  }

  function hideSoon() {
    if (pinned || hideTimer) return;
    hideTimer = setTimeout(hide, 300); // time to move the pointer into the popup
  }

  // Is the pointer over the video or the popup? Decided by position, not by element:
  // YouTube puts its inline preview player on top of the thumbnail, so the element
  // under the pointer is often not the thumbnail at all.
  function inZone(x, y) {
    const pad = 8;
    const hit = (r) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    if (hit(tip.getBoundingClientRect())) return true;
    return !!tipAnchor && tipAnchor.isConnected && hit(tipAnchor.getBoundingClientRect());
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!tipId || pinned) return;
      if (inZone(e.clientX, e.clientY)) {
        clearTimeout(hideTimer);
        hideTimer = null;
      } else hideSoon();
    },
    true
  );

  const anchorOf = (t) => (t.closest ? t.closest("a[href*='/watch?v=']") : null);

  document.addEventListener(
    "mouseover",
    (e) => {
      if (tip.contains(e.target)) return;
      const a = anchorOf(e.target);
      if (!a || (location.pathname === "/watch" && a.closest("#movie_player"))) return;
      const id = videoIdFromAnchor(a);
      if (!id) return;
      if (id === tipId || pinned) return;
      const st = stateOf(id);
      const onBadge = !!(e.target.closest && e.target.closest(".ytsum-badge"));
      // Summaries show when hovering the video; loading/error text only on the badge itself.
      if (st !== "done" && !(onBadge && (st === "loading" || st === "error"))) return;
      if (hoverId === id) return;
      hoverId = id;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => showFor(a, id, false), onBadge ? 100 : HOVER_DELAY);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      const a = anchorOf(e.target);
      if (!a) return;
      const to = e.relatedTarget;
      if (to && (a.contains(to) || tip.contains(to))) return;
      // Only cancels a pending hover. Closing an open popup is decided by pointer position.
      if (!tipId) {
        clearTimeout(hoverTimer);
        hoverId = null;
      }
    },
    true
  );

  // Badge clicks: must not open the video.
  function onBadgeEvent(e) {
    const badge = e.target.closest && e.target.closest(".ytsum-badge");
    if (!badge) return false;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return badge;
  }
  for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup"]) document.addEventListener(t, onBadgeEvent, true);

  document.addEventListener(
    "click",
    (e) => {
      const badge = onBadgeEvent(e);
      if (!badge) {
        if (pinned && !tip.contains(e.target)) hide();
        return;
      }
      const a = badge.parentElement;
      const id = videoIdFromAnchor(a) || badge.dataset.id;
      const st = stateOf(id);
      if (st === "done") {
        if (pinned && tipId === id) hide();
        else showFor(a, id, true);
      } else if (st === "none" || st === "error") {
        if (tipId === id) hide();
        request(id, true, st === "error");
        scan();
      }
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tipId) hide();
  });

  // Wheel over the video or the popup scrolls the summary instead of the page.
  document.addEventListener(
    "wheel",
    (e) => {
      if (!tipId || tip.scrollHeight <= tip.clientHeight + 1) return;
      if (!inZone(e.clientX, e.clientY)) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * tip.clientHeight : e.deltaY;
      tip.scrollTop += dy;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true, passive: false }
  );

  window.addEventListener("scroll", () => tipId && hide(), { passive: true });

  // ---------- Bulk button on the subscriptions feed ----------
  const btn = document.createElement("button");
  btn.id = "ytsum-bulk";
  document.documentElement.appendChild(btn);

  function pendingIds() {
    const ids = new Set();
    document.querySelectorAll(".ytsum-badge[data-state='none']").forEach((b) => ids.add(b.dataset.id));
    return [...ids];
  }

  function updateButton() {
    const onFeed = location.pathname.startsWith("/feed/subscriptions");
    btn.style.display = onFeed ? "block" : "none";
    if (!onFeed) return;
    if (bulk.size) btn.textContent = `Summarizing… ${bulk.size} left`;
    else btn.textContent = `Summarize all loaded (${pendingIds().length} new)`;
  }

  btn.addEventListener("click", () => {
    if (bulk.size) return;
    for (const id of pendingIds()) {
      bulk.add(id);
      request(id, false, false);
    }
    scan();
    updateButton();
  });

  let scanTimer = null;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scan();
      updateButton();
    }, 400);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("yt-navigate-finish", () => {
    hide();
    scan();
    updateButton();
  });
  scan();
  updateButton();
})();
