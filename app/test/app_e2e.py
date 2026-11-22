"""The desktop app itself: Electron starts the station in-process and plays H.264/AAC MP4 (what
most libraries are), which a plain open-source Chromium can't. Drives the real window over the
DevTools protocol.

Run:  python3 app/test/app_e2e.py     (needs ffmpeg, the electron devDependency, Python
Playwright; on Linux without a display it runs itself under xvfb-run)
      PTM_APP=path/to/built/app python3 app/test/app_e2e.py   tests a packaged build instead
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def mp4(path: Path, seconds: float, freq: int, ac3_mkv: bool = False) -> None:
    """H.264 + AAC MP4, or (ac3_mkv) H.264 + AC3 in MKV: the usual TV rip, which no Chromium plays as-is."""
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = ["-c:a", "ac3"] if ac3_mkv else ["-c:a", "aac", "-movflags", "+faststart"]
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=320x180:rate=15:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=44100:duration={seconds}",
         "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", *audio, str(path)],
        check=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def electron() -> str:
    """The Electron binary. Its package no longer downloads it at install time, so fetch it
    here the same way `npm run app` does (a no-op when it's already there)."""
    subprocess.run(["node", str(ROOT / "node_modules" / "electron" / "install.js")], check=True)
    exe = ROOT / "node_modules" / "electron" / "dist" / ("electron.exe" if os.name == "nt" else "electron")
    if not exe.exists():
        sys.exit("electron is not installed: npm install")
    return str(exe)


def main() -> int:
    if sys.platform.startswith("linux") and not os.environ.get("DISPLAY") and shutil.which("xvfb-run"):
        return subprocess.call(["xvfb-run", "-a", sys.executable, *sys.argv])
    tmp = Path(tempfile.mkdtemp(prefix="ptm-app-"))
    media = tmp / "media"
    mp4(media / "Shows/Alpha (1991)/Season 1/Alpha - S01E01 - Pilot.mp4", 50, 440)
    mp4(media / "Shows/Alpha (1991)/Season 1/Alpha - S01E02 - Second.mp4", 48, 520)
    mp4(media / "Shows/Rip (2004)/Season 1/Rip - S01E01 - One.mkv", 49, 600, ac3_mkv=True)
    mp4(media / "Shows/Rip (2004)/Season 1/Rip - S01E02 - Two.mkv", 48, 620, ac3_mkv=True)
    mp4(media / "Ads/1991/Cola.mp4", 4, 880)
    cfg = tmp / "cfg" / "config.json"
    cfg.parent.mkdir()
    cfg.write_text(json.dumps({"folders": [str(media)], "channels": [
        {"id": "90s", "number": 12, "name": "The 90s", "years": [1990, 1999], "slotMinutes": 1},
        {"id": "00s", "number": 20, "name": "The 2000s", "years": [2000, 2009], "slotMinutes": 1}]}))
    cdp = free_port()
    packaged = os.environ.get("PTM_APP")      # a built app (npm run dist) instead of the sources
    launch = [packaged] if packaged else [electron(), str(ROOT / "app" / "main.mjs")]
    args = [*launch, "--config", str(cfg), "--port", "0", "--windowed", f"--remote-debugging-port={cdp}"]
    if sys.platform.startswith("linux") and (os.environ.get("CI") or os.geteuid() == 0):
        # Test-only: Chromium can't sandbox as root, and Ubuntu 24.04 runners block the
        # user namespaces its sandbox needs. The app itself always runs sandboxed.
        args.insert(1, "--no-sandbox")
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        return drive(cdp)
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        out = proc.stdout.read() if proc.stdout else ""
        if out.strip():
            print("--- electron output ---\n" + out[-3000:])


def targets(cdp: int) -> list[dict]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{cdp}/json", timeout=2) as r:
            return [t for t in json.load(r) if t.get("type") == "page"]
    except OSError:
        return []


def station_page_listed(cdp: int) -> bool:
    return any(t.get("url", "").startswith("http://127.0.0.1") for t in targets(cdp))


def drive(cdp: int) -> int:
    # Attach once the window shows the station: a CDP connection made before Electron creates
    # the window's context never sees that page.
    deadline = time.time() + 60
    while not station_page_listed(cdp):
        assert time.time() < deadline, "the app window never showed the station"
        time.sleep(0.5)
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp}")
        pages = [pg for ctx in browser.contexts for pg in ctx.pages if pg.url.startswith("http://127.0.0.1")]
        assert pages, "connected, but the station page isn't there"
        page = pages[0]
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.wait_for_function("window.ptm && window.ptm.playout", timeout=30000)
        assert not page.is_visible("#power"), "the app should never ask for a key press"
        # wait for a program segment, then check the H.264 picture is really playing on the clock
        page.wait_for_function("window.ptm.current && window.ptm.current.role === 'program'", timeout=70000)
        time.sleep(2)
        s = page.evaluate("""() => { const v = document.getElementById('tv'), s = window.ptm.current;
          return { src: v.currentSrc, w: v.videoWidth, paused: v.paused, err: v.error && v.error.code,
                   at: v.currentTime, expected: s.fromSec + (Date.now() - s.start) / 1000, role: s.role }; }""")
        print("playing:", s)
        assert s["err"] is None, f"media error {s['err']}: H.264 didn't decode"
        assert s["w"] == 320 and not s["paused"], s
        assert s["role"] != "program" or abs(s["at"] - s["expected"]) < 1.5, s
        # an MKV with AC3 sound: the station copies the H.264 and converts the sound, live.
        # The station's answer is held up 2.5 s, as on a slow machine (GitHub's runners), so
        # the stream joins late and has to catch up with the clock.
        held = []

        def slow(route):
            held.append(route.request.url)
            time.sleep(2.5)
            route.continue_()
        page.route("**/api/live*", slow)
        page.evaluate("document.getElementById('tv').focus()")
        page.keyboard.press("ArrowUp")
        page.wait_for_function("window.ptm.channels[window.ptm.index].id === '00s'", timeout=5000)
        page.wait_for_function("window.ptm.current && window.ptm.current.role === 'program'", timeout=70000)
        probe = """() => { const v = document.getElementById('tv'), s = window.ptm.current;
          const b = [...Array(v.buffered.length).keys()].map((i) => [v.buffered.start(i).toFixed(1), v.buffered.end(i).toFixed(1)]);
          const f = window.ptm.feed;
          return { src: f && v.getAttribute('src').startsWith('blob:') ? f.url : v.getAttribute('src'),
                   w: v.videoWidth, paused: v.paused, err: v.error && v.error.code,
                   at: v.currentTime + window.ptm.base, expected: s.fromSec + (Date.now() - s.start) / 1000,
                   live: s.live, role: s.role, buffered: b, ready: v.readyState, feed: !!f }; }"""
        # wait for the converted stream to be on screen, then it must hold the clock
        on = time.time() + 15
        while True:
            r = page.evaluate(probe)
            if r["role"] == "program" and r["src"] and "/live?" in r["src"] and r["feed"] and not r["paused"]:
                break
            assert time.time() < on, f"the converted stream never started: {r}"
            time.sleep(0.25)
        # a converted stream may join a little late (it arrives about as fast as it plays), so
        # it catches up by playing faster: within a few seconds it is on the clock, and stays
        # (how late it was by the first sample depends on the machine: on a fast one it has
        # already jumped to the clock; the point is that the slow answer really happened)
        assert held, "the station's answer was never held up: the test didn't exercise a late join"
        first = r["expected"] - r["at"]
        caught = time.time() + 12
        while True:
            r = page.evaluate(probe)
            if r["role"] != "program" or abs(r["at"] - r["expected"]) < 0.75:
                break
            assert time.time() < caught, f"never caught up with the clock: {r}"
            time.sleep(0.5)
        worst = 0.0
        for _ in range(5):
            r = page.evaluate(probe)
            if r["role"] == "program" and "/live?" in (r["src"] or ""):
                worst = max(worst, abs(r["at"] - r["expected"]))
            time.sleep(1)
        print(f"MKV + AC3 via the station: joined {first:.2f}s off, then at most {worst:.2f}s off the clock")
        assert worst < 1.0, worst
        assert r["err"] is None and r["w"] == 320, r
        page.keyboard.press("g")
        page.wait_for_selector("#guide:not([hidden]) .g-cell.sel")
        page.keyboard.press("Escape")
        # E opens the break editor in a window of its own; the TV keeps playing. (A CDP
        # connection doesn't learn of windows made after it attached: look with a fresh one.)
        page.keyboard.press("e")
        deadline = time.time() + 20
        while not any(t.get("url", "").endswith("/editor.html") for t in targets(cdp)):
            assert time.time() < deadline, "E didn't open the break editor"
            time.sleep(0.3)
        second = p.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp}")
        editor = next(pg for ctx in second.contexts for pg in ctx.pages if pg.url.endswith("/editor.html"))
        editor.wait_for_selector("#list .ep")
        assert editor.locator("#list .ep").count() == 4
        # the station takes changes from the app's own window
        saved = editor.evaluate("""async () => {
          const key = document.querySelector('#list .ep').dataset.key;
          const r = await fetch(`/api/episodes/${key}/breaks`, { method: 'PUT',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ breaksSec: [20] }) });
          return [r.status, (await r.json()).status];
        }""")
        assert saved == [200, "edited"], saved
        second.close()
        assert page.url.rstrip("/").count("/") == 2 and not page.evaluate("document.getElementById('tv').paused")
        assert not errors, errors
        browser.close()
    print("app e2e OK: Electron plays H.264 live on the clock")
    return 0


if __name__ == "__main__":
    sys.exit(main())
