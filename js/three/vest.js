/**
 * The vest in 3D.
 *
 * One WebGL canvas covers the window, transparent, underneath the interface overlays. The vest is
 * drawn into a viewport rectangle that follows a DOM element (the landing stage, the dashboard's
 * model box, or the full-screen stage). Moving between them eases that rectangle and the camera
 * together, so the transition is one continuous move with no canvas resize and no reallocation.
 *
 * Look: matched to scene3d.py (bone material, key light from (3,4,3), fill from (-3,2,-2),
 * floor grid at y = -0.85, 35 degree vertical field of view, 0.42 rad/s turntable).
 */

import * as THREE from '../../vendor/three/three.bundle.js';
import { MOTORS } from '../core/config.js';

const FOV = 35;
const TURN_RATE = 0.42;                 // rad/s, as in the film
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
const FIT_HALF_WIDTH = 0.95;            // vest half-width (0.8) plus room for the motor glows
const FOG_NEAR = 3.2, FOG_FAR = 7.5;     // the floor grid fades into the background
const BONE = new THREE.Color().setRGB(0.80, 0.785, 0.745, THREE.SRGBColorSpace);

/** Camera placement per mode: distance, target height, and how the floor fades. */
const RIGS = {
  landing:   { dist: 3.05, lookY: 0.26, height: 0.30 },
  dashboard: { dist: 2.30, lookY: 0.20, height: 0.20 },   // the film's model box: camz 2.30, ty 0.20
  expanded:  { dist: 2.2, lookY: 0.27, height: 0.26 },
};

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);   // easeInOutCubic
const lerp = (a, b, t) => a + (b - a) * t;

/** A soft radial glow, drawn once into a canvas texture. */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class VestView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = false;
    this.mode = 'landing';
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    this.tween = null;
    this.rig = { ...RIGS.landing };
    this.spin = 0;
    this.dragVel = 0;
    this.dragging = false;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.frameCost = 16;
    this.motorState = MOTORS.map(() => ({ a: 0, shocks: [] }));
  }

  /** Returns false if WebGL is unavailable; the caller shows the still-image fallback. */
  init() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
      });
    } catch {
      return false;
    }
    const r = this.renderer;
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.setPixelRatio(this.pixelRatio);
    r.setScissorTest(true);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x09090b, FOG_NEAR, FOG_FAR);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 40);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x16161a, 0.55));
    const key = new THREE.DirectionalLight(0xfff6ea, 2.6);
    key.position.set(3, 4, 3);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.85);
    fill.position.set(-3, 2, -2);
    const rim = new THREE.DirectionalLight(0xffffff, 0.9);
    rim.position.set(0, 2.5, -4);
    this.scene.add(key, fill, rim);

    this.turntable = new THREE.Group();
    this.scene.add(this.turntable);
    this.scene.add(this._floor());
    this._motors();
    this.resize();
    return true;
  }

  /**
   * Parse the (meshopt-compressed) vest from its downloaded bytes, a Promise<ArrayBuffer> started
   * at boot. Resolves false on failure.
   */
  async load(bytes) {
    try {
      const data = await bytes;
      const loader = new THREE.GLTFLoader();
      loader.setMeshoptDecoder(THREE.MeshoptDecoder);
      const gltf = await new Promise((resolve, reject) => loader.parse(data, '', resolve, reject));
      const material = new THREE.MeshStandardMaterial({ color: BONE, roughness: 0.52, metalness: 0.0 });
      gltf.scene.traverse((o) => { if (o.isMesh) o.material = material; });
      this.turntable.add(gltf.scene);
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  /** The film's floor: a 4 x 4 grid of hairlines at y = -0.85, fading into the fog. */
  _floor() {
    const pts = [];
    for (let k = 0; k <= 30; k++) {
      const u = -2 + (4 * k) / 30;
      pts.push(-2, -0.85, u, 2, -0.85, u, u, -0.85, -2, u, -0.85, 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x2a2a33, transparent: true, opacity: 0.55, fog: true });
    return new THREE.LineSegments(geo, mat);
  }

  /** Each motor: a disc, a ring, an additive halo, and a pool of shockwave rings. */
  _motors() {
    const halo = glowTexture();
    this.motors = MOTORS.map((m) => {
      const g = new THREE.Group();
      g.position.set(...m.pos);
      g.lookAt(m.pos[0], m.pos[1], m.pos[2] + m.facing);
      const mk = (geo, opacity) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }));
      const disc = mk(new THREE.CircleGeometry(0.034, 40), 0.06);
      const ring = mk(new THREE.RingGeometry(0.047, 0.058, 48), 0.22);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: halo, color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      }));
      sprite.scale.setScalar(0.2);
      const shocks = [0, 1, 2].map(() => {
        const s = mk(new THREE.RingGeometry(0.06, 0.066, 48), 0);
        s.visible = false;
        g.add(s);
        return s;
      });
      g.add(disc, ring, sprite);
      this.turntable.add(g);
      return { group: g, disc, ring, sprite, shocks, facing: m.facing };
    });
  }

  /**
   * Point the vest at a new screen rectangle (CSS pixels) in a new mode.
   * `duration` 0 snaps (used on window resize).
   */
  setTarget(rect, mode, duration = 0.95) {
    const to = { ...rect };
    const toRig = { ...RIGS[mode] };
    this.mode = mode;
    if (!duration || !this.renderer) {
      this.tween = null;
      this.rect = to;
      this.rig = toRig;
      return;
    }
    this.tween = { t: 0, duration, fromRect: { ...this.rect }, toRect: to, fromRig: { ...this.rig }, toRig };
  }

  /** Follow a rect that moved without a mode change (window resize, stage rescale). */
  retarget(rect) {
    if (this.tween) this.tween.toRect = { ...rect };
    else this.rect = { ...rect };
  }

  resize() {
    if (!this.renderer) return;
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  /** Drag-to-spin in the full-screen view. */
  nudge(dx) { this.spin += dx * 0.008; this.dragVel = dx * 0.008; }
  setDragging(on) { this.dragging = on; }

  /**
   * Advance and draw one frame.
   * zones: motor drive 0..1 (M1..M4), onset: >0 on a strong hit.
   */
  frame(dt, zones, onset) {
    if (!this.renderer) return;
    const start = performance.now();

    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const e = ease(tw.t);
      for (const k of ['x', 'y', 'w', 'h']) this.rect[k] = lerp(tw.fromRect[k], tw.toRect[k], e);
      for (const k of ['dist', 'lookY', 'height']) this.rig[k] = lerp(tw.fromRig[k], tw.toRig[k], e);
      if (tw.t >= 1) this.tween = null;
    }

    // Turntable: steady rotation, with drag inertia in the full-screen view.
    if (!this.dragging) {
      this.dragVel *= Math.pow(0.04, dt);
      this.spin += (TURN_RATE * (this.mode === 'landing' ? 0.6 : 1)) * dt + this.dragVel;
    }
    this.turntable.rotation.y = this.spin;

    this._updateMotors(dt, zones, onset);

    const { x, y, w, h } = this.rect;
    if (w < 2 || h < 2) return;
    const H = window.innerHeight;
    const cam = this.camera;
    cam.aspect = w / h;
    // On a narrow region (portrait screens) step back until the vest's full width fits.
    const dist = Math.max(this.rig.dist, FIT_HALF_WIDTH / (TAN_HALF_FOV * cam.aspect));
    cam.position.set(0, this.rig.lookY + this.rig.height * (dist / this.rig.dist), dist);
    const back = dist - this.rig.dist;           // keep the fog where it was relative to the vest
    this.scene.fog.near = FOG_NEAR + back;
    this.scene.fog.far = FOG_FAR + back;
    cam.lookAt(0, this.rig.lookY, 0);
    cam.updateProjectionMatrix();

    const r = this.renderer;
    r.setViewport(x, H - y - h, w, h);
    r.setScissor(x, H - y - h, w, h);
    r.render(this.scene, cam);

    this._adaptResolution(performance.now() - start, dt);
  }

  _updateMotors(dt, zones, onset) {
    const attack = Math.min(1, dt * 22), release = Math.min(1, dt * 6);
    this.motors.forEach((m, i) => {
      const st = this.motorState[i];
      const z = zones[i] || 0;
      st.a += (z - st.a) * (z > st.a ? attack : release);
      const a = st.a;
      m.disc.material.opacity = 0.06 + a * 0.9;
      m.ring.material.opacity = 0.22 + a * 0.7;
      const rs = 1 + a * 0.35;
      m.ring.scale.set(rs, rs, 1);
      m.sprite.material.opacity = 0.08 + a * 0.95;
      m.sprite.scale.setScalar(0.16 + a * 0.42);

      if (onset > 0 && z > 0.2) st.shocks.push({ t: 0, s: onset });
      st.shocks = st.shocks.filter((s) => (s.t += dt) < 0.7).slice(-3);
      m.shocks.forEach((ring, k) => {
        const s = st.shocks[k];
        ring.visible = !!s;
        if (!s) return;
        const p = s.t / 0.7;
        const sc = 1 + p * 3.2;
        ring.scale.set(sc, sc, 1);
        ring.material.opacity = (1 - p) * (1 - p) * 0.55 * s.s;
      });
    });
  }

  /** Hold 60 fps on very large displays by trading render resolution for frame time. */
  _adaptResolution(cost, dt) {
    this.frameCost = this.frameCost * 0.95 + cost * 0.05;
    const max = Math.min(window.devicePixelRatio || 1, 2);
    let next = this.pixelRatio;
    if (dt > 1 / 45 && this.frameCost > 9) next = Math.max(1, this.pixelRatio * 0.9);
    else if (dt < 1 / 58 && this.frameCost < 5) next = Math.min(max, this.pixelRatio * 1.02);
    if (Math.abs(next - this.pixelRatio) > 0.05) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  /** Screen positions of the motors (CSS px) and how much each faces the camera, 0..1. */
  motorScreen(out) {
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    const { x, y, w, h } = this.rect;
    this.motors.forEach((m, i) => {
      m.group.getWorldPosition(v);
      n.set(0, 0, m.facing).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.turntable.rotation.y);
      toCam.copy(this.camera.position).sub(v).normalize();
      const facing = Math.max(0, n.dot(toCam));
      v.project(this.camera);
      out[i] = { x: x + (v.x * 0.5 + 0.5) * w, y: y + (-v.y * 0.5 + 0.5) * h, facing, side: v.x < 0 ? -1 : 1 };
    });
    return out;
  }
}
