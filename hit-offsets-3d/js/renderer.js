import { WebGlBackend } from "./webgl.js";
import { WebGpuBackend } from "./webgpu.js";

const ORDER = {
  auto: ["webgpu", "webgl2", "webgl1"],
  webgpu: ["webgpu", "webgl2", "webgl1"],
  webgl: ["webgl2", "webgl1"],
  webgl2: ["webgl2", "webgl1"],
  webgl1: ["webgl1"],
};

async function attempt(kind, canvas, onLost) {
  if (kind === "webgpu") return WebGpuBackend.create(canvas, onLost);
  return WebGlBackend.create(canvas, kind, onLost);
}

/**
 * Tries each backend in `preference` order (`?renderer=` value; unknown values mean "auto") and
 * returns the first that initialises. A canvas keeps the first context type it was asked for, so
 * every attempt after a failed one renders into a fresh copy that replaces it.
 * @returns {Promise<{backend: object, canvas: HTMLCanvasElement}>}
 */
export async function createRenderer(canvas, preference, onLost) {
  let target = canvas;
  let touched = false;
  for (const kind of ORDER[preference] ?? ORDER.auto) {
    if (touched) {
      const fresh = target.cloneNode(false);
      target.replaceWith(fresh);
      target = fresh;
    }
    touched = true;
    try {
      const backend = await attempt(kind, target, onLost);
      if (backend) return { backend, canvas: target };
      console.info(`hit-offsets-3d: ${kind} unavailable`);
    } catch (error) {
      console.warn(`hit-offsets-3d: ${kind} failed`, error);
    }
  }
  throw new Error("Neither WebGPU nor WebGL is available");
}
