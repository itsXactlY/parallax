/**
 * The local media provider: `local.*` jobs rendered on this machine by sd-cpp.
 *
 * No provider call, no price, no network — but the GPU is shared with the LLM server that
 * answers the member's chat. So a render takes a **lease**: it asks that server to give the
 * GPU back (`POST /unload?wait=…`, which waits for the turn in flight rather than cutting it),
 * renders one image, then hands the GPU back (`POST /load`). Renders are serialized in this
 * process, because two of them on one GPU oversubscribe it and both fail.
 *
 * The lease is a plain HTTP call to whatever serves `/unload` and `/load`
 * (`MEDIA_GPU_LEASE_URL`). It is sent without an `Origin`, which is what that server accepts
 * for control routes; a browser page cannot reach them.
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { models } from "@/registry";

export const LOCAL_PREFIX = "local.";
export const isLocalEndpoint = (endpoint: string) => endpoint.startsWith(LOCAL_PREFIX);

/** Why a local render did not happen. `code` is what the job records. */
export class LocalRendererError extends Error {
  code: "provider_off" | "renderer_missing" | "weights_missing" | "gpu_busy" | "lease_failed" | "render_failed" | "timeout";

  constructor(code: LocalRendererError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const bin = () => process.env.SD_CPP_BIN ?? "/run/media/alca/store/comfy/sd-cpp/build-master/bin/sd-cli";

/** Weight directories, searched by file name. First hit wins. */
const modelDirs = () =>
  (process.env.SD_CPP_MODEL_DIR ?? "/run/media/alca/store/comfy/models")
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);

const leaseBase = () => (process.env.MEDIA_GPU_LEASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const leaseWaitS = () => Math.max(0, Math.min(3600, Number(process.env.MEDIA_GPU_LEASE_WAIT_S ?? 240)));
const renderTimeoutMs = () => Math.max(30_000, Number(process.env.MEDIA_LOCAL_TIMEOUT_MS ?? 20 * 60_000));
const cpuOffload = () => process.env.MEDIA_LOCAL_CPU_OFFLOAD === "1";

/** "treg" keeps every job on the paid gateway; the default runs local endpoints here. */
export function mediaProvider(): "auto" | "treg" | "local" {
  const raw = (process.env.MEDIA_PROVIDER ?? "auto").trim().toLowerCase();
  return raw === "treg" || raw === "local" ? raw : "auto";
}

/** A file name from the registry, resolved against the machine's weight dirs. Cached. */
const weightPaths = new Map<string, string | null>();

export function findWeight(name: string): string | null {
  if (weightPaths.has(name)) return weightPaths.get(name) ?? null;
  for (const dir of modelDirs()) {
    const hit = walk(dir, name, 4);
    if (hit) {
      weightPaths.set(name, hit);
      return hit;
    }
  }
  // Only a hit is cached: weights can be staged later, and a stale "missing" would never clear.
  return null;
}

function walk(dir: string, name: string, depth: number): string | null {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  const direct = path.join(dir, name);
  if (fs.existsSync(direct)) return direct;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".cache" || e.name.startsWith(".")) continue;
    const hit = walk(path.join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** Free VRAM in MiB, or null when there is no NVIDIA tool to ask. */
export function freeVramMiB(): number | null {
  // A test seam: name the free VRAM instead of asking the GPU.
  const forced = process.env.MEDIA_VRAM_FREE_MIB;
  if (forced != null && Number.isFinite(Number(forced))) return Math.round(Number(forced));
  try {
    const out = execSync("nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits", {
      encoding: "utf8",
      timeout: 5000,
    });
    const n = Number(out.split("\n")[0]);
    return Number.isFinite(n) ? Math.round(n) : null;
  } catch {
    return null;
  }
}

export interface LocalRenderRequest {
  /** File names, resolved with `findWeight`. */
  components: { model?: string; diffusion?: string; llm?: string; tokenizer?: string; vae?: string };
  /** File names that must exist for this run. */
  required?: string[];
  /** Rough VRAM the run needs, in MiB. */
  vram_mib?: number;
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps: number;
  cfg_scale: number;
  flow_shift?: number;
  seed?: number;
}

/** One row per local model: whether its weights are on this machine, and what is missing. */
export function localStatus(): {
  provider: string;
  binary: { path: string; present: boolean };
  free_vram_mib: number | null;
  lease: string;
  rows: { id: string; ready: boolean; missing: string[] }[];
} {
  const present = fs.existsSync(bin());
  const rows = localRows().map((row) => ({
    id: row.id,
    missing: row.required.filter((name) => !findWeight(name)),
    ready: present && row.required.every((name) => findWeight(name)),
  }));
  return { provider: mediaProvider(), binary: { path: bin(), present }, free_vram_mib: freeVramMiB(), lease: leaseBase(), rows };
}

/** Rows the registry declares as local, with the files each one needs. The registry is the source of truth. */
function localRows(): { id: string; required: string[] }[] {
  const probe = { prompt: "", values: {}, media: {}, count: 1 };
  return models
    .filter((m) => m.build(probe).endpoint.startsWith(LOCAL_PREFIX))
    .map((m) => {
      const body = m.build(probe).body as Record<string, unknown>;
      return { id: m.id, required: Array.isArray(body.required) ? (body.required as string[]) : [] };
    });
}

/**
 * Ask the serving server for the GPU. Returns the release, which gives it back.
 * `wait` is the server's own patience for a turn that is still generating.
 */
async function acquireLease(needMiB: number): Promise<() => Promise<void>> {
  const free = freeVramMiB();
  if (free != null && free >= needMiB) return async () => {};

  const wait = leaseWaitS();
  const url = `${leaseBase()}/unload${wait > 0 ? `?wait=${Math.round(wait)}` : ""}`;
  let reply: Response;
  try {
    reply = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.MEDIA_GPU_LEASE_TOKEN ? { Authorization: `Bearer ${process.env.MEDIA_GPU_LEASE_TOKEN}` } : {}) },
      body: "{}",
      signal: AbortSignal.timeout(Math.round((wait + 15) * 1000)),
    });
  } catch (err) {
    throw new LocalRendererError("lease_failed", `The GPU is held by another service and the lease server at ${leaseBase()} did not answer. ${err instanceof Error ? err.message : ""}`);
  }
  if (reply.status === 409) throw new LocalRendererError("gpu_busy", "The GPU is in use by a turn that did not finish in time. Try again in a minute.");
  if (!reply.ok) throw new LocalRendererError("lease_failed", `The GPU lease server refused: ${reply.status} ${await reply.text().then((t) => t.slice(0, 160))}`);

  return async () => {
    try {
      await fetch(`${leaseBase()}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(process.env.MEDIA_GPU_LEASE_TOKEN ? { Authorization: `Bearer ${process.env.MEDIA_GPU_LEASE_TOKEN}` } : {}) },
        body: "{}",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      // The serving server reloads the model on the next request, so a failed /load is not a lost GPU.
      console.warn("[local-media] the GPU was rendered on and not handed back; the serving server reloads on the next request");
    }
  };
}

/** Renders are serialized: one GPU, one renderer at a time. */
let tail: Promise<unknown> = Promise.resolve();

export async function runLocal(req: LocalRenderRequest, jobId = ""): Promise<Buffer> {
  const done = tail.then(() => render(req, jobId));
  tail = done.catch(() => {});
  return done;
}

async function render(req: LocalRenderRequest, jobId: string): Promise<Buffer> {
  if (mediaProvider() === "treg") throw new LocalRendererError("provider_off", "Local rendering is switched off on this deployment (MEDIA_PROVIDER=treg).");
  if (!fs.existsSync(bin())) throw new LocalRendererError("renderer_missing", `The local renderer is not installed: ${bin()}`);

  const components: Record<string, string> = {};
  const missing: string[] = [];
  for (const [slot, name] of Object.entries(req.components)) {
    if (!name) continue;
    const file = findWeight(name);
    if (!file) missing.push(name);
    else components[slot] = file;
  }
  const required = req.required?.length ? req.required : Object.keys(req.components);
  const absent = required.filter((name) => !findWeight(name));
  if (absent.length) throw new LocalRendererError("weights_missing", `This model's weights are not on this machine: ${absent.join(", ")}`);

  const need = Math.max(1, Math.round(req.vram_mib ?? 8000));
  const release = await acquireLease(need);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parallax-media-"));
  const out = path.join(dir, "out.png");
  try {
    const args: string[] = [];
    if (components.model) args.push("-m", components.model);
    if (components.diffusion) args.push("--diffusion-model", components.diffusion);
    if (components.llm) args.push("--llm", components.llm);
    if (components.tokenizer) args.push("--tokenizer", components.tokenizer);
    if (components.vae) args.push("--vae", components.vae);
    args.push("-p", req.prompt);
    if (req.negative_prompt) args.push("-n", req.negative_prompt);
    args.push("-W", String(req.width), "-H", String(req.height));
    args.push("--steps", String(req.steps));
    args.push("--cfg-scale", String(req.cfg_scale));
    if (req.flow_shift != null) args.push("--flow-shift", String(req.flow_shift));
    if (req.seed != null && Number.isFinite(req.seed)) args.push("--seed", String(Math.floor(req.seed)));
    if (cpuOffload()) args.push("--offload-to-cpu");
    args.push("-o", out);

    const log = await spawnRenderer(args, renderTimeoutMs());
    if (!fs.existsSync(out)) throw new LocalRendererError("render_failed", `The renderer finished with no file. ${log.tail}`);
    const bytes = fs.readFileSync(out);
    if (bytes.length < 64 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new LocalRendererError("render_failed", `The renderer wrote something that is not a PNG. ${log.tail}`);
    }
    console.log(`[local-media] ${jobId} ${path.basename(components.diffusion ?? components.model ?? "")} ${req.width}x${req.height} ${req.steps} steps in ${log.ms} ms, ${bytes.length} bytes`);
    return bytes;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await release();
  }
}

function spawnRenderer(args: string[], timeoutMs: number): Promise<{ tail: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin(), args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
      reject(new LocalRendererError("timeout", `The local render was stopped after ${Math.round(timeoutMs / 60000)} minutes.`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-4000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-4000);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LocalRendererError("renderer_missing", `Could not start the renderer: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ tail: err.slice(-300), ms: Date.now() - started });
      else reject(new LocalRendererError("render_failed", `The renderer exited with code ${code}. ${err.slice(-300)}`));
    });
  });
}
