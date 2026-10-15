import { SEGMENT_FLOATS } from "./scene.js";

// GLSL ES 1.00 runs unchanged on WebGL2 and on WebGL1 (with ANGLE_instanced_arrays), so one set
// of shaders covers both. Same maths as the WGSL in webgpu.js; keep the two in step.
const COMMON = /* glsl */ `
uniform mat4 u_viewProj;
uniform vec4 u_v[8];

float depthFade(float w) {
  return clamp((w - u_v[3].y + u_v[3].w) / (2.0 * u_v[3].w), 0.0, 1.0);
}
`;

const POINT_VS = /* glsl */ `
attribute vec2 a_corner;
attribute vec3 a_hit;
attribute float a_time;
${COMMON}
const float CORE = 0.6;
varying vec2 v_uv;
varying vec4 v_color;
varying float v_glow;
varying float v_radius;

vec3 judge(float error) {
  float a = abs(error);
  if (a <= u_v[2].y) return u_v[5].rgb;
  if (a <= u_v[2].z) return u_v[6].rgb;
  return u_v[7].rgb;
}

void main() {
  float error = a_hit.z / u_v[2].x;
  vec3 world = vec3(a_hit.x * u_v[1].z, -a_hit.y * u_v[1].z, clamp(error * u_v[1].w, -u_v[3].x, u_v[3].x));
  vec4 clip = u_viewProj * vec4(world, 1.0);
  float k = clamp(1.0 - (u_v[0].z - a_time) / u_v[0].w, 0.0, 1.0);
  float e = k * k;
  float size = u_v[1].x * (1.0 + u_v[3].z * e) * (u_v[3].y / clip.w) / CORE;
  float depth = depthFade(clip.w);
  clip.xy += a_corner * size / u_v[0].xy * clip.w;
  gl_Position = clip;
  v_uv = a_corner;
  v_color = vec4(mix(judge(error), vec3(1.0), 0.35 * e), mix(u_v[1].y, 1.0, k) * mix(1.0, 0.55, depth));
  v_glow = e;
  v_radius = size * 0.5;
}
`;

const POINT_FS = /* glsl */ `
precision mediump float;
const float CORE = 0.6;
varying vec2 v_uv;
varying vec4 v_color;
varying float v_glow;
varying float v_radius;

void main() {
  float d = length(v_uv);
  float aa = 1.0 / max(v_radius, 1.0);
  float core = 1.0 - smoothstep(CORE - aa, CORE + aa, d);
  float ring = max(1.0 - d, 0.0);
  float a = v_color.a * max(core, v_glow * 0.45 * ring * ring);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(v_color.rgb * a, a);
}
`;

const LINE_VS = /* glsl */ `
attribute vec2 a_corner;
attribute vec4 a_p0;
attribute vec4 a_p1;
attribute vec4 a_color;
${COMMON}
varying vec4 v_color;
varying float v_dist;
varying float v_halfWidth;

void main() {
  vec4 c0 = u_viewProj * vec4(a_p0.xyz, 1.0);
  vec4 c1 = u_viewProj * vec4(a_p1.xyz, 1.0);
  vec2 hv = u_v[0].xy * 0.5;
  vec2 d = c1.xy / c1.w * hv - c0.xy / c0.w * hv;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float halfWidth = a_p0.w * u_v[4].x * 0.5;
  float hw = halfWidth + 1.0;
  vec4 clip = mix(c0, c1, a_corner.x);
  clip.xy += n * a_corner.y * hw / hv * clip.w;
  gl_Position = clip;
  v_color = vec4(a_color.rgb, a_color.a * mix(1.0, 0.4, depthFade(clip.w)));
  v_dist = a_corner.y * hw;
  v_halfWidth = halfWidth;
}
`;

const LINE_FS = /* glsl */ `
precision mediump float;
varying vec4 v_color;
varying float v_dist;
varying float v_halfWidth;

void main() {
  float a = v_color.a * clamp(v_halfWidth + 0.5 - abs(v_dist), 0.0, 1.0);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(v_color.rgb * a, a);
}
`;

// Triangle-strip corners, in the order the WGSL derives from vertex_index.
const POINT_CORNERS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const LINE_CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);

const CONTEXT_OPTIONS = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
};

function compile(gl, vs, fs, attributes) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  attributes.forEach((name, location) => gl.bindAttribLocation(program, location, name));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return {
    program,
    viewProj: gl.getUniformLocation(program, "u_viewProj"),
    v: gl.getUniformLocation(program, "u_v"),
  };
}

export class WebGlBackend {
  /** @param {"webgl2" | "webgl1"} version */
  static create(canvas, version, onLost) {
    const gl = canvas.getContext(version === "webgl2" ? "webgl2" : "webgl", CONTEXT_OPTIONS);
    if (!gl) return null;
    let instancing;
    if (version === "webgl2") {
      instancing = {
        divisor: (location, divisor) => gl.vertexAttribDivisor(location, divisor),
        draw: (count, instances) => gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, count, instances),
      };
    } else {
      const ext = gl.getExtension("ANGLE_instanced_arrays");
      if (!ext) return null;
      instancing = {
        divisor: (location, divisor) => ext.vertexAttribDivisorANGLE(location, divisor),
        draw: (count, instances) => ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, count, instances),
      };
    }
    return new WebGlBackend(gl, version, instancing, canvas, onLost);
  }

  constructor(gl, version, instancing, canvas, onLost) {
    this.name = version;
    this.gl = gl;
    this.instancing = instancing;
    this.destroyed = false;
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      if (!this.destroyed) onLost("WebGL context lost");
    });
    this.uniformSource = null;
    this.matrixView = null;
    this.vectorView = null;

    this.points = compile(gl, POINT_VS, POINT_FS, ["a_corner", "a_hit", "a_time"]);
    this.lines = compile(gl, LINE_VS, LINE_FS, ["a_corner", "a_p0", "a_p1", "a_color"]);
    const buffer = (data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return b;
    };
    this.pointCorners = buffer(POINT_CORNERS);
    this.lineCorners = buffer(LINE_CORNERS);
    this.stemBuffer = buffer(new Float32Array(SEGMENT_FLOATS));
    this.guideBuffer = gl.createBuffer();
    this.guideCapacity = 0;
    this.guideVersion = -1;
    this.offsetBuffer = gl.createBuffer();
    this.timeBuffer = gl.createBuffer();
    this.pointCapacity = 0;
    this.revision = -1;
    this.uploaded = 0;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  uploadGuides(guides) {
    if (guides.version === this.guideVersion || guides.count === 0) return;
    const { gl } = this;
    this.guideVersion = guides.version;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.guideBuffer);
    if (guides.count * SEGMENT_FLOATS * 4 > this.guideCapacity) {
      this.guideCapacity = guides.data.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, this.guideCapacity, gl.STATIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, guides.data.subarray(0, guides.count * SEGMENT_FLOATS));
  }

  uploadPoints(store) {
    const { gl } = this;
    if (store.capacity > this.pointCapacity) {
      this.pointCapacity = store.capacity;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.offsetBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, store.capacity * 12, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.timeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, store.capacity * 4, gl.DYNAMIC_DRAW);
      this.uploaded = 0;
    }
    if (store.revision !== this.revision) {
      this.revision = store.revision;
      this.uploaded = 0;
    }
    if (store.count > this.uploaded) {
      const from = this.uploaded;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.offsetBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, from * 12, store.offsets.subarray(from * 3, store.count * 3));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.timeBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, from * 4, store.times.subarray(from, store.count));
      this.uploaded = store.count;
    }
  }

  /** Binds `attributes` ([buffer, size, stride, offset, divisor] per location) and disables the rest. */
  bindAttributes(attributes) {
    const { gl } = this;
    for (let location = 0; location < 4; location++) {
      const attribute = attributes[location];
      if (!attribute) {
        gl.disableVertexAttribArray(location);
        continue;
      }
      const [buffer, size, stride, offset, divisor] = attribute;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      this.instancing.divisor(location, divisor);
    }
  }

  useProgram(program, uniforms) {
    const { gl } = this;
    if (uniforms !== this.uniformSource) {
      this.uniformSource = uniforms;
      this.matrixView = uniforms.subarray(0, 16);
      this.vectorView = uniforms.subarray(16);
    }
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(program.viewProj, false, this.matrixView);
    gl.uniform4fv(program.v, this.vectorView);
  }

  drawLines(buffer, count, uniforms) {
    const stride = SEGMENT_FLOATS * 4;
    this.useProgram(this.lines, uniforms);
    this.bindAttributes([
      [this.lineCorners, 2, 0, 0, 0],
      [buffer, 4, stride, 0, 1],
      [buffer, 4, stride, 16, 1],
      [buffer, 4, stride, 32, 1],
    ]);
    this.instancing.draw(4, count);
  }

  /** @param {{uniforms: Float32Array, guides: object, store: object, first: number, count: number, stem: Float32Array | null}} frame */
  draw(frame) {
    const { gl } = this;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.uploadGuides(frame.guides);
    this.uploadPoints(frame.store);

    if (frame.guides.count > 0) this.drawLines(this.guideBuffer, frame.guides.count, frame.uniforms);
    if (frame.stem) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stemBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.stem);
      this.drawLines(this.stemBuffer, 1, frame.uniforms);
    }
    if (frame.count > 0) {
      this.useProgram(this.points, frame.uniforms);
      // WebGL has no base instance; offsetting the instanced attributes skips the oldest hits.
      this.bindAttributes([
        [this.pointCorners, 2, 0, 0, 0],
        [this.offsetBuffer, 3, 12, frame.first * 12, 1],
        [this.timeBuffer, 1, 4, frame.first * 4, 1],
      ]);
      this.instancing.draw(4, frame.count);
    }
  }

  destroy() {
    this.destroyed = true;
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
