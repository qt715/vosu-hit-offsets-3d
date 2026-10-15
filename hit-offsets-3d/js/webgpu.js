import { SEGMENT_FLOATS, UNIFORM_FLOATS } from "./scene.js";

// Same maths as the GLSL in webgl.js; keep the two in step.
const WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  v: array<vec4f, 8>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

const CORE = 0.6;

fn depthFade(w: f32) -> f32 {
  return clamp((w - u.v[3].y + u.v[3].w) / (2.0 * u.v[3].w), 0.0, 1.0);
}

fn judge(error: f32) -> vec3f {
  let a = abs(error);
  if (a <= u.v[2].y) { return u.v[5].rgb; }
  if (a <= u.v[2].z) { return u.v[6].rgb; }
  return u.v[7].rgb;
}

struct PointOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) glow: f32,
  @location(3) radius: f32,
}

@vertex
fn pointVs(@builtin(vertex_index) vertex: u32, @location(0) hit: vec3f, @location(1) time: f32) -> PointOut {
  let corner = vec2f(f32(vertex & 1u) * 2.0 - 1.0, f32(vertex >> 1u) * 2.0 - 1.0);
  let error = hit.z / u.v[2].x;
  let world = vec3f(hit.x * u.v[1].z, -hit.y * u.v[1].z, clamp(error * u.v[1].w, -u.v[3].x, u.v[3].x));
  var clip = u.viewProj * vec4f(world, 1.0);
  let k = clamp(1.0 - (u.v[0].z - time) / u.v[0].w, 0.0, 1.0);
  let e = k * k;
  let size = u.v[1].x * (1.0 + u.v[3].z * e) * (u.v[3].y / clip.w) / CORE;
  let depth = depthFade(clip.w);
  clip = vec4f(clip.xy + corner * size / u.v[0].xy * clip.w, clip.zw);
  var out: PointOut;
  out.position = clip;
  out.uv = corner;
  out.color = vec4f(mix(judge(error), vec3f(1.0), 0.35 * e), mix(u.v[1].y, 1.0, k) * mix(1.0, 0.55, depth));
  out.glow = e;
  out.radius = size * 0.5;
  return out;
}

@fragment
fn pointFs(frag: PointOut) -> @location(0) vec4f {
  let d = length(frag.uv);
  let aa = 1.0 / max(frag.radius, 1.0);
  let core = 1.0 - smoothstep(CORE - aa, CORE + aa, d);
  let ring = max(1.0 - d, 0.0);
  let a = frag.color.a * max(core, frag.glow * 0.45 * ring * ring);
  if (a <= 0.002) { discard; }
  return vec4f(frag.color.rgb * a, a);
}

struct LineOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) dist: f32,
  @location(2) halfWidth: f32,
}

@vertex
fn lineVs(@builtin(vertex_index) vertex: u32, @location(0) p0: vec4f, @location(1) p1: vec4f, @location(2) color: vec4f) -> LineOut {
  let along = f32(vertex >> 1u);
  let side = f32(vertex & 1u) * 2.0 - 1.0;
  let c0 = u.viewProj * vec4f(p0.xyz, 1.0);
  let c1 = u.viewProj * vec4f(p1.xyz, 1.0);
  let hv = u.v[0].xy * 0.5;
  let d = c1.xy / c1.w * hv - c0.xy / c0.w * hv;
  let len = length(d);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-4) { dir = d / len; }
  let n = vec2f(-dir.y, dir.x);
  let halfWidth = p0.w * u.v[4].x * 0.5;
  let hw = halfWidth + 1.0;
  var clip = mix(c0, c1, along);
  clip = vec4f(clip.xy + n * side * hw / hv * clip.w, clip.zw);
  var out: LineOut;
  out.position = clip;
  out.color = vec4f(color.rgb, color.a * mix(1.0, 0.4, depthFade(clip.w)));
  out.dist = side * hw;
  out.halfWidth = halfWidth;
  return out;
}

@fragment
fn lineFs(frag: LineOut) -> @location(0) vec4f {
  let a = frag.color.a * clamp(frag.halfWidth + 0.5 - abs(frag.dist), 0.0, 1.0);
  if (a <= 0.002) { discard; }
  return vec4f(frag.color.rgb * a, a);
}
`;

const BLEND = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

const SEGMENT_LAYOUT = {
  arrayStride: SEGMENT_FLOATS * 4,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" },
    { shaderLocation: 1, offset: 16, format: "float32x4" },
    { shaderLocation: 2, offset: 32, format: "float32x4" },
  ],
};

export class WebGpuBackend {
  static async create(canvas, onLost) {
    if (!navigator.gpu) return null;
    // Must be the GPU Chromium composites on: on hybrid systems "low-power" can pick an iGPU
    // whose canvas textures the compositor cannot import, and nothing is shown.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) {
      device.destroy();
      return null;
    }
    return new WebGpuBackend(device, context, onLost);
  }

  constructor(device, context, onLost) {
    this.name = "webgpu";
    this.device = device;
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: "premultiplied" });
    device.lost.then((info) => {
      if (info.reason !== "destroyed") onLost(info.message);
    });

    const module = device.createShaderModule({ code: WGSL });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const target = { format: this.format, blend: BLEND };
    const primitive = { topology: "triangle-strip" };
    this.pointPipeline = device.createRenderPipeline({
      layout,
      vertex: {
        module,
        entryPoint: "pointVs",
        buffers: [
          // The hitOffsets triples exactly as received: one vec3 per instance.
          { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          { arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] },
        ],
      },
      fragment: { module, entryPoint: "pointFs", targets: [target] },
      primitive,
    });
    this.linePipeline = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: "lineVs", buffers: [SEGMENT_LAYOUT] },
      fragment: { module, entryPoint: "lineFs", targets: [target] },
      primitive,
    });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.stemBuffer = device.createBuffer({
      size: SEGMENT_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.guideBuffer = null;
    this.guideCapacity = 0;
    this.guideVersion = -1;
    this.offsetBuffer = null;
    this.timeBuffer = null;
    this.pointCapacity = 0;
    this.revision = -1;
    this.uploaded = 0;

    this.attachment = { view: null, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" };
    this.passDescriptor = { colorAttachments: [this.attachment] };
    this.commandBuffers = [null];
  }

  uploadGuides(guides) {
    if (guides.version === this.guideVersion || guides.count === 0) return;
    this.guideVersion = guides.version;
    const bytes = guides.count * SEGMENT_FLOATS * 4;
    if (bytes > this.guideCapacity) {
      this.guideBuffer?.destroy();
      this.guideCapacity = guides.data.byteLength;
      this.guideBuffer = this.device.createBuffer({
        size: this.guideCapacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.guideBuffer, 0, guides.data, 0, guides.count * SEGMENT_FLOATS);
  }

  uploadPoints(store) {
    const { device } = this;
    if (store.capacity > this.pointCapacity) {
      this.offsetBuffer?.destroy();
      this.timeBuffer?.destroy();
      this.pointCapacity = store.capacity;
      const usage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
      this.offsetBuffer = device.createBuffer({ size: store.capacity * 12, usage });
      this.timeBuffer = device.createBuffer({ size: store.capacity * 4, usage });
      this.uploaded = 0;
    }
    if (store.revision !== this.revision) {
      this.revision = store.revision;
      this.uploaded = 0;
    }
    if (store.count > this.uploaded) {
      const from = this.uploaded;
      const added = store.count - from;
      device.queue.writeBuffer(this.offsetBuffer, from * 12, store.offsets, from * 3, added * 3);
      device.queue.writeBuffer(this.timeBuffer, from * 4, store.times, from, added);
      this.uploaded = store.count;
    }
  }

  /** @param {{uniforms: Float32Array, guides: object, store: object, first: number, count: number, stem: Float32Array | null}} frame */
  draw(frame) {
    const { device } = this;
    device.queue.writeBuffer(this.uniformBuffer, 0, frame.uniforms);
    this.uploadGuides(frame.guides);
    this.uploadPoints(frame.store);
    if (frame.stem) device.queue.writeBuffer(this.stemBuffer, 0, frame.stem);

    this.attachment.view = this.context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass(this.passDescriptor);
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.linePipeline);
    if (frame.guides.count > 0) {
      pass.setVertexBuffer(0, this.guideBuffer);
      pass.draw(4, frame.guides.count);
    }
    if (frame.stem) {
      pass.setVertexBuffer(0, this.stemBuffer);
      pass.draw(4, 1);
    }
    if (frame.count > 0) {
      pass.setPipeline(this.pointPipeline);
      pass.setVertexBuffer(0, this.offsetBuffer);
      pass.setVertexBuffer(1, this.timeBuffer);
      pass.draw(4, frame.count, 0, frame.first);
    }
    pass.end();
    this.commandBuffers[0] = encoder.finish();
    device.queue.submit(this.commandBuffers);
  }

  destroy() {
    this.context.unconfigure();
    this.device.destroy();
  }
}
