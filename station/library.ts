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
import { DAY_MS, programsFor } from "../core/src/schedule.ts";
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
    this.channels = (config.channels?.length ? config.channels : defaultChannels(items))
      .slice().sort((a, b) => a.number - b.number);
    this.scannedAt = Date.now();
    this.dayViews.clear();
    await this.saveCache();
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
