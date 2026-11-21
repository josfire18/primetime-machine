// The shapes everything else agrees on. A source turns whatever it reads (a folder, a media
// server, an archive) into MediaItems; channels are rules over those items; the scheduler
// turns rules plus the clock into what is on the air.

export type Kind = "episode" | "movie" | "ad" | "bumper";

export interface MediaItem {
  /** Stable id: the source's id plus its locator, so a rescan keeps the same id. */
  id: string;
  /** Which source plug-in can play it. */
  source: string;
  /** What that source needs to play it: a file path, a URL, a server item id. */
  locator: string;
  kind: Kind;
  title: string;
  show?: string;
  season?: number;
  episode?: number;
  /** First air or release year. Ads: the year they ran. */
  year?: number;
  durationSec: number;
  /** Where the original commercial breaks were, in seconds from the start, ascending. */
  breaksSec?: number[];
  genres?: string[];
  network?: string;
  /** What's inside the file, when known: decides whether a screen can play it as-is. */
  media?: MediaInfo;
}

export interface MediaInfo {
  /** ffprobe's codec names, e.g. "h264", "hevc", "vp9"; "aac", "ac3", "dts", "opus". */
  video?: string;
  audio?: string;
}

export interface ChannelRule {
  id: string;
  /** What the guide shows and the remote dials. */
  number: number;
  name: string;
  /** Air years this channel draws programs and ads from, inclusive. */
  years: [number, number];
  /** Program kinds on this channel. Default: episodes. */
  kinds?: Kind[];
  /** Any of these, when given. Matched case-insensitively. */
  genres?: string[];
  shows?: string[];
  networks?: string[];
  /** Guide grid size. Default 30 minutes. */
  slotMinutes?: number;
  /** Changes the shuffle; the same seed gives the same schedule everywhere. */
  seed?: string;
}

export type Role = "program" | "ad" | "filler";

/** One continuous piece of playout: part of a program, an ad, or filler. */
export interface Segment {
  role: Role;
  /** Absent for filler (the "we'll be right back" card). */
  item?: MediaItem;
  /** Range of the item that plays, in seconds into the item. */
  fromSec: number;
  toSec: number;
  /** Wall-clock span, epoch milliseconds. */
  start: number;
  end: number;
}

/** One guide entry: a program and everything that airs in its time slot. */
export interface Block {
  channelId: string;
  /** null for a station break: the end of a day where no program fits. */
  program: MediaItem | null;
  start: number;
  end: number;
  segments: Segment[];
}

/** A place media comes from. Anyone can write one; the app ships a few. */
export interface Source {
  id: string;
  list(): Promise<MediaItem[]>;
}
