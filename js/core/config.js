/**
 * HapticWear Live — shared constants.
 *
 * Everything here is either part of the design system (colours, geometry) or ported from the
 * project's own sources, so the live site behaves like the real vest:
 *   - audio constants from the HapticWear phone app (03_Code/Mobile App Demo/index.html)
 *   - BLE protocol from the vest firmware (03_Code/Arduino/HapticWear_BLE_Serial.ino)
 *   - motor positions from the render system (scripts/scene3d.py, PADS)
 */

export const VERSION = '1.0.0';

/** Band colours as RGB for the spectrum canvas. The rest of the design system is css/tokens.css. */
export const PALETTE = {
  low: [255, 255, 255],   // LOW  < 300 Hz          #FFFFFF
  mid: [0, 229, 255],     // MID  300 – 2000 Hz     #00E5FF
  high: [59, 30, 255],    // HIGH > 2000 Hz         #3B1EFF, one flat colour, never a lighter cap
};

/** Audio analysis. The band edges, FFT size and gate constants are the phone app's. */
export const AUDIO = {
  FFT_SIZE: 1024,
  SMOOTHING: 0.4,               // AnalyserNode.smoothingTimeConstant, as in the app
  BARS: 80,                     // first 80 FFT bins, as in the app and the film
  BANDS: { low: [20, 300], mid: [300, 2000], high: [2000, 8000] },
  FOLLOW: 0.3,                  // per-frame hold for the band followers at 60 fps (app: SMOOTH = 0.3)
  CALIBRATION_MS: 2000,         // ambient noise calibration before the mic goes live
  SENSITIVITY: 7,               // app default; sensMultiplier = SENSITIVITY / 5
  // Band references the app was tuned with on a phone mic (mean linear FFT magnitude).
  REF: { low: 0.003, mid: 0.002, high: 0.0008 },
  // Adaptive gain: a slow peak follower so loud music does not pin every meter at 100%.
  PEAK_HALF_LIFE_S: 5,
  PEAK_SHARE: 0.85,
  BACK_MOTOR_SCALE: 0.7,        // back motors run at 70% of the front pair, as on the vest
  ACTIVE_THRESHOLD: 0.03,       // app: max(z) > 0.03 reads ACTIVE
  MUSIC_NOISE_FLOOR: 0.0015,    // digital playback has no room noise to calibrate against
  // Spectrum bars: linear magnitude against a slow peak reference, as the film draws them.
  SPEC_HALF_LIFE_S: 6,          // how fast the reference relaxes after a loud passage
  SPEC_REF_SHARE: 0.8,          // the loudest bars reach the top, like the film's 99th percentile
  SPEC_MIN_REF: 0.001,          // silence stays flat instead of amplifying hiss
  SPEC_NOISE_MARGIN: 1.25,      // microphone: room noise x this is subtracted from every bar
  SPEC_NOISE_RISE: 0.15,        // ...and the noise estimate may creep up 15% a second under steady sound
};

/** Web Bluetooth protocol of the physical vest (Arduino UNO R4 WiFi firmware). */
export const BLE = {
  NAME: 'HapticWear',
  SERVICE: '19b10000-e8f2-537e-4f6c-d104768a1214',
  CHARACTERISTIC: '19b10001-e8f2-537e-4f6c-d104768a1214',
  RATE_HZ: 30,                  // firmware zeroes the motors after 2 s without data
  MAX_DUTY: 200,                // firmware clamps PWM at 200
};

/**
 * The four motors, in the vest model's normalised space.
 * The film's PADS (scene3d.py: ±0.16, 0, 0.20 / -0.18) sit inside the torso cavity, which is fine for
 * flat 2D glows but would be hidden by the lattice in real 3D. These are the nearest points on the
 * lattice surface (closest-point query on the mesh), just outside the outer face: where a motor
 * physically sits against the print.
 */
export const MOTORS = [
  { id: 'M1', label: 'FRONT LEFT',  pos: [-0.144, -0.035, 0.392], facing: 1 },
  { id: 'M2', label: 'FRONT RIGHT', pos: [0.142, -0.004, 0.392], facing: 1 },
  { id: 'M3', label: 'BACK LEFT',   pos: [-0.151, -0.033, -0.392], facing: -1 },
  { id: 'M4', label: 'BACK RIGHT',  pos: [0.139, -0.008, -0.392], facing: -1 },
];

/** Exhibition behaviour. Overridable from the URL: ?idle=30 for testing. */
export const KIOSK = {
  IDLE_S: 90,                   // back to the start screen after 90 s without a touch
  IDLE_MUSIC_CAP_S: 240,        // ...but never mid-track, up to 4 minutes after the last touch
  COUNTDOWN_S: 10,              // visible countdown before a reset
  CURSOR_HIDE_MS: 3000,
  TOAST_MS: 5200,
  PERMISSION_HINT_DELAY_MS: 450,
  MIC_PROMPT_TIMEOUT_MS: 15000,  // an unanswered permission prompt falls back to music
};

/** Stage geometry: the dashboard is laid out on the film's 1920 x 1080 grid (render_videos.hw_interface). */
export const STAGE = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
};

/** Read a URL flag once. `?kiosk`, `?debug`, `?idle=30`. */
export function urlFlag(name) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(name)) return null;
  const v = params.get(name);
  return v === '' ? true : v;
}
