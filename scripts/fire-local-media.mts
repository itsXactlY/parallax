/**
 * Fire a local model for real: takes the GPU, renders, writes the PNG out.
 *
 *   npm run fire:local                                  # MOSS Image Base, 1024x1024
 *   npm run fire:local -- --model moss-image-base --aspect 16:9 --size 768 --steps 12 -p "a red fox"
 *
 * The flags fill the same draft the studio screen sends, so this runs the registry's real
 * `quoteJob` + `build()` and then the executor the worker calls. It imports the app modules
 * dynamically, like the test script: tsx resolves them without a build.
 *
 * It takes the GPU lease. Run it when the lane is quiet, or point the seams elsewhere:
 *   MEDIA_GPU_LEASE_URL=…      where /unload and /load live
 *   SD_CPP_BIN=…               the renderer to run
 *   MEDIA_VRAM_FREE_MIB=20000  name the free VRAM, so no lease is asked (dry runs, stubs)
 */
import fs from "node:fs";
import path from "node:path";
import type { LocalRenderRequest } from "../src/server/local-media";

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const { getModel, quoteUsd } = await import("../src/registry");
const { runLocal } = await import("../src/server/local-media");

const model = getModel(flag("model", "moss-image-base"));
if (!model) {
  console.error(`${flag("model", "moss-image-base")} is not in the registry.`);
  process.exit(1);
}

// One render per request: the app splits a batch into separate jobs, each with its own seed.
const built = model.build({
  prompt: flag("p", "a small red fox sitting on a mossy stone, soft afternoon light"),
  values: {
    aspect: flag("aspect", "1:1"),
    resolution: flag("size", "1024"),
    steps: flag("steps", "20"),
    cfg: flag("cfg", "3"),
    negative: flag("n", ""),
  },
  media: {},
  count: 1,
});

if (!built.endpoint.startsWith("local.")) {
  console.error(`${model.id} is not a local endpoint (${built.endpoint}).`);
  process.exit(1);
}
const price = quoteUsd(built.endpoint, built.body);
if (price.usd !== 0 || !price.exact) {
  console.error(`${model.id} is priced at $${price.usd}; a local model must price at zero.`);
  process.exit(1);
}
const body = built.body;
const outDir = flag("out", "/tmp/local-media-fire");
fs.mkdirSync(outDir, { recursive: true });

console.log(`firing ${model.id} on ${built.endpoint}: ${body.width}x${body.height}, ${body.steps} steps, cfg ${body.cfg_scale}`);
console.log(`lease ${process.env.MEDIA_GPU_LEASE_URL ?? "http://127.0.0.1:8080"}  renderer ${process.env.SD_CPP_BIN ?? "/run/media/alca/store/comfy/sd-cpp/build-master/bin/sd-cli"}`);

const started = Date.now();
try {
  // The request body IS the render request: components, required files, box, sampler.
  const buffer = await runLocal({ ...(body as unknown as LocalRenderRequest), seed: Number(flag("seed", "42")) }, `fire_${started}`);
  const file = path.join(outDir, `fire-${started}.png`);
  fs.writeFileSync(file, buffer);
  console.log(`${file}  ${buffer.length} bytes  ${Math.round((Date.now() - started) / 1000)}s`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`failed: ${message}`);
  if (process.env.FIRE_DEBUG && error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
}
