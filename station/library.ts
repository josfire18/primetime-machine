// The station's view of the world: the library it scanned, the channels it airs, and short
// keys for media so URLs never carry file paths.
//
// Config lives in one JSON file (default ~/.primetime-machine/config.json):
//   { "folders": ["D:/Video/TV", "D:/Video/Ads"], "channels": [ ...ChannelRule ],
//     "lan": false, "port": 8420 }
// "lan": true shares the station with other screens on the home network (a Roku, a phone,
// another computer's browser); off by default, so only this machine can reach it.
// With no channels configured, the station makes one per decade the library covers (plus a
// movie channel when there are movies), so a fresh install shows a full guide at once.
// The probe cache sits next to the config, so a restart only probes new or changed files.
//
// Commercial breaks: after a scan, every episode not yet checked goes through ffmpeg's
// black-and-silence detection in the background, one at a time at low priority. Results live
// in the probe cache with the file. Breaks found today take effect at the next midnight, so
// ads never jump around inside a show that is already on the air, and every screen agrees on
// tomorrow from the start.
//
// The break editor (ui/editor.html) sets an episode's breaks by hand, or hands it back to
// detection. An edit follows the same midnight rule: the record keeps the versions it
// replaced, so a day that began before the edit still airs what was in force then.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type BreakOptions, detectBreaks } from "../core/src/breaks.ts";
import type { ChannelRule, MediaItem } from "../core/src/model.ts";
import { hash } from "../core/src/rng.ts";
import { adsFor, DAY_MS, programsFor } from "../core/src/schedule.ts";
import { type BreaksVersion, LocalFolder, type ProbeCache, type ProbeRecord } from "../core/src/sources/local.ts";

export interface Config {
  folders: string[];
  channels?: ChannelRule[];
  /** Share with other screens on the home network. Default false: this machine only. */
  lan?: boolean;
  port?: number;
}

export const DEFAULT_PORT = 8420;

export const DEFAULT_CONFIG = join(homedir(), ".primetime-machine", "config.json");

export async function loadConfig(path = DEFAULT_CONFIG): Promise<Config> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { folders: [] };
    throw new Error(`can't read ${path}: ${(e as Error).message}`);
  }
  const c = raw as Partial<Config>;
  if (!Array.isArray(c.folders) || !c.folders.every((f) => typeof f === "string")) {
    throw new Error(`${path}: "folders" must be a list of folder paths`);
  }
  if (c.channels !== undefined) c.channels.forEach((ch, i) => checkChannel(ch, `${path}: channels[${i}]`));
  if (c.lan !== undefined && typeof c.lan !== "boolean") throw new Error(`${path}: "lan" must be true or false`);
  if (c.port !== undefined && !(Number.isInteger(c.port) && c.port > 0 && c.port < 65536)) {
    throw new Error(`${path}: "port" must be a port number`);
  }
  return { folders: c.folders, channels: c.channels, lan: c.lan ?? false, port: c.port ?? DEFAULT_PORT };
}

function checkChannel(ch: ChannelRule, where: string): void {
  const ok = ch && typeof ch.id === "string" && ch.id && typeof ch.name === "string" &&
    Number.isInteger(ch.number) && Array.isArray(ch.years) && ch.years.length === 2 &&
    ch.years.every(Number.isInteger) && ch.years[0] <= ch.years[1];
  if (!ok) throw new Error(`${where}: needs id, name, an integer number and years [from, to]`);
}

const PROGRAM_KINDS = ["episode", "movie"] as const;
const strList = (v: unknown, what: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === "string" && x.trim() && x.length <= 120)) {
    throw new Error(`${what}: a list of names`);
  }
  const out = [...new Set(v.map((x: string) => x.trim()))];
  return out.length ? out : undefined;
};

/**
 * A channel as the lineup editor sends it (or a shared channel.json), checked field by field and
 * reduced to the fields a channel has. Throws "channel: ..." with what's wrong.
 */
export function cleanChannel(raw: unknown): ChannelRule {
  const c = (raw ?? {}) as Record<string, unknown>;
  const fail = (why: string) => { throw new Error(`channel ${JSON.stringify(c.name ?? c.id ?? "?")}: ${why}`); };
  if (typeof c.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(c.id)) fail("id: lowercase letters, digits and dashes");
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 40) fail("name: 1 to 40 characters");
  if (!Number.isInteger(c.number) || (c.number as number) < 1 || (c.number as number) > 999) fail("number: 1 to 999");
  const y = c.years as unknown[];
  if (!Array.isArray(y) || y.length !== 2 || !y.every((v) => Number.isInteger(v) && (v as number) >= 1900 && (v as number) <= 2100) ||
      (y[0] as number) > (y[1] as number)) fail("years: [from, to], from 1900 to 2100");
  const rule: ChannelRule = { id: c.id as string, number: c.number as number, name: (c.name as string).trim(),
                              years: [y[0] as number, y[1] as number] };
  if (c.kinds !== undefined) {
    if (!Array.isArray(c.kinds) || !c.kinds.length || !c.kinds.every((k) => (PROGRAM_KINDS as readonly unknown[]).includes(k))) {
      fail("kinds: episode and/or movie");
    }
    const kinds = [...new Set(c.kinds as NonNullable<ChannelRule["kinds"]>)];
    if (!(kinds.length === 1 && kinds[0] === "episode")) rule.kinds = kinds;
  }
  try {
    const shows = strList(c.shows, "shows");
    const genres = strList(c.genres, "genres");
    const networks = strList(c.networks, "networks");
    if (shows) rule.shows = shows;
    if (genres) rule.genres = genres;
    if (networks) rule.networks = networks;
  } catch (e) {
    fail((e as Error).message);
  }
  if (c.slotMinutes !== undefined) {
    if (!Number.isInteger(c.slotMinutes) || (c.slotMinutes as number) < 1 || (c.slotMinutes as number) > 240) fail("slotMinutes: 1 to 240");
    if (c.slotMinutes !== 30) rule.slotMinutes = c.slotMinutes as number;
  }
  if (c.seed !== undefined) {
    if (typeof c.seed !== "string" || c.seed.length > 40) fail("seed: a short text");
    if (c.seed) rule.seed = c.seed as string;
  }
  return rule;
}

/** A whole lineup, checked: every channel, and no two sharing an id or a number. */
export function cleanLineup(raw: unknown): ChannelRule[] {
  if (!Array.isArray(raw) || raw.length > 200) throw new Error("channels: a list of at most 200");
  const out = raw.map(cleanChannel);
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const ch of out) {
    if (ids.has(ch.id)) throw new Error(`channel ${JSON.stringify(ch.name)}: id ${ch.id} is used twice`);
    if (numbers.has(ch.number)) throw new Error(`channel ${JSON.stringify(ch.name)}: number ${ch.number} is used twice`);
    ids.add(ch.id);
    numbers.add(ch.number);
  }
  return out.sort((a, b) => a.number - b.number);
}

/** What the library holds, for building channels: shows with their years, and the rest. */
export interface Catalog {
  years?: [number, number];
  shows: { name: string; years: [number, number]; episodes: number }[];
  movies: number;
  genres: string[];
  networks: string[];
}

/** One channel per decade the library covers, and a movie channel if it has movies. */
export function defaultChannels(library: readonly MediaItem[]): ChannelRule[] {
  const years = library.filter((m) => m.kind === "episode").map((m) => m.year).filter((y): y is number => y !== undefined);
  const out: ChannelRule[] = [];
  let number = 2;
  if (years.length) {
    for (let d = Math.floor(Math.min(...years) / 10) * 10; d <= Math.max(...years); d += 10) {
      const rule: ChannelRule = { id: `${d}s`, number, name: `The ${String(d).slice(2)}s`, years: [d, d + 9] };
      if (programsFor(rule, library).length) {
        out.push(rule);
        number++;
      }
    }
  }
  const movieYears = library.filter((m) => m.kind === "movie").map((m) => m.year).filter((y): y is number => y !== undefined);
  if (movieYears.length) {
    out.push({ id: "movies", number: Math.max(number, 30), name: "Movie Classics", kinds: ["movie"],
               years: [Math.min(...movieYears), Math.max(...movieYears)], slotMinutes: 30 });
  }
  return out;
}

/** A short, stable, path-free key for an item, used in media URLs. */
export const mediaKey = (item: MediaItem): string => hash(item.id).toString(36);

/** The most breaks an episode can have (a feature film cut for TV had about a dozen). */
export const MAX_BREAKS = 24;

/** The breaks a record had in force on `day`: its newest version made before that day began. */
function inForce(rec: ProbeRecord | undefined, day: number): BreaksVersion | undefined {
  if (!rec) return undefined;
  if (rec.breaksAt !== undefined && rec.breaksAt <= day) return { breaksSec: rec.breaksSec ?? [], breaksAt: rec.breaksAt };
  return rec.earlier?.find((v) => v.breaksAt <= day);
}

/** Older versions worth keeping: everything from the last two days, plus the one before that. */
function trimEarlier(versions: BreaksVersion[], now: number): BreaksVersion[] {
  const recent = versions.filter((v) => v.breaksAt > now - 2 * DAY_MS);
  const older = versions.find((v) => v.breaksAt <= now - 2 * DAY_MS);
  return [...recent, ...(older ? [older] : [])].slice(0, 12);
}

/** A list of break points from the editor, checked: ascending seconds inside the episode. */
export function checkBreaks(value: unknown, durationSec: number): number[] {
  if (!Array.isArray(value) || value.length > MAX_BREAKS) throw new Error(`breaks: a list of at most ${MAX_BREAKS} times`);
  const out = value.map((v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= durationSec) {
      throw new Error("breaks: each is seconds from the start, inside the episode");
    }
    return Math.round(v * 100) / 100;
  }).sort((a, b) => a - b);
  for (let i = 1; i < out.length; i++) if (out[i] - out[i - 1] < 1) throw new Error("breaks: two are less than a second apart");
  return out;
}

/** One episode as the break editor sees it. */
export interface EpisodeBreaks {
  key: string;
  show?: string;
  season?: number;
  episode?: number;
  title: string;
  year?: number;
  durationSec: number;
  /** "pending": not checked yet; "found"/"none": detection's result; "edited": set by hand. */
  status: "pending" | "found" | "none" | "edited";
  /** The current breaks (from the next midnight, if they changed today). */
  breaksSec: number[];
  /** When they were set (epoch ms). */
  since?: number;
  /** What airs today, when that differs from breaksSec. */
  today?: number[];
}

export interface BreakJob {
  running: boolean;
  /** Episodes with a break result (including "none found"). */
  done: number;
  total: number;
  failed: number;
  current?: string;
}

export class Library {
  items: MediaItem[] = [];
  breakJob: BreakJob = { running: false, done: 0, total: 0, failed: 0 };
  /** Detection settings; tests shorten the edges. */
  breakOptions: BreakOptions = {};
  private dayViews = new Map<string, MediaItem[]>();
  private detecting: Promise<void> | null = null;
  private detectAgain = false;
  channels: ChannelRule[] = [];
  /** The lineup came from defaultChannels (none configured). */
  autoChannels = true;
  /** Bumps when the lineup changes, so screens and caches can tell. */
  lineupAt = 0;
  private byKey = new Map<string, MediaItem>();
  private cache: ProbeCache = {};
  readonly configPath: string;
  private cachePath: string;
  scannedAt = 0;

  constructor(configPath = DEFAULT_CONFIG) {
    this.configPath = configPath;
    this.cachePath = join(dirname(configPath), "probe-cache.json");
  }

  /** Read the config, scan every folder (probing only new or changed files), pick channels. */
  async scan(): Promise<void> {
    const config = await loadConfig(this.configPath);
    try {
      this.cache = JSON.parse(await readFile(this.cachePath, "utf8"));
    } catch {
      this.cache = {};
    }
    const items: MediaItem[] = [];
    for (const folder of config.folders) items.push(...await new LocalFolder(folder, `local:${folder}`, this.cache).list());
    this.items = items;
    this.byKey = new Map(items.map((m) => [mediaKey(m), m]));
    this.autoChannels = !config.channels?.length;
    this.channels = (config.channels?.length ? config.channels : defaultChannels(items))
      .slice().sort((a, b) => a.number - b.number);
    this.scannedAt = Date.now();
    this.lineupAt = this.scannedAt;
    this.dayViews.clear();
    await this.saveCache();
  }

  /** The library's shows, years and so on, for the lineup editor. */
  catalog(): Catalog {
    const shows = new Map<string, { name: string; years: [number, number]; episodes: number }>();
    const genres = new Set<string>();
    const networks = new Set<string>();
    let lo = Infinity;
    let hi = -Infinity;
    let movies = 0;
    for (const m of this.items) {
      if (m.kind !== "episode" && m.kind !== "movie") continue;
      if (m.year !== undefined) { lo = Math.min(lo, m.year); hi = Math.max(hi, m.year); }
      for (const g of m.genres ?? []) genres.add(g);
      if (m.network) networks.add(m.network);
      if (m.kind === "movie") { movies++; continue; }
      if (m.show === undefined) continue;
      const s = shows.get(m.show.toLowerCase()) ?? { name: m.show, years: [m.year ?? 0, m.year ?? 0] as [number, number], episodes: 0 };
      s.episodes++;
      if (m.year !== undefined) s.years = [s.years[0] ? Math.min(s.years[0], m.year) : m.year, Math.max(s.years[1], m.year)];
      shows.set(m.show.toLowerCase(), s);
    }
    return {
      ...(lo <= hi ? { years: [lo, hi] as [number, number] } : {}),
      shows: [...shows.values()].sort((a, b) => a.name.localeCompare(b.name)),
      movies, genres: [...genres].sort(), networks: [...networks].sort(),
    };
  }

  /** What a channel would air: how many programs, from which shows. */
  preview(rule: ChannelRule): { programs: number; runSec: number; shows: { name: string; episodes: number }[]; movies: number; ads: number } {
    const programs = programsFor(rule, this.items);
    const shows = new Map<string, number>();
    let movies = 0;
    for (const m of programs) {
      if (m.kind === "movie") movies++;
      else if (m.show) shows.set(m.show, (shows.get(m.show) ?? 0) + 1);
    }
    const ads = adsFor(rule, this.items).length;
    return {
      programs: programs.length, movies, ads,
      runSec: Math.round(programs.reduce((t, m) => t + m.durationSec, 0)),
      shows: [...shows].map(([name, episodes]) => ({ name, episodes })).sort((a, b) => b.episodes - a.episodes || a.name.localeCompare(b.name)),
    };
  }

  /**
   * Replace the lineup (`null`: back to one channel per decade) and save it in the config,
   * keeping everything else there as it was. The new lineup airs at once.
   */
  async setChannels(raw: unknown): Promise<ChannelRule[]> {
    const lineup = raw === null ? null : cleanLineup(raw);
    if (lineup && !lineup.length) throw new Error("channels: at least one (or go back to automatic)");
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await readFile(this.configPath, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (lineup) config.channels = lineup;
    else delete config.channels;
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
    await rename(tmp, this.configPath);
    this.autoChannels = !lineup;
    this.channels = (lineup ?? defaultChannels(this.items)).slice().sort((a, b) => a.number - b.number);
    this.lineupAt = Math.max(Date.now(), this.lineupAt + 1);
    return this.channels;
  }

  /** A short key that changes when the breaks in force on `day` change (for day caches). */
  breaksKey(day: number): string {
    let n = 0;
    let sum = 0;
    for (const m of this.items) {
      const v = inForce(this.cache[m.locator], day);
      if (v) { n++; sum = (sum + v.breaksAt) % 1e15; }
    }
    return `${n}.${sum}`;
  }

  /** The library as it airs on `day`: breaks set after that day began aren't used yet. */
  itemsForDay(day: number): MediaItem[] {
    const key = `${this.scannedAt}|${day}|${this.breaksKey(day)}`;
    let view = this.dayViews.get(key);
    if (!view) {
      view = this.items.map((m) => {
        const v = inForce(this.cache[m.locator], day);
        if (v?.breaksSec.length) return { ...m, breaksSec: v.breaksSec };
        if (m.breaksSec) {
          const { breaksSec: _drop, ...rest } = m;
          return rest;
        }
        return m;
      });
      if (this.dayViews.size > 16) this.dayViews.clear();
      this.dayViews.set(key, view);
    }
    return view;
  }

  /** Every episode with its breaks, for the editor. */
  episodeBreaks(now = Date.now()): EpisodeBreaks[] {
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    return this.items.filter((m) => m.kind === "episode").map((m) => {
      const rec = this.cache[m.locator];
      const breaksSec = rec?.breaksSec ?? [];
      const status = rec?.breaksAt === undefined ? "pending" : rec.breaksEdited ? "edited" : breaksSec.length ? "found" : "none";
      const airing = inForce(rec, today)?.breaksSec ?? [];
      const out: EpisodeBreaks = {
        key: mediaKey(m), title: m.title, durationSec: m.durationSec, status, breaksSec,
        ...(m.show !== undefined ? { show: m.show } : {}), ...(m.season !== undefined ? { season: m.season } : {}),
        ...(m.episode !== undefined ? { episode: m.episode } : {}), ...(m.year !== undefined ? { year: m.year } : {}),
        ...(rec?.breaksAt !== undefined ? { since: rec.breaksAt } : {}),
      };
      if (airing.join() !== breaksSec.join()) out.today = airing;
      return out;
    }).sort((a, b) => `${a.show ?? a.title}`.localeCompare(`${b.show ?? b.title}`) ||
      (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title));
  }

  /**
   * Set an episode's breaks by hand, or with `null` hand it back to detection. Takes effect at
   * the next midnight; today keeps the version it began with.
   */
  async setBreaks(key: string, breaks: unknown): Promise<EpisodeBreaks> {
    const item = this.item(key);
    const rec = item && this.cache[item.locator];
    if (!item || item.kind !== "episode" || !rec) throw new Error("no such episode");
    const list = breaks === null ? null : checkBreaks(breaks, item.durationSec);
    const now = Date.now();
    if (rec.breaksAt !== undefined) {
      const was: BreaksVersion = { breaksSec: rec.breaksSec ?? [], breaksAt: rec.breaksAt, ...(rec.breaksEdited ? { edited: true } : {}) };
      rec.earlier = trimEarlier([was, ...(rec.earlier ?? [])], now);
    }
    delete rec.breaksEdited;
    if (list === null) {
      delete rec.breaksSec;
      delete rec.breaksAt;
    } else {
      rec.breaksSec = list;
      rec.breaksAt = Math.max(now, (rec.earlier?.[0]?.breaksAt ?? 0) + 1);   // versions never share a time
      rec.breaksEdited = true;
    }
    this.dayViews.clear();
    await this.saveCache();
    if (list === null) void this.detectBreaks();
    return this.episodeBreaks(now).find((e) => e.key === key)!;
  }

  /** Find the breaks of every episode not yet checked. Safe to call again: one job at a time. */
  detectBreaks(): Promise<void> {
    if (this.detecting) {
      this.detectAgain = true;            // an episode handed back mid-job is picked up after it
      return this.detecting;
    }
    this.detecting = this.runBreakJob().finally(() => {
      this.detecting = null;
      if (this.detectAgain) {
        this.detectAgain = false;
        void this.detectBreaks();
      }
    });
    return this.detecting;
  }

  private async runBreakJob(): Promise<void> {
    const episodes = this.items.filter((m) => m.kind === "episode");
    const todo = episodes.filter((m) => this.cache[m.locator] && this.cache[m.locator].breaksAt === undefined);
    this.breakJob = { running: true, done: episodes.length - todo.length, total: episodes.length, failed: 0 };
    let unsaved = 0;
    for (const m of todo) {
      this.breakJob.current = m.show ? `${m.show}: ${m.title}` : m.title;
      const was = this.cache[m.locator];
      let found: number[] = [];
      try {
        found = await detectBreaks(m.locator, m.durationSec, this.breakOptions);
      } catch {
        this.breakJob.failed++;           // unreadable: recorded as "none found", not retried
      }
      const rec = this.cache[m.locator];
      // the file may have changed or gone during detection, or been edited by hand meanwhile
      if (rec && rec.breaksAt === undefined && rec.mtimeMs === was.mtimeMs && rec.size === was.size) {
        rec.breaksSec = found;
        rec.breaksAt = Math.max(Date.now(), (rec.earlier?.[0]?.breaksAt ?? 0) + 1);
      }
      this.breakJob.done++;
      if (++unsaved >= 10) {
        await this.saveCache();
        unsaved = 0;
      }
    }
    this.breakJob.running = false;
    this.breakJob.current = undefined;
    await this.saveCache();
  }

  private async saveCache(): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.cache));
    await rename(tmp, this.cachePath);
  }

  item(key: string): MediaItem | undefined {
    return this.byKey.get(key);
  }

  channel(id: string): ChannelRule | undefined {
    return this.channels.find((c) => c.id === id);
  }
}
