/**
 * A hidden status panel for whoever is running the show: press D (or open with ?debug).
 * Also the only place errors go. The console stays quiet and visitors never see a stack trace.
 */

import { VERSION, urlFlag } from './config.js';

export class Diagnostics {
  constructor(read) {
    this.read = read;                 // () => object of live values
    this.el = document.getElementById('diag');
    this.errors = [];
    this.fps = 60;
    this.lastPaint = 0;
    this.visible = !!urlFlag('debug');
    this.el.hidden = !this.visible;
    const note = (msg) => {
      this.errors.push(`${new Date().toLocaleTimeString()}  ${String(msg).slice(0, 140)}`);
      if (this.errors.length > 5) this.errors.shift();
    };
    window.addEventListener('error', (e) => { note(e.message || 'error'); e.preventDefault(); });
    window.addEventListener('unhandledrejection', (e) => {
      note((e.reason && (e.reason.code || e.reason.message)) || 'rejected promise');
      e.preventDefault();
    });
  }

  toggle() { this.visible = !this.visible; this.el.hidden = !this.visible; }

  frame(dt, now) {
    if (dt > 0) this.fps = this.fps * 0.94 + (1 / dt) * 0.06;
    if (!this.visible || now - this.lastPaint < 250) return;
    this.lastPaint = now;
    const v = this.read();
    const lines = [
      `HAPTICWEAR LIVE ${VERSION}`,
      `fps          ${this.fps.toFixed(0)}`,
      `scene        ${v.scene}`,
      `audio        ${v.audio}  ${v.sampleRate} Hz`,
      `source       ${v.source}`,
      `rms          ${v.rms.toFixed(4)}   floor ${v.floor.toFixed(4)}`,
      `zones        ${v.zones.map((z) => z.toFixed(2)).join('  ')}`,
      `vest (ble)   ${v.ble}`,
      `3d           ${v.gl}   pixel ratio ${v.pixelRatio.toFixed(2)}`,
      `offline      ${v.offline}`,
      `idle         ${v.idle.toFixed(0)} s`,
    ];
    if (this.errors.length) lines.push('', 'recent issues', ...this.errors);
    this.el.textContent = lines.join('\n');
  }
}
