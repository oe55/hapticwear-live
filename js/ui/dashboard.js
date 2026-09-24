/**
 * Draws the live dashboard every frame: spectrum, band meters, vibration state, motor boxes, the
 * LIVE indicator and the now-playing strip. Also drives the band bars of the full-screen view.
 *
 * Drawing rules are the film's (render_videos.hw_interface): 80 bars, white below 300 Hz, cyan to
 * 2 kHz, ocean blue above; LOW/MID bars faded by level with a brighter 4 px tip in the same colour;
 * HIGH bars drawn solid so #3B1EFF reads on the black ground; a dashed reference line at 86%.
 */

import { AUDIO, PALETTE } from '../core/config.js';

const $ = (sel, root = document) => root.querySelector(sel);
const fmtTime = (s) => {
  if (!isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export class Dashboard {
  constructor() {
    this.canvas = $('#spec');
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.cssW = 1082;
    this.cssH = 464;
    this.meters = ['low', 'mid', 'high'].map((b) => ({
      fill: $(`.meter--${b} .meter__fill`), pct: $(`.meter--${b} .meter__pct`), last: -1, lastW: -1,
    }));
    this.hbars = ['low', 'mid', 'high'].map((b) => ({
      fill: $(`.hbar--${b} .hbar__fill`), pct: $(`.hbar--${b} .hbar__pct`), last: -1, lastW: -1,
    }));
    this.motors = [...document.querySelectorAll('.motor')].map((el) => ({ el, pct: $('.motor__pct', el), last: -1, on: false, glow: -1 }));
    this.vibState = $('#vib-state');
    this.vibSub = $('#vib-sub');
    this.vibCal = $('#vib-cal');
    this.vibCalFill = $('#vib-cal-fill');
    this.live = $('#live');
    this.liveDot = $('.live__dot');
    this.liveTxt = $('#live-txt');
    this.micLevel = $('#mic-level');
    this.nowBar = $('#now-bar');
    this.nowTime = $('#now-time');
    this.stateKey = '';
    this.setSampleRate(48000);
  }

  /** Bar colours depend on the real sample rate (Macs run at 48 kHz, not the 44.1 in the film). */
  setSampleRate(sr) {
    const hz = sr / AUDIO.FFT_SIZE;
    this.bars = Array.from({ length: AUDIO.BARS }, (_, i) => {
      const f = i * hz;
      if (f < 300) return { rgb: PALETTE.low, high: false };
      if (f < 2000) return { rgb: PALETTE.mid, high: false };
      return { rgb: PALETTE.high, high: true };
    });
    document.getElementById('sr').textContent = (sr / 1000).toFixed(sr % 1000 ? 1 : 0);
  }

  /** Keep the spectrum canvas sharp at the stage's current scale. */
  resize(scale, portrait) {
    this.cssW = portrait ? 912 : 1082;
    this.cssH = portrait ? 326 : 464;
    const k = scale * Math.min(window.devicePixelRatio || 1, 2);
    this.k = k;
    this.canvas.width = Math.max(1, Math.round(this.cssW * k));
    this.canvas.height = Math.max(1, Math.round(this.cssH * k));
  }

  /**
   * @param frame   analysis frame
   * @param t       seconds since start
   * @param status  { source: 'mic'|'music'|null, playing, time, duration }
   */
  render(frame, t, status) {
    this._spectrum(frame.spectrum);
    this._bars(this.meters, frame);
    this._bars(this.hbars, frame);
    this._vibration(frame, t, status);
    this._motors(frame.zones);
    this._live(t, status);
    this._strip(frame, status);
  }

  _spectrum(spec) {
    const c = this.ctx, W = this.cssW, H = this.cssH;
    c.setTransform(this.k, 0, 0, this.k, 0, 0);
    c.clearRect(0, 0, W, H);
    const n = AUDIO.BARS, bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = spec[i];
      const { rgb: [r, g, b], high } = this.bars[i];
      const h = Math.max(2, v * H * 0.92);
      const x = i * bw, y = H - h, w = bw - 3;
      c.fillStyle = `rgba(${r},${g},${b},${high ? 1 : 0.14 + v * 0.25})`;
      c.fillRect(x, y, w, h);
      c.fillStyle = `rgba(${r},${g},${b},${high ? 1 : 0.82})`;
      c.fillRect(x, y, w, 4);
    }
    // The film's dashed reference line.
    c.fillStyle = 'rgba(255,255,255,0.086)';
    const ly = Math.round(H * 0.86);
    for (let x = 0; x < W; x += 22) c.fillRect(x, ly, 10, 2);
  }

  _bars(list, f) {
    const vals = [f.low, f.mid, f.high];
    list.forEach((m, i) => {
      const v = Math.max(0, Math.min(1, vals[i]));
      if (Math.abs(v - m.lastW) > 0.002) {
        m.fill.style.transform = `scaleX(${v.toFixed(4)})`;
        m.lastW = v;
      }
      const pct = Math.round(v * 100);
      if (pct !== m.last) { m.pct.textContent = `${pct}%`; m.last = pct; }
    });
  }

  _vibration(f, t, status) {
    let state, sub, cls = '';
    if (f.calibrating) { state = 'CALIBRATING'; sub = 'STAY QUIET FOR A MOMENT'; cls = 'is-cal'; }
    else if (!status.source) { state = 'STANDBY'; sub = '—'; }
    else if (status.source === 'music' && !status.playing) { state = 'PAUSED'; sub = '—'; }
    else if (f.active) { state = 'ACTIVE'; sub = `CROSS-MODAL  ·  ${f.dominant}`; cls = 'is-on'; }
    else { state = 'QUIET'; sub = 'BELOW GATE'; }
    const key = state + sub + cls;
    if (key !== this.stateKey) {
      this.vibState.textContent = state;
      this.vibState.className = `vib__state ${cls}`;
      this.vibSub.textContent = sub;
      this.vibCal.hidden = !f.calibrating;
      this.stateKey = key;
    }
    if (f.calibrating) this.vibCalFill.style.transform = `scaleX(${f.calibration.toFixed(3)})`;
    // The film's jitter: the word shivers while the motors run.
    this.vibState.style.transform = f.active ? `translateX(${(Math.sin(t * 95) * 3).toFixed(2)}px)` : '';
  }

  _motors(zones) {
    this.motors.forEach((m, i) => {
      const z = Math.max(0, Math.min(1, zones[i]));
      const on = z > 0.05;
      if (on !== m.on) { m.el.classList.toggle('is-on', on); m.on = on; }
      if (Math.abs(z - m.glow) > 0.004) {
        m.glow = z;
        m.el.style.borderColor = on ? `rgba(255,255,255,${((90 + 120 * z) / 255).toFixed(3)})` : '';
        m.el.style.boxShadow = on
          ? `0 0 ${(10 + 30 * z).toFixed(1)}px rgba(255,255,255,${(0.2 * z).toFixed(3)}), inset 0 0 ${(22 * z).toFixed(1)}px rgba(255,255,255,${(0.06 * z).toFixed(3)})`
          : '';
      }
      const pct = Math.round(z * 100);
      if (pct !== m.last) { m.pct.textContent = `${pct}%`; m.last = pct; }
    });
  }

  _live(t, status) {
    const on = !!status.source && (status.source === 'mic' || status.playing);
    this.live.classList.toggle('is-off', !on);
    const txt = on ? 'LIVE' : status.source === 'music' ? 'PAUSED' : 'STANDBY';
    if (this.liveTxt.textContent !== txt) this.liveTxt.textContent = txt;
    this.liveDot.style.opacity = on ? (0.35 + 0.65 * Math.abs(Math.sin((t * Math.PI) / 1.5))).toFixed(3) : '1';
  }

  _strip(f, status) {
    if (status.source === 'mic') {
      const db = 20 * Math.log10(Math.max(f.rms, 1e-6));
      this.micLevel.style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 62) / 52)).toFixed(3)})`;
    } else if (status.source === 'music') {
      const p = status.duration ? status.time / status.duration : 0;
      this.nowBar.style.transform = `scaleX(${Math.max(0, Math.min(1, p)).toFixed(4)})`;
      const txt = `${fmtTime(status.time)} / ${fmtTime(status.duration)}`;
      if (this.nowTime.textContent !== txt) this.nowTime.textContent = txt;
    }
  }
}
