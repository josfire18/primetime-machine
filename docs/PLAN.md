# Primetime Machine: plan

A retro live-TV app in the spirit of Back When TV, but better: curated channels from any era, period ads at each episode's real break points, a cable-style guide, and tune-in mid-episode by the clock. Open source on GitHub (josfire18), free, no hosting: it runs on the viewer's own hardware.

Build with Jarvis once he's back up: Claude designs and reviews, Jarvis does cataloging/tagging on local models.

## Ground rules
- **The app ships no content and no source list.** It plays what each user points it at.
- **Sources are plug-ins.** Anyone can add one; the app doesn't need to know about it ahead of time.
- **Built-in sources:** local folders, Plex, Jellyfin/Emby, Internet Archive (public-domain shows and commercials), and a generic "source manifest" (see below).
- We don't write, ship or link adapters for unlicensed streaming sites. A user's own legally hosted source plugs in through the manifest or a plug-in.
- No telemetry, accounts or servers we run.

## Pieces
1. **Core library** (TypeScript, shared by everything)
   - Source plug-in interface: `list()`, `metadata(item)`, `resolve(item) -> playable URL or file`, plus optional `breaks(item)`.
   - Catalog: every item with show, season/episode, air year, runtime, genre, network, and ad-break timestamps.
   - Channel rules, scheduler and ad placement (below).
2. **Station** (`station/`, built): a small local HTTP server around the core. It scans the
   folders (probing only new or changed files), computes the lineup, guide and playout from
   the clock, and streams media with seeking. Every screen talks to it the same way.
3. **TV screen** (`ui/`, built): the player, guide and info bar as a plain web page served by
   the station. The desktop app is a window on it; a browser on the same machine works too.
4. **Desktop app** (Electron; Windows/Mac/Linux): starts the station and opens the screen
   full-screen. Electron because its Chromium plays H.264/AAC, which most libraries use.
   - Doubles as the home station for the Roku: LAN access is an opt-in setting, then HLS via
     ffmpeg for files the Roku can't play directly. No internet hosting.
5. **Roku app** (BrightScript/SceneGraph)
   - Thin client: guide plus player, talks to the desktop app on the LAN.
   - Installed as a private/sideloaded channel, like Jellyfin's.
6. **Later:** Android TV / Fire TV client.

## How the key features work
- **Clock-based schedule.** The schedule is a pure function of (channel rules, catalog, seed, date), so the guide is identical on every device with no shared state. Tune in at 8:25 → the 8:00 show starts 25 minutes in, counting the ad breaks already played.
- **Fills real time slots.** Shows land on :00/:30 like real TV. Short runtimes are padded with ads/bumpers, and long ones take an hour block.
- **Ad breaks in the episode.** Find where commercials were originally cut: ffmpeg `blackdetect` plus `silencedetect`, chapter markers when the file has them, and a manual editor to fix mistakes. Results are cached per file in the catalog.
- **Era-correct ads.** Ads are tagged with a year (or range), region and category. A channel set to 1987–1992 only plays ads from those years, and channels whose eras overlap share the pool. Breaks are filled to the length of the original gap.
- **Channels.** Rules, not lists:
  - Decade channels.
  - Curated ones: "TGIF '90s", "Saturday Morning", "Toonami-style", "Nick at Nite".
  - "Any channel in any year": pick a year, and the lineup and ads are rebuilt as of that year.
  - Channels are shareable JSON (`channel.json`) with no media inside, so people can trade lineups.
- **Guide.** Cable/DirecTV-style grid: channel column, 30-minute time slots, mini preview window, info bar, channel up/down, number entry and favorites. Fully usable with a Roku remote.

## Phases
1. Core: catalog, local-folder source, channel rules, scheduler. Tests against a real folder of public-domain episodes from the Internet Archive.
2. Station, TV screen and the Electron app (done), with installers built by the release workflow (Windows NSIS, macOS DMG, Linux AppImage; unsigned for now).
3. Ad-break detection in the station (done: background, cached, in force from midnight), era ad pools (done), and the break editor (done: E on the TV or Edit > Commercial breaks in the app; edits air from midnight).
4. LAN sharing (done, opt-in) and the Roku client (written and validated; needs a real-TV test), then HLS via ffmpeg for files the Roku can't play.
5. Any file on any screen (done for the TV screen and app: live remux/transcode via ffmpeg). Channel sharing (done: the lineup editor exports and imports channel.json). More sources (Plex, Jellyfin, Archive, manifest), polish.

## Jarvis's part
- Catalog tagging: use his local model to fill in air year, network and genre from filenames and NFO files, so your library list stays on your PC.
- Run nightly break detection on new files.
- Help curate channel rules from your library.

## Open questions
- **Name:** settled: Primetime Machine (two public GitHub repos are already called NostalgiaVision).
  - nexusjuan12/Nostalgiavision: a Plex-based retro TV guide in the browser, the same idea as ours.
  - justinloveless/NostalgiaVision: an Apple TV app.
  - A different name avoids confusion; options to consider: Channel Surf, RerunTV, Dial Era, Rabbit Ears.
- **Desktop shell:** settled: Electron (H.264/AAC playback built in; Tauri's system webviews vary).
- **Ad library:** where do you want public-domain/archival commercials to come from by default? The Internet Archive has large collections.
