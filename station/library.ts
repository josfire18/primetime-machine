// The station's view of the world: the library it scanned, the channels it airs, and short
// keys for media so URLs never carry file paths.
//
// Config lives in one JSON file (default ~/.primetime-machine/config.json):
//   { "folders": ["D:/Video/TV", "D:/Video/Ads"], "channels": [ ...ChannelRule ] }
// With no channels configured, the station makes one per decade the library covers (plus a
// movie channel when there are movies), so a fresh install shows a full guide at once.
// The probe cache sits next to the config, so a restart only probes new or changed files.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ChannelRule, MediaItem } from "../core/src/model.ts";
import { hash } from "../core/src/rng.ts";
import { programsFor } from "../core/src/schedule.ts";
import { LocalFolder, type ProbeCache } from "../core/src/sources/local.ts";

export interface Config {
  folders: string[];
  channels?: ChannelRule[];
}

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
  return { folders: c.folders, channels: c.channels };
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

export class Library {
  items: MediaItem[] = [];
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
