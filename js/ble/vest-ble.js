/**
 * Web Bluetooth link to the physical vest.
 *
 * Protocol (03_Code/Arduino/HapticWear_BLE_Serial.ino):
 *   device name "HapticWear", one service, one 4-byte write characteristic: [M1, M2, M3, M4],
 *   each 0-255, clamped to 200 by the firmware. If no packet arrives for 2 s the firmware zeroes
 *   the motors, so this streams continuously at 30 Hz while connected.
 *
 * Web Bluetooth only exists in Chromium browsers. Everywhere else `supported` is false and the UI
 * hides the button. Every failure is silent to the visitor: the dashboard never depends on the vest.
 *
 * Emits 'change' whenever `status` changes: 'idle' | 'connecting' | 'connected' | 'error'.
 */

import { BLE } from '../core/config.js';

export class VestLink extends EventTarget {
  constructor() {
    super();
    this.supported = typeof navigator !== 'undefined' && !!navigator.bluetooth && window.isSecureContext;
    this.status = 'idle';
    this.message = '';
    this.device = null;
    this.char = null;
    this.values = new Uint8Array(4);
    this.busy = false;
    this.timer = null;
  }

  /** Must be called from a click: the browser shows its device chooser. */
  async connect() {
    if (!this.supported || this.status === 'connecting') return;
    this._set('connecting');
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: BLE.NAME }],
        optionalServices: [BLE.SERVICE],
      });
      device.addEventListener('gattserverdisconnected', () => this._dropped());
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE.SERVICE);
      this.char = await service.getCharacteristic(BLE.CHARACTERISTIC);
      this.device = device;
      this._set('connected');
      this._startStream();
    } catch (err) {
      this.char = null;
      this.device = null;
      // The visitor closing the chooser is not an error worth mentioning.
      const cancelled = err && (err.name === 'NotFoundError' && /cancel/i.test(err.message || ''));
      this._set(cancelled ? 'idle' : 'error',
        cancelled ? '' : 'No vest found nearby. Everything else keeps working.');
    }
  }

  disconnect() {
    this._stopStream();
    if (this.device && this.device.gatt.connected) {
      this._write(new Uint8Array(4)).finally(() => this.device && this.device.gatt.disconnect());
    }
    this.char = null;
    this.device = null;
    this._set('idle');
  }

  /** Latest motor drive, 0..1 per motor. Sent on the next 30 Hz tick. */
  setZones(zones) {
    for (let i = 0; i < 4; i++) this.values[i] = Math.min(BLE.MAX_DUTY, Math.round(Math.max(0, zones[i]) * 255));
  }

  /** Zero the motors without dropping the connection (used by the idle reset). */
  rest() { this.values.fill(0); }

  _startStream() {
    this._stopStream();
    this.timer = setInterval(() => { if (!this.busy) this._write(this.values); }, 1000 / BLE.RATE_HZ);
  }

  _stopStream() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _write(bytes) {
    if (!this.char) return;
    this.busy = true;
    try {
      if (this.char.writeValueWithoutResponse) await this.char.writeValueWithoutResponse(bytes);
      else await this.char.writeValue(bytes);
    } catch {
      // A dropped packet is harmless: the next one follows in 33 ms.
    } finally {
      this.busy = false;
    }
  }

  _dropped() {
    this._stopStream();
    this.char = null;
    this.device = null;
    this._set('idle', 'Vest disconnected.');
  }

  _set(status, message = '') {
    this.status = status;
    this.message = message;
    this.dispatchEvent(new Event('change'));
  }
}
