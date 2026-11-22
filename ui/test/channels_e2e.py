"""The lineup editor in a real browser against a real station and real video files, with the TV
screen open beside it.

Run:  python3 ui/test/channels_e2e.py [--shots DIR]      (needs ffmpeg, node, and Python Playwright)

Starts from the automatic lineup, builds a channel of one show, saves it, and watches the TV
pick the new lineup up by itself; refuses a clash; exports the lineup and imports a shared
channel.json; goes back to automatic. Saved lineups are checked in the station's config file.
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
from e2e import ROOT, clip, free_port  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="save screenshots here")
    args = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="ptm-channels-"))
    media = tmp / "media"
    clip(media / "Shows/Alpha (1991)/Season 1/Alpha - S01E01 - Pilot.webm", 40, 440)
    clip(media / "Shows/Alpha (1991)/Season 1/Alpha - S01E02 - Second.webm", 38, 520)
    clip(media / "Shows/Beta (1993)/Season 1/Beta - S01E01 - Thing.webm", 37, 600)
    clip(media / "Shows/Gamma (1984)/Season 1/Gamma - S01E01 - Start.webm", 36, 660)
    clip(media / "Ads/1991/Cola.webm", 4, 880)
    cfg = tmp / "cfg" / "config.json"
    cfg.parent.mkdir()
    cfg.write_text(json.dumps({"folders": [str(media)], "port": 1}))
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
        return run(f"http://127.0.0.1:{port}", cfg, tmp, args.shots)
    finally:
        station.terminate()


def run(base: str, cfg: Path, tmp: Path, shots: str | None) -> int:
    errors: list[str] = []
    shot_dir = Path(shots) if shots else None
    if shot_dir:
        shot_dir.mkdir(parents=True, exist_ok=True)

    def shot(page, name):
        if shot_dir:
            page.screenshot(path=str(shot_dir / f"{name}.png"))

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, accept_downloads=True)
        tv = ctx.new_page()
        tv.on("pageerror", lambda e: errors.append(f"tv: {e}"))
        tv.goto(f"{base}/?lineupCheckMs=1000")
        tv.wait_for_function("window.ptm && window.ptm.playout")
        assert tv.evaluate("window.ptm.channels.map(c => c.id)") == ["1980s", "1990s"]

        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base}/channels.html")
        page.wait_for_selector("#lineup li[data-i]")
        assert "Automatic" in page.inner_text("#mode")
        assert page.locator("#lineup li[data-i]").count() == 2
        page.wait_for_function("document.querySelector('#lineup li[data-i=\"1\"]').textContent.includes('3 programs')")
        assert page.is_disabled("#save")

        # a channel of one show: 1990s, then only Alpha
        page.click("#add")
        page.fill("#f-name", "Alpha Only")
        page.fill("#f-number", "9")
        page.click('#decades .chip[data-d="1990"]')
        page.uncheck("#f-allshows")                           # every 90s show, picked one by one
        page.uncheck('#shows input[data-show="Beta"]')
        page.wait_for_function("document.getElementById('preview').textContent.includes('2 episodes')")
        assert "Alpha" in page.inner_text("#preview") and "Beta" not in page.inner_text("#preview")
        page.select_option("#f-slot", "60")
        assert page.is_visible("#dirty") and "Your lineup" in page.inner_text("#mode")
        shot(page, "1-new-channel")
        page.keyboard.press("Control+s")
        page.wait_for_function("document.getElementById('dirty').hidden")
        saved = json.loads(cfg.read_text())
        assert saved["port"] == 1, "the rest of the config is kept"
        mine = next(c for c in saved["channels"] if c["name"] == "Alpha Only")
        assert mine == {"id": "alpha-only", "number": 9, "name": "Alpha Only", "years": [1990, 1999],
                        "shows": ["Alpha"], "slotMinutes": 60}, mine
        assert [c["number"] for c in saved["channels"]] == [2, 3, 9]

        # the TV picks the new lineup up by itself and stays on its channel
        was = tv.evaluate("window.ptm.channels[window.ptm.index].id")
        tv.wait_for_function("window.ptm.channels.some(c => c.id === 'alpha-only')", timeout=10000)
        tv.wait_for_function("window.ptm.playout && window.ptm.current", timeout=20000)
        assert tv.evaluate("window.ptm.channels[window.ptm.index].id") == was

        # two channels on one number: refused, nothing written
        page.click('#lineup li[data-i="0"]')
        page.fill("#f-number", "9")
        page.click("#save")
        page.wait_for_selector("#error:not([hidden])")
        assert "number 9 is used twice" in page.inner_text("#error"), page.inner_text("#error")
        assert json.loads(cfg.read_text()) == saved
        page.click("#discard")
        assert page.is_hidden("#dirty")

        # share: export the lineup (no local ids in it), import a channel someone sent
        with page.expect_download() as dl:
            page.click("#export")
        shared = json.loads(Path(dl.value.path()).read_text())
        assert shared["primetimeMachine"] == "lineup" and len(shared["channels"]) == 3
        assert all("id" not in c for c in shared["channels"]), shared
        sent = tmp / "tgif.channel.json"
        sent.write_text(json.dumps({"primetimeMachine": "channel", "version": 1, "number": 9, "name": "TGIF",
                                    "years": [1989, 1998], "shows": ["Beta", "Full House"]}))
        page.set_input_files("#file", str(sent))
        page.wait_for_function("document.querySelectorAll('#lineup li[data-i]').length === 4")
        assert page.input_value("#f-name") == "TGIF" and page.input_value("#f-number") == "10", "renumbered: 9 is taken"
        assert "not in your library" in page.inner_text("#shows")
        page.wait_for_function("document.getElementById('preview').textContent.includes('1 episode')")
        page.click("#save")
        page.wait_for_function("document.getElementById('dirty').hidden")
        assert [c["name"] for c in json.loads(cfg.read_text())["channels"]] == ["The 80s", "The 90s", "Alpha Only", "TGIF"]
        shot(page, "2-imported")

        # back to automatic
        page.click("#auto")
        page.wait_for_function("document.getElementById('mode').textContent.includes('Automatic')")
        assert "channels" not in json.loads(cfg.read_text())
        tv.wait_for_function("window.ptm.channels.length === 2", timeout=10000)

        page.set_viewport_size({"width": 420, "height": 860})
        shot(page, "3-narrow")
        browser.close()

    # a refused save is a 400 the page shows (checked above); anything else is a fault
    bad = [e for e in errors if "favicon" not in e and "status of 400" not in e]
    assert not bad, bad
    print("channels e2e: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
