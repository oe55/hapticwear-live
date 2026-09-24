/**
 * Sound -> touch, frame by frame.
 *
 * This is a port of the HapticWear phone app's pipeline, so what the screen shows is what the vest
 * would do:
 *   - band energy = mean linear FFT magnitude over 20-300 / 300-2000 / 2000-8000 Hz   (app: be())
 *   - one-pole followers on RMS and the three bands                                   (app: SMOOTH)
 *   - microphone calibration: 2 s of room RMS, noise floor = mean + std               (app: lp())
 *   - gate = floor x (3 - 1.5 x sens), headroom = max(0.01, 0.15 - gate)              (app: doVib())
 *   - cross-modal mapping: every motor follows LOW x level, back pair at 70%          (app: 'cross')
 *
 * Two additions make it read well on an exhibition screen instead of a phone:
 *   - adaptive gain: each reference is the app's fixed value OR 85% of a slow peak follower,
 *     whichever is larger, so a whisper and a loud track both use the full meter range
 *   - the spectrum subtracts the calibrated per-bin room noise, so a quiet hall shows quiet bars
 */

import { AUDIO } from '../core/config.js';

const SENS = AUDIO.SENSITIVITY / 5;
const PEAK_KEEP_PER_S = Math.pow(0.5, 1 / AUDIO.PEAK_HALF_LIFE_S);

export class Analysis {
  constructor() {
    this.analyser = null;
    this.frame = {
      spectrum: new Float32Array(AUDIO.BARS),   // 0..1 bar heights
      low: 0, mid: 0, high: 0,                  // 0..1 meters
      level: 0,                                 // 0..1 gated loudness
      zones: [0, 0, 0, 0],                      // 0..1 motor drive, M1..M4
      active: false,
      dominant: 'LOW',
      calibrating: false,
      calibration: 0,                           // 0..1 progress
      onset: 0,                                 // >0 on a strong low-end hit (drives the shockwaves)
      rms: 0,
    };
    this.reset('music');
  }

  attach(analyser, sampleRate) {
    this.analyser = analyser;
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.time = new Float32Array(analyser.fftSize);
    this.noiseMag = new Float32Array(AUDIO.BARS);
    this.calMag = new Float32Array(AUDIO.BARS);
    const bin = (f) => Math.round((f * analyser.fftSize) / sampleRate);
    this.bandBins = {};
    for (const [k, [lo, hi]] of Object.entries(AUDIO.BANDS)) {
      this.bandBins[k] = [Math.max(1, bin(lo)), Math.min(bin(hi), analyser.frequencyBinCount - 1)];
    }
  }

  /** Start a fresh session. The microphone calibrates the room; music needs no calibration. */
  reset(kind) {
    this.kind = kind;
    this.follow = { rms: 0, low: 0, mid: 0, high: 0 };
    this.peak = { rms: 0, low: 0, mid: 0, high: 0 };
    this.specRef = 0;
    this.prevLow = 0;
    this.onsetCooldown = 0;
    this.calSamples = [];
    this.calElapsed = 0;
    this.calFrames = 0;
    if (kind === 'mic') {
      this.noiseFloor = 0;
      this.calibrating = true;
      if (this.calMag) this.calMag.fill(0);
    } else {
      this.noiseFloor = AUDIO.MUSIC_NOISE_FLOOR;
      this.calibrating = false;
      if (this.noiseMag) this.noiseMag.fill(0);
    }
    const f = this.frame;
    f.spectrum.fill(0);
    f.low = f.mid = f.high = f.level = f.onset = 0;
    f.zones.fill(0);
    f.active = false;
  }

  /** Mean linear magnitude over a band (the app's be()). */
  _band([a, b]) {
    let s = 0;
    for (let i = a; i <= b; i++) s += Math.pow(10, this.freq[i] / 20);
    return s / (b - a + 1);
  }

  /**
   * Advance one frame. `dt` is in seconds. `live` is false when nothing is feeding the analyser
   * (paused, no source): everything eases to rest instead of freezing.
   */
  update(dt, live) {
    const f = this.frame;
    const k = Math.pow(AUDIO.FOLLOW, dt * 60);              // frame-rate independent follower
    const peakKeep = Math.pow(PEAK_KEEP_PER_S, dt);

    let rms = 0, lo = 0, mi = 0, hi = 0;
    if (live && this.analyser) {
      this.analyser.getFloatFrequencyData(this.freq);
      this.analyser.getFloatTimeDomainData(this.time);
      let s = 0;
      for (let i = 0; i < this.time.length; i++) s += this.time[i] * this.time[i];
      rms = Math.sqrt(s / this.time.length);
      lo = this._band(this.bandBins.low);
      mi = this._band(this.bandBins.mid);
      hi = this._band(this.bandBins.high);
    }
    const fl = this.follow;
    fl.rms = fl.rms * k + rms * (1 - k);
    fl.low = fl.low * k + lo * (1 - k);
    fl.mid = fl.mid * k + mi * (1 - k);
    fl.high = fl.high * k + hi * (1 - k);
    f.rms = fl.rms;

    // ---- microphone calibration: 2 s of room tone ----
    if (this.calibrating) {
      this.calElapsed += dt * 1000;
      this.calSamples.push(rms);
      this.calFrames++;
      for (let i = 0; i < AUDIO.BARS; i++) this.calMag[i] += Math.pow(10, this.freq[i] / 20);
      f.calibrating = true;
      f.calibration = Math.min(1, this.calElapsed / AUDIO.CALIBRATION_MS);
      if (this.calElapsed >= AUDIO.CALIBRATION_MS) this._finishCalibration();
      this._drawSpectrum(dt, live);
      this._rest(dt);
      return f;
    }
    f.calibrating = false;

    // ---- adaptive references (the app's fixed values are the floor) ----
    const pk = this.peak;
    pk.low = Math.max(fl.low, pk.low * peakKeep);
    pk.mid = Math.max(fl.mid, pk.mid * peakKeep);
    pk.high = Math.max(fl.high, pk.high * peakKeep);
    const ref = (band) => Math.max(AUDIO.REF[band] / SENS, pk[band] * AUDIO.PEAK_SHARE);
    const lN = Math.min(fl.low / ref('low'), 1);
    const mN = Math.min(fl.mid / ref('mid'), 1);
    const hN = Math.min(fl.high / ref('high'), 1);

    // ---- gate and level (app: doVib) ----
    const gate = this.noiseFloor * (3.0 - SENS * 1.5);
    const rGated = Math.max(0, fl.rms - gate);
    pk.rms = Math.max(rGated, pk.rms * peakKeep);
    const headroom = Math.max(0.01, 0.15 - gate);
    const rRef = Math.max(headroom / SENS, pk.rms * AUDIO.PEAK_SHARE);
    const rN = rGated < 0.002 ? 0 : Math.min(rGated / rRef, 1);

    // ---- cross-modal mapping: lows drive all four, back pair at 70% ----
    const z = lN * rN;
    f.zones[0] = z;
    f.zones[1] = z;
    f.zones[2] = z * AUDIO.BACK_MOTOR_SCALE;
    f.zones[3] = z * AUDIO.BACK_MOTOR_SCALE;
    f.level = rN;
    f.low = lN;
    f.mid = mN;
    f.high = hN;
    f.active = z > AUDIO.ACTIVE_THRESHOLD;
    f.dominant = lN >= mN && lN >= hN ? 'LOW' : hN >= mN ? 'HIGH' : 'MID';

    // ---- onsets: a sharp rise in the low drive fires a shockwave on the motor points ----
    this.onsetCooldown = Math.max(0, this.onsetCooldown - dt);
    const rise = z - this.prevLow;
    f.onset = 0;
    if (rise > 0.16 * dt * 60 && z > 0.38 && this.onsetCooldown === 0) {
      f.onset = Math.min(1, z);
      this.onsetCooldown = 0.18;
    }
    this.prevLow = this.prevLow + (z - this.prevLow) * Math.min(1, dt * 18);

    this._drawSpectrum(dt, live);
    return f;
  }

  _finishCalibration() {
    const n = this.calSamples.length || 1;
    const mean = this.calSamples.reduce((a, b) => a + b, 0) / n;
    const variance = this.calSamples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    this.noiseFloor = mean + Math.sqrt(variance);                  // the app's noise floor
    for (let i = 0; i < AUDIO.BARS; i++) this.noiseMag[i] = this.calMag[i] / Math.max(1, this.calFrames);
    this.calibrating = false;
  }

  /**
   * Bar heights, drawn the way the film was: linear FFT magnitude of bins 0-79 against a reference
   * level, so the low end stands tall and the highs sit low (render_videos.analyze divides by the
   * 99th percentile of the whole track; live, the reference is a slow peak follower). The
   * microphone first subtracts each bar's room noise: measured during calibration, then tracked.
   */
  _drawSpectrum(dt, live) {
    const spec = this.frame.spectrum;
    const mic = this.kind === 'mic';
    const mags = this.mags || (this.mags = new Float32Array(AUDIO.BARS));
    const fall = Math.min(1, dt * 4);
    const rise = 1 + AUDIO.SPEC_NOISE_RISE * dt;
    let top = 0;
    for (let i = 0; i < AUDIO.BARS; i++) {
      let m = 0;
      if (live) {
        m = Math.pow(10, this.freq[i] / 20);
        if (mic && !this.calibrating) {
          // Track each bar's room floor: drop at once when the room gets quieter, creep up under
          // steady sound. A hum fades out; claps, voices and music stay on top of it.
          const n = this.noiseMag[i];
          this.noiseMag[i] = m < n ? n + (m - n) * fall : Math.min(m, n * rise);
          m = Math.max(0, m - this.noiseMag[i] * AUDIO.SPEC_NOISE_MARGIN);
        }
      }
      mags[i] = m;
      if (m > top) top = m;
    }
    const keep = Math.pow(0.5, dt / AUDIO.SPEC_HALF_LIFE_S);
    this.specRef = top > this.specRef ? this.specRef + (top - this.specRef) * Math.min(1, dt * 10) : this.specRef * keep;
    const ref = Math.max(this.specRef * AUDIO.SPEC_REF_SHARE, AUDIO.SPEC_MIN_REF);
    // The film's frame smoothing (0.25 old / 0.75 new at 30 fps), made frame-rate independent.
    const blend = 1 - Math.pow(0.25, dt * 30);
    for (let i = 0; i < AUDIO.BARS; i++) {
      const v = Math.min(1, mags[i] / ref);
      spec[i] += (v - spec[i]) * blend;
    }
  }

  /** Ease the meters and motors to rest (paused, calibrating, or no source). */
  _rest(dt) {
    const f = this.frame;
    const e = Math.min(1, dt * 8);
    f.low -= f.low * e; f.mid -= f.mid * e; f.high -= f.high * e; f.level -= f.level * e;
    for (let i = 0; i < 4; i++) f.zones[i] -= f.zones[i] * e;
    f.active = false;
    f.onset = 0;
  }

  /** For paused music or no source. */
  idle(dt) {
    this.frame.calibrating = false;
    this._drawSpectrum(dt, false);
    this._rest(dt);
    return this.frame;
  }
}
