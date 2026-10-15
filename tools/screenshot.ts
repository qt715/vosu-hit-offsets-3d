// Headless Chromium screenshots of the overlay (for docs/ previews and renderer checks). Serves
// hit-offsets-3d/ locally, drives Chromium over the DevTools protocol and never opens a window:
// DISPLAY and WAYLAND_DISPLAY are removed from the browser's environment.
//
//   bun tools/screenshot.ts <out.png> [query] [--no-webgpu] [--size 520x520] [--scale 2] [--wait 3000]
//                           [--base http://127.0.0.1:24050/hit-offsets-3d/]
//
//   bun tools/screenshot.ts docs/webgpu.png "demo=1&bg=%2316181d"
//   bun tools/screenshot.ts docs/webgl2.png "demo=1&renderer=webgl&bg=%2316181d"
//
// --base screenshots the overlay as a running vosu serves it (live data) instead of the local copy.
//
// Chromium comes from $CHROME, else chromium / google-chrome-stable on PATH, else the newest
// Playwright build in ~/.cache/ms-playwright. WebGPU and WebGL both run on SwiftShader, so no GPU
// is needed; --no-webgpu leaves WebGPU off entirely to exercise the automatic fallback.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const noWebGpu = args.includes("--no-webgpu");
if (noWebGpu) args.splice(args.indexOf("--no-webgpu"), 1);
const [width, height] = flag("--size", "520x520").split("x").map(Number);
const scale = Number(flag("--scale", "2"));
const wait = Number(flag("--wait", "3000"));
const base = flag("--base", "");
const [out, query = "demo=1"] = args;
if (!out) {
  console.error("usage: bun tools/screenshot.ts <out.png> [query] [--no-webgpu] [--size WxH] [--scale N] [--wait ms]");
  process.exit(2);
}

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ["chromium", "google-chrome-stable", "google-chrome"]) {
    const path = Bun.which(name);
    if (path) return path;
  }
  const cache = join(homedir(), ".cache", "ms-playwright");
  const builds = existsSync(cache)
    ? readdirSync(cache)
        .filter((dir) => /^chromium-\d+$/.test(dir))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const dir of builds) {
    const path = join(cache, dir, "chrome-linux64", "chrome");
    if (existsSync(path)) return path;
  }
  throw new Error("No Chromium found; set CHROME to a Chromium/Chrome binary");
}

const root = resolve(import.meta.dir, "..", "hit-offsets-3d");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path.endsWith("/")) path += "index.html";
    const full = resolve(root, `.${path}`);
    const file = Bun.file(full);
    if (!full.startsWith(root + sep) || !(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "content-type": TYPES[extname(full)] ?? "application/octet-stream" } });
  },
});

const profile = mkdtempSync(join(tmpdir(), "hit-offsets-3d-chrome-"));
const env = { ...process.env };
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
const browser = Bun.spawn(
  [
    findChrome(),
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--mute-audio",
    "--use-angle=swiftshader",
    ...(noWebGpu
      ? ["--disable-features=WebGPU"]
      : ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader"]),
    "about:blank",
  ],
  { env, stdout: "ignore", stderr: "pipe" },
);

async function devtoolsUrl(): Promise<string> {
  const decoder = new TextDecoder();
  let log = "";
  for await (const chunk of browser.stderr) {
    log += decoder.decode(chunk);
    const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) return match[1];
  }
  throw new Error(`Chromium exited before DevTools was ready:\n${log}`);
}

// The subset of DevTools protocol messages this script reads.
type RemoteObject = { value?: unknown; description?: string };
type CdpMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string; data?: string };
  method?: string;
  params?: {
    type?: string;
    args?: RemoteObject[];
    exceptionDetails?: { text: string; exception?: RemoteObject };
  };
};

const socket = new WebSocket(await devtoolsUrl());
const opened = Promise.withResolvers<void>();
socket.onopen = () => opened.resolve();
await opened.promise;
let nextId = 0;
const pending = new Map<number, PromiseWithResolvers<Record<string, unknown>>>();
socket.onmessage = (event) => {
  const message: CdpMessage = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call?.reject(new Error(`${message.error.message} ${message.error.data ?? ""}`));
    else call?.resolve(message.result ?? {});
  } else if (message.method === "Runtime.consoleAPICalled") {
    const text = (message.params?.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
    console.log(`  console.${message.params?.type}: ${text}`);
  } else if (message.method === "Runtime.exceptionThrown") {
    const details = message.params?.exceptionDetails;
    console.log(`  exception: ${details?.exception?.description ?? details?.text}`);
  }
};
function send(method: string, params: object = {}, sessionId?: string): Promise<Record<string, unknown>> {
  const id = ++nextId;
  const call = Promise.withResolvers<Record<string, unknown>>();
  pending.set(id, call);
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return call.promise;
}

let failed = false;
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  const url = `${base || `http://127.0.0.1:${server.port}/index.html`}?${query}`;
  await send("Page.navigate", { url }, sessionId);

  const evaluate = async (expression: string): Promise<unknown> => {
    const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return (result as RemoteObject | undefined)?.value;
  };
  let renderer = "";
  for (let waited = 0; !renderer && waited < 20000; waited += 100) {
    await Bun.sleep(100);
    renderer = String((await evaluate("document.querySelector('[data-root]')?.dataset.renderer ?? ''")) ?? "");
  }
  await Bun.sleep(wait);
  const webgpu = await evaluate("'gpu' in navigator");
  const hud = await evaluate("document.querySelector('[data-stats]')?.textContent");
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  await Bun.write(out, Buffer.from(String(data), "base64"));
  console.log(`${out}: renderer=${renderer || "(none)"} navigator.gpu=${webgpu} hud="${hud}" url=${url}`);
  if (!renderer || renderer === "none") failed = true;
} finally {
  socket.close();
  browser.kill();
  await browser.exited;
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
