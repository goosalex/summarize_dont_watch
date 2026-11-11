const $ = (id) => document.getElementById(id);
const flash = (t) => {
  $("status").textContent = t;
  setTimeout(() => ($("status").textContent = ""), 2000);
};

chrome.storage.sync.get({ parallel: 3 }).then((s) => ($("parallel").value = s.parallel));

$("save").addEventListener("click", async () => {
  const n = Math.min(6, Math.max(1, parseInt($("parallel").value, 10) || 3));
  $("parallel").value = n;
  await chrome.storage.sync.set({ parallel: n });
  flash("Saved");
});

$("clear").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => /^s2?:/.test(k));
  await chrome.storage.local.remove(keys);
  flash(`Cleared ${keys.length}`);
});
