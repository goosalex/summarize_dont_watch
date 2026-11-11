// Service worker. Job pool: each requested video gets its own background tab, up to
// `parallel` at once. The tab loads the watch page, this worker drives YouTube's own
// Ask panel in short injected steps, caches the answer and closes the tab.
// All waiting happens here, so throttled timers in a hidden page cannot stall it,
// and the frequent API calls keep the service worker alive.

const PREFIX = "s2:";
const MIN = 60 * 1000;

const queued = new Set(); // ids waiting or running
const hi = []; // individually clicked
const lo = []; // bulk
let active = 0;
let parallel = 3;

chrome.storage.sync.get({ parallel: 3 }).then((s) => (parallel = clampPar(s.parallel)));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "sync" && c.parallel) parallel = clampPar(c.parallel.newValue);
  pump();
});
function clampPar(n) {
  n = parseInt(n, 10);
  return Math.min(6, Math.max(1, isNaN(n) ? 3 : n));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cacheGet(id) {
  const k = PREFIX + id;
  const e = (await chrome.storage.local.get(k))[k];
  if (!e) return null;
  if (e.summary) return e;
  if (e.error && Date.now() - e.at < (e.ttl || 0)) return e;
  return null;
}
const cacheSet = (id, v) => chrome.storage.local.set({ [PREFIX + id]: { ...v, at: Date.now() } });

function enqueue(ids, priority, force) {
  for (const id of ids) {
    if (!/^[\w-]{11}$/.test(id)) continue;
    if (queued.has(id)) {
      const i = lo.findIndex((j) => j.id === id);
      if (priority && i >= 0) hi.push(lo.splice(i, 1)[0]);
      continue;
    }
    queued.add(id);
    (priority ? hi : lo).push({ id, force: !!force });
  }
  pump();
}

function pump() {
  while (active < parallel && (hi.length || lo.length)) {
    const job = hi.length ? hi.shift() : lo.shift();
    active++;
    run(job).finally(() => {
      active--;
      queued.delete(job.id);
      pump();
    });
  }
}

async function run(job) {
  try {
    if (!job.force && (await cacheGet(job.id))) return;
    const r = await scrapeVideo(job.id);
    await cacheSet(job.id, r.ok ? { summary: r.text } : { error: r.error, ttl: r.ttl || 2 * MIN });
  } catch (e) {
    await cacheSet(job.id, { error: "Failed: " + e.message, ttl: 2 * MIN });
  }
}

// Runs inside the watch page. Must be self-contained.
function pageStep(action, wantId) {
  document.dispatchEvent(new Event("ytsum-flush")); // let worker-page.js render pending frames
  const v = document.querySelector("video");
  if (v) {
    v.muted = true;
    if (!v.paused) v.pause();
  }
  const onVideo =
    location.hostname === "www.youtube.com" &&
    location.pathname === "/watch" &&
    new URLSearchParams(location.search).get("v") === wantId;
  // The player's own Ask button is language-neutral and works even while hidden.
  const ask =
    document.querySelector(".you-chat-entrypoint-button button") ||
    document.querySelector('ytd-watch-metadata button[aria-label="Ask"]');
  const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]');
  const open = !!panel && panel.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
  const chips = panel ? [...panel.querySelectorAll("button.ytwYouChatChipsDataChip")] : [];
  const chip = chips.find((c) => /summar|zusammenfass|r[ée]sum|riassu|samenvat/i.test(c.textContent)) || chips[0];
  const md = panel ? [...panel.querySelectorAll("markdown-div")] : [];
  if (action === "clickAsk" && ask) ask.click();
  if (action === "clickChip" && chip) chip.click();
  return {
    onVideo,
    host: location.hostname,
    ready: !!document.querySelector("ytd-watch-metadata h1"),
    signedOut: !!document.querySelector('ytd-masthead a[href*="ServiceLogin"]'),
    hasAsk: !!ask,
    open,
    hasChip: !!chip,
    mdCount: md.length,
    lastText: md.length ? (md[md.length - 1].innerText || md[md.length - 1].textContent || "").trim() : "",
  };
}

async function step(tabId, action, id) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageStep, args: [action, id] });
    return r?.result || null;
  } catch {
    return null; // page is navigating, or tab was closed
  }
}

async function poll(tabId, id, timeout, pred, interval = 500) {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < timeout) {
    s = await step(tabId, "probe", id);
    if (s && pred(s)) return { hit: true, s };
    await sleep(interval);
  }
  return { hit: false, s };
}

function clean(t) {
  return t
    .replace(/\s*\(\s*[\d:]+(?:\s*[-–,]\s*[\d:]+)*\s*\)/g, "") // drop (2:42-3:35) timestamps
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function scrapeVideo(id) {
  const tab = await chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${id}#ytsum`, active: false });
  try {
    return await drive(tab.id, id);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function drive(tabId, id) {
  // 1. wait for the Ask button
  let readyAt = 0;
  const a = await poll(tabId, id, 45000, (s) => {
    if (!s.onVideo) return false;
    if (s.hasAsk) return true;
    if (s.ready && !readyAt) readyAt = Date.now();
    return readyAt && Date.now() - readyAt > 12000; // page is up, still no Ask
  });
  const s0 = a.s;
  if (!s0 || !s0.onVideo) {
    if (s0 && /consent|accounts\.google/.test(s0.host))
      return { ok: false, error: "YouTube shows a consent/sign-in page in the background tab." };
    return { ok: false, error: "Video page did not load in time." };
  }
  if (!s0.hasAsk) {
    if (s0.signedOut) return { ok: false, error: "Not signed in to YouTube in this Chrome profile." };
    return { ok: false, error: "No Ask button on this video.", ttl: 60 * MIN };
  }

  // 2. open the panel and wait for the suggestion chips
  let lastClick = 0;
  const c = await poll(tabId, id, 25000, (s) => {
    if (s.hasChip) return true;
    if (!s.open && Date.now() - lastClick > 4000) {
      lastClick = Date.now();
      step(tabId, "clickAsk", id);
    }
    return false;
  });
  if (!c.hit) return { ok: false, error: "Ask panel did not show its suggestions." };

  // 3. click "Summarise the video" and wait until the answer stops growing
  const before = c.s.mdCount;
  await step(tabId, "clickChip", id);
  let last = "";
  let stable = 0;
  const d = await poll(
    tabId,
    id,
    90000,
    (s) => {
      if (s.mdCount <= before || s.lastText.length < 40) return false;
      if (s.lastText === last) return ++stable >= 3;
      last = s.lastText;
      stable = 0;
      return false;
    },
    800
  );
  if (!d.hit) return { ok: false, error: "Ask did not finish answering in time." };
  return { ok: true, text: clean(last) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "enqueue" && Array.isArray(msg.ids)) {
    enqueue(msg.ids, !!msg.priority, !!msg.force);
    sendResponse({ ok: true });
  }
});
