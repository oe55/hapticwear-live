/**
 * Fits the fixed-size stages (1920 x 1080 landscape, 1080 x 1920 portrait) to the window.
 * Sets --s on :root; every stage scales by it, so the layout is the film's grid on any display.
 */

import { STAGE } from './config.js';

export class StageFit {
  constructor(onChange) {
    this.onChange = onChange;
    this.scale = 1;
    this.portrait = false;
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.measure()); };
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule);
    this.measure();
  }

  measure() {
    const w = window.innerWidth, h = window.innerHeight;
    // Portrait layout only on genuinely tall screens (phones, tablets on end).
    this.portrait = h > w * 1.1;
    document.body.classList.toggle('is-portrait', this.portrait);
    const box = this.portrait ? STAGE.portrait : STAGE.landscape;
    this.scale = Math.min(w / box.w, h / box.h);
    document.documentElement.style.setProperty('--s', String(this.scale));
    this.onChange(this.scale);
  }
}

/** Rectangle of an element in CSS pixels, for the WebGL viewport. */
export function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
