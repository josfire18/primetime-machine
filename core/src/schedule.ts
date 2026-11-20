// What is on the air, computed from the clock.
//
// A channel's day is a pure function of (its rule, the library, the date): walk the guide grid
// from the start of the day, put a whole program in each time slot (a 22-minute sitcom takes a
// 30-minute slot, a 44-minute drama an hour), and spread the time left over across the
// program's own commercial breaks as ad pods from the channel's years. Every device computes
// the same day, so there is no server and nothing to keep in sync. Tuning in at 8:25 to the
// 8:00 slot lands 25 minutes into that slot's playout: some of the episode plus the ads that
// already ran.
//
// Days start at UTC midnight. Slots are multiples of the grid size since then, so in any time
// zone with a whole- or half-hour offset programs start on :00 and :30 local time.

import type { Block, ChannelRule, MediaItem, Segment } from "./model.ts";
import { rng, shuffled } from "./rng.ts";

export const DAY_MS = 86_400_000;
/** Ads may come from up to this many years either side of a channel's range. */
export const AD_YEAR_SLACK = 1;
/** Breaks closer than this to the start or end of a program are ignored. */
const BREAK_EDGE_SEC = 60;
/** Without detected breaks, one break per this much content. */
const DEFAULT_ACT_SEC = 8 * 60;

const lower = (xs?: string[]) => (xs ?? []).map((x) => x.toLowerCase());
const ms = (sec: number) => Math.round(sec * 1000);

/** Programs a channel may air: right kind, inside its years, matching its filters. */
export function programsFor(rule: ChannelRule, library: readonly MediaItem[]): MediaItem[] {
  const kinds = rule.kinds ?? ["episode"];
  const [from, to] = rule.years;
  const genres = lower(rule.genres);
  const shows = lower(rule.shows);
  const networks = lower(rule.networks);
  return library.filter(
    (m) =>
      kinds.includes(m.kind) &&
      m.durationSec > 0 &&
      m.year !== undefined && m.year >= from && m.year <= to &&
      (!genres.length || lower(m.genres).some((g) => genres.includes(g))) &&
      (!shows.length || (m.show !== undefined && shows.includes(m.show.toLowerCase()))) &&
      (!networks.length || (m.network !== undefined && networks.includes(m.network.toLowerCase()))),
  );
}

/** Ads that ran in the channel's years. Ads without a year are never placed: their era is unknown. */
export function adsFor(rule: ChannelRule, library: readonly MediaItem[]): MediaItem[] {
  const [from, to] = rule.years;
  return library.filter(
    (m) =>
      m.kind === "ad" && m.durationSec > 0 && m.year !== undefined &&
      m.year >= from - AD_YEAR_SLACK && m.year <= to + AD_YEAR_SLACK,
  );
}

export function slotMs(rule: ChannelRule): number {
  const s = (rule.slotMinutes ?? 30) * 60_000;
  if (s <= 0 || DAY_MS % s !== 0) throw new Error(`slotMinutes must divide a day: ${rule.slotMinutes}`);
  return s;
}

export function dayStart(atMs: number): number {
  return Math.floor(atMs / DAY_MS) * DAY_MS;
}

/** Where the ad pods go inside a program: its detected breaks, else evenly spaced acts. */
export function breakPoints(program: MediaItem): number[] {
  const d = program.durationSec;
  const known = (program.breaksSec ?? [])
    .filter((b) => b > BREAK_EDGE_SEC && b < d - BREAK_EDGE_SEC)
    .sort((a, b) => a - b);
  if (known.length) return known;
  const acts = Math.max(1, Math.round(d / DEFAULT_ACT_SEC));
  return Array.from({ length: acts - 1 }, (_, i) => (d * (i + 1)) / acts);
}

/** Fill `lengthMs` from `start` with whole ads, then filler for whatever no ad fits. */
function adPod(start: number, lengthMs: number, ads: readonly MediaItem[], rand: () => number): Segment[] {
  const out: Segment[] = [];
  let t = start;
  const end = start + lengthMs;
  for (const ad of shuffled(ads, rand)) {
    const d = ms(ad.durationSec);
    if (t + d > end) continue;
    out.push({ role: "ad", item: ad, fromSec: 0, toSec: ad.durationSec, start: t, end: t + d });
    t += d;
  }
  if (t < end) out.push({ role: "filler", fromSec: 0, toSec: (end - t) / 1000, start: t, end });
  return out;
}

/** Playout for one slot: program acts with ad pods at its breaks and one at the end. */
export function playout(
  program: MediaItem, start: number, end: number, ads: readonly MediaItem[], seed: string,
): Segment[] {
  const breaks = breakPoints(program);
  const spare = end - start - ms(program.durationSec);
  const pods = breaks.length + 1;
  const segs: Segment[] = [];
  let t = start;
  let prev = 0;
  breaks.forEach((b, i) => {
    segs.push({ role: "program", item: program, fromSec: prev, toSec: b, start: t, end: t + ms(b - prev) });
    t += ms(b - prev);
    const pod = adPod(t, Math.floor(spare / pods), ads, rng(`${seed}|pod${i}`));
    segs.push(...pod);
    t = pod.length ? pod[pod.length - 1].end : t;
    prev = b;
  });
  const last = ms(program.durationSec - prev);
  segs.push({ role: "program", item: program, fromSec: prev, toSec: program.durationSec, start: t, end: t + last });
  t += last;
  segs.push(...adPod(t, end - t, ads, rng(`${seed}|pod${breaks.length}`)));
  return segs.filter((s) => s.end > s.start);
}

/**
 * One channel's whole day. `programs` and `ads` are already filtered for the channel
 * (programsFor / adsFor). No program airs twice in a day while unaired ones still fit.
 */
export function dayBlocks(
  rule: ChannelRule, programs: readonly MediaItem[], ads: readonly MediaItem[], day: number,
): Block[] {
  const slot = slotMs(rule);
  const seed = `${rule.seed ?? ""}|${rule.id}|${day}`;
  const order = shuffled(programs, rng(seed));
  const used = new Set<string>();
  const blocks: Block[] = [];
  for (let t = day; t < day + DAY_MS; ) {
    const room = day + DAY_MS - t;
    const fits = (m: MediaItem) => Math.ceil(ms(m.durationSec) / slot) * slot <= room;
    const pick = order.find((m) => !used.has(m.id) && fits(m)) ?? order.find(fits);
    if (!pick) {
      // nothing fits the rest of the day: a station break until midnight
      blocks.push({
        channelId: rule.id, program: null, start: t, end: day + DAY_MS,
        segments: adPod(t, day + DAY_MS - t, ads, rng(`${seed}|signoff`)),
      });
      break;
    }
    used.add(pick.id);
    const end = t + Math.ceil(ms(pick.durationSec) / slot) * slot;
    blocks.push({ channelId: rule.id, program: pick, start: t, end, segments: playout(pick, t, end, ads, `${seed}|${t}`) });
    t = end;
  }
  return blocks;
}

export interface OnAir {
  block: Block;
  segment: Segment;
  /** Seconds into the segment's item (or into the filler) at that moment. */
  offsetSec: number;
}

/** What a channel is airing at `atMs`, and where in it to start playing. */
export function onAir(rule: ChannelRule, library: readonly MediaItem[], atMs: number): OnAir | null {
  const programs = programsFor(rule, library);
  if (!programs.length) return null;
  for (const block of dayBlocks(rule, programs, adsFor(rule, library), dayStart(atMs))) {
    if (atMs < block.start || atMs >= block.end) continue;
    const segment = block.segments.find((s) => atMs >= s.start && atMs < s.end);
    if (!segment) return null;
    return { block, segment, offsetSec: segment.fromSec + (atMs - segment.start) / 1000 };
  }
  return null;
}

/** Guide entries overlapping [fromMs, toMs), across day boundaries. */
export function guide(rule: ChannelRule, library: readonly MediaItem[], fromMs: number, toMs: number): Block[] {
  const programs = programsFor(rule, library);
  if (!programs.length) return [];
  const ads = adsFor(rule, library);
  const out: Block[] = [];
  for (let day = dayStart(fromMs); day < toMs; day += DAY_MS) {
    out.push(...dayBlocks(rule, programs, ads, day).filter((b) => b.end > fromMs && b.start < toMs));
  }
  return out;
}
