"""The desktop app itself: Electron starts the station in-process and plays H.264/AAC MP4 (what
most libraries are), which a plain open-source Chromium can't. Drives the real window over the
DevTools protocol.

Run:  python3 app/test/app_e2e.py     (needs ffmpeg, the electron devDependency, Python
Playwright; on Linux without a display it runs itself under xvfb-run)
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


def mp4(path: Path, seconds: float, freq: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=320x180:rate=15:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=44100:duration={seconds}",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
         "-movflags", "+faststart", str(path)],
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
    mp4(media / "Ads/1991/Cola.mp4", 4, 880)
    cfg = tmp / "cfg" / "config.json"
    cfg.parent.mkdir()
    cfg.write_text(json.dumps({"folders": [str(media)], "channels": [
        {"id": "90s", "number": 12, "name": "The 90s", "years": [1990, 1999], "slotMinutes": 1}]}))
    cdp = free_port()
    args = [electron(), str(ROOT / "app" / "main.mjs"), "--config", str(cfg), "--port", "0", "--windowed",
            f"--remote-debugging-port={cdp}"]
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


def station_page_listed(cdp: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{cdp}/json", timeout=2) as r:
            return any(t.get("type") == "page" and t.get("url", "").startswith("http://127.0.0.1")
                       for t in json.load(r))
    except OSError:
        return False


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
        page.keyboard.press("g")
        page.wait_for_selector("#guide:not([hidden]) .g-cell.sel")
        assert not errors, errors
        browser.close()
    print("app e2e OK: Electron plays H.264 live on the clock")
    return 0


if __name__ == "__main__":
    sys.exit(main())
