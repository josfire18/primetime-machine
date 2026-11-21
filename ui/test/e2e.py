"""The TV screen in a real browser against a real station and real video files.

Run:  python3 ui/test/e2e.py [--shots DIR]      (needs ffmpeg, node, and Python Playwright)

Checks that it stays live: after power-on the picture is the right file at the clock's second;
channel up/down and dialing a number retune; the guide lists every channel, moves, and tunes;
it keeps tracking the clock across segment changes (program -> ads -> program); and the page
logs no errors. Clips are WebM because Playwright's Chromium has no H.264.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def clip(path: Path, seconds: float, freq: int, vp9: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    video = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-g", "30"] if vp9 else ["-c:v", "libvpx", "-deadline", "realtime"]
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=320x180:rate=15:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=48000:duration={seconds}",
         *video, "-b:v", "300k", "-c:a", "libopus", str(path)],
        check=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="save screenshots here")
    args = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="ptm-e2e-"))
    media = tmp / "media"
    clip(media / "Shows/Alpha (1991)/Season 1/Alpha - S01E01 - Pilot.webm", 50, 440)
    clip(media / "Shows/Alpha (1991)/Season 1/Alpha - S01E02 - Second.webm", 48, 520)
    clip(media / "Shows/Beta (1984)/Season 2/Beta - S02E03 - Thing.webm", 47, 600)
    clip(media / "Shows/Gamma (1975)/Season 1/Gamma - S01E01 - Start.webm", 46, 660)
    # MKV can't play in a browser as-is: the station streams it through ffmpeg
    clip(media / "Shows/Delta (2004)/Season 1/Delta - S01E01 - Remux.mkv", 49, 700, vp9=True)
    clip(media / "Shows/Delta (2004)/Season 1/Delta - S01E02 - Again.mkv", 48, 720, vp9=True)
    clip(media / "Ads/1990/Cola.webm", 4, 880)
    clip(media / "Ads/1991/Soda.webm", 3, 990)
    clip(media / "Ads/1984/Cereal.webm", 4, 770)
    cfg = tmp / "cfg" / "config.json"
    cfg.parent.mkdir()
    cfg.write_text(json.dumps({"folders": [str(media)], "channels": [
        {"id": "70s", "number": 3, "name": "The 70s", "years": [1970, 1979], "slotMinutes": 1},
        {"id": "80s", "number": 7, "name": "The 80s", "years": [1980, 1989], "slotMinutes": 1},
        {"id": "90s", "number": 12, "name": "The 90s", "years": [1990, 1999], "slotMinutes": 1},
        {"id": "00s", "number": 20, "name": "The 2000s", "years": [2000, 2009], "slotMinutes": 1},
    ]}))
    port = free_port()
    station = subprocess.Popen(["node", str(ROOT / "station/main.ts"), "--config", str(cfg), "--port", str(port)],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for line in station.stdout:
            if "on the air" in line:
                break
        else:
            print("station did not start", file=sys.stderr)
            return 1
        return run(f"http://127.0.0.1:{port}", args.shots)
    finally:
        station.terminate()


def run(base: str, shots: str | None) -> int:
    errors: list[str] = []
    shot_dir = Path(shots) if shots else None
    if shot_dir:
        shot_dir.mkdir(parents=True, exist_ok=True)

    def shot(page, name):
        if shot_dir:
            page.screenshot(path=str(shot_dir / f"{name}.png"))

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base)
        page.wait_for_function("window.ptm && window.ptm.playout")
        # launched with autoplay allowed, so no "press a key" splash: it just plays
        assert not page.is_visible("#power"), "power splash shown although playback is allowed"

        def live():
            """What is on screen vs. what the clock says should be."""
            return page.evaluate("""() => {
              const s = window.ptm.current, v = document.getElementById('tv');
              if (!s) return { seg: null };
              const now = Date.now();
              const f = window.ptm.feed;
              const src = f && v.getAttribute('src') && v.getAttribute('src').startsWith('blob:') ? f.url : v.getAttribute('src');
              return { seg: { role: s.role, src: s.src, start: s.start, end: s.end, live: s.live }, inSeg: now >= s.start && now < s.end,
                       expected: s.fromSec + (now - s.start) / 1000, at: v.currentTime + window.ptm.base, paused: v.paused,
                       src, feed: !!f, card: !document.getElementById('card').hidden,
                       channel: window.ptm.channels[window.ptm.index].id };
            }""")

        def assert_live(where, wait=6):
            deadline = time.time() + wait
            while True:
                s = live()
                playing = s["seg"] and s["seg"]["src"] and (
                    s["src"].startswith(s["seg"]["src"] + "/live?") if s["seg"]["live"] else s["src"] == s["seg"]["src"])
                ok = s["seg"] and s["inSeg"] and (
                    (s["seg"]["src"] is None and s["card"]) or
                    (playing and not s["paused"] and abs(s["at"] - s["expected"]) < 1.5))
                if ok:
                    return s
                if time.time() > deadline:
                    raise AssertionError(f"{where}: not live: {s}")
                time.sleep(0.25)

        s = assert_live("after power-on")
        print(f"on the air: {s['channel']} {s['seg']['role']} at {s['at']:.1f}s (clock says {s['expected']:.1f}s)")
        shot(page, "1-tuned")

        start = s["channel"]
        page.keyboard.press("ArrowUp")
        page.wait_for_function(f"window.ptm.channels[window.ptm.index].id !== {json.dumps(start)}")
        s = assert_live("after channel up")
        assert page.is_visible("#osd"), "no on-screen channel number"
        print(f"channel up -> {s['channel']}")

        page.keyboard.press("7")                 # dial 7: the 80s
        page.wait_for_function("window.ptm.channels[window.ptm.index].id === '80s'", timeout=4000)
        assert_live("after dialing 7")
        print("dialed 7 -> 80s")
        page.keyboard.press("i")
        assert page.is_visible("#infobar"), "info bar did not show"
        slot = page.evaluate("""() => { const b = window.ptm.current.block;
          const t = (x) => new Date(x).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          return { ms: b.end - b.start, text: `${t(b.start)} – ${t(b.end)}`,
                   meta: document.getElementById('ib-meta').textContent }; }""")
        assert slot["ms"] == 60_000 and slot["text"] in slot["meta"], slot
        shot(page, "2-info")

        page.keyboard.press("g")
        page.wait_for_selector("#guide:not([hidden]) .g-cell.sel")
        rows = page.eval_on_selector_all("#g-rows .g-row", "rs => rs.length")
        assert rows == 4, f"guide shows {rows} rows, expected 4"
        cells = page.eval_on_selector_all(".g-cell", "cs => cs.length")
        assert cells > 4 * 100, f"guide too thin: {cells} cells for 3 h of 1-minute slots"
        title = page.inner_text("#g-title")
        assert title, "no detail for the selected program"
        shot(page, "3-guide")
        page.keyboard.press("ArrowDown")         # 80s -> 90s
        page.keyboard.press("ArrowRight")        # a later program on that channel
        assert "12 The 90s" in page.inner_text("#g-meta"), page.inner_text("#g-meta")
        page.keyboard.press("Enter")
        page.wait_for_function("window.ptm.channels[window.ptm.index].id === '90s'")
        assert not page.is_visible("#guide"), "guide still open after tuning"
        assert_live("after tuning from the guide")
        print("guide: 3 channels, moved, tuned to 90s")

        # ride the clock across several segment changes
        seen = set()
        until = time.time() + 75
        while time.time() < until:
            s = assert_live("riding the clock")
            seen.add((s["seg"]["role"], s["seg"]["start"]))
            time.sleep(1)
        roles = {r for r, _ in seen}
        assert len(seen) >= 3 and "program" in roles and ("ad" in roles or "filler" in roles), seen
        print(f"stayed live across {len(seen)} segments ({', '.join(sorted(roles))})")

        # an MKV channel: the station converts on the fly, and the picture still keeps the clock
        page.keyboard.press("2")
        page.keyboard.press("0")
        page.wait_for_function("window.ptm.channels[window.ptm.index].id === '00s'", timeout=4000)
        page.wait_for_function("window.ptm.current && window.ptm.current.role === 'program'", timeout=70000)
        s = assert_live("an MKV through the station", wait=15)     # may catch up first
        assert s["seg"]["live"] and "/live?" in s["src"], s
        live_seen, worst = 0, 0.0
        until = time.time() + 12
        while time.time() < until:
            s = assert_live("an MKV, riding the clock", wait=15)
            if s["seg"]["live"] and s["src"]:
                live_seen += 1
                worst = max(worst, abs(s["at"] - s["expected"]))
            time.sleep(1)
        assert live_seen >= 3, f"only {live_seen} samples on the converted stream"
        print(f"MKV via the station: {live_seen} samples, at most {worst:.2f}s off the clock")
        shot(page, "4-later")
        browser.close()

    bad = [e for e in errors if "favicon" not in e]
    if bad:
        print("page errors:", *bad, sep="\n  ", file=sys.stderr)
        return 1
    print("e2e OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
