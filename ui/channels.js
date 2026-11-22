// The lineup editor. Channels are rules, not lists of files: a number, a name, the years it airs,
// and optionally which shows, genres or networks. The station builds every schedule from them,
// so a lineup is small, and shareable as channel.json without any media in it.
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clone = (x) => JSON.parse(JSON.stringify(x));
const runtime = (sec) => sec >= 2 * 86400 ? `${Math.round(sec / 86400)} days` : sec >= 5400 ? `${Math.round(sec / 3600)} hours`
  : count(Math.max(1, Math.round(sec / 60)), "minute");
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const st = { catalog: null, auto: true, saved: [], channels: [], sel: -1, previews: new Map(), busy: false, previewTimer: 0 };

async function api(path, opts = {}) {
  const r = await fetch(path, { cache: "no-store", ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
}
const sendJson = (method, path, body) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- Loading and the list ------------------------------------------------------------------
async function load() {
  const l = await api("/api/lineup");
  st.catalog = l.catalog;
  apply(l);
}
function apply(l) {
  st.auto = l.auto;
  st.saved = clone(l.channels);
  st.channels = clone(l.channels);
  st.previews.clear();
  if (st.sel >= st.channels.length) st.sel = st.channels.length - 1;
  if (st.sel < 0 && st.channels.length) st.sel = 0;
  render();
  st.channels.forEach((c) => preview(c));
}
const dirty = () => JSON.stringify(st.channels) !== JSON.stringify(st.saved);
const cur = () => st.channels[st.sel];

function renderList() {
  $("lineup").innerHTML = st.channels.map((c, i) => {
    const p = st.previews.get(key(c));
    const what = p ? (p.programs ? count(p.programs, p.movies === p.programs ? "movie" : "program") : '<span class="warn">nothing airs</span>') : "";
    return `<li data-i="${i}" class="${i === st.sel ? "on" : ""}"><span class="num">${esc(c.number)}</span>
      <span class="nm">${esc(c.name)}<small>${c.years[0]}–${c.years[1]}${what ? " · " + what : ""}</small></span></li>`;
  }).join("") || '<li class="dim">No channels.</li>';
  $("mode").textContent = st.auto && !dirty() ? "Automatic: one channel per decade of your library" : "Your lineup";
  $("dirty").hidden = !dirty();
  $("save").disabled = !dirty() || st.busy;
  $("discard").disabled = !dirty() || st.busy;
  $("auto").disabled = st.busy || (st.auto && !dirty());
}
$("lineup").onclick = (e) => { const li = e.target.closest("li[data-i]"); if (li) { st.sel = Number(li.dataset.i); render(); } };

// ---- One channel ---------------------------------------------------------------------------
function render() {
  renderList();
  const c = cur();
  $("form").hidden = !c;
  $("empty").hidden = Boolean(c);
  if (!c) return;
  const cat = st.catalog;
  const kinds = c.kinds ?? ["episode"];
  setVal("f-number", c.number);
  setVal("f-name", c.name);
  setVal("f-from", c.years[0]);
  setVal("f-to", c.years[1]);
  $("f-episodes").checked = kinds.includes("episode");
  $("f-movies").checked = kinds.includes("movie");
  $("movies-box").hidden = !cat.movies && !kinds.includes("movie");
  $("f-slot").value = String(c.slotMinutes ?? 30);
  if (![...$("f-slot").options].some((o) => o.value === $("f-slot").value)) {
    $("f-slot").insertAdjacentHTML("beforeend", `<option value="${c.slotMinutes}">${c.slotMinutes} minutes</option>`);
    $("f-slot").value = String(c.slotMinutes);
  }
  // decades the library covers, as one-tap year ranges
  const decades = [];
  if (cat.years) for (let d = Math.floor(cat.years[0] / 10) * 10; d <= cat.years[1]; d += 10) decades.push(d);
  $("decades").innerHTML = decades.map((d) => `<span class="chip${c.years[0] === d && c.years[1] === d + 9 ? " on" : ""}" data-d="${d}">${d}s</span>`).join("")
    + (cat.years ? `<span class="chip${c.years[0] === cat.years[0] && c.years[1] === cat.years[1] ? " on" : ""}" data-all="1">All years</span>` : "");
  // shows: every show from the years, or a pick
  $("show-pick").hidden = !kinds.includes("episode");
  $("f-allshows").checked = !c.shows?.length;
  renderShows();
  chips("genres", "genre-pick", cat.genres, c.genres);
  chips("networks", "network-pick", cat.networks, c.networks);
  renderPreview();
}
function setVal(id, v) { if (document.activeElement !== $(id)) $(id).value = v; }
function chips(id, box, all, picked = []) {
  $(box).hidden = !all.length;
  const on = new Set((picked ?? []).map((x) => x.toLowerCase()));
  $(id).innerHTML = all.map((g) => `<span class="chip${on.has(g.toLowerCase()) ? " on" : ""}" data-v="${esc(g)}">${esc(g)}</span>`).join("");
}
function renderShows() {
  const c = cur();
  const q = $("show-filter").value.toLowerCase();
  const picked = new Set((c.shows ?? []).map((s) => s.toLowerCase()));
  const all = !c.shows?.length;
  const rows = st.catalog.shows.filter((s) => !q || s.name.toLowerCase().includes(q)).map((s) => {
    const inYears = s.years[1] >= c.years[0] && s.years[0] <= c.years[1];
    const yrs = s.years[0] === s.years[1] ? s.years[0] : `${s.years[0]}–${s.years[1]}`;
    return `<li class="${inYears ? "" : "out"}"><label><input type="checkbox" data-show="${esc(s.name)}"${all ? (inYears ? " checked disabled" : " disabled") : picked.has(s.name.toLowerCase()) ? " checked" : ""}>
      ${esc(s.name)} <small>${yrs} · ${s.episodes} ep${inYears ? "" : " · outside the years"}</small></label></li>`;
  });
  // shows from a shared channel that this library doesn't have
  for (const name of c.shows ?? []) {
    if (!st.catalog.shows.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      rows.push(`<li class="out"><label><input type="checkbox" data-show="${esc(name)}" checked> ${esc(name)} <small>not in your library</small></label></li>`);
    }
  }
  $("shows").innerHTML = rows.join("") || '<li class="dim">No shows found.</li>';
}

function change(fn) {
  const c = cur();
  if (!c) return;
  fn(c);
  if (c.shows && !c.shows.length) delete c.shows;
  if (c.genres && !c.genres.length) delete c.genres;
  if (c.networks && !c.networks.length) delete c.networks;
  showError("");
  render();
  schedulePreview();
}
const int = (v) => (v === "" ? NaN : Number(v));
$("f-number").oninput = (e) => change((c) => { c.number = int(e.target.value); });
$("f-name").oninput = (e) => change((c) => {
  c.name = e.target.value;
  // a channel not saved yet takes its id from its name; a saved one keeps its id (and schedule)
  if (!st.saved.some((x) => x.id === c.id) || st.channels.filter((x) => x.id === c.id).length > 1) {
    c.id = "";
    c.id = freeId(c.name);
  }
});
$("f-from").oninput = (e) => change((c) => { c.years = [int(e.target.value), c.years[1]]; });
$("f-to").oninput = (e) => change((c) => { c.years = [c.years[0], int(e.target.value)]; });
$("decades").onclick = (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const y = chip.dataset.all ? st.catalog.years : [Number(chip.dataset.d), Number(chip.dataset.d) + 9];
  change((c) => { c.years = [...y]; });
};
function kindsChange() {
  change((c) => {
    const k = [];
    if ($("f-episodes").checked) k.push("episode");
    if ($("f-movies").checked) k.push("movie");
    if (!k.length) k.push("episode");
    if (k.length === 1 && k[0] === "episode") delete c.kinds; else c.kinds = k;
  });
}
$("f-episodes").onchange = kindsChange;
$("f-movies").onchange = kindsChange;
$("f-allshows").onchange = (e) => change((c) => {
  if (e.target.checked) delete c.shows;
  else c.shows = st.catalog.shows.filter((s) => s.years[1] >= c.years[0] && s.years[0] <= c.years[1]).map((s) => s.name);
});
$("show-filter").oninput = renderShows;
$("shows").onchange = (e) => {
  const name = e.target.dataset.show;
  if (!name) return;
  change((c) => {
    const rest = (c.shows ?? []).filter((s) => s.toLowerCase() !== name.toLowerCase());
    c.shows = e.target.checked ? [...rest, name] : rest;      // none left: every show again
  });
};
for (const [id, field] of [["genres", "genres"], ["networks", "networks"]]) {
  $(id).onclick = (e) => {
    const v = e.target.closest(".chip")?.dataset.v;
    if (!v) return;
    change((c) => {
      const has = (c[field] ?? []).some((x) => x.toLowerCase() === v.toLowerCase());
      c[field] = has ? c[field].filter((x) => x.toLowerCase() !== v.toLowerCase()) : [...(c[field] ?? []), v];
    });
  };
}
$("f-slot").onchange = (e) => change((c) => { const m = Number(e.target.value); if (m === 30) delete c.slotMinutes; else c.slotMinutes = m; });
$("reshuffle").onclick = () => change((c) => { c.seed = Math.random().toString(36).slice(2, 8); });

// ---- Previews: what a channel would air ------------------------------------------------------
const key = (c) => JSON.stringify([c.years, c.kinds, c.shows, c.genres, c.networks]);
async function preview(c) {
  const k = key(c);
  if (st.previews.has(k)) return st.previews.get(k);
  try {
    const p = await sendJson("POST", "/api/lineup/preview", { channel: { ...c, id: "preview", number: 1, name: "preview" } });
    st.previews.set(k, p);
    renderList();
    if (cur() && key(cur()) === k) renderPreview();
    return p;
  } catch {
    return null;          // an unfinished field: the form shows what's wrong when saving
  }
}
function schedulePreview() {
  clearTimeout(st.previewTimer);
  st.previewTimer = setTimeout(() => { if (cur()) preview(cur()); }, 250);
}
function renderPreview() {
  const c = cur();
  const p = c && st.previews.get(key(c));
  if (!p) { $("preview").innerHTML = '<span class="dim">Checking what this channel would air…</span>'; return; }
  if (!p.programs) {
    $("preview").innerHTML = '<b class="warn">Nothing airs on this channel.</b><div class="dim">No program in your library matches: widen the years, or pick other shows.</div>';
    return;
  }
  const what = p.movies === p.programs ? count(p.programs, "movie")
    : p.movies ? `${count(p.programs - p.movies, "episode")} and ${count(p.movies, "movie")}` : count(p.programs, "episode");
  const shows = p.shows.slice(0, 8).map((s) => `<li>${esc(s.name)} <span class="dim">(${s.episodes})</span></li>`).join("")
    + (p.shows.length > 8 ? `<li>and ${p.shows.length - 8} more</li>` : "");
  const ads = p.ads ? `${count(p.ads, "commercial")} from those years` : '<span class="warn">No commercials from those years: breaks show the "we\'ll be right back" card</span>';
  $("preview").innerHTML = `<b>${what}</b> <span class="dim">· ${runtime(p.runSec)} before anything repeats</span><div>${ads}</div>${shows ? `<ul>${shows}</ul>` : ""}`;
}

// ---- Adding, removing, sharing ---------------------------------------------------------------
function freeNumber(from = 2) {
  const used = new Set(st.channels.map((c) => c.number));
  let n = from;
  while (used.has(n)) n++;
  return n;
}
function freeId(name) {
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "channel").slice(0, 32);
  let id = base;
  for (let n = 2; st.channels.some((c) => c.id === id); n++) id = `${base}-${n}`;
  return id;
}
function addChannel(c) {
  st.channels.push(c);
  st.sel = st.channels.length - 1;
  showError("");
  render();
  preview(c);
}
$("add").onclick = () => {
  const y = st.catalog.years ?? [1980, 1989];
  const name = "New channel";
  addChannel({ id: freeId(name), number: freeNumber(), name, years: [...y] });
  $("f-name").focus();
  $("f-name").select();
};
$("dup").onclick = () => {
  const c = clone(cur());
  c.name = `${c.name} 2`.slice(0, 40);
  c.id = freeId(c.name);
  c.number = freeNumber(c.number + 1);
  addChannel(c);
};
$("del").onclick = () => {
  st.channels.splice(st.sel, 1);
  st.sel = Math.min(st.sel, st.channels.length - 1);
  render();
};

function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const shareable = (c) => { const { id: _id, ...rest } = c; return rest; };     // ids are local
$("export").onclick = () => download("primetime-lineup.json", { primetimeMachine: "lineup", version: 1, channels: st.channels.map(shareable) });
$("export-one").onclick = () => download(`${cur().id}.channel.json`, { primetimeMachine: "channel", version: 1, ...shareable(cur()) });
$("import").onclick = () => $("file").click();
$("file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    importChannels(JSON.parse(await f.text()));
  } catch (err) {
    showError(`Couldn't import ${f.name}: ${err.message}`);
  }
};
/** A lineup file ({channels: [...]}), a list, or one channel: added to this lineup, never replacing it. */
function importChannels(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.channels) ? data.channels : [data];
  let added = 0;
  for (const raw of list) {
    if (!raw || typeof raw.name !== "string" || !Array.isArray(raw.years)) continue;
    const { primetimeMachine: _p, version: _v, ...c } = raw;
    c.name = c.name.slice(0, 40);
    c.id = freeId(c.name);
    if (!Number.isInteger(c.number) || st.channels.some((x) => x.number === c.number)) c.number = freeNumber(Number.isInteger(c.number) ? c.number : 2);
    st.channels.push(c);
    preview(c);
    added++;
  }
  if (!added) throw new Error("no channels in it");
  st.sel = st.channels.length - 1;
  render();
}

// ---- Saving ------------------------------------------------------------------------------------
function showError(msg) { $("error").hidden = !msg; $("error").textContent = msg; }
async function save() {
  if (!dirty() || st.busy) return;
  st.busy = true; renderList();
  try {
    apply(await sendJson("PUT", "/api/lineup", { channels: st.channels }));
    showError("");
  } catch (e) {
    showError(`Not saved: ${e.message}`);
    const bad = /channel "([^"]*)"/.exec(e.message);
    const i = bad ? st.channels.findIndex((c) => c.name.trim() === bad[1]) : -1;
    if (i >= 0) { st.sel = i; render(); }
  } finally {
    st.busy = false; renderList();
  }
}
$("save").onclick = save;
$("discard").onclick = () => { st.channels = clone(st.saved); st.sel = Math.min(st.sel, st.channels.length - 1); showError(""); render(); };
$("auto").onclick = async () => {
  if (st.busy) return;
  st.busy = true; renderList();
  try {
    apply(await sendJson("DELETE", "/api/lineup"));
    showError("");
  } catch (e) {
    showError(`Couldn't switch back: ${e.message}`);
  } finally {
    st.busy = false; renderList();
  }
};
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
});
window.addEventListener("beforeunload", (e) => { if (dirty()) e.preventDefault(); });
window.ptmChannels = st;     // for tests

load().catch((e) => showError(`Can't reach the station: ${e.message}`));
