// The TV screen. Everything airs on the station's clock: tuning in asks the station what a
// channel is playing now and joins it at the right second; the picture is checked against the
// clock four times a second, so it stays live through ad breaks, slow files and sleep.
//
// Remote:  ▲▼ / PgUp PgDn  channel     0-9  dial a number     OK / G  guide     I  info
//          M  mute     F  full screen     Esc  close the guide

const $ = (id) => document.getElementById(id);
const tv = $("tv");
const SLOT_MS = 30 * 60_000;
const GUIDE_SPAN = 3 * 60 * 60_000;
const PLAYOUT_AHEAD = 90 * 60_000;
const DRIFT_SEC = 1.5;

const state = {
  channels: [],
  index: 0,
  playout: null,          // { channel, from, to, segments }
  current: null,          // the segment on screen
  base: 0,                // seconds into the file where the loaded media starts (live streams)
  stream: { seg: null, url: "", base: 0, at: 0 },   // the live stream in use, if any
  feed: null,             // its MediaSource feed
  token: 0,               // bumps on every tune, so a slow fetch can't play the wrong channel
  dial: "",
  dialTimer: 0,
  guide: { open: false, from: 0, data: null, row: 0, at: 0 },
  infoTimer: 0,
  osdTimer: 0,
};

async function api(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

const time = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const slotStart = (t) => Math.floor(t / SLOT_MS) * SLOT_MS;
const channel = () => state.channels[state.index];
function label(p) {
  if (!p) return "Station break";
  return p.show ? `${p.show}` : p.title;
}
function sub(p) {
  if (!p) return "";
  const bits = [];
  if (p.show && p.title) bits.push(`“${p.title}”`);
  if (p.season != null && p.episode != null) bits.push(`S${p.season} E${p.episode}`);
  if (p.year) bits.push(String(p.year));
  if (p.kind === "movie") bits.push("Movie");
  return bits.join(" · ");
}

// ---------------------------------------------------------------- static between channels
const noise = $("static");
const noiseCtx = noise.getContext("2d");
let noiseFrame = 0;
function staticBurst(ms = 450) {
  noise.hidden = false;
  const img = noiseCtx.createImageData(noise.width, noise.height);
  const until = performance.now() + ms;
  cancelAnimationFrame(noiseFrame);
  const draw = () => {
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    noiseCtx.putImageData(img, 0, 0);
    if (performance.now() < until) noiseFrame = requestAnimationFrame(draw);
    else noise.hidden = true;
  };
  draw();
}

// ---------------------------------------------------------------- overlays
function card(title, subtitle = "") {
  $("card-title").textContent = title;
  $("card-sub").textContent = subtitle;
  $("card").hidden = false;
}
const hideCard = () => { $("card").hidden = true; };

function osd(text) {
  $("osd").textContent = text;
  $("osd").hidden = false;
  clearTimeout(state.osdTimer);
  state.osdTimer = setTimeout(() => { $("osd").hidden = true; }, 3000);
}

function blockOf(seg) {
  // the guide slot the segment airs in (the station says), and what follows it
  if (!seg?.block) return null;
  const after = state.playout?.segments.find((s) => s.start >= seg.block.end) ?? null;
  return { start: seg.block.start, end: seg.block.end, next: after?.program ?? null, nextKnown: !!after };
}

function showInfo(ms = 5000) {
  const ch = channel();
  const seg = state.current;
  if (!ch) return;
  $("ib-num").textContent = ch.number;
  $("ib-name").textContent = ch.name;
  const p = seg?.program ?? null;
  $("ib-title").textContent = seg ? label(p) : "No signal";
  const blk = seg && blockOf(seg);
  $("ib-meta").textContent = [sub(p), blk ? `${time(blk.start)} – ${time(blk.end)}` : ""].filter(Boolean).join("  ·  ");
  $("ib-next").textContent = blk?.nextKnown ? label(blk.next) : "";
  $("infobar").hidden = false;
  updateInfo();
  clearTimeout(state.infoTimer);
  if (ms) state.infoTimer = setTimeout(() => { $("infobar").hidden = true; }, ms);
}

function updateInfo() {
  $("ib-clock").textContent = time(Date.now());
  const seg = state.current;
  const blk = seg && blockOf(seg);
  const pct = blk ? Math.min(100, Math.max(0, ((Date.now() - blk.start) / (blk.end - blk.start)) * 100)) : 0;
  $("ib-progress").style.width = `${pct}%`;
}

// ---------------------------------------------------------------- live feeds
// A stream the station converts with ffmpeg arrives through MediaSource: fetched as fast as
// the station makes it, so the picture can start right on the clock's second (a plain
// <video src> reads an endless stream only a couple of seconds ahead, so a late start could
// never catch up). Reading pauses READ_AHEAD_SEC past what's playing, which also pauses
// ffmpeg, and what has played is trimmed, so memory stays small for a whole episode.
const READ_AHEAD_SEC = 90;
const KEEP_BEHIND_SEC = 20;

class LiveFeed {
  constructor(url, mime) {
    this.url = url;
    this.mime = mime;
    this.abort = new AbortController();
    this.stopped = false;
  }

  static supported(mime) {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
  }

  /** Point the video at this feed; resolves once it knows what it's playing (or failed). */
  attach(video) {
    this.video = video;
    this.source = new MediaSource();
    video.src = URL.createObjectURL(this.source);
    return new Promise((resolve) => {
      const done = () => { video.removeEventListener("loadedmetadata", done); video.removeEventListener("error", done); resolve(); };
      video.addEventListener("loadedmetadata", done);
      video.addEventListener("error", done);
      this.source.addEventListener("sourceopen", () => this.pump().catch(() => { if (!this.stopped) done(); }), { once: true });
    });
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    if (this.video?.src.startsWith("blob:")) URL.revokeObjectURL(this.video.src);
  }

  ahead() {
    const v = this.video;
    const b = v.buffered;
    return b.length ? b.end(b.length - 1) - v.currentTime : 0;
  }

  async append(chunk) {
    const sb = this.buffer;
    for (let attempt = 0; ; attempt++) {
      await this.idle();
      try {
        sb.appendBuffer(chunk);
        return this.idle();
      } catch (e) {
        if (e.name !== "QuotaExceededError" || attempt > 2) throw e;
        await this.trim(true);               // full: drop what has played, then try again
      }
    }
  }

  idle() {
    const sb = this.buffer;
    return sb.updating ? new Promise((r) => sb.addEventListener("updateend", r, { once: true })) : Promise.resolve();
  }

  async trim(hard = false) {
    const v = this.video;
    const b = this.buffer.buffered;
    const cut = v.currentTime - (hard ? 2 : KEEP_BEHIND_SEC);
    if (b.length && b.start(0) < cut - 1) {
      await this.idle();
      this.buffer.remove(b.start(0), cut);
      await this.idle();
    }
  }

  async pump() {
    this.buffer = this.source.addSourceBuffer(this.mime);
    const res = await fetch(this.url, { signal: this.abort.signal });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      while (!this.stopped && this.ahead() > READ_AHEAD_SEC) await new Promise((r) => setTimeout(r, 500));
      if (this.stopped) return;
      const { value, done } = await reader.read();
      if (done || this.stopped) break;
      await this.append(value);
      await this.trim();
    }
    if (!this.stopped && this.source.readyState === "open") {
      await this.idle();
      this.source.endOfStream();
    }
  }
}

// ---------------------------------------------------------------- playback
async function loadPlayout(ch, at) {
  const p = await api(`/api/playout?channel=${encodeURIComponent(ch.id)}&from=${at}&to=${at + PLAYOUT_AHEAD}`);
  return p;
}

function segmentAt(t) {
  return state.playout?.segments.find((s) => t >= s.start && t < s.end) ?? null;
}

async function tune(index) {
  if (!state.channels.length) return;
  state.index = (index + state.channels.length) % state.channels.length;
  const token = ++state.token;
  const ch = channel();
  staticBurst();
  osd(String(ch.number));
  state.current = null;
  state.playout = null;
  state.stream = { seg: null, url: "", base: 0, at: 0 };
  tv.pause();
  stopFeed();
  try {
    const p = await loadPlayout(ch, Date.now());
    if (token !== state.token) return;
    state.playout = p;
  } catch {
    if (token !== state.token) return;
    card("No signal", `${ch.number} ${ch.name}`);
    return;
  }
  await playNow(token);
  showInfo();
  try { localStorage.setItem("ptm.channel", ch.id); } catch { /* storage off: fine */ }
}

async function playNow(token, force = false) {
  const now = Date.now();
  let seg = segmentAt(now);
  if (!seg) {                                  // ran past what we fetched: get the next stretch
    try {
      state.playout = await loadPlayout(channel(), now);
    } catch {
      return card("No signal", channel().name);
    }
    if (token !== state.token) return;
    seg = segmentAt(now);
  }
  state.current = seg;
  if (!seg) {
    tv.removeAttribute("src");
    tv.load();
    return card("Nothing on", `${channel().number} ${channel().name} has nothing to air yet`);
  }
  if (seg.role === "filler" || !seg.src) {
    tv.pause();
    return card(seg.program ? "We'll be right back" : "Station break", seg.program ? label(seg.program) : channel().name);
  }
  hideCard();
  const at = seg.fromSec + (now - seg.start) / 1000;
  // Files the screen can't play as-is come as a live stream from the station, which starts
  // at `base` seconds into the file (a keyframe when the video is copied).
  let base = 0;
  const loaded = () => new Promise((res) => {
    const done = () => { tv.removeEventListener("loadedmetadata", done); tv.removeEventListener("error", done); res(); };
    tv.addEventListener("loadedmetadata", done);
    tv.addEventListener("error", done);
  });
  if (seg.live) {
    if (state.stream.seg === seg && !force) {
      base = state.stream.base;
    } else {
      let r;
      try {
        r = await api(`/api/live?key=${encodeURIComponent(seg.src.split("/")[2])}&at=${at.toFixed(3)}`);
      } catch {
        return card("No signal", "The station couldn't convert this file");
      }
      if (token !== state.token) return;
      base = r.start;
      stopFeed();
      state.stream = { seg, url: r.src, base, at: Date.now() };
      if (LiveFeed.supported(r.mime)) {
        state.feed = new LiveFeed(r.src, r.mime);
        await state.feed.attach(tv);
      } else {
        tv.src = r.src;                    // no MediaSource for this: plain streaming
        await loaded();
      }
      if (token !== state.token) return;
    }
  } else if (tv.getAttribute("src") !== seg.src) {
    stopFeed();
    tv.src = seg.src;
    await loaded();
    if (token !== state.token) return;
  }
  if (tv.error) return card("No signal", "This file can't be played here");
  state.base = base;
  const target = at + (Date.now() - now) / 1000 - base;
  if (seg.live) seekWhenBuffered(target, token);
  else tv.currentTime = target;
  try {
    await tv.play();
  } catch (e) {
    // A browser that wants a key press before sound says so; the app never does.
    if (e?.name === "NotAllowedError") $("power").hidden = false;
  }
}

function stopFeed() {
  state.feed?.stop();
  state.feed = null;
}

/** A live stream can only seek inside what has arrived: wait for it (briefly), then seek. */
function seekWhenBuffered(target, token) {
  if (target < 0.25) return;
  const started = Date.now();
  const tryIt = () => {
    if (token !== state.token) return;
    const t = target + (Date.now() - started) / 1000;
    for (let i = 0; i < tv.buffered.length; i++) {
      if (tv.buffered.start(i) <= t && t < tv.buffered.end(i) - 0.2) {
        tv.currentTime = t;
        return;
      }
    }
    if (Date.now() - started < 10_000) setTimeout(tryIt, 150);
  };
  tryIt();
}

function tick() {
  const seg = state.current;
  if (state.playout && (!seg || Date.now() >= seg.end)) {
    playNow(state.token);
  } else if (seg && seg.src && !tv.paused && !tv.seeking && tv.readyState >= 2) {
    const expected = seg.fromSec + (Date.now() - seg.start) / 1000 - state.base;
    if (Math.abs(tv.currentTime - expected) > DRIFT_SEC) {
      const buffered = [...Array(tv.buffered.length).keys()]
        .some((i) => tv.buffered.start(i) <= expected && expected < tv.buffered.end(i) - 0.2);
      if (!seg.live || buffered) tv.currentTime = expected;
      else if (Date.now() - state.stream.at > 15_000) playNow(state.token, true);   // fell behind: a fresh stream
    }
  }
  if (!$("infobar").hidden) updateInfo();
  if (state.guide.open) $("g-clock").textContent = time(Date.now());
}

tv.addEventListener("error", () => {
  if (state.current?.src) card("No signal", "This file can't be played here");
});

// ---------------------------------------------------------------- guide
async function openGuide() {
  state.guide.open = true;
  state.guide.row = state.index;
  state.guide.from = slotStart(Date.now());
  state.guide.at = Date.now();
  $("guide").hidden = false;
  $("infobar").hidden = true;
  await loadGuide();
}

function closeGuide() {
  state.guide.open = false;
  $("guide").hidden = true;
}

async function loadGuide() {
  const g = state.guide;
  try {
    g.data = await api(`/api/guide?from=${g.from}&to=${g.from + GUIDE_SPAN}`);
  } catch {
    g.data = null;
  }
  renderGuide();
  try {
    const b = await api("/api/breaks");
    $("g-breaks").textContent = b.running
      ? `Finding commercial breaks: ${b.done} of ${b.total} episodes (in place from midnight)` : "";
  } catch {
    $("g-breaks").textContent = "";
  }
}

function selectedBlock() {
  const g = state.guide;
  const row = g.data?.channels.find((c) => c.id === state.channels[g.row]?.id);
  return row?.blocks.find((b) => g.at >= b.start && g.at < b.end) ?? null;
}

function renderGuide() {
  const g = state.guide;
  const span = GUIDE_SPAN;
  const pct = (t) => ((t - g.from) / span) * 100;
  $("g-clock").textContent = time(Date.now());
  const times = [];
  for (let t = g.from; t < g.from + span; t += SLOT_MS) times.push(`<span style="left:${pct(t)}%">${time(t)}</span>`);
  $("g-times").innerHTML = `<div class="g-chan"></div><div class="g-timecols">${times.join("")}</div>`;

  if (!g.data || !state.channels.length) {
    $("g-rows").innerHTML = `<div class="g-empty">${state.channels.length ? "The guide is unavailable" : "No channels yet: add folders to the config"}</div>`;
    $("g-title").textContent = "";
    $("g-meta").textContent = "";
    return;
  }
  const rowsEl = $("g-rows");
  const visible = Math.max(1, Math.floor(rowsEl.clientHeight / 64) || 6);
  const first = Math.min(Math.max(0, g.row - Math.floor(visible / 2)), Math.max(0, state.channels.length - visible));
  const now = Date.now();
  const html = [];
  for (let i = first; i < Math.min(state.channels.length, first + visible + 1); i++) {
    const ch = state.channels[i];
    const blocks = g.data.channels.find((c) => c.id === ch.id)?.blocks ?? [];
    const cells = blocks.map((b) => {
      const left = Math.max(0, pct(b.start));
      const width = Math.min(100, pct(b.end)) - left;
      const sel = i === g.row && g.at >= b.start && g.at < b.end;
      const cls = ["g-cell", sel && "sel", !b.program && "break", b.start < g.from && "cut-left"].filter(Boolean).join(" ");
      return `<div class="${cls}" style="left:${left}%;width:${width}%" data-row="${i}" data-at="${Math.max(b.start, g.from)}">` +
        `<div class="t">${esc(label(b.program))}</div><div class="s">${esc(b.program?.title && b.program.show ? b.program.title : (b.program?.year ?? ""))}</div></div>`;
    }).join("");
    const nowLine = now >= g.from && now < g.from + span ? `<div class="g-now" style="left:${pct(now)}%"></div>` : "";
    html.push(`<div class="g-row${i === state.index ? " on" : ""}"><div class="g-chan"><b>${ch.number}</b><span>${esc(ch.name)}</span></div>` +
      `<div class="g-cells">${cells}${nowLine}</div></div>`);
  }
  rowsEl.innerHTML = html.join("");
  const b = selectedBlock();
  const ch = state.channels[g.row];
  $("g-title").textContent = b ? label(b.program) : ch.name;
  $("g-meta").textContent = [`${ch.number} ${ch.name}`, b ? `${time(b.start)} – ${time(b.end)}` : "", sub(b?.program)].filter(Boolean).join("  ·  ");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

async function guideKey(key) {
  const g = state.guide;
  if (key === "ArrowUp") g.row = (g.row - 1 + state.channels.length) % state.channels.length;
  else if (key === "ArrowDown") g.row = (g.row + 1) % state.channels.length;
  else if (key === "ArrowRight" || key === "ArrowLeft") {
    const b = selectedBlock();
    const t = key === "ArrowRight" ? (b ? b.end : g.at + SLOT_MS) : (b ? b.start - 1 : g.at - SLOT_MS);
    g.at = Math.max(Date.now(), t);
    if (g.at >= g.from + GUIDE_SPAN) { g.from += SLOT_MS * 2; await loadGuide(); return; }
    if (g.at < g.from) { g.from = slotStart(g.at); await loadGuide(); return; }
  } else if (key === "Enter") {
    closeGuide();
    if (g.row !== state.index) await tune(g.row);
    else showInfo();
    return;
  } else if (key === "Escape" || key === "g" || key === "G") return closeGuide();
  else return;
  renderGuide();
}

// ---------------------------------------------------------------- input
function dial(digit) {
  state.dial = (state.dial + digit).slice(-3);
  osd(state.dial.padEnd(2, "-"));
  clearTimeout(state.dialTimer);
  state.dialTimer = setTimeout(() => {
    const n = Number(state.dial);
    state.dial = "";
    const i = state.channels.findIndex((c) => c.number === n);
    if (i >= 0) tune(i);
    else osd(String(channel()?.number ?? "--"));
  }, 1500);
}

async function powerOn() {
  $("power").hidden = true;
  if (state.playout) await playNow(state.token);
}

document.addEventListener("keydown", async (e) => {
  if (!$("power").hidden) { e.preventDefault(); return powerOn(); }
  if (state.guide.open) { e.preventDefault(); return guideKey(e.key); }
  const k = e.key;
  if (k === "ArrowUp" || k === "PageUp" || k === "ChannelUp") tune(state.index + 1);
  else if (k === "ArrowDown" || k === "PageDown" || k === "ChannelDown") tune(state.index - 1);
  else if (/^[0-9]$/.test(k)) dial(k);
  else if (k === "Enter" || k === "g" || k === "G") openGuide();
  else if (k === "i" || k === "I" || k === " ") showInfo();
  else if (k === "m" || k === "M") { tv.muted = !tv.muted; osd(tv.muted ? "MUTE" : String(channel()?.number ?? "")); }
  else if (k === "f" || k === "F") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  else return;
  e.preventDefault();
});

document.addEventListener("click", async (e) => {
  document.body.classList.add("pointer");
  if (!$("power").hidden) return powerOn();
  const cell = e.target.closest?.(".g-cell");
  if (cell) {
    state.guide.row = Number(cell.dataset.row);
    state.guide.at = Number(cell.dataset.at);
    return guideKey("Enter");
  }
  if (!state.guide.open) showInfo();
});

// ---------------------------------------------------------------- start
async function boot() {
  try {
    state.channels = (await api("/api/channels")).channels;
  } catch {
    return card("Can't reach the station", "Is Primetime Machine running?");
  }
  if (!state.channels.length) {
    return card("No channels yet", "Add your video folders to the config, then rescan");
  }
  let start = 0;
  try {
    const saved = localStorage.getItem("ptm.channel");
    start = Math.max(0, state.channels.findIndex((c) => c.id === saved));
  } catch { /* storage off */ }
  await tune(start);
  setInterval(tick, 250);
  setInterval(() => { if (state.guide.open) loadGuide(); }, 60_000);
}

window.ptm = state;          // for tests and curious people
boot();
