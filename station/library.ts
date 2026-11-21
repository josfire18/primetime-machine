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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type BreakOptions, detectBreaks } from "../core/src/breaks.ts";
import type { ChannelRule, MediaItem } from "../core/src/model.ts";
import { hash } from "../core/src/rng.ts";
import { programsFor } from "../core/src/schedule.ts";
import { LocalFolder, type ProbeCache } from "../core/src/sources/local.ts";

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

  /** When a file's breaks were found, if they have been. */
  private breaksAt(item: MediaItem): number | undefined {
    return this.cache[item.locator]?.breaksAt;
  }

  /** A short key that changes when the breaks in force on `day` change (for day caches). */
  breaksKey(day: number): string {
    let n = 0;
    let latest = 0;
    for (const m of this.items) {
      const at = this.breaksAt(m);
      if (at !== undefined && at <= day) { n++; latest = Math.max(latest, at); }
    }
    return `${n}.${latest}`;
  }

  /** The library as it airs on `day`: breaks found after that day began aren't used yet. */
  itemsForDay(day: number): MediaItem[] {
    const key = `${this.scannedAt}|${day}|${this.breaksKey(day)}`;
    let view = this.dayViews.get(key);
    if (!view) {
      view = this.items.map((m) => {
        const at = this.breaksAt(m);
        const rec = this.cache[m.locator];
        if (at !== undefined && at <= day && rec?.breaksSec?.length) return { ...m, breaksSec: rec.breaksSec };
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

  /** Find the breaks of every episode not yet checked. Safe to call again: one job at a time. */
  detectBreaks(): Promise<void> {
    this.detecting ??= this.runBreakJob().finally(() => { this.detecting = null; });
    return this.detecting;
  }

  private async runBreakJob(): Promise<void> {
    const episodes = this.items.filter((m) => m.kind === "episode");
    const todo = episodes.filter((m) => this.cache[m.locator] && this.cache[m.locator].breaksAt === undefined);
    this.breakJob = { running: true, done: episodes.length - todo.length, total: episodes.length, failed: 0 };
    let unsaved = 0;
    for (const m of todo) {
      this.breakJob.current = m.show ? `${m.show}: ${m.title}` : m.title;
      let found: number[] = [];
      try {
        found = await detectBreaks(m.locator, m.durationSec, this.breakOptions);
      } catch {
        this.breakJob.failed++;           // unreadable: recorded as "none found", not retried
      }
      const rec = this.cache[m.locator];
      if (rec) {                          // the file may have changed or gone during detection
        rec.breaksSec = found;
        rec.breaksAt = Date.now();
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
