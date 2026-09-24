/**
 * Everything the visitor is told, in the design language: short notices, the microphone
 * permission hint, and full "designed state" cards for things like a blocked microphone.
 * Nothing here ever shows a raw error.
 */

import { KIOSK } from '../core/config.js';

const $ = (id) => document.getElementById(id);

export class Notices {
  constructor() {
    this.noticeEl = $('notice');
    this.permEl = $('perm');
    this.cardEl = $('card');
    this.scrimEl = $('scrim');
    this.noticeTimer = 0;
    this.permTimer = 0;
    this.cardRaf = 0;
    this.cardClose = null;
  }

  /** A short line at the bottom of the screen. */
  toast(text, ms = KIOSK.TOAST_MS) {
    clearTimeout(this.noticeTimer);
    this.noticeEl.textContent = text;
    this.noticeEl.classList.add('is-on');
    this.noticeTimer = setTimeout(() => this.noticeEl.classList.remove('is-on'), ms);
  }

  /**
   * The "allow the microphone" hint. Shown only if the browser prompt is still open after a
   * short delay, so a remembered permission never flashes it on screen.
   */
  permission(on) {
    clearTimeout(this.permTimer);
    if (on) this.permTimer = setTimeout(() => { this.permEl.hidden = false; }, KIOSK.PERMISSION_HINT_DELAY_MS);
    else this.permEl.hidden = true;
  }

  /**
   * A designed state. `body` is a list of text runs; a run wrapped in *asterisks* is emphasised.
   * Built as DOM text nodes, never HTML, so a file name can never inject markup.
   * `autoMs` runs the primary action after that long, with a visible timer, so an unattended
   * screen always moves on by itself.
   */
  card({ eyebrow, title, body, primary, secondary, autoMs = 0 }) {
    this.closeCard();
    $('card-eyebrow').textContent = eyebrow || '';
    $('card-title').textContent = title;
    const bodyEl = $('card-body');
    bodyEl.replaceChildren(...String(body).split(/(\*[^*]+\*)/).filter(Boolean).map((run) => {
      if (!run.startsWith('*')) return document.createTextNode(run);
      const b = document.createElement('b');
      b.textContent = run.slice(1, -1);
      return b;
    }));
    const p = $('card-primary'), s = $('card-secondary');
    p.textContent = primary.label;
    s.hidden = !secondary;
    if (secondary) s.textContent = secondary.label;
    const close = () => {
      cancelAnimationFrame(this.cardRaf);
      this.cardEl.hidden = true;
      this.scrimEl.hidden = true;
      p.onclick = s.onclick = null;
      this.cardClose = null;
    };
    p.onclick = () => { close(); primary.action(); };
    if (secondary) s.onclick = () => { close(); secondary.action(); };
    this.cardEl.hidden = false;
    this.scrimEl.hidden = false;
    this.cardClose = close;
    const timer = $('card-timer');
    timer.parentElement.hidden = !autoMs;
    if (autoMs) {
      const t0 = performance.now();
      const step = (now) => {
        const p01 = Math.min(1, (now - t0) / autoMs);
        timer.style.transform = `scaleX(${p01})`;
        if (p01 >= 1) { close(); primary.action(); return; }
        this.cardRaf = requestAnimationFrame(step);
      };
      this.cardRaf = requestAnimationFrame(step);
    }
    p.focus({ preventScroll: true });
  }

  closeCard() { if (this.cardClose) this.cardClose(); }
  get cardOpen() { return !!this.cardClose; }
}
