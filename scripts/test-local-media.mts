/**
 * The local media provider, tested without a GPU and without real weights.
 * Run: npm run test:local-media   (tsx, no server, no network beyond a localhost stub)
 *
 * What it proves:
 *   - the registry builds a `local.` request with the weight names and a 16-aligned box
 *   - a local endpoint prices at zero and queues one job per result
 *   - a render takes the GPU lease (`/unload`), runs sd-cli, hands it back (`/load`)
 *   - a busy lease, missing weights, a missing binary and a failing renderer each report
 *     the code the job records, and none of them touch the GPU first
 *   - renders serialize: two jobs never run at the same time on one GPU
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallax-local-test-"));

const stubRenderer = path.join(root, "sd-cli-stub.mjs");
fs.writeFileSync(
  stubRenderer,
  `#!/usr/bin/env node
import fs from "node:fs";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
if (process.env.STUB_FAIL === "1") { process.stderr.write("stub: cannot load weights\\n"); process.exit(3); }
await new Promise((d) => setTimeout(d, Number(process.env.STUB_SLEEP_MS ?? 0)));
if (process.env.STUB_NO_FILE !== "1") fs.writeFileSync(out, PNG);
`,
);
fs.chmodSync(stubRenderer, 0o755);

const leases: string[] = [];
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const url = req.url ?? "";
    leases.push(url);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/unload")) {
      if (process.env.STUB_UNLOAD_BUSY === "1") return json(409, { status: "busy" });
      return json(200, { status: "unloaded" });
    }
    json(200, { status: "loaded" });
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const leaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// The provider reads its config when it runs, so the environment is set before the import.
process.env.SD_CPP_BIN = stubRenderer;
process.env.SD_CPP_MODEL_DIR = root;
process.env.MEDIA_GPU_LEASE_URL = leaseUrl;
process.env.MEDIA_VRAM_FREE_MIB = "1200"; // what a resident LLM leaves over on this machine
process.env.MEDIA_PROVIDER = "auto";

const { LocalRendererError, freeVramMiB, isLocalEndpoint, localStatus, runLocal } = await import("../src/server/local-media");
const { getModel, models, quoteJob } = await import("../src/registry");

let failed = 0;
const ok = (what: string, detail: string) => console.log(`ok   ${what}: ${detail}`);
const bad = (what: string, detail: string) => {
  console.log(`FAIL ${what}: ${detail}`);
  failed++;
};

/* ------------------------------ registry shape ------------------------------ */

const model = getModel("moss-image-base");
if (!model) bad("registry", "moss-image-base is not in the registry");
else {
  const quote = quoteJob(model, { prompt: "a cat", values: { aspect: "16:9", resolution: "1024", steps: 20, cfg: 3, negative: "" }, filled: {}, count: 2 });
  if (quote.request.endpoint !== "local.moss-image-base") bad("registry", `endpoint ${quote.request.endpoint}`);
  if (quote.millicredits !== 0) bad("registry", `a local job costs ${quote.millicredits} millicredits`);
  if (quote.jobs !== 2) bad("registry", `count 2 queued ${quote.jobs} jobs`);
  const body = quote.request.body as Record<string, unknown>;
  if (Number(body.width) % 16 || Number(body.height) % 16) bad("registry", `box ${body.width}x${body.height} is not 16-aligned`);
  if (Number(body.height) >= Number(body.width)) bad("registry", `16:9 gave ${body.width}x${body.height}`);
  if (!isLocalEndpoint(quote.request.endpoint)) bad("registry", "isLocalEndpoint said no");
  ok("registry", `${quote.request.endpoint} ${body.width}x${body.height}, ${quote.millicredits} millicredits, ${quote.jobs} jobs`);
  const localRows = models.filter((m) => m.build({ prompt: "", values: {}, media: {}, count: 1 }).endpoint.startsWith("local."));
  ok("registry", `${localRows.length} local rows: ${localRows.map((m) => `${m.id} (${m.status})`).join(", ")}`);
}

/* ------------------------------ readiness ------------------------------ */

if (freeVramMiB() !== 1200) bad("vram", `free said ${freeVramMiB()}`);
else ok("vram", "the test seam reports 1200 MiB free, so a render must take the lease");

let status = localStatus();
if (status.provider !== "auto") bad("status", `provider ${status.provider}`);
if (!status.binary.present) bad("status", "the stub renderer was not seen");
const row = status.rows.find((r) => r.id === "moss-image-base");
if (!row) bad("status", "no row for moss-image-base");
else if (row.ready || row.missing.length !== 4) bad("status", `ready=${row.ready} missing=${row.missing.join(", ")}`);
else ok("status", `missing before staging: ${row.missing.join(", ")}`);

/* ------------------------------ failure paths ------------------------------ */

const req = (extra: Record<string, unknown> = {}) => ({
  components: {
    diffusion: "MOSS-Image-Base-UD-Q4_K_XL.gguf",
    llm: "Qwen3.5-9B-Q4_K_S.gguf",
    tokenizer: "tokenizer.json",
    vae: "flux2-vae.safetensors",
  },
  required: ["MOSS-Image-Base-UD-Q4_K_XL.gguf", "Qwen3.5-9B-Q4_K_S.gguf", "tokenizer.json", "flux2-vae.safetensors"],
  vram_mib: 11000,
  prompt: "a cat holding a sign",
  width: 1024,
  height: 1024,
  steps: 20,
  cfg_scale: 3,
  seed: 7,
  ...extra,
});

async function expectCode(what: string, code: string, request: Parameters<typeof runLocal>[0]) {
  try {
    await runLocal(request);
    bad(what, "it ran and returned a file");
  } catch (err) {
    if (!(err instanceof LocalRendererError)) bad(what, `${err instanceof Error ? err.message : err}`);
    else if (err.code !== code) bad(what, `code ${err.code}, expected ${code}: ${err.message}`);
    else ok(what, `${err.code}: ${err.message.slice(0, 80)}`);
  }
}

await expectCode("weights", "weights_missing", req());
if (leases.length !== 0) bad("weights", `it asked the GPU (${leases.length} lease calls) before checking weights`);
else ok("weights", "no lease was taken for a model whose weights are not here");

process.env.MEDIA_PROVIDER = "treg";
await expectCode("provider switch", "provider_off", req());
process.env.MEDIA_PROVIDER = "auto";

process.env.SD_CPP_BIN = path.join(root, "not-installed");
await expectCode("renderer", "renderer_missing", req());
process.env.SD_CPP_BIN = stubRenderer;

/* ------------------------------ staged weights + the lease ------------------------------ */

for (const name of ["MOSS-Image-Base-UD-Q4_K_XL.gguf", "Qwen3.5-9B-Q4_K_S.gguf", "tokenizer.json", "flux2-vae.safetensors"]) {
  fs.writeFileSync(path.join(root, name), "stub");
}
status = localStatus();
const ready = status.rows.find((r) => r.id === "moss-image-base");
if (!ready?.ready) bad("status", "the row still says missing after staging");
else ok("status", "ready once the four weights are on disk");

process.env.STUB_UNLOAD_BUSY = "1";
await expectCode("lease busy", "gpu_busy", req());
process.env.STUB_UNLOAD_BUSY = "0";

process.env.STUB_FAIL = "1";
await expectCode("renderer exit", "render_failed", req());
process.env.STUB_FAIL = "0";

process.env.STUB_SLEEP_MS = "250";
const before = leases.length; // the failure paths above already talked to the lease server
const both = await Promise.all([runLocal(req(), "job-a"), runLocal(req({ seed: 8 }), "job-b")]);
for (const [i, bytes] of both.entries()) {
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") bad("render", `result ${i} is not a PNG`);
}
const taken = leases.slice(before);
const unloads = taken.filter((u) => u.startsWith("/unload"));
const loads = taken.filter((u) => u.startsWith("/load"));
if (unloads.length !== 2 || loads.length !== 2) bad("lease", `${unloads.length} /unload and ${loads.length} /load for two renders`);
else ok("lease", `two renders took and returned the GPU: ${unloads[0]} then ${loads[0]}`);
const order = taken.map((u) => (u.startsWith("/unload") ? "u" : "l")).join("");
if (order !== "ulul") bad("lease", `order ${order}, expected unload/load/unload/load`);
else ok("lease", "renders did not overlap: each waited for the GPU before the next asked for it");

/* ------------------------------ the job row the submit route stores ------------------------------ */

// `jobs.request` holds `{ body, query, headers }`; the worker renders from `body`, so a real row
// must carry the components. Storing the wrapper instead would leave `components` undefined.
const built = getModel("moss-image-base")!.build({ prompt: "a cat holding a sign", values: {}, media: {}, count: 1 });
const storedRow = JSON.parse(JSON.stringify({ body: built.body, query: {}, headers: {} }));
const fromRow = await runLocal({ ...(storedRow.body ?? {}), seed: 11 }, "job-row");
if (fromRow.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") bad("worker seam", "a stored job row did not render");
else if (built.endpoint !== "local.moss-image-base") bad("worker seam", `endpoint ${built.endpoint}`);
else ok("worker seam", `a stored job row renders: ${built.endpoint} ${storedRow.body.width}x${storedRow.body.height}`);

server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `FAILED (${failed})` : "PASS");
if (failed) process.exitCode = 1;
