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
- **A cable-style guide**: channel grid, 30-minute slots, info bar, on-screen channel
  numbers, static between channels. Remote-first: arrows, number keys, OK.
  A desktop app and a Roku channel that plays from it over your home network are next.

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

- `station/`: the station, a small local HTTP server: lineup, guide and playout computed
  from the clock, and media streaming with seeking. Listens on this machine only by default.
- `ui/`: the TV screen: full-screen player, guide, info bar. Plain HTML/JS, no build step.
  Tested in a real browser against real video (`ui/test/e2e.py`).

- `app/`: the desktop app (Electron). Starts the station inside itself and shows the screen
  full-screen; plays H.264/AAC MP4, which most libraries are. Asks for your folders on
  first run. Tested on real H.264 video in the real app window (`app/test/app_e2e.py`).

Next: installers, LAN streaming to Roku, then more sources. See [docs/PLAN.md](docs/PLAN.md).

## Try it

Needs Node 22.18+ and ffmpeg.

```
npm install
npm run app                                    # the desktop app; asks for your folders
npm run station -- /path/to/your/library      # or just the station: open http://127.0.0.1:8420
npm test && npm run e2e                        # unit tests, then browser and app tests
```

Keys: ▲▼ change channel, number keys dial one, OK (Enter) opens the guide, I shows what's
on, M mutes, F goes full screen. The app plays H.264/AAC MP4 and WebM; in a browser it
depends on the browser (Chrome plays both).

To keep a library and your own channels, put them in `~/.primetime-machine/config.json`
and run `npm run station` with no folders:

```json
{
  "folders": ["/media/TV", "/media/Commercials"],
  "channels": [
    { "id": "tgif", "number": 4, "name": "TGIF", "years": [1989, 1996], "genres": ["Comedy"] },
    { "id": "vice", "number": 11, "name": "Cop Shows", "years": [1980, 1989], "shows": ["Miami Vice"] }
  ]
}
```

With no channels listed you get one per decade your library covers, plus a movie channel.
`npm run guide -- /path` prints the next few hours instead of opening the screen.

## License

MIT
