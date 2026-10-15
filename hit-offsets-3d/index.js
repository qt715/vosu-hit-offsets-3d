import {
  MODE_STANDARD,
  SettingsChannel,
  Subscription,
  VISIBILITY_OPTIONS,
  bool,
  hexColor,
  isVisibleIn,
  num,
} from "./js/vosu.js";
import { HitOffsetDecoder, OffsetStore, PreciseOffsetStream } from "./js/offsets.js";
import {
  OrbitCamera,
  SCENE,
  SEGMENT_FLOATS,
  UNIFORM_FLOATS,
  buildGuides,
  hitRadius,
  project,
  writeStem,
} from "./js/scene.js";
import { createRenderer } from "./js/renderer.js";
import { startDemo } from "./js/demo.js";

const POINTERS = [
  "/state/number",
  "/play/mode/number",
  "/beatmap/stats/cs/converted",
  "/beatmap/stats/hitWindow",
  "/play/mods/rate",
  "/beatmap/checksum",
];
const DEG = Math.PI / 180;
const INK = hexColor("#e9ecf2");
// Size multiplier a brand-new hit gets on top of the point size; it eases out with the fade.
const RECENT_BOOST = 1.6;
const UNKNOWN_WINDOW = 1e9;

const params = new URLSearchParams(location.search);
const demo = params.get("demo") === "1";
let preference = params.get("renderer") ?? "auto";
if (params.has("bg")) document.body.style.background = params.get("bg");

const root = document.querySelector("[data-root]");
const labelLayer = root.querySelector("[data-labels]");
const hud = root.querySelector("[data-hud]");
const stats = root.querySelector("[data-stats]");
const backendTag = root.querySelector("[data-backend]");
const notice = root.querySelector("[data-notice]");
let canvas = root.querySelector("[data-canvas]");

const settings = {
  visibility: "gameplay + results",
  pointSize: 7,
  fadeDuration: 3,
  fadedOpacity: 0.35,
  maxPoints: 1500,
  autoRotateSpeed: 10,
  showLabels: true,
  showInfo: true,
  colors: [hexColor("#79c7f2"), hexColor("#9ad672"), hexColor("#f0b54a")],
};

const meta = { state: -1, mode: MODE_STANDARD, cs: 4, hitWindow: null, rate: 1, checksum: null };

const store = new OffsetStore();
const decoder = new HitOffsetDecoder(store);
const camera = new OrbitCamera();
const uniforms = new Float32Array(UNIFORM_FLOATS);
const stem = new Float32Array(SEGMENT_FLOATS);
const frame = { uniforms, guides: null, store, first: 0, count: 0, stem: null };

let guides = null;
let guideVersion = 0;
let guidesDirty = true;
let labelNodes = [];
let backend = null;
let losses = 0;
let visible = false;
let rafId = 0;
let lastFrameAt = 0;
let drag = null;

function windows() {
  const source = meta.hitWindow ?? {};
  const ms = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return { great: ms(source.great), ok: ms(source.ok), meh: ms(source.meh) };
}

function rate() {
  return meta.rate > 0 ? meta.rate : 1;
}

function rebuildGuides() {
  guidesDirty = false;
  guides = buildGuides(hitRadius(meta.cs), windows(), settings.colors, INK);
  guides.version = ++guideVersion;
  frame.guides = guides;
  labelNodes = guides.labels.map((label) => {
    const node = document.createElement("span");
    node.className = label.kind;
    node.textContent = label.text;
    if (label.color) node.style.color = `rgb(${label.color.map((c) => Math.round(c * 255)).join(" ")})`;
    return node;
  });
  labelLayer.replaceChildren(...labelNodes);
}

function judgeColor(errorMs, w) {
  const magnitude = Math.abs(errorMs);
  if (magnitude <= (w.great || UNKNOWN_WINDOW)) return settings.colors[0];
  if (magnitude <= (w.ok || w.great || UNKNOWN_WINDOW)) return settings.colors[1];
  return settings.colors[2];
}

function packUniforms(width, height, dpr, now, radius) {
  const w = windows();
  const fade = Math.max(0.05, settings.fadeDuration);
  uniforms.set(camera.update(width / height), 0);
  uniforms[16] = width;
  uniforms[17] = height;
  uniforms[18] = now;
  uniforms[19] = fade;
  uniforms[20] = settings.pointSize * dpr;
  uniforms[21] = settings.fadedOpacity;
  uniforms[22] = 1 / radius;
  uniforms[23] = guides.zScale;
  uniforms[24] = rate();
  uniforms[25] = w.great || UNKNOWN_WINDOW;
  uniforms[26] = w.ok || w.great || UNKNOWN_WINDOW;
  uniforms[27] = w.meh || UNKNOWN_WINDOW;
  uniforms[28] = SCENE.zClamp;
  uniforms[29] = camera.distance;
  uniforms[30] = RECENT_BOOST;
  uniforms[31] = SCENE.radius;
  uniforms[32] = dpr;
  for (let i = 0; i < 3; i++) {
    uniforms.set(settings.colors[i], 36 + i * 4);
    uniforms[39 + i * 4] = 1;
  }
}

/** Stem under the newest hit while it is still emphasised; `null` once it has faded. */
function newestStem(now, radius) {
  if (store.count === 0) return null;
  const k = 1 - (now - store.lastHitAt) / Math.max(0.05, settings.fadeDuration);
  if (!(k > 0)) return null;
  const o = (store.count - 1) * 3;
  const error = store.offsets[o + 2] / rate();
  writeStem(stem, store.offsets[o], store.offsets[o + 1], error, radius, guides.zScale, judgeColor(error, windows()), 0.85 * k * k);
  return stem;
}

function placeLabels(cssWidth, cssHeight) {
  const m = camera.viewProj;
  guides.labels.forEach((label, i) => {
    const p = project(m, label.at, cssWidth, cssHeight);
    const depth = Math.min(1, Math.max(0, (p.w - camera.distance + SCENE.radius) / (2 * SCENE.radius)));
    const node = labelNodes[i];
    node.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    node.style.opacity = (1 - 0.55 * depth).toFixed(2);
  });
}

function render(time) {
  rafId = 0;
  if (!backend || !visible) {
    lastFrameAt = 0;
    return;
  }
  const dt = lastFrameAt ? Math.min(0.1, (time - lastFrameAt) / 1000) : 0;
  lastFrameAt = time;
  if (!drag) camera.orbit(settings.autoRotateSpeed * DEG * dt, 0);

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1, canvas.clientWidth);
  const cssHeight = Math.max(1, canvas.clientHeight);
  const width = Math.round(cssWidth * dpr);
  const height = Math.round(cssHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (guidesDirty) rebuildGuides();

  const radius = hitRadius(meta.cs);
  const now = store.now();
  packUniforms(width, height, dpr, now, radius);
  frame.count = Math.min(store.count, settings.maxPoints);
  frame.first = store.count - frame.count;
  frame.stem = newestStem(now, radius);
  backend.draw(frame);
  if (settings.showLabels) placeLabels(cssWidth, cssHeight);

  const fading = now - store.lastHitAt < settings.fadeDuration;
  if (settings.autoRotateSpeed !== 0 || drag || fading) schedule();
  else lastFrameAt = 0;
}

function schedule() {
  if (!rafId) rafId = requestAnimationFrame(render);
}

function updateHud() {
  hud.hidden = !settings.showInfo;
  backendTag.hidden = !settings.showInfo;
  if (store.count === 0) {
    stats.textContent = "waiting for hits";
  } else {
    const mean = store.errorSum / store.count / rate();
    const sign = mean > 0 ? "+" : mean < 0 ? "−" : "";
    const cs = `CS ${meta.cs.toFixed(1)} · r ${hitRadius(meta.cs).toFixed(1)} px`;
    stats.textContent = `${store.count} hits · avg ${sign}${Math.abs(mean).toFixed(1)} ms · ${cs}`;
  }
  if (decoder.supported === false) {
    notice.textContent = "This server sends no hitOffsets. Update vosu to 1.1.0 or newer.";
    notice.hidden = false;
  } else if (root.dataset.renderer === "none") {
    notice.textContent = "Neither WebGPU nor WebGL is available in this browser.";
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}

function updateVisibility() {
  const next = demo || (isVisibleIn(settings.visibility, meta.state) && meta.mode === MODE_STANDARD);
  if (next === visible) return;
  visible = next;
  root.classList.toggle("is-hidden", !visible);
  if (visible) schedule();
}

function applyMeta(next) {
  if (next.checksum !== meta.checksum && meta.checksum !== null) {
    store.reset();
    decoder.invalidate(false);
  }
  const cs = Number.isFinite(next.cs) && next.cs > 0 ? next.cs : meta.cs;
  if (cs !== meta.cs || JSON.stringify(next.hitWindow) !== JSON.stringify(meta.hitWindow)) guidesDirty = true;
  meta.state = next.state ?? -1;
  meta.mode = next.mode ?? MODE_STANDARD;
  meta.cs = cs;
  meta.hitWindow = next.hitWindow ?? null;
  meta.rate = next.rate ?? 1;
  meta.checksum = next.checksum ?? null;
  updateVisibility();
  updateHud();
  schedule();
}

function onStoreChange() {
  updateHud();
  schedule();
}

function applySettings(incoming) {
  if (VISIBILITY_OPTIONS.includes(incoming.visibility)) settings.visibility = incoming.visibility;
  settings.pointSize = num(incoming.pointSize, settings.pointSize, 1, 40);
  settings.fadeDuration = num(incoming.fadeDuration, settings.fadeDuration, 0, 60);
  settings.fadedOpacity = num(incoming.fadedOpacity, settings.fadedOpacity, 0, 1);
  settings.maxPoints = Math.round(num(incoming.maxPoints, settings.maxPoints, 1, 100000));
  settings.autoRotateSpeed = num(incoming.autoRotateSpeed, settings.autoRotateSpeed, -360, 360);
  settings.showLabels = bool(incoming.showLabels, settings.showLabels);
  settings.showInfo = bool(incoming.showInfo, settings.showInfo);
  settings.colors = [
    hexColor(incoming.colorGreat, settings.colors[0]),
    hexColor(incoming.colorOk, settings.colors[1]),
    hexColor(incoming.colorMeh, settings.colors[2]),
  ];
  labelLayer.hidden = !settings.showLabels;
  guidesDirty = true;
  updateVisibility();
  updateHud();
  schedule();
}

async function startRenderer() {
  try {
    const created = await createRenderer(canvas, preference, onLost);
    backend = created.backend;
    canvas = created.canvas;
    root.dataset.renderer = backend.name;
    backendTag.textContent = backend.name;
  } catch (error) {
    console.error(error);
    root.dataset.renderer = "none";
    backendTag.textContent = "";
  }
  updateHud();
  schedule();
}

function onLost(message) {
  console.warn("hit-offsets-3d: renderer lost", message);
  backend = null;
  // A second loss suggests WebGPU itself is unreliable here; stay on WebGL from then on.
  if (++losses >= 2) preference = "webgl";
  const fresh = canvas.cloneNode(false);
  canvas.replaceWith(fresh);
  canvas = fresh;
  startRenderer();
}

root.addEventListener("pointerdown", (event) => {
  drag = { x: event.clientX, y: event.clientY };
  root.setPointerCapture(event.pointerId);
  schedule();
});
root.addEventListener("pointermove", (event) => {
  if (!drag) return;
  camera.orbit((event.clientX - drag.x) * -0.008, (event.clientY - drag.y) * 0.008);
  drag.x = event.clientX;
  drag.y = event.clientY;
  schedule();
});
const endDrag = () => {
  drag = null;
  schedule();
};
root.addEventListener("pointerup", endDrag);
root.addEventListener("pointercancel", endDrag);
root.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    camera.zoom = Math.min(2.5, Math.max(0.5, camera.zoom * Math.exp(event.deltaY * 0.001)));
    schedule();
  },
  { passive: false },
);
root.addEventListener("dblclick", () => {
  const fresh = new OrbitCamera();
  camera.yaw = fresh.yaw;
  camera.pitch = fresh.pitch;
  camera.zoom = fresh.zoom;
  schedule();
});
new ResizeObserver(schedule).observe(root);

startRenderer();
if (demo) {
  const seed = Number.parseInt(params.get("seed") ?? "7", 10) || 7;
  startDemo(seed, applyMeta, (payload) => {
    if (decoder.push(payload)) onStoreChange();
  });
} else {
  new Subscription(POINTERS, (values) =>
    applyMeta({
      state: values[0],
      mode: values[1],
      cs: values[2],
      hitWindow: values[3],
      rate: values[4],
      checksum: values[5],
    }),
  );
  new PreciseOffsetStream(decoder, onStoreChange);
  new SettingsChannel(applySettings);
}
