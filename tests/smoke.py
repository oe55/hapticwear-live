"""
End-to-end smoke test for HapticWear Live, in Chrome (Chromium engine) and Safari (WebKit engine).

    pip install playwright && python -m playwright install webkit chromium
    python tests/smoke.py                 # both engines
    python tests/smoke.py webkit          # one engine
    python tests/smoke.py --shots out/    # also save a screenshot of every state
    python tests/smoke.py --url https://oe55.github.io/hapticwear-live/   # test the published site

What it checks, per engine:
  - the page loads with nothing at all in the console and no page errors
  - START with the microphone allowed: calibration, then the live dashboard
  - START with the microphone blocked: the designed card, then music plays automatically
  - START with the permission prompt left unanswered: after 15 s, a card and music
  - the full-screen vest opens and closes (click and keyboard), with the band bars shown
  - the library opens, lists categories, and plays a track from My Library added as a file
  - transport: pause, resume, next
  - a portrait screen gets the portrait layout
  - after one visit, the site, the vest and a played track all work with the network off
  - the idle reset returns to the start screen (?idle=3 shortens the timer)
  - the vest connect button is hidden where Web Bluetooth does not exist
It serves the repository itself on a free local port; nothing else needs to be running.

The microphone is simulated in the page (allowed: a synthetic bass pulse; blocked; or a prompt that
never answers), because headless browsers cannot reliably open a real or fake capture device.
"""

import functools
import http.server
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = os.path.join(ROOT, 'assets', 'music', 'hapticwear-film-score.m4a')


class QuietServer(socketserver.ThreadingTCPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass                                   # a browser closing mid-download is not a failure


def serve():
    handler = functools.partial(QuietHandler, directory=ROOT)
    httpd = QuietServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f'http://127.0.0.1:{httpd.server_address[1]}/'


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Run:
    def __init__(self, name, shots):
        self.name, self.shots, self.failures, self.passes = name, shots, [], 0

    def check(self, ok, what):
        if ok:
            self.passes += 1
            print(f'  ok    {what}')
        else:
            self.failures.append(what)
            print(f'  FAIL  {what}')

    def shot(self, page, label):
        if self.shots:
            os.makedirs(self.shots, exist_ok=True)
            page.screenshot(path=os.path.join(self.shots, f'{self.name}-{label}.png'))


# Replacements for getUserMedia, injected before the page loads.
MIC = {
    # Allowed: a 55 Hz tone switching on and off twice a second, like a kick drum in a room.
    'allowed': """
        Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, value: async () => {
            const ac = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ac.createOscillator(); osc.frequency.value = 55;
            const t0 = ac.currentTime + 2.6;                 // silent while the room calibrates
            const amp = ac.createGain(); amp.gain.setValueAtTime(0, 0); amp.gain.setValueAtTime(0.2, t0);
            const lfo = ac.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 2;
            const depth = ac.createGain(); depth.gain.setValueAtTime(0, 0); depth.gain.setValueAtTime(0.2, t0);
            lfo.connect(depth).connect(amp.gain);
            const out = ac.createMediaStreamDestination();
            osc.connect(amp).connect(out);
            osc.start(); lfo.start();
            return out.stream;
        } });""",
    'denied': """
        Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, value: () =>
            Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) });""",
    'unanswered': """
        Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, value: () =>
            new Promise(() => {}) });""",
}


def open_page(browser, url, run, mic='denied'):
    ctx = browser.new_context(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    page = ctx.new_page()
    page.add_init_script(MIC[mic])
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto(url)
    page.wait_for_function('document.body && !document.body.classList.contains("is-booting")')
    return ctx, page, logs


def body_has(page, cls):
    return page.evaluate(f'document.body.classList.contains("{cls}")')


def spectrum_ink(page):
    """Sum of alpha in the top 80% of the spectrum canvas: > 0 only when bars stand up."""
    return page.evaluate("""() => {
        const c = document.getElementById('spec');
        const h = Math.floor(c.height * 0.8);
        // Read through a copy, so the page's own canvas is never asked for pixels.
        const copy = document.createElement('canvas');
        copy.width = c.width; copy.height = h;
        const x = copy.getContext('2d', { willReadFrequently: true });
        x.drawImage(c, 0, 0);
        const d = x.getImageData(0, 0, c.width, h).data;
        let s = 0; for (let i = 3; i < d.length; i += 16) s += d[i]; return s;
    }""")


def wait_class(page, cls, timeout=8000):
    page.wait_for_function(f'document.body.classList.contains("{cls}")', timeout=timeout)


def test_engine(p, engine, base, shots, local=True):
    run = Run(engine, shots)
    print(f'\n{engine}')
    if engine == 'chromium':
        try:
            browser = p.chromium.launch(channel='chrome')      # the installed Chrome: AAC support
        except Exception:
            browser = p.chromium.launch()
    else:
        browser = p.webkit.launch()

    # ---- 1. landing, console silence --------------------------------------------------------
    ctx, page, logs = open_page(browser, base, run)
    page.wait_for_timeout(1500)
    run.check(page.is_visible('#start'), 'landing shows START')
    run.check(page.is_visible('.wordmark--hero'), 'landing shows the wordmark')
    gl = page.evaluate("!document.getElementById('gl').hidden")
    run.check(True, f'vest renderer: {"WebGL" if gl else "still image fallback"}')
    connect_hidden = page.evaluate("document.getElementById('connect').hidden")
    has_bt = page.evaluate("!!navigator.bluetooth")
    run.check(connect_hidden == (not has_bt), f'connect button {"hidden" if connect_hidden else "shown"} (Web Bluetooth {"present" if has_bt else "absent"})')
    run.shot(page, '1-landing')

    # ---- 2. microphone blocked -> designed card -> music ---------------------------------------
    page.click('#start')
    page.wait_for_selector('#card:not([hidden])', timeout=8000)
    title = page.text_content('#card-title')
    run.check('microphone' in title.lower(), f'mic unavailable card: "{title}"')
    run.shot(page, '2-mic-card')
    page.click('#card-primary')
    wait_class(page, 'is-playing', 15000)
    page.wait_for_timeout(1500)
    run.check(body_has(page, 'is-dash'), 'dashboard is showing')
    run.check(spectrum_ink(page) > 0, 'spectrum draws while music plays')
    t0 = page.text_content('#now-time')
    page.wait_for_timeout(1200)
    run.check(page.text_content('#now-time') != t0, f'playback clock advances ({t0} -> {page.text_content("#now-time")})')
    vib = page.text_content('#vib-state')
    run.check(vib in ('ACTIVE', 'QUIET'), f'vibration panel reads {vib}')
    run.shot(page, '3-dashboard-music')

    # ---- 3. transport -----------------------------------------------------------------------
    page.click('#play')
    page.wait_for_timeout(300)
    run.check(body_has(page, 'is-paused'), 'pause')
    page.keyboard.press('Space')
    page.wait_for_timeout(300)
    run.check(body_has(page, 'is-playing'), 'Space resumes')
    first = page.text_content('#now-title')
    page.click('#next')
    page.wait_for_function(f'document.getElementById("now-title").textContent !== {first!r} && document.body.classList.contains("is-playing")'
                           ' && document.getElementById("now-title").textContent !== "LOADING"', timeout=15000)
    run.check(True, f'next track: {first} -> {page.text_content("#now-title")}')

    # ---- 4. full-screen vest ------------------------------------------------------------------
    page.click('#model-box')
    page.wait_for_timeout(1300)
    run.check(body_has(page, 'is-expanded'), 'model box opens the full-screen vest')
    run.check(page.is_visible('.hbar--low'), 'full screen shows the LOW/MID/HIGH bars')
    run.shot(page, '4-expanded')
    page.mouse.click(960, 500)
    page.wait_for_timeout(1300)
    run.check(body_has(page, 'is-dash') and not body_has(page, 'is-expanded'), 'a click returns to the dashboard')
    page.keyboard.press('e')
    page.wait_for_timeout(200)
    run.check(body_has(page, 'is-expanded'), 'E opens the full screen')
    page.keyboard.press('Escape')
    page.wait_for_timeout(1200)
    run.check(not body_has(page, 'is-expanded'), 'Esc closes it')

    # ---- 5. library -------------------------------------------------------------------------
    page.click('#open-library')
    page.wait_for_timeout(600)
    run.check(body_has(page, 'is-drawer'), 'library drawer opens')
    cats = page.eval_on_selector_all('#cats .cat', 'els => els.map(e => e.textContent)')
    run.check('MY LIBRARY' in cats and len(cats) >= 2, f'categories: {", ".join(cats)}')
    page.click('#cats .cat >> text=MY LIBRARY')
    page.set_input_files('#file-input', SAMPLE)
    page.wait_for_selector('#tracks .track', timeout=8000)
    run.check(page.is_visible('#tracks .track'), 'a file added to My Library is listed')
    run.shot(page, '5-library')
    page.click('#tracks .track')
    page.wait_for_function('document.getElementById("now-tag").textContent === "MY LIBRARY"', timeout=10000)
    run.check(body_has(page, 'is-playing'), 'the My Library track plays')
    page.click('.track__remove')
    page.wait_for_timeout(500)
    run.check(page.locator('#tracks .track').count() == 0, 'and can be removed again')
    page.keyboard.press('Escape')
    page.wait_for_timeout(500)
    run.check(not body_has(page, 'is-drawer'), 'Esc closes the library')

    run.check(not logs, 'console stayed silent' + (f': {logs[:3]}' if logs else ''))
    ctx.close()

    # ---- 6. microphone allowed ----------------------------------------------------------------
    ctx, page, logs = open_page(browser, base, run, mic='allowed')
    page.click('#start')
    wait_class(page, 'is-mic')
    page.wait_for_function('document.getElementById("vib-state").textContent === "CALIBRATING"', timeout=1000)
    run.check(True, 'microphone calibrates the room first')
    page.wait_for_function('document.getElementById("vib-state").textContent === "ACTIVE"', timeout=8000)
    run.check(True, 'a bass pulse after calibration reads ACTIVE')
    run.check(page.text_content('#now-title') == 'LISTENING', 'the strip reads LISTENING')
    ink = 0
    for _ in range(8):                         # the pulse is 250 ms on, 250 ms off: sample across it
        ink = max(ink, spectrum_ink(page))
        page.wait_for_timeout(80)
    run.check(ink > 0, 'and the spectrum stands up')
    run.shot(page, '6-dashboard-mic')
    run.check(not logs, 'console stayed silent' + (f': {logs[:3]}' if logs else ''))
    ctx.close()

    # ---- 7. permission prompt never answered ------------------------------------------------------
    ctx, page, logs = open_page(browser, base, run, mic='unanswered')
    page.click('#start')
    page.wait_for_selector('#perm:not([hidden])', timeout=3000)
    run.check(True, 'the "allow the microphone" hint shows while the prompt is open')
    page.wait_for_selector('#card:not([hidden])', timeout=20000)
    run.check(page.text_content('#card-title') == 'Waiting for the microphone', 'after 15 s: "Waiting for the microphone"')
    wait_class(page, 'is-playing', 25000)
    run.check(True, 'and music starts by itself')
    run.check(not logs, 'console stayed silent' + (f': {logs[:3]}' if logs else ''))
    ctx.close()

    # ---- 8. idle reset ------------------------------------------------------------------------
    ctx, page, logs = open_page(browser, base + '?idle=3', run)
    page.click('#start')
    page.wait_for_selector('#card:not([hidden])', timeout=8000)
    page.click('#card-primary')
    wait_class(page, 'is-playing', 15000)
    page.click('#play')                        # paused music does not hold the session open
    page.wait_for_selector('#idle:not([hidden])', timeout=6000)
    run.check(True, 'idle countdown appears')
    run.shot(page, '7-idle')
    wait_class(page, 'is-landing', 8000)
    run.check(body_has(page, 'is-landing'), 'idle reset returns to the start screen')
    run.check(not logs, 'console stayed silent' + (f': {logs[:3]}' if logs else ''))
    ctx.close()

    # ---- 9. portrait screen --------------------------------------------------------------------
    ctx = browser.new_context(viewport={'width': 1080, 'height': 1920}, device_scale_factor=1)
    page = ctx.new_page()
    page.add_init_script(MIC['denied'])
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto(base)
    page.wait_for_function('document.body && !document.body.classList.contains("is-booting")')
    run.check(body_has(page, 'is-portrait'), 'a tall screen gets the portrait layout')
    page.wait_for_timeout(1200)
    run.shot(page, '9-portrait-landing')
    page.click('#start')
    page.wait_for_selector('#card:not([hidden])', timeout=8000)
    page.click('#card-primary')
    wait_class(page, 'is-playing', 15000)
    page.wait_for_timeout(1500)
    run.shot(page, '9-portrait-dashboard')
    run.check(not logs, 'console stayed silent' + (f': {logs[:3]}' if logs else ''))
    ctx.close()

    # ---- 10. offline: the wifi drops after the first visit -----------------------------------------
    # A server of its own (a fresh origin, so a fresh cache), switched off for real mid-test.
    if not local:
        browser.close()
        return run
    srv, url = serve()
    ctx = browser.new_context(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    page = ctx.new_page()
    page.add_init_script(MIC['denied'])
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto(url + '?sw')                     # the offline cache is opt-in on a local server
    page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=20000)
    page.click('#start')
    page.wait_for_selector('#card:not([hidden])', timeout=8000)
    page.click('#card-primary')
    wait_class(page, 'is-playing', 15000)      # the first track is now cached as well
    srv.shutdown()
    srv.server_close()
    page.reload()
    page.wait_for_function('document.body && !document.body.classList.contains("is-booting")', timeout=10000)
    page.wait_for_timeout(1500)
    run.check(page.is_visible('#start') and page.evaluate("!document.getElementById('gl').hidden"),
              'offline: the site and the vest still load')
    page.click('#start')
    page.wait_for_selector('#card:not([hidden])', timeout=8000)
    page.click('#card-primary')
    wait_class(page, 'is-playing', 15000)
    run.check(True, 'offline: a cached track still plays')
    run.check(not logs, 'console stayed silent' + (f': {logs[:3]}' if logs else ''))
    ctx.close()

    browser.close()
    return run


def main():
    argv = sys.argv[1:]
    shots = None
    if '--shots' in argv:
        i = argv.index('--shots')
        shots = argv[i + 1]
        del argv[i:i + 2]
    url = None
    if '--url' in argv:
        i = argv.index('--url')
        url = argv[i + 1]
        del argv[i:i + 2]
    engines = argv or ['chromium', 'webkit']
    httpd, base = serve()
    runs = []
    with sync_playwright() as p:
        for e in engines:
            runs.append(test_engine(p, e, url or base, shots, local=not url))
    httpd.shutdown()
    print()
    failed = False
    for r in runs:
        print(f'{r.name:9} {r.passes} passed, {len(r.failures)} failed')
        failed |= bool(r.failures)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
