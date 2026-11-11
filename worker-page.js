// Runs in the page's own JS world at document_start, only in the extension's worker
// tab (marked by the #ytsum hash). Chrome does not run requestAnimationFrame in a
// hidden tab, and YouTube renders the Ask answer through it, so the answer never
// appears until the tab is focused. This makes the page render while hidden.
(() => {
  if (location.hash !== "#ytsum") return;

  const q = new Map();
  let n = 0;
  let timer = null;
  const flush = () => {
    timer = null;
    const cbs = [...q.values()];
    q.clear();
    const t = performance.now();
    for (const cb of cbs) {
      try {
        cb(t);
      } catch (e) {
        console.error(e);
      }
    }
  };
  window.requestAnimationFrame = (cb) => {
    const id = ++n;
    q.set(id, cb);
    if (!timer) timer = setTimeout(flush, 16);
    return id;
  };
  window.cancelAnimationFrame = (id) => q.delete(id);
  // The extension's poller also triggers a flush, in case page timers are throttled.
  document.addEventListener("ytsum-flush", flush);

  try {
    Object.defineProperty(Document.prototype, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(Document.prototype, "hidden", { get: () => false, configurable: true });
  } catch {}
  for (const t of ["visibilitychange", "webkitvisibilitychange"])
    document.addEventListener(t, (e) => e.stopImmediatePropagation(), true);
})();
