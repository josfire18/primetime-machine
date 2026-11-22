// The break editor. Lists every episode with its commercial breaks (found by detection, or
// set here by hand), plays one with its breaks on a timeline, and saves changes to the
// station. A change airs from the next midnight, so today's schedule never shifts under a
// show that is on the air.
"use strict";

const $ = (id) => document.getElementById(id);
const video = $("video");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clock = (sec, tenths = true) => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${(tenths ? rest.toFixed(1) : Math.floor(rest)).toString().padStart(tenths ? 4 : 2, "0")}`;
};
const STATUS = { pending: "not checked", found: "found", none: "none found", edited: "set by hand" };
const PREVIEW_SEC = 5;

const st = {
  episodes: [], filter: "", status: "", ep: null,
  saved: [], breaks: [], sel: -1,
  base: 0,            // where the loaded media starts in the episode (live streams start part-way)
  live: false, seekToken: 0, busy: false,
};

async function api(path, opts = {}) {
  const r = await fetch(path, { cache: "no-store", ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
}

// ---- The list ----------------------------------------------------------------------------
async function loadList() {
  const d = await api("/api/episodes");
  st.episodes = d.episodes;
  const j = d.job;
  $("job").textContent = j.running ? `Finding breaks: ${j.done} of ${j.total}${j.current ? ` (${j.current})` : ""}` : "";
  // the open episode follows the station (detection may have just finished it), unless edited here
  const fresh = st.ep && st.episodes.find((e) => e.key === st.ep.key);
  if (fresh && !dirty() && !st.busy && (fresh.status !== st.ep.status || fresh.since !== st.ep.since)) {
    fresh.delivery = st.ep.delivery;
    st.ep = fresh;
    setBreaks(fresh.breaksSec, true);
  }
  renderList();
  if (j.running) setTimeout(() => loadList().catch(() => {}), 2000);
}
function renderList() {
  const counts = {};
  for (const e of st.episodes) counts[e.status] = (counts[e.status] || 0) + 1;
  $("counts").innerHTML = [["", `All ${st.episodes.length}`], ...Object.keys(STATUS).filter((k) => counts[k]).map((k) => [k, `${STATUS[k]} ${counts[k]}`])]
    .map(([k, t]) => `<span class="chip${k === st.status ? " on" : ""}" data-status="${k}">${esc(t)}</span>`).join("");
  const q = st.filter.toLowerCase();
  let show = null;
  const rows = [];
  for (const e of st.episodes) {
    if (st.status && e.status !== st.status) continue;
    if (q && !`${e.show ?? ""} ${e.title}`.toLowerCase().includes(q)) continue;
    if ((e.show ?? "") !== show) { show = e.show ?? ""; rows.push(`<li class="show">${esc(show || "Other")}</li>`); }
    const num = e.season !== undefined && e.episode !== undefined ? `S${e.season}E${String(e.episode).padStart(2, "0")} ` : "";
    rows.push(`<li class="ep${st.ep?.key === e.key ? " on" : ""}" data-key="${esc(e.key)}">
      <span class="t">${esc(num + e.title)}</span><span class="status ${e.status}">${esc(STATUS[e.status])}${e.breaksSec.length ? ` · ${e.breaksSec.length}` : ""}</span></li>`);
  }
  $("list").innerHTML = rows.join("") || '<li class="dim">Nothing matches.</li>';
}
$("filter").oninput = (e) => { st.filter = e.target.value; renderList(); };
$("counts").onclick = (e) => { const c = e.target.closest("[data-status]"); if (c) { st.status = c.dataset.status; renderList(); } };
$("list").onclick = (e) => { const li = e.target.closest("[data-key]"); if (li) open(li.dataset.key); };

// ---- One episode ---------------------------------------------------------------------------
const dirty = () => st.breaks.join() !== st.saved.join();

function open(key) {
  if (st.ep && dirty() && st.ep.key !== key) return showError("Save or discard the changes to this episode first.");
  const ep = st.episodes.find((e) => e.key === key);
  if (!ep) return;
  st.ep = ep;
  st.live = ep.delivery === "live";
  setBreaks(ep.breaksSec, true);
  $("editor").hidden = false;
  $("empty").hidden = true;
  const num = ep.season !== undefined && ep.episode !== undefined ? `Season ${ep.season}, episode ${ep.episode}` : "";
  $("ep-title").textContent = ep.show ? `${ep.show}: ${ep.title}` : ep.title;
  $("ep-meta").textContent = [num, ep.year, clock(ep.durationSec, false)].filter(Boolean).join(" · ");
  $("dur").textContent = clock(ep.durationSec, false);
  showError("");
  renderList();
  seek(0);
}

function setBreaks(list, saved = false) {
  st.breaks = [...list].sort((a, b) => a - b);
  if (saved) st.saved = [...st.breaks];
  if (st.sel >= st.breaks.length) st.sel = st.breaks.length - 1;
  renderBreaks();
}

function renderBreaks() {
  const ep = st.ep;
  const pct = (t) => `${(100 * t / ep.durationSec).toFixed(3)}%`;
  const marks = st.breaks.map((b, i) => `<div class="mark${i === st.sel ? " sel" : ""}" data-i="${i}" style="left:${pct(b)}" title="${clock(b)}"></div>`);
  const today = ep.today && !dirty() ? ep.today.map((b) => `<div class="mark today" style="left:${pct(b)}" title="today: ${clock(b)}"></div>`) : [];
  for (const el of $("timeline").querySelectorAll(".mark")) el.remove();
  $("timeline").insertAdjacentHTML("beforeend", today.join("") + marks.join(""));
  $("breaks").innerHTML = st.breaks.map((b, i) => `<li data-i="${i}" class="${i === st.sel ? "sel" : ""}">
    <span class="at">${clock(b)}</span><span class="dim">act ${i + 1} ends</span><span class="gap" style="flex:1"></span>
    <button data-act="nudge" data-d="-0.5">−½s</button><button data-act="nudge" data-d="0.5">+½s</button>
    <button data-act="preview">Preview</button><button data-act="remove">Remove</button></li>`).join("");
  $("none").hidden = st.breaks.length > 0;
  const d = dirty();
  $("dirty").hidden = !d;
  $("save").disabled = !d || st.busy;
  $("discard").disabled = !d || st.busy;
  $("redetect").disabled = st.busy || ep.status === "pending";
  const since = ep.since ? new Date(ep.since).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
  let note = ep.status === "pending" ? "Not checked yet: detection gets to it in the background."
    : ep.status === "edited" ? `Set by hand ${since}.` : ep.status === "found" ? `Found by detection ${since}.` : `Detection found none ${since}.`;
  if (d) note = "Changes air from midnight on. Today keeps the breaks it started with.";
  else if (ep.today) note += ` Today still airs the earlier version (${ep.today.length ? ep.today.map((b) => clock(b, false)).join(", ") : "no breaks"}); this one from midnight.`;
  $("note").textContent = note;
}

function showError(msg) { $("error").hidden = !msg; $("error").textContent = msg; }

// ---- Playing ---------------------------------------------------------------------------------
const position = () => st.base + (video.currentTime || 0);

async function seek(t) {
  const ep = st.ep;
  t = Math.max(0, Math.min(ep.durationSec - 0.1, t));
  const token = ++st.seekToken;
  if (!st.live) {
    const src = `/media/${ep.key}`;
    if (!video.src.endsWith(src)) { video.src = src; st.base = 0; }
    video.currentTime = t;
    return tick();
  }
  // a file the station converts on the fly: ask where a stream for that second starts
  const loaded = video.dataset.key === ep.key && t >= st.base && t <= position() + 20;
  if (loaded) { video.currentTime = t - st.base; return tick(); }
  $("loading").hidden = false;
  try {
    const r = await api(`/api/live?key=${encodeURIComponent(ep.key)}&at=${t.toFixed(3)}`);
    if (token !== st.seekToken) return;
    const playing = !video.paused;
    st.base = r.start;
    video.dataset.key = ep.key;
    video.src = r.src;
    await new Promise((res) => video.addEventListener("loadedmetadata", res, { once: true }));
    video.currentTime = Math.max(0, t - st.base);
    if (playing) await video.play().catch(() => {});
  } catch (e) {
    showError(`Can't play this file: ${e.message}`);
  } finally {
    if (token === st.seekToken) $("loading").hidden = true;
  }
  tick();
}

function tick() {
  if (!st.ep) return;
  const t = position();
  const p = `${Math.min(100, (100 * t) / st.ep.durationSec)}%`;
  $("played").style.width = p;
  $("head").style.left = p;
  $("pos").textContent = clock(t);
  $("play").textContent = video.paused ? "Play" : "Pause";
}
video.addEventListener("timeupdate", tick);
video.addEventListener("play", tick);
video.addEventListener("pause", tick);
(function frame() { if (!video.paused) tick(); requestAnimationFrame(frame); })();

function togglePlay() { if (video.paused) video.play().catch(() => {}); else video.pause(); }
$("play").onclick = togglePlay;
document.querySelectorAll("[data-step]").forEach((b) => { b.onclick = () => seek(position() + Number(b.dataset.step)); });
$("timeline").onclick = (e) => {
  const mark = e.target.closest(".mark[data-i]");
  if (mark) return select(Number(mark.dataset.i), true);
  const r = $("timeline").getBoundingClientRect();
  seek(((e.clientX - r.left) / r.width) * st.ep.durationSec);
};

// ---- Editing ---------------------------------------------------------------------------------
function select(i, jump = false) {
  st.sel = i;
  renderBreaks();
  if (jump && i >= 0) seek(st.breaks[i]);
}
function add() {
  const t = Math.round(position() * 10) / 10;
  if (t <= 0.5 || t >= st.ep.durationSec - 0.5) return showError("A break has to be inside the episode.");
  if (st.breaks.some((b) => Math.abs(b - t) < 1)) return showError("There's already a break here.");
  showError("");
  setBreaks([...st.breaks, t]);
  select(st.breaks.indexOf(t));
}
function nudge(i, d) {
  if (i < 0) return;
  const t = Math.round((st.breaks[i] + d) * 10) / 10;
  if (t <= 0.5 || t >= st.ep.durationSec - 0.5) return;
  if (st.breaks.some((b, j) => j !== i && Math.abs(b - t) < 1)) return;
  const next = [...st.breaks];
  next[i] = t;
  setBreaks(next);
  select(st.breaks.indexOf(t));
  seek(t);
}
function remove(i) {
  if (i < 0) return;
  setBreaks(st.breaks.filter((_, j) => j !== i));
  select(Math.min(i, st.breaks.length - 1));
}
async function preview(i) {
  if (i < 0) return;
  await seek(st.breaks[i] - PREVIEW_SEC);
  video.play().catch(() => {});
}
$("add").onclick = add;
$("breaks").onclick = (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  const i = Number(li.dataset.i);
  const act = e.target.dataset.act;
  if (act === "nudge") nudge(i, Number(e.target.dataset.d));
  else if (act === "remove") remove(i);
  else if (act === "preview") { select(i); preview(i); }
  else select(i, true);
};

async function save() {
  if (!dirty() || st.busy) return;
  st.busy = true; renderBreaks();
  try {
    const ep = await api(`/api/episodes/${st.ep.key}/breaks`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ breaksSec: st.breaks }),
    });
    replace(ep);
    showError("");
  } catch (e) {
    showError(`Not saved: ${e.message}`);
  } finally {
    st.busy = false; renderBreaks();
  }
}
async function redetect() {
  if (st.busy) return;
  st.busy = true; renderBreaks();
  try {
    replace(await api(`/api/episodes/${st.ep.key}/breaks`, { method: "DELETE" }));
    showError("");
    loadList().catch(() => {});
  } catch (e) {
    showError(`Couldn't hand it back: ${e.message}`);
  } finally {
    st.busy = false; renderBreaks();
  }
}
function replace(ep) {
  const i = st.episodes.findIndex((e) => e.key === ep.key);
  ep.delivery = st.ep.delivery;
  if (i >= 0) st.episodes[i] = ep;
  st.ep = ep;
  setBreaks(ep.breaksSec, true);
  renderList();
}
$("save").onclick = save;
$("discard").onclick = () => { setBreaks(st.saved); showError(""); };
$("redetect").onclick = redetect;

document.addEventListener("keydown", (e) => {
  if (!st.ep || e.target.matches("input, textarea")) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "s") { e.preventDefault(); save(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const handled = {
    " ": togglePlay,
    ArrowLeft: () => seek(position() - (e.shiftKey ? 0.5 : 5)),
    ArrowRight: () => seek(position() + (e.shiftKey ? 0.5 : 5)),
    b: add, B: add,
    "[": () => nudge(st.sel, -0.5), "]": () => nudge(st.sel, 0.5),
    Delete: () => remove(st.sel), Backspace: () => remove(st.sel),
    p: () => preview(st.sel), P: () => preview(st.sel),
  }[k];
  if (handled) { e.preventDefault(); handled(); }
});
window.addEventListener("beforeunload", (e) => { if (st.ep && dirty()) e.preventDefault(); });

loadList().catch((e) => showError(`Can't reach the station: ${e.message}`));
