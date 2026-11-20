# Primetime Machine

Live TV from your own library, the way it used to air. Pick a channel and you land in the
middle of whatever's on, with commercials from the right year in the breaks where they
originally ran.

- **Channels by rule, not by playlist.** Decades, years, shows, genres, networks:
  "Nineties sitcoms", "TGIF '94", "Saturday morning". Any channel, any year.
- **Era-correct commercials** at each episode's own break points. The breaks are found where
  the original ads were cut: a fade to black with the sound dropping out.
- **Tune in mid-show.** The schedule is computed from the clock, so at 8:25 you join the
  8:00 episode 25 minutes in, ads included. Every device agrees, with no server.
- **A cable-style guide** (planned): channel grid, 30-minute slots, info bar, remote-first.
  Desktop app plus a Roku channel that plays from it over your home network.

It ships with **no content and no list of sources**. It plays what you point it at: your own
files, your Plex or Jellyfin server, or public-domain archives. Sources are plug-ins, so
anyone with a legally hosted source can add one.

## Status

Early. The core works and is tested on real video files:

- `core/src/schedule.ts`: clock-based channel schedules, ad pods at breaks, tune-in offsets.
- `core/src/breaks.ts`: commercial-break detection with ffmpeg (black frames plus silence).
- `core/src/sources/local.ts`: a library folder, read with ffprobe; understands the usual
  `Show (Year)/Season N/Show - S01E02 - Title` layouts. Commercials go in an `Ads/` folder,
  dated by a year folder or `(1994)` in the name.

Next: the desktop app and guide, LAN streaming to Roku, then more sources. See
[docs/PLAN.md](docs/PLAN.md).

## Try it

Needs Node 22.18+ and ffmpeg.

```
npm install
npm test
npm run guide -- /path/to/your/library
```

## License

MIT
