// Scene layout shared by both renderers: world units, camera, guide geometry and the uniform block.
//
// World space: one unit is the hit-circle radius. +x is right, +y is up (osu! y points down, so it
// is negated) and +z is late. The widest timing window spans ±Z_HALF.

const XY_EXTENT = 1.25;
const Z_HALF = 1.6;
const Z_CLAMP = Z_HALF * 1.1;
const SCENE_RADIUS = Math.hypot(1, Z_HALF) + 0.12;
const FOVY = (30 * Math.PI) / 180;
const RING_SEGMENTS = 72;
const FALLBACK_RANGE_MS = 100;

/**
 * Uniform block, identical in WGSL (`mat4x4f` + `array<vec4f, 8>`) and GLSL (`mat4` + `vec4[8]`):
 *   m       view-projection, column-major
 *   v[0]    viewport width, height (device px), now (s), fade duration (s)
 *   v[1]    point diameter (device px), faded opacity, world units per osu! px, world units per ms
 *   v[2]    clock rate, great, ok, meh windows (real ms)
 *   v[3]    z clamp, camera distance, recent-hit size boost, scene radius
 *   v[4]    device pixel ratio, -, -, -
 *   v[5..7] great, ok, meh colours (rgb, 1)
 */
export const UNIFORM_FLOATS = 16 + 8 * 4;

/** One guide line: p0.xyz + width (css px), p1.xyz + unused, rgba (straight alpha). */
export const SEGMENT_FLOATS = 12;

/** osu! hit-circle radius in playfield pixels; `cs` already includes HR/EZ. */
export function hitRadius(cs) {
  return Math.max(1, 54.4 - 4.48 * cs);
}

/** Widest known timing window, or a fallback when the map's windows are unknown. */
function timingRange(windows) {
  const widest = Math.max(windows.great, windows.ok, windows.meh);
  return widest > 0 && widest < 1e6 ? widest : FALLBACK_RANGE_MS;
}

function niceStep(span) {
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const unit = span / magnitude;
  return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * magnitude;
}

function formatMs(value) {
  return `${value > 0 ? "+" : "−"}${Math.abs(value) < 10 ? Math.abs(value).toFixed(1) : Math.round(Math.abs(value))}`;
}

class SegmentWriter {
  constructor() {
    this.data = new Float32Array(SEGMENT_FLOATS * 1024);
    this.count = 0;
  }

  line(a, b, width, color, alpha) {
    if ((this.count + 1) * SEGMENT_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set([a[0], a[1], a[2], width, b[0], b[1], b[2], 0, color[0], color[1], color[2], alpha], this.count * SEGMENT_FLOATS);
    this.count++;
  }

  ring(z, width, color, alpha) {
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a0 = (i / RING_SEGMENTS) * 2 * Math.PI;
      const a1 = ((i + 1) / RING_SEGMENTS) * 2 * Math.PI;
      this.line([Math.cos(a0), Math.sin(a0), z], [Math.cos(a1), Math.sin(a1), z], width, color, alpha);
    }
  }
}

/**
 * Static guides: the hit circle at zero error, one ring per timing window on each side, axes with
 * px/ms ticks, and the labels that go with them.
 * @returns {{ data: Float32Array, count: number, zScale: number, labels: {text: string, at: number[], color: number[] | null, kind: string}[] }}
 */
export function buildGuides(radius, windows, colors, ink) {
  const range = timingRange(windows);
  const zScale = Z_HALF / range;
  const out = new SegmentWriter();
  const labels = [];

  out.line([-XY_EXTENT, 0, 0], [XY_EXTENT, 0, 0], 1.2, ink, 0.55);
  out.line([0, -XY_EXTENT, 0], [0, XY_EXTENT, 0], 1.2, ink, 0.55);
  out.line([0, 0, -Z_CLAMP], [0, 0, Z_CLAMP], 1.2, ink, 0.55);

  const pxStep = niceStep(radius / 3);
  for (let px = pxStep; px / radius <= XY_EXTENT; px += pxStep) {
    for (const sign of [-1, 1]) {
      const p = (sign * px) / radius;
      out.line([p, -0.035, 0], [p, 0.035, 0], 1, ink, 0.5);
      out.line([-0.035, p, 0], [0.035, p, 0], 1, ink, 0.5);
    }
  }
  // The scale label sits below the centre on the vertical axis: the camera only orbits sideways by
  // itself, so that axis is never foreshortened into the "right" label, and the window labels own
  // the top. The outermost tick lies outside the hit circle, where no hit can cover it.
  const pxLabel = pxStep * Math.max(1, Math.floor((radius * XY_EXTENT) / pxStep));
  labels.push({ text: `${pxLabel} px`, at: [0, -pxLabel / radius, 0], color: null, kind: "tick" });

  const msStep = niceStep(range / 4);
  for (let ms = msStep; ms * zScale <= Z_CLAMP; ms += msStep) {
    for (const sign of [-1, 1]) {
      const z = sign * ms * zScale;
      out.line([-0.035, 0, z], [0.035, 0, z], 1, ink, 0.5);
    }
  }

  out.ring(0, 1.6, ink, 0.9);

  const judged = [
    [windows.great, colors[0]],
    [windows.ok, colors[1]],
    [windows.meh, colors[2]],
  ];
  for (const [ms, color] of judged) {
    if (!(ms > 0 && ms < 1e6)) continue;
    for (const sign of [-1, 1]) {
      out.ring(sign * ms * zScale, 1, color, 0.42);
      labels.push({ text: `${formatMs(sign * ms)} ms`, at: [0, 1.13, sign * ms * zScale], color, kind: "window" });
    }
  }

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 2 * Math.PI;
    out.line([Math.cos(a), Math.sin(a), -Z_HALF], [Math.cos(a), Math.sin(a), Z_HALF], 1, ink, 0.1);
  }

  labels.push({ text: "right", at: [XY_EXTENT + 0.14, 0, 0], color: null, kind: "axis" });
  labels.push({ text: "up", at: [0, XY_EXTENT + 0.1, 0], color: null, kind: "axis" });
  labels.push({ text: "early", at: [0, 0, -Z_CLAMP - 0.14], color: null, kind: "axis" });
  labels.push({ text: "late", at: [0, 0, Z_CLAMP + 0.14], color: null, kind: "axis" });

  return { data: out.data, count: out.count, zScale, labels };
}

/** Guide line from a hit (osu! px, real ms) down to the zero-error plane. */
export function writeStem(out, x, y, errorMs, radius, zScale, color, alpha) {
  const wx = x / radius;
  const wy = -y / radius;
  const wz = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, errorMs * zScale));
  out.set([wx, wy, 0, 1.4, wx, wy, wz, 0, color[0], color[1], color[2], alpha]);
}

function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  // Depth maps to 0..1 (WebGPU); WebGL ignores depth here, nothing is depth-tested.
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (near * far) / (near - far);
  return out;
}

function lookAtOrigin(out, eye) {
  const len = Math.hypot(eye[0], eye[1], eye[2]);
  const zx = eye[0] / len;
  const zy = eye[1] / len;
  const zz = eye[2] / len;
  // right = up(0,1,0) × forward
  let xx = zz;
  let xz = -zx;
  const xl = Math.hypot(xx, xz) || 1;
  xx /= xl;
  xz /= xl;
  const yx = zy * xz;
  const yy = zz * xx - zx * xz;
  const yz = -zy * xx;
  out.fill(0);
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[4] = 0;
  out[5] = yy;
  out[6] = zy;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[12] = 0;
  out[13] = 0;
  out[14] = -len;
  out[15] = 1;
  return out;
}

function multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

const PITCH_LIMIT = (80 * Math.PI) / 180;

/** Orbit camera around the origin, framing the whole scene at any angle. */
export class OrbitCamera {
  constructor() {
    this.yaw = (35 * Math.PI) / 180;
    this.pitch = (20 * Math.PI) / 180;
    this.zoom = 1;
    this.distance = 1;
    this.viewProj = new Float32Array(16);
    this.projection = new Float32Array(16);
    this.view = new Float32Array(16);
    this.eye = [0, 0, 0];
  }

  orbit(dYaw, dPitch) {
    this.yaw = (this.yaw + dYaw) % (2 * Math.PI);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dPitch));
  }

  update(aspect) {
    const fovx = 2 * Math.atan(Math.tan(FOVY / 2) * aspect);
    this.distance = (SCENE_RADIUS / Math.sin(Math.min(FOVY, fovx) / 2)) * this.zoom;
    const cp = Math.cos(this.pitch);
    this.eye[0] = this.distance * cp * Math.sin(this.yaw);
    this.eye[1] = this.distance * Math.sin(this.pitch);
    this.eye[2] = this.distance * cp * Math.cos(this.yaw);
    const near = Math.max(0.05, this.distance - SCENE_RADIUS * 1.5);
    perspective(this.projection, FOVY, aspect, near, this.distance + SCENE_RADIUS * 1.5);
    lookAtOrigin(this.view, this.eye);
    return multiply(this.viewProj, this.projection, this.view);
  }
}

export const SCENE = Object.freeze({ radius: SCENE_RADIUS, zClamp: Z_CLAMP });

/** World point to CSS pixels; `w` is the clip-space depth used for the depth fade. */
export function project(m, p, width, height) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return { x: (x / w * 0.5 + 0.5) * width, y: (0.5 - (y / w) * 0.5) * height, w };
}
