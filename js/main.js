/**
 * HapticWear Live — entry point.
 *
 * Scenes:   landing (attract loop)  ->  dash (the dashboard)  <->  expanded (the vest full screen)
 * Sources:  microphone (default on START) | built-in music | My Library files
 *
 * One requestAnimationFrame loop reads the analyser, draws the dashboard, moves the vest, streams
 * to the physical vest if connected, and runs the kiosk timers. Every failure path ends in a
 * designed state; nothing here ever surfaces a raw error to a visitor.
 */

import { KIOSK, urlFlag } from './core/config.js';
import { StageFit, rectOf } from './core/stage.js';
import { Kiosk } from './core/kiosk.js';
import { Diagnostics } from './core/diagnostics.js';
import { AudioEngine } from './audio/engine.js';
import { Analysis } from './audio/analysis.js';
import { Library } from './audio/library.js';
import { VestView } from './three/vest.js';
import { VestLink } from './ble/vest-ble.js';
import { Dashboard } from './ui/dashboard.js';
import { Drawer } from './ui/drawer.js';
import { Notices } from './ui/notices.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

const engine = new AudioEngine();
const analysis = new Analysis();
const library = new Library();
const vest = new VestView($('gl'));
const link = new VestLink();
const dash = new Dashboard();
const notices = new Notices();

const app = {
  scene: 'landing',
  track: null,          // current or last track
  loading: 0,           // token: only the latest track request may start playing
  gl: false,            // WebGL vest available
  started: 0,
  starting: false,      // START is running (it awaits the audio context)
  callouts: [],
  updateReady: false,   // a new deploy is cached: reload at the next reset
};

let stage, drawer, kiosk, diag;

/* ============================================================ scenes */

const TARGETS = { landing: 'landing-stage', dash: 'model-viewport', expanded: 'expanded-stage' };
const RIG = { landing: 'landing', dash: 'dashboard', expanded: 'expanded' };

function setScene(scene) {
  if (app.scene === scene) return;
  app.scene = scene;
  body.classList.toggle('is-landing', scene === 'landing');
  body.classList.toggle('is-dash', scene === 'dash');
  body.classList.toggle('is-expanded', scene === 'expanded');
  $('expanded').setAttribute('aria-hidden', String(scene !== 'expanded'));
  if (scene !== 'dash') drawer.close();
  if (app.gl) vest.setTarget(rectOf($(TARGETS[scene])), RIG[scene]);
}

function expand() { if (app.scene === 'dash') setScene('expanded'); }
function collapse() { if (app.scene === 'expanded') setScene('dash'); }

/* ============================================================ start / reset */

async function start() {
  if (app.scene !== 'landing' || app.starting) return;
  app.starting = true;
  try { await begin(); } finally { app.starting = false; }
}

async function begin() {
  kiosk.enterFullscreenIfKiosk();
  kiosk.touch();
  try {
    await engine.ensure();
  } catch {
    notices.card({
      eyebrow: 'AUDIO', title: 'This browser cannot process audio',
      body: 'HapticWear needs a current version of *Chrome* or *Safari*.',
      primary: { label: 'OK', action: () => {} },
    });
    return;
  }
  if (!analysis.analyser) {
    analysis.attach(engine.analyser, engine.sampleRate);
    dash.setSampleRate(engine.sampleRate);
  }
  kiosk.keepAwake();
  body.classList.add('is-starting');
  setScene('dash');
  setTimeout(() => body.classList.remove('is-starting'), 1200);
  await useMic();
}

/** Back to a clean start screen for the next visitor. Keeps a vest connection alive. */
function reset() {
  if (app.updateReady) { location.reload(); return; }
  notices.closeCard();
  notices.permission(false);
  engine.stopAll();
  link.rest();
  app.loading++;
  app.track = null;
  analysis.reset('music');
  setScene('landing');
  updateSourceUI();
}

/* ============================================================ sources */

async function useMic() {
  notices.permission(true);
  // An unanswered browser prompt must not leave an unattended screen waiting forever.
  const waiting = setTimeout(() => {
    if (engine.kind || app.scene === 'landing') return;     // a source was chosen, or the session ended
    notices.permission(false);
    notices.card({
      eyebrow: 'MICROPHONE', title: 'Waiting for the microphone',
      body: 'Choose *Allow* in the browser’s prompt to let HapticWear listen. Until then, here is music.',
      primary: { label: 'PLAY MUSIC', action: playDefault }, autoMs: 9000,
    });
  }, KIOSK.MIC_PROMPT_TIMEOUT_MS);
  try {
    await engine.useMic();
    notices.closeCard();
    analysis.reset('mic');
  } catch (err) {
    if (err.code !== 'mic-superseded') micFailed(err.code);
  } finally {
    clearTimeout(waiting);
    notices.permission(false);
    updateSourceUI();
  }
}

/** A designed state for each way the microphone can fail, then music so the screen never goes dead. */
function micFailed(code) {
  const common = { primary: { label: 'PLAY MUSIC', action: playDefault }, autoMs: 9000 };
  const copy = {
    'mic-denied': {
      title: 'The microphone is blocked',
      body: 'To let HapticWear listen, allow the microphone for this page. In *Chrome*, click the icon at the left of the address bar. In *Safari*, open Safari › Settings for This Website › Microphone › Allow. Until then, here is music.',
      secondary: { label: 'TRY AGAIN', action: useMic },
    },
    'mic-notfound': { title: 'No microphone found', body: 'This computer has no microphone connected, so HapticWear will play music instead. Put the headphones on.' },
    'mic-busy': { title: 'The microphone is busy', body: 'Another app is using the microphone. HapticWear will play music instead.', secondary: { label: 'TRY AGAIN', action: useMic } },
    'mic-insecure': { title: 'The microphone needs a secure page', body: 'Open HapticWear from its *https://* address to use the microphone. Playing music instead.' },
  }[code] || { title: 'The microphone is unavailable', body: 'HapticWear will play music instead. Put the headphones on.' };
  notices.card({ eyebrow: 'MICROPHONE', ...common, ...copy });
}

function playDefault() {
  const first = library.builtInTracks[0];
  if (first) playTrack(first);
  else drawer.open();
}

async function playTrack(track, attempt = 0) {
  if (!track) return;
  const token = ++app.loading;
  app.track = track;
  drawer.setCurrent(track);
  showNow({ title: 'LOADING', artist: track.title.toUpperCase(), tag: '' });
  try {
    const buffer = await engine.load(track.blob || track.url);
    if (token !== app.loading) return;
    engine.play(buffer);
    analysis.reset('music');
    if (!track.duration) library.noteDuration(track, buffer.duration);
    updateSourceUI();
    prefetch(library.next(track));
  } catch {
    if (token !== app.loading) return;
    const next = library.next(track);
    const size = (library.category(track.category) || { tracks: [] }).tracks.length;
    if (next && next.id !== track.id && attempt < size) {
      notices.toast(`Could not play “${track.title}”. Skipping to the next track.`);
      playTrack(next, attempt + 1);
    } else {
      notices.toast('That track could not be played.');
      updateSourceUI();
    }
  }
}

/** Warm the cache for the next track so auto-advance is instant, even if the wifi drops. */
function prefetch(track) {
  if (!track || !track.url || (navigator.connection && navigator.connection.saveData)) return;
  fetch(track.url, { priority: 'low' }).catch(() => {});
}

function togglePlay() {
  if (engine.kind !== 'music') { if (app.track) playTrack(app.track); else playDefault(); return; }
  if (engine.playing) engine.pause(); else engine.resume();
}

function step(dir) {
  if (!app.track) { playDefault(); return; }
  playTrack(library.next(app.track, dir));
}

function showNow({ title, artist, tag }) {
  $('now-title').textContent = title;
  $('now-artist').textContent = artist || '';
  const tagEl = $('now-tag');
  tagEl.hidden = !tag;
  tagEl.textContent = tag || '';
}

function updateSourceUI() {
  const kind = engine.kind;
  body.classList.toggle('is-mic', kind === 'mic');
  body.classList.toggle('is-playing', kind === 'music' && engine.playing);
  body.classList.toggle('is-paused', kind === 'music' && !engine.playing);
  document.querySelectorAll('.src').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.source === kind)));
  if (kind === 'mic') {
    const khz = (engine.sampleRate / 1000).toFixed(engine.sampleRate % 1000 ? 1 : 0);
    showNow({ title: 'LISTENING', artist: `${engine.micLabel.replace(/\s*\(.*?\)\s*/g, ' ').trim().toUpperCase()}  ·  ${khz} KHZ`, tag: '' });
  } else if (kind === 'music' && app.track) {
    showNow({ title: app.track.title, artist: (app.track.artist || '').toUpperCase(), tag: app.track.licence || (app.track.local ? 'MY LIBRARY' : '') });
  } else if (app.scene !== 'landing') {
    showNow({ title: 'Choose a source', artist: 'MICROPHONE OR MUSIC', tag: '' });
  }
}

/* ============================================================ vest (bluetooth) */

function updateConnect() {
  const btn = $('connect');
  btn.classList.toggle('is-on', link.status === 'connected');
  btn.classList.toggle('is-busy', link.status === 'connecting');
  $('connect-label').textContent = { connected: 'VEST CONNECTED', connecting: 'CONNECTING…' }[link.status] || 'CONNECT VEST';
  if (link.message) notices.toast(link.message);
}

/* ============================================================ full-screen callouts */

function updateCallouts() {
  const pts = vest.motorScreen(app.callouts);
  const s = stage.scale;
  const zones = analysis.frame.zones;
  document.querySelectorAll('.callout').forEach((el, i) => {
    const p = pts[i];
    if (!p) return;
    const a = p.facing * (0.4 + 0.6 * Math.min(1, zones[i]));
    el.classList.toggle('is-left', p.side < 0);
    el.style.opacity = a.toFixed(3);
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(${p.side < 0 ? '-100%' : '0'}, -50%) translateX(${(p.side * 26 * s).toFixed(1)}px)`;
  });
}

/* ============================================================ input */

function bindInput() {
  $('start').addEventListener('click', start);
  $('model-box').addEventListener('click', expand);
  $('model-box').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expand(); } });
  $('collapse').addEventListener('click', (e) => { e.stopPropagation(); collapse(); });

  // Full-screen vest: drag to spin, click to return.
  const exp = $('expanded');
  let down = null;
  exp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    down = { x: e.clientX, moved: 0 };
    exp.classList.add('is-grabbing');
    vest.setDragging(true);
  });
  window.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    down.x = e.clientX;
    down.moved += Math.abs(dx);
    vest.nudge(dx);
  });
  window.addEventListener('pointerup', () => {
    if (!down) return;
    const click = down.moved < 6;
    down = null;
    exp.classList.remove('is-grabbing');
    vest.setDragging(false);
    if (click) collapse();
  });

  document.querySelectorAll('.src').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.source === 'mic') { if (engine.kind !== 'mic') useMic(); return; }
    if (engine.kind === 'music') drawer.toggle();
    else { drawer.open(); if (app.track) playTrack(app.track); else playDefault(); }
  }));
  $('play').addEventListener('click', togglePlay);
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('open-library').addEventListener('click', () => drawer.toggle());
  $('connect').addEventListener('click', () => (link.status === 'connected' ? link.disconnect() : link.connect()));

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'd') { diag.toggle(); return; }
    if (k === 'f') { kiosk.toggleFullscreen(); return; }
    if (app.scene === 'landing') {
      // A focused START button handles its own Enter and Space.
      if ((k === 'enter' || k === ' ') && !e.target.closest('button')) { e.preventDefault(); start(); }
      return;
    }
    if (k === 'escape') {
      if (notices.cardOpen) notices.closeCard();
      else if (drawer.isOpen) drawer.close();
      else collapse();
    } else if (k === ' ' && !e.target.closest('button, [tabindex]')) { e.preventDefault(); togglePlay(); }
    else if (k === 'arrowright') step(1);
    else if (k === 'arrowleft') step(-1);
    else if (k === 'm') { if (engine.kind !== 'mic') useMic(); }
    else if (k === 'l') drawer.toggle();
    else if (k === 'e') (app.scene === 'expanded' ? collapse() : expand());
  });

  engine.addEventListener('ended', () => {
    if (kiosk.idleEnough()) reset();
    else playTrack(library.next(app.track));
  });
  engine.addEventListener('mic-lost', () => {
    notices.toast('The microphone was disconnected. Playing music instead.');
    playDefault();
  });
  // Safari suspends or interrupts audio when the tab is hidden: wake it on the next touch or return.
  const wake = () => { if (engine.ctx && engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {}); };
  window.addEventListener('pointerdown', wake, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  engine.addEventListener('source', updateSourceUI);
  engine.addEventListener('state', updateSourceUI);
  link.addEventListener('change', updateConnect);
}

/* ============================================================ loop */

let last = 0;
const REST = [0, 0, 0, 0];

function loop(now) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
  last = now;
  const t = (now - app.started) / 1000;

  // Read layout before anything writes styles this frame.
  const target = app.gl ? rectOf($(TARGETS[app.scene])) : null;

  const live = engine.kind === 'mic' || (engine.kind === 'music' && engine.playing);
  const frame = live ? analysis.update(dt, true) : analysis.idle(dt);

  let zones = frame.zones;
  if (app.scene === 'landing') {
    // Attract loop: the motor points breathe slowly while the vest turns.
    const b = (p) => 0.18 + 0.14 * Math.sin(t * 1.25 + p);
    zones = [b(0), b(0.6), b(1.9), b(2.5)];
  } else {
    dash.render(frame, t, { source: engine.kind, playing: engine.playing, time: engine.currentTime, duration: engine.duration });
  }

  if (app.gl) {
    vest.retarget(target);
    vest.frame(dt, zones, app.scene === 'landing' ? 0 : frame.onset);
    if (app.scene === 'expanded') updateCallouts();
  }
  link.setZones(app.scene === 'landing' ? REST : frame.zones);
  kiosk.tick(now);
  diag.frame(dt, now);
  requestAnimationFrame(loop);
}

/* ============================================================ boot */

function showStills() {
  document.querySelectorAll('.still').forEach((img) => { img.hidden = false; });
  $('gl').hidden = true;
}

async function boot() {
  // The model is the largest first-view download: start it before anything else waits.
  const model = fetch('assets/model/vest.glb').then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()));
  model.catch(() => {});
  stage = new StageFit((s) => dash.resize(s, stage ? stage.portrait : false));
  dash.resize(stage.scale, stage.portrait);

  kiosk = new Kiosk({
    isSessionActive: () => app.scene !== 'landing',
    isMusicPlaying: () => engine.kind === 'music' && engine.playing,
    onReset: reset,
  });
  diag = new Diagnostics(() => ({
    scene: app.scene,
    audio: engine.ctx ? engine.ctx.state : 'not started',
    sampleRate: engine.sampleRate,
    source: engine.kind === 'music' && app.track ? `music: ${app.track.title}` : engine.kind || 'none',
    rms: analysis.frame.rms,
    floor: analysis.noiseFloor || 0,
    zones: analysis.frame.zones,
    ble: link.supported ? link.status : 'not supported in this browser',
    gl: app.gl ? 'webgl' : 'still image',
    pixelRatio: vest.pixelRatio,
    offline: navigator.serviceWorker && navigator.serviceWorker.controller ? 'cached, works offline' : 'not cached yet',
    idle: (performance.now() - kiosk.lastInput) / 1000,
  }));

  await library.load();
  drawer = new Drawer(library, {
    play: (t) => { playTrack(t); },
    added: (n) => notices.toast(n ? `Added ${n} track${n === 1 ? '' : 's'} to My Library.` : 'Those files are not playable audio.'),
  });

  app.gl = vest.init();
  if (app.gl) {
    vest.setTarget(rectOf($(TARGETS.landing)), 'landing', 0);
    vest.load(model).then((ok) => { if (!ok) { app.gl = false; showStills(); } });
  } else {
    showStills();
  }
  window.addEventListener('resize', () => vest.resize());

  $('connect').hidden = !link.supported;
  bindInput();
  updateSourceUI();

  app.started = performance.now();
  requestAnimationFrame(loop);
  requestAnimationFrame(() => body.classList.remove('is-booting'));

  registerServiceWorker();
}

/**
 * Offline support: the app shell is cached on the first visit and each track as it plays. On the
 * show computer (?kiosk) the whole music library is also fetched in the background, so the show
 * survives the wifi going down; ordinary visitors never download music they do not play.
 * A new deploy installs quietly and the page reloads at the next idle reset, between visitors.
 * Off on a local dev server (so edits show on reload) unless the URL has ?sw.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !urlFlag('sw')) return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => { if (hadController) app.updateReady = true; });
  sw.register('sw.js').then(() => sw.ready).then((reg) => {
    if (!kiosk.kiosk) return;
    setTimeout(() => {
      const urls = library.builtInTracks.map((t) => new URL(t.url, location.href).href);
      if (reg.active) reg.active.postMessage({ type: 'warm', urls });
    }, KIOSK.TOAST_MS * 2);
  }).catch(() => {});
}

boot();
