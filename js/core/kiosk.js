/**
 * Unattended-exhibition behaviour.
 *
 *  - Idle reset: back to the start screen 90 s after the last touch. If music is playing it waits
 *    for the track to end, up to 4 minutes after the last touch. The last 10 s show a countdown
 *    that any touch cancels.
 *  - Screen wake lock while the site is visible, so the display never sleeps mid-show.
 *  - Cursor hides after 3 s without movement.
 *  - `?kiosk` in the URL: START also goes full screen.
 */

import { KIOSK, urlFlag } from './config.js';

const $ = (id) => document.getElementById(id);

export class Kiosk {
  /**
   * @param {object} o
   * @param {() => boolean} o.isSessionActive   true while a visitor session is running
   * @param {() => boolean} o.isMusicPlaying    true while a track plays
   * @param {() => void}    o.onReset           return to the start screen
   */
  constructor(o) {
    Object.assign(this, o);
    const idle = Number(urlFlag('idle'));
    this.idleMs = (idle > 0 ? idle : KIOSK.IDLE_S) * 1000;
    this.capMs = Math.max(this.idleMs, KIOSK.IDLE_MUSIC_CAP_S * 1000);
    this.kiosk = !!urlFlag('kiosk');
    this.lastInput = performance.now();
    this.lock = null;
    this.cursorTimer = 0;
    this.overlay = $('idle');
    this.countEl = $('idle-count');
    this.fillEl = $('idle-fill');
    this.counting = false;

    const touch = () => this.touch();
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, touch, { passive: true, capture: true });
    }
    window.addEventListener('pointermove', () => this._cursor(), { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantLock) this.keepAwake();
    });
  }

  touch() {
    this.lastInput = performance.now();
    if (this.counting) this._count(false);
  }

  /** Called every frame. */
  tick(now) {
    if (!this.isSessionActive()) { if (this.counting) this._count(false); return; }
    const idle = now - this.lastInput;
    const music = this.isMusicPlaying();
    const limit = music ? this.capMs : this.idleMs;
    if (idle >= limit) { this._count(false); this.onReset(); return; }
    const remaining = limit - idle;
    const countdown = KIOSK.COUNTDOWN_S * 1000;
    if (remaining <= countdown && (!music || idle >= this.capMs - countdown)) {
      this._count(true, remaining / 1000);
    } else if (this.counting) {
      this._count(false);
    }
  }

  /** When a track ends on its own: has the visitor been gone long enough to reset now? */
  idleEnough(now = performance.now()) { return now - this.lastInput >= this.idleMs; }

  _count(on, seconds = 0) {
    this.counting = on;
    this.overlay.hidden = !on;
    if (!on) return;
    this.countEl.textContent = String(Math.max(1, Math.ceil(seconds)));
    this.fillEl.style.transform = `scaleX(${Math.max(0, seconds / KIOSK.COUNTDOWN_S)})`;
  }

  async keepAwake() {
    this.wantLock = true;
    if (!('wakeLock' in navigator) || this.lock) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; });
    } catch { /* not allowed right now: retried on the next visibility change */ }
  }

  /** In kiosk mode, START also takes the page full screen. Must run inside the click. */
  enterFullscreenIfKiosk() {
    if (this.kiosk) this.toggleFullscreen(true);
  }

  toggleFullscreen(force) {
    const el = document.documentElement;
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    const want = force === undefined ? !active : force;
    try {
      if (want && !active) (el.requestFullscreen || el.webkitRequestFullscreen).call(el)?.catch?.(() => {});
      else if (!want && active) (document.exitFullscreen || document.webkitExitFullscreen).call(document)?.catch?.(() => {});
    } catch { /* full screen refused: the site works the same without it */ }
  }

  _cursor() {
    document.body.classList.remove('hide-cursor');
    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), KIOSK.CURSOR_HIDE_MS);
  }
}
