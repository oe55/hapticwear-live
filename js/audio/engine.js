/**
 * Audio engine: one AudioContext, one AnalyserNode, and whichever source is live.
 *
 *   microphone  -> analyser                        (never routed to the speakers: no feedback)
 *   music track -> analyser  +  master -> speakers (so headphones hear what the screen shows)
 *
 * Tracks are fetched and decoded whole (fetch -> decodeAudioData) rather than streamed through an
 * <audio> element. That keeps playback identical in Chrome and Safari, works from the service
 * worker cache when the network is gone, and avoids cross-origin analyser silence.
 *
 * Emits: 'source' (kind changed), 'ended' (track finished on its own), 'state' (play/pause).
 */

import { AUDIO } from '../core/config.js';

/** An error the UI knows how to present. `code` drives which designed state is shown. */
export class AudioError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.analyser = null;
    this.master = null;
    this.kind = null;            // 'mic' | 'music' | null
    this.micStream = null;
    this.micNode = null;
    this.micLabel = '';
    this.node = null;            // current AudioBufferSourceNode
    this.buffer = null;
    this.offset = 0;             // seconds into the buffer when paused
    this.startedAt = 0;          // ctx.currentTime when the current node started
    this.playing = false;
    this.request = 0;            // bumped by every source change; a late mic grant checks it
  }

  /** Create or resume the context. Must be called from a user gesture the first time. */
  async ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new AudioError('audio-unsupported');
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = AUDIO.FFT_SIZE;
      this.analyser.smoothingTimeConstant = AUDIO.SMOOTHING;
      // Some WebKit builds only pull an analyser that reaches the destination, so give it a
      // silent path there. Nothing is audible through this branch.
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.analyser.connect(sink).connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get currentTime() {
    if (!this.buffer) return 0;
    const t = this.playing ? this.offset + (this.ctx.currentTime - this.startedAt) : this.offset;
    return Math.min(t, this.buffer.duration);
  }

  /**
   * Switch to the live microphone. Throws AudioError with a presentable code. If another source
   * was chosen while the permission prompt was open, the late stream is released and this throws
   * 'mic-superseded', which the UI ignores.
   */
  async useMic() {
    const id = ++this.request;
    await this.ensure();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new AudioError(window.isSecureContext ? 'mic-unsupported' : 'mic-insecure');
    }
    let stream;
    try {
      // Raw input, exactly as the phone app asks for it: the browser's voice processing would
      // flatten music and gate the very dynamics the vest is meant to show.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      if (id !== this.request) throw new AudioError('mic-superseded', err);
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') throw new AudioError('mic-denied', err);
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') throw new AudioError('mic-notfound', err);
      if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') throw new AudioError('mic-busy', err);
      throw new AudioError('mic-failed', err);
    }
    if (id !== this.request) {
      stream.getTracks().forEach((t) => t.stop());
      throw new AudioError('mic-superseded');
    }
    this._stopMusic();
    this._releaseMic();
    this.micStream = stream;
    const track = stream.getAudioTracks()[0];
    this.micLabel = (track && track.label) || 'Microphone';
    if (track) track.addEventListener('ended', () => this.dispatchEvent(new Event('mic-lost')));
    this.micNode = this.ctx.createMediaStreamSource(stream);
    this.micNode.connect(this.analyser);
    this._setKind('mic');
  }

  /** Decode a track from a URL or a Blob. Throws AudioError('track-failed'). */
  async load(src) {
    await this.ensure();
    try {
      let data;
      if (src instanceof Blob) {
        data = await src.arrayBuffer();
      } else {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.arrayBuffer();
      }
      return await this.ctx.decodeAudioData(data);
    } catch (err) {
      throw new AudioError('track-failed', err);
    }
  }

  /** Play a decoded buffer from the start. */
  play(buffer) {
    this.request++;
    this._releaseMic();
    this._stopMusic();
    this.buffer = buffer;
    this.offset = 0;
    this._startNode();
    this._setKind('music');
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this._stopNode();
    this.playing = false;
    this.dispatchEvent(new Event('state'));
  }

  resume() {
    if (this.playing || !this.buffer) return;
    if (this.offset >= this.buffer.duration - 0.05) this.offset = 0;
    this._startNode();
    this.dispatchEvent(new Event('state'));
  }

  /** Stop everything and drop the mic, e.g. on the idle reset. The context stays alive. */
  stopAll() {
    this.request++;
    this._stopMusic();
    this._releaseMic();
    this._setKind(null);
  }

  _startNode() {
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.connect(this.analyser);
    node.connect(this.master);
    // A 30 ms fade-in so a track never starts with a click.
    const g = this.master.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setValueAtTime(0, this.ctx.currentTime);
    g.linearRampToValueAtTime(1, this.ctx.currentTime + 0.03);
    node.onended = () => {
      if (this.node !== node) return;     // stopped on purpose: not a natural end
      this.node = null;
      this.playing = false;
      this.offset = this.buffer ? this.buffer.duration : 0;
      this.dispatchEvent(new Event('ended'));
    };
    node.start(0, this.offset);
    this.node = node;
    this.startedAt = this.ctx.currentTime;
    this.playing = true;
  }

  _stopNode() {
    const node = this.node;
    this.node = null;
    if (!node) return;
    try { node.stop(); } catch { /* already stopped */ }
    node.disconnect();
  }

  _stopMusic() {
    this._stopNode();
    this.playing = false;
    this.buffer = null;
    this.offset = 0;
  }

  _releaseMic() {
    if (this.micNode) { this.micNode.disconnect(); this.micNode = null; }
    if (this.micStream) { this.micStream.getTracks().forEach((t) => t.stop()); this.micStream = null; }
  }

  _setKind(kind) {
    if (this.kind === kind) return;
    this.kind = kind;
    this.dispatchEvent(new Event('source'));
  }
}
