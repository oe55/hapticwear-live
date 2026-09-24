# HapticWear Live

**Sound you can feel.** HapticWear is a wearable vest that renders sound as touch: live frequency
analysis drives four vibration motors across the torso. This is the live companion to the vest for
the exhibition. It is a web page that listens to the room or plays music, shows exactly what the vest
would do, and drives the physical vest over Bluetooth when it is nearby.

**Open it:** https://oe55.github.io/hapticwear-live/
**Exhibition mode:** https://oe55.github.io/hapticwear-live/?kiosk (START also goes full screen)

Nothing to install. It runs entirely in the browser, with no server, no accounts and no API keys.
After the first visit it keeps working without a network connection.

Omar Essayeh · MSc Architectural Computation · The Bartlett, UCL

---

## On the day: checklist for the show computer

1. Open **Google Chrome** (Safari works too, but only Chrome can connect to the vest) and go to
   `https://oe55.github.io/hapticwear-live/?kiosk`. On this first visit, while the wifi works, it
   also saves the whole music library to the computer (about 45 MB, a minute or two). After that the
   show keeps running even if the network goes down.
2. Press **START**. When Chrome asks for the microphone, choose **Allow**. Chrome remembers this.
   If macOS blocks it, open System Settings › Privacy & Security › Microphone and turn Chrome on.
3. Press **F** at any point to go in or out of full screen.
4. Headphones: music plays through the computer's audio output. The microphone is never played back.
5. Optional, **the vest**: switch it on, then press **CONNECT VEST** and pick *HapticWear*.
   If the vest is off or out of range, nothing else is affected.
6. Optional, **your own music**: open **LIBRARY › MY LIBRARY** and drop in audio files or whole
   folders (e.g. a folder called `K-Pop` becomes a K-POP group). They stay on this computer only.
   Files bought from iTunes, Bandcamp or Amazon work. Streaming-app downloads (Spotify, Apple Music)
   are copy-protected and will not play.
7. Leave it running. 90 seconds after the last visitor touches it, it returns to the start screen by
   itself, with a 10-second countdown any touch cancels. While music plays it lets the track finish,
   up to 4 minutes. The screen will not go to sleep while the page is open.

If anything looks wrong, press **D** for a status panel (audio, microphone, vest, frame rate,
offline cache). Reloading the page is always safe.

### Keyboard

| Key | Action |
| --- | --- |
| `Enter` / `Space` on the start screen | START |
| `Space` | play / pause |
| `←` `→` | previous / next track |
| `M` | microphone |
| `L` | library |
| `E` | vest full screen |
| `Esc` | back / close |
| `F` | full screen |
| `D` | status panel |

### URL options

| Option | Effect |
| --- | --- |
| `?kiosk` | START also enters full screen |
| `?debug` | show the status panel from the start |
| `?idle=30` | idle reset after 30 s instead of 90 s (for testing) |
| `?sw` | enable the offline cache on a local server (it is always on when published) |

---

## What it does

- **Start screen.** The HAPTICWEAR wordmark, the vest turning slowly, and one START button.
- **Microphone.** START asks for the microphone, calibrates the room for two seconds, then listens.
  If the microphone is blocked, missing or busy, or the permission prompt is left unanswered, a
  short designed message explains what to do and the music starts on its own. The screen never goes
  dead.
- **Music.** A built-in library in several genres, chosen for a strong low end, all original or
  openly licensed. Visitors can also play files from My Library.
- **Dashboard.** Laid out on the same 1920 × 1080 grid as the HapticWear film:
  - an 80-bar spectrum coloured by band;
  - LOW / MID / HIGH meters;
  - the vibration state (ACTIVE / QUIET and the dominant band);
  - the four motor boxes, which glow as they fire;
  - the vest on a turntable with its motor points pulsing in sync.
- **Full screen.** Click the vest box and the vest fills the screen, with LOW / MID / HIGH bars
  below and the motors labelled. It is one continuous camera move, not a cut. Drag to spin; click
  to go back.
- **The vest.** In Chrome, CONNECT VEST streams the four motor levels to the vest at 30 Hz over
  Bluetooth Low Energy. The button is hidden in browsers without Web Bluetooth.

## How it works

```
 microphone ─┐                                          ┌─> dashboard (Canvas 2D + DOM)
             ├─> AnalyserNode ─> analysis.js ─> frame ──┼─> vest.js (WebGL, one canvas)
 music ──────┘   FFT 1024        bands, gate,           └─> vest-ble.js (4 bytes, 30 Hz)
   └─> speakers                  motor zones
```

- **Audio** (`js/audio/engine.js`). One `AudioContext` and one `AnalyserNode` (FFT 1024, smoothing
  0.4). The microphone feeds only the analyser and is never played back. Music is fetched and
  decoded whole, then played through an `AudioBufferSourceNode`, which behaves identically in Chrome
  and Safari and plays from the offline cache.
- **Analysis** (`js/audio/analysis.js`). A port of the HapticWear phone app, so the screen does what
  the vest would do:
  - band energy is the mean FFT magnitude over 20–300 / 300–2000 / 2000–8000 Hz;
  - a two-second room calibration sets the noise floor (mean + standard deviation);
  - the gate and headroom are the app's;
  - the cross-modal mapping drives all four motors from the low end times the level, with the back
    pair at 70%.

  Two additions make it read well on a large screen:
  - an adaptive reference, so both a quiet room and a loud track use the full range;
  - a per-bar room-noise estimate for the microphone spectrum, so a steady hum fades away and
    voices, claps and music stand out.

  The spectrum is drawn exactly as the film draws it: linear magnitude of bins 0–79, so the low end
  stands tall.
- **The vest** (`js/three/vest.js`). The HapticWear model, compressed with meshopt (125 KB), rendered
  with Three.js into one transparent full-window canvas. The canvas draws into whichever rectangle
  is active: the start screen, the model box or full screen. That is why moving between them is a
  single smooth camera move. It scales its resolution down on its own if a very large display
  cannot hold 60 fps. Without WebGL, a still image of the vest is shown instead.
- **Bluetooth** (`js/ble/vest-ble.js`). The protocol comes from the vest's Arduino firmware:
  - device `HapticWear`, service `19b10000-e8f2-537e-4f6c-d104768a1214`;
  - one 4-byte write characteristic, `[M1, M2, M3, M4]`, each 0–200;
  - the firmware stops the motors after 2 s without data, so the page streams continuously.
- **Exhibition behaviour** (`js/core/kiosk.js`). Idle reset, screen wake lock, cursor auto-hide and
  full screen.
- **Offline** (`sw.js`). A service worker caches the site on the first visit and each track as it
  plays. With `?kiosk` (the show computer) it also caches the whole music library in the
  background, so the show survives the wifi going down. Ordinary visitors never download music they
  don't play. A new version installs quietly and takes over at the next idle reset, between
  visitors.
- **My Library** (`js/audio/library.js`). Files are stored in the browser's IndexedDB on that
  computer and never uploaded. In a private window, which cannot store files, they play until the
  window closes.

No build step: the site is plain ES modules. Three.js r186 is vendored as one tree-shaken file
(`vendor/three/three.bundle.js`, rebuilt by `tools/build-vendor.sh` if ever needed).

```
index.html               the page: every screen and state, in one document
css/tokens.css           colours, type, fonts
css/app.css              layout on the film's grid, states, transitions
js/main.js               start-up, scenes, sources, input, the frame loop
js/core/                 config, stage scaling, kiosk behaviour, status panel
js/audio/                audio engine, analysis, music library
js/three/vest.js         the 3D vest
js/ble/vest-ble.js       Bluetooth link to the vest
js/ui/                   dashboard drawing, library drawer, notices
sw.js                    offline cache
assets/                  model, fonts, music, images
tests/smoke.py           end-to-end test in Chrome and Safari's engine
tools/                   service-worker stamp, Three.js vendoring
```

## Design system

| Token | Value | Use |
| --- | --- | --- |
| Background | `#09090B` | page |
| Panel | `#0E0E10` / `#151518` | panels, buttons |
| Border | `#1A1A1E` | panel outlines |
| Text | `#FFFFFF` / `#CECED6` / `#AAAAAA` / `#444444` | primary / WEAR / body / labels |
| LOW | `#FFFFFF` | below 300 Hz |
| MID | `#00E5FF` | 300 Hz – 2 kHz |
| HIGH | `#3B1EFF` | above 2 kHz, one flat colour |

- **Type.** The wordmark is Jost: HAPTIC in weight 400 white, WEAR in weight 250 `#CECED6`, wide
  tracking. JetBrains Mono is used for every label and number.
- **Grid.** The dashboard uses the film's 1920 × 1080 coordinates:
  - spectrum 70,170 · 1130 × 560;
  - meters at y 756;
  - vest box 1250,170 · 600 × 344;
  - vibration at y 539;
  - motors at y 678 and 810.

  The whole stage scales to fit any display, and tall screens get a portrait arrangement.
- **Motion.** Scene changes use one ease-in-out curve over 0.95 s. Panels enter in a short stagger.
  Reduced-motion settings are respected.

## Run it locally

```bash
cd hapticwear-live
python3 -m http.server 8000
```

Then open http://localhost:8000. The microphone needs `localhost` or `https`, not a `file://` path.

## Test

```bash
pip install playwright
python -m playwright install chromium webkit
python tests/smoke.py
```

The test runs 41 checks in both Chrome and WebKit (Safari's engine), with simulated microphones
(allowed, blocked, prompt left unanswered):

- START in all three microphone cases, and the music fallback;
- the dashboard, transport and full-screen view;
- the library and My Library;
- the idle reset;
- a portrait screen;
- the site, the vest and a played track still working after the network goes off;
- a console with nothing in it.

Add `--shots out/` to save a screenshot of every state. Add
`--url https://oe55.github.io/hapticwear-live/` to test the published site instead of the local
copy; every check except the offline one runs there.

## Publish (GitHub Pages)

The site is served straight from the `main` branch.

```bash
node tools/stamp.mjs                 # stamp the offline cache with this version
git add -A && git commit -m "Update"
git push
```

The first publish, already done for `oe55/hapticwear-live`:

```bash
git init -b main && git add -A && git commit -m "HapticWear Live"
gh repo create oe55/hapticwear-live --public --source . --push
gh api -X POST repos/oe55/hapticwear-live/pages -f "source[branch]=main" -f "source[path]=/"
```

GitHub Pages serves it at `https://<user>.github.io/<repo>/`, here
https://oe55.github.io/hapticwear-live/, a minute or two after each push.

## Credits

- Concept, design and code: Omar Essayeh.
- Music: see [CREDITS.md](CREDITS.md) for every track, artist, licence and source.
- [Three.js](https://threejs.org) (MIT) with meshoptimizer (MIT): `vendor/three/LICENSE`.
- Fonts: [Jost](https://github.com/indestructible-type/Jost),
  [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) and
  [Inter](https://github.com/rsms/inter), all under the SIL Open Font License
  (`assets/fonts/OFL.txt`).

© Omar Essayeh. The code, design and the HapticWear model are not licensed for reuse. Third-party
parts keep their own licences, listed above and in CREDITS.md.
