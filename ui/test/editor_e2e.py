"""The break editor in a real browser against a real station and real video files.

Run:  python3 ui/test/editor_e2e.py [--shots DIR]      (needs ffmpeg, node, and Python Playwright)

Background detection finds the black-and-silent seam in a real episode; the editor lists it,
plays the file (a WebM played directly and an MKV the station streams through ffmpeg), adds,
nudges and removes breaks with the keyboard and mouse, saves, and hands an episode back to
detection. Saved breaks are checked through the station's own API, and the page must log no
errors.
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e import ROOT, free_port  # noqa: E402


def clip(path: Path, parts: list[tuple[str, float]], freq: int) -> None:
    """A clip of `parts`: ("show", seconds) is picture and tone, ("gap", seconds) black and silent."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.stem}-parts"
    tmp.mkdir(exist_ok=True)
    names = []
    for i, (kind, sec) in enumerate(parts):
        v = f"testsrc2=size=320x180:rate=15:duration={sec}" if kind == "show" else f"color=black:size=320x180:rate=15:duration={sec}"
        a = f"sine=frequency={freq}:sample_rate=48000:duration={sec}" if kind == "show" else f"anullsrc=r=48000:cl=mono:d={sec}"
        out = tmp / f"{i}.webm"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", v, "-f", "lavfi", "-i", a,
                        "-c:v", "libvpx-vp9", "-deadline", "realtime", "-g", "15", "-b:v", "200k",
                        "-c:a", "libopus", "-ac", "1", str(out)], check=True)
        names.append(out)
    lst = tmp / "list.txt"
    lst.write_text("".join(f"file '{n}'\n" for n in names))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                    "-c", "copy", str(path)], check=True)
    for n in [*names, lst]:
        n.unlink()
    tmp.rmdir()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="save screenshots here")
    args = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="ptm-editor-"))
    media = tmp / "media"
    # a seam at 70.5 s, well inside: detection keeps clear of the first and last minute
    clip(media / "Shows/Alpha (1991)/Season 1/Alpha - S01E01 - Pilot.webm", [("show", 70), ("gap", 1), ("show", 79)], 440)
    clip(media / "Shows/Delta (2004)/Season 1/Delta - S01E01 - Remux.mkv", [("show", 140)], 700)
    clip(media / "Ads/1991/Cola.webm", [("show", 5)], 880)
    cfg = tmp / "cfg" / "config.json"
    cfg.parent.mkdir()
    cfg.write_text(json.dumps({"folders": [str(media)], "channels": [
        {"id": "90s", "number": 12, "name": "The 90s", "years": [1990, 1999], "slotMinutes": 3},
        {"id": "00s", "number": 20, "name": "The 2000s", "years": [2000, 2009], "slotMinutes": 3},
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
    import urllib.request

    def api(path: str):
        with urllib.request.urlopen(base + path) as r:
            return json.load(r)

    def episode(show: str):
        return next(e for e in api("/api/episodes")["episodes"] if e.get("show") == show)

    # the station checks every episode in the background after its scan
    deadline = time.time() + 120
    while time.time() < deadline and api("/api/episodes")["job"].get("running", True):
        time.sleep(1)
    alpha = episode("Alpha")
    assert alpha["status"] == "found" and abs(alpha["breaksSec"][0] - 70.5) < 0.3, alpha
    assert episode("Delta")["delivery"] == "live"

    errors: list[str] = []
    shot_dir = Path(shots) if shots else None
    if shot_dir:
        shot_dir.mkdir(parents=True, exist_ok=True)

    def shot(page, name):
        if shot_dir:
            page.screenshot(path=str(shot_dir / f"{name}.png"))

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base}/editor.html")
        page.wait_for_selector("#list .ep")
        assert page.locator("#list .ep").count() == 2
        assert "found · 1" in page.inner_text(f'#list .ep[data-key="{alpha["key"]}"]')
        shot(page, "1-list")

        # open Alpha: its found break is on the timeline and in the list
        page.click(f'#list .ep[data-key="{alpha["key"]}"]')
        page.wait_for_function("document.getElementById('video').readyState >= 1")
        assert page.locator("#timeline .mark[data-i]").count() == 1
        assert page.inner_text("#breaks li .at") == "1:10.5"

        # jump to 30 s with the timeline, then step: → +5 s, Shift+→ +½ s
        box = page.locator("#timeline").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 30 / 150, box["y"] + box["height"] / 2)
        page.keyboard.press("ArrowRight")
        page.keyboard.press("Shift+ArrowRight")
        page.wait_for_function("Math.abs(document.getElementById('video').currentTime - 35.5) < 0.2")

        # B adds a break here; ] nudges it ½ s later; it's selected, unsaved, and not yet on the air
        page.keyboard.press("b")
        page.keyboard.press("]")
        assert page.locator("#breaks li").count() == 2
        assert page.inner_text("#breaks li.sel .at") == "0:36.0", page.inner_text("#breaks")
        assert page.is_visible("#dirty")
        assert "from midnight" in page.inner_text("#note")
        assert episode("Alpha")["status"] == "found"
        shot(page, "2-editing")

        # switching episodes with unsaved changes is refused
        page.click(f'#list .ep[data-key="{episode("Delta")["key"]}"]')
        assert page.is_visible("#error") and "Save or discard" in page.inner_text("#error")

        # Ctrl+S saves: the station has both, set by hand
        page.keyboard.press("Control+s")
        page.wait_for_function("document.getElementById('dirty').hidden")
        saved = episode("Alpha")
        assert saved["status"] == "edited" and saved["breaksSec"] == [36, alpha["breaksSec"][0]], saved
        assert "set by hand" in page.inner_text(f'#list .ep[data-key="{alpha["key"]}"]')

        # remove the found one with its button and save again
        page.locator("#breaks li").nth(1).locator("[data-act=remove]").click()
        page.click("#save")
        page.wait_for_function("document.getElementById('dirty').hidden")
        assert episode("Alpha")["breaksSec"] == [36]

        # an MKV plays through the station's stream, starting where it's asked
        page.click(f'#list .ep[data-key="{episode("Delta")["key"]}"]')
        page.wait_for_function("document.getElementById('video').src.includes('/live/') || document.getElementById('video').src.includes('/api/')"
                               " || document.getElementById('video').readyState >= 1", timeout=30000)
        box = page.locator("#timeline").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 90 / 140, box["y"] + box["height"] / 2)
        page.wait_for_function("document.getElementById('loading').hidden && document.getElementById('video').readyState >= 2", timeout=30000)
        at = page.evaluate("() => parseFloat(document.getElementById('pos').textContent.split(':')[0]) * 60 + parseFloat(document.getElementById('pos').textContent.split(':')[1])")
        assert abs(at - 90) < 1.5, at
        page.keyboard.press("b")
        page.keyboard.press("Control+s")
        page.wait_for_function("document.getElementById('dirty').hidden")
        delta = episode("Delta")
        assert delta["status"] == "edited" and abs(delta["breaksSec"][0] - 90) < 1.5, delta
        shot(page, "3-live")

        # hand Alpha back to detection: it's found again
        page.click(f'#list .ep[data-key="{alpha["key"]}"]')
        page.click("#redetect")
        deadline = time.time() + 60
        while time.time() < deadline and episode("Alpha")["status"] != "found":
            time.sleep(0.5)
        assert abs(episode("Alpha")["breaksSec"][0] - 70.5) < 0.3
        page.wait_for_function("document.querySelector('#list .ep').textContent.includes('found')", timeout=20000)
        # the open episode shows what detection found, without reopening it
        page.wait_for_function("document.querySelectorAll('#breaks li').length === 1", timeout=20000)
        assert page.inner_text("#breaks li .at") == "1:10.5"
        assert not page.is_visible("#empty")

        # small screens stack the list over the editor
        page.set_viewport_size({"width": 420, "height": 860})
        assert page.locator("aside").bounding_box()["width"] > 380
        shot(page, "4-narrow")
        browser.close()

    bad = [e for e in errors if "favicon" not in e]
    assert not bad, bad
    print("editor e2e: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
