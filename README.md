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
  The station runs it in the background on every new episode, one at a time at low
  priority, and keeps the result; breaks found today are used from midnight on.
- `core/src/sources/local.ts`: a library folder, read with ffprobe; understands the usual
  `Show (Year)/Season N/Show - S01E02 - Title` layouts. Commercials go in an `Ads/` folder,
  dated by a year folder or `(1994)` in the name.

- `station/`: the station, a small local HTTP server: lineup, guide and playout computed
  from the clock, and media streaming with seeking. Listens on this machine only by default.
- `ui/`: the TV screen: full-screen player, guide, info bar. Plain HTML/JS, no build step.
  Tested in a real browser against real video (`ui/test/e2e.py`).
- `ui/editor.html`: the commercial break editor. Every episode with the breaks detection
  found; play it, add, nudge or remove breaks, or hand it back to detection. Edits air from
  midnight, so nothing shifts under a show already on. Press E on the TV, or Edit >
  Commercial breaks in the app (`ui/test/editor_e2e.py`).

- `app/`: the desktop app (Electron). Starts the station inside itself and shows the screen
  full-screen; plays H.264/AAC MP4, which most libraries are. Asks for your folders on
  first run. Tested on real H.264 video in the real app window (`app/test/app_e2e.py`).

- `roku/`: the Roku channel. A thin client of the station on your home network: the
  native Roku program grid, channel surfing with the remote, the info bar, playing the
  station's files directly. Compiled and validated with BrighterScript, its clock logic
  unit-tested in a BrightScript interpreter, but **not yet tried on a real Roku**.

Next: try the Roku channel on a real TV, installers, then more sources. See
[docs/PLAN.md](docs/PLAN.md).

## Install

Installers for Windows, macOS and Linux are attached to each
[release](https://github.com/josfire18/primetime-machine/releases). They're not code-signed
yet: Windows SmartScreen and macOS Gatekeeper will ask you to confirm the first time
(on a Mac, right-click the app and choose Open).

## Try it from the source

Needs Node 22.18+ and ffmpeg.

```
npm install
npm run app                                    # the desktop app; asks for your folders
npm run station -- /path/to/your/library      # or just the station: open http://127.0.0.1:8420
npm test && npm run e2e                        # unit tests, then browser and app tests
```

Keys: ▲▼ change channel, number keys dial one, OK (Enter) opens the guide, I shows what's
on, M mutes, F goes full screen, E opens the commercial break editor.

**Any file plays.** MP4 (H.264/AAC) and WebM play as they are. Everything else (MKV, AC3 or
DTS sound, HEVC, MPEG-2, AVI) goes through ffmpeg on the way to the screen: the video is
copied when the screen can decode it and re-encoded only when it can't, the sound is
converted to AAC when needed, and it still starts on the clock's second.

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

**Other screens at home.** Add `"lan": true` to the config (or turn on File > Share with other
screens at home in the app, or `npm run station -- --lan`) and any phone, laptop or TV browser
on your network can open the station's address. It's off by default, so nothing outside this
machine can reach it. Either way the station only answers requests that name it by an address
or a home-network name (`.local`, `.lan`, Tailscale's `.ts.net`, this computer's name), which
keeps websites you visit from reading it through DNS rebinding.
`npm run guide -- /path` prints the next few hours instead of opening the screen.

## Roku

1. In the desktop app, turn on File > Share with other screens at home, and note an address
   from File > Addresses for other screens (like `192.168.1.20:8420`).
2. Put the Roku in developer mode: on the remote press Home 3×, Up 2×, Right, Left, Right,
   Left, Right, and follow the steps (it gives the Roku's address and asks for a password).
3. `npm run roku` builds `build/primetime-machine-roku.zip`. Open the Roku's address in a
   browser, sign in, and upload the zip.
4. Start the channel and enter the station's address. It remembers it, and the channel you
   were on.

On the remote: Up/Down change channel, OK opens the guide (OK again watches what's
selected), Back closes it, ✱ shows what's on. The Roku plays the station's files directly,
so they need to be formats it plays (H.264/AAC MP4 is the safe choice); converting the
rest on the fly (HLS via ffmpeg) is planned.

## License

MIT
