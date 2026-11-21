// A folder of video files on this machine. Understands the usual library layouts:
//
//   Shows/Seinfeld (1989)/Season 4/Seinfeld - S04E11 - The Contest.mkv
//   Shows/Seinfeld.S04E11.The.Contest.1992.mkv
//   Movies/Night of the Living Dead (1968).mp4
//   Ads/1994/Crystal Pepsi.mp4            (any folder named ads/commercials holds ads)
//
// Durations come from ffprobe; nothing is guessed from file size.

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import type { Kind, MediaInfo, MediaItem, Source } from "../model.ts";

const run = promisify(execFile);

export const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".m4v", ".mpg", ".mpeg", ".ts", ".webm", ".wmv"]);
const AD_DIRS = new Set(["ads", "commercials", "commercial", "adverts"]);
const MOVIE_DIRS = new Set(["movies", "films"]);

export interface Parsed {
  kind: Kind;
  title: string;
  show?: string;
  season?: number;
  episode?: number;
  year?: number;
}

const tidy = (s: string) => s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim().replace(/^[-\s]+|[-\s]+$/g, "");
const yearIn = (s: string): number | undefined => {
  const m = s.match(/(?:^|[\s.(\[_-])((?:19|20)\d{2})(?:$|[\s.)\]_-])/);
  return m ? Number(m[1]) : undefined;
};

/** What a path says about the file, relative to the source root. */
export function parsePath(rel: string): Parsed {
  const parts = rel.split(/[\\/]/);
  const file = basename(rel, extname(rel));
  const dirs = parts.slice(0, -1);
  const lowerDirs = dirs.map((d) => d.toLowerCase());

  if (lowerDirs.some((d) => AD_DIRS.has(d))) {
    const yearDir = [...dirs].reverse().map(yearIn).find((y) => y !== undefined);
    return { kind: "ad", title: tidy(file.replace(/\(?(19|20)\d{2}\)?/, "")) || tidy(file), year: yearIn(file) ?? yearDir };
  }

  const se = file.match(/^(.*?)[\s._-]*[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})(.*)$/);
  if (se) {
    const showDir = dirs.find((d) => !/^season\s*\d+$/i.test(d) && !["shows", "tv", "tv shows"].includes(d.toLowerCase()));
    const fromFile = tidy(se[1]);
    const show = tidy((fromFile || showDir || "").replace(/\((?:19|20)\d{2}\)/, "")) || undefined;
    const rest = tidy(se[4].replace(/\(?(19|20)\d{2}\)?/, ""));
    return {
      kind: "episode",
      show,
      season: Number(se[2]),
      episode: Number(se[3]),
      title: rest || `${show ?? "Episode"} S${se[2]}E${se[3]}`,
      year: yearIn(file) ?? [...dirs].reverse().map(yearIn).find((y) => y !== undefined),
    };
  }

  const kind: Kind = lowerDirs.some((d) => MOVIE_DIRS.has(d)) ? "movie" : "episode";
  return { kind, title: tidy(file.replace(/\(?(19|20)\d{2}\)?/, "")) || tidy(file), year: yearIn(file) ?? [...dirs].reverse().map(yearIn).find((y) => y !== undefined) };
}

/** Duration (seconds) and the first video and audio codecs, from one ffprobe run. */
export async function probe(file: string): Promise<{ durationSec: number; media: MediaInfo }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", file,
  ]);
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string }[] };
  const d = Number(j.format?.duration);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`no duration for ${file}`);
  const first = (type: string) => j.streams?.find((s) => s.codec_type === type && s.codec_name)?.codec_name;
  const media: MediaInfo = {};
  const video = first("video");
  const audio = first("audio");
  if (video) media.video = video;
  if (audio) media.audio = audio;
  return { durationSec: d, media };
}

/** Duration in seconds, from ffprobe. */
export async function probeDuration(file: string): Promise<number> {
  return (await probe(file)).durationSec;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && VIDEO_EXTS.has(extname(e.name).toLowerCase())) yield p;
  }
}

/** What a scan learned about one file, kept between scans so unchanged files aren't re-probed. */
export interface ProbeRecord {
  mtimeMs: number;
  size: number;
  durationSec: number;
  /** Commercial breaks found in the file (seconds), once detection has run; [] = none found. */
  breaksSec?: number[];
  /** When they were found (epoch ms). A changed file loses both, so they're found again. */
  breaksAt?: number;
  /** The file's codecs (a record made before codecs were probed lacks this: probed again). */
  media?: MediaInfo;
}
export type ProbeCache = Record<string, ProbeRecord>;

export class LocalFolder implements Source {
  readonly id: string;
  readonly root: string;
  /** Keyed by file path. list() reads it, updates it, and drops files that are gone. */
  readonly cache: ProbeCache;

  constructor(root: string, id = `local:${root}`, cache: ProbeCache = {}) {
    this.root = root;
    this.id = id;
    this.cache = cache;
  }

  async list(): Promise<MediaItem[]> {
    const out: MediaItem[] = [];
    const seen = new Set<string>();
    for await (const file of walk(this.root)) {
      const rel = relative(this.root, file).split(sep).join("/");
      const st = await stat(file);
      seen.add(file);
      let rec = this.cache[file];
      const changed = !rec || rec.mtimeMs !== st.mtimeMs || rec.size !== st.size;
      if (changed || !rec.media) {
        let p: Awaited<ReturnType<typeof probe>>;
        try {
          p = await probe(file);
        } catch {
          delete this.cache[file];
          continue;                     // unreadable or not really video: skip it
        }
        // an unchanged file only missed its codecs: keep what was found about it before
        rec = changed ? { mtimeMs: st.mtimeMs, size: st.size, durationSec: p.durationSec, media: p.media }
                      : { ...rec, media: p.media };
        this.cache[file] = rec;
      }
      out.push({
        id: `${this.id}#${rel}`, source: this.id, locator: file, durationSec: rec.durationSec, ...parsePath(rel),
        ...(rec.media ? { media: rec.media } : {}),
        ...(rec.breaksSec?.length ? { breaksSec: rec.breaksSec } : {}),
      });
    }
    for (const file of Object.keys(this.cache)) if (file.startsWith(this.root) && !seen.has(file)) delete this.cache[file];
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
}
