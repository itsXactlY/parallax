/**
 * Models that run on this machine: GGUF weights loaded by sd-cpp, no provider call,
 * no network, no price. Their endpoints are `local.<id>`; the worker runs them with
 * `src/server/local-media.ts`, which takes the GPU lease first.
 *
 * The components here are file *names*, not paths: the machine's weight directories are
 * a deployment fact (`SD_CPP_MODEL_DIR`), and the registry is shared with the browser.
 */
import { aspect, compact, resolution, slider, text } from "./helpers";
import type { MediaSlot, ModelDef, ModelStatus } from "./types";

const PROMPT = { required: true, maxLength: 4000, placeholder: "Describe the image: subject, setting, light, lens, mood." };

/** Local models take no reference files yet: sd-cpp edits are a separate recipe. */
const NO_SLOTS: MediaSlot[] = [];

interface LocalImageModel {
  id: string;
  name: string;
  tagline: string;
  /** Weight file names this model needs. `diffusion` is the transformer; `model` a single checkpoint. */
  components: { model?: string; diffusion?: string; llm?: string; tokenizer?: string; vae?: string };
  /** File name that must exist for the row to be usable; the rest are optional unless marked. */
  required: string[];
  /** Rough VRAM the run needs, in MiB: weights plus activations. The lease checks this. */
  vramMiB: number;
  aspects: string[];
  sizes: string[];
  defaultSize: string;
  steps: { min: number; max: number; default: number };
  cfg: { min: number; max: number; default: number };
  flowShift?: number;
  eta: number;
  status: ModelStatus;
  statusNote?: string;
  featured?: boolean;
}

/** `aspect` x `resolution` -> a pixel box on a multiple of 16, which the DiT latents need. */
function box(aspectRatio: string, base: string): { width: number; height: number } {
  const edge = Math.max(128, Math.min(2048, Number(base) || 1024));
  const [a, b] = aspectRatio.split(":").map((n) => Number(n));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return { width: edge, height: edge };
  const round16 = (n: number) => Math.max(128, Math.round(n / 16) * 16);
  if (a >= b) return { width: round16(edge), height: round16((edge * b) / a) };
  return { width: round16((edge * a) / b), height: round16(edge) };
}

function localImage(m: LocalImageModel): ModelDef {
  return {
    id: m.id,
    kind: "image",
    name: m.name,
    vendor: "Local",
    tagline: m.tagline,
    badges: ["GGUF", "runs here"],
    featured: m.featured,
    status: m.status,
    statusNote: m.statusNote,
    surfaces: ["image"],
    prompt: PROMPT,
    slots: NO_SLOTS,
    controls: [
      aspect(m.aspects, m.aspects.includes("1:1") ? "1:1" : m.aspects[0]),
      resolution(m.sizes, m.defaultSize, "Size"),
      slider("steps", "Steps", m.steps.min, m.steps.max, 1, m.steps.default, { advanced: true }),
      slider("cfg", "Guidance", m.cfg.min, m.cfg.max, 0.5, m.cfg.default, { advanced: true }),
      text("negative", "Avoid", 600, { advanced: true, placeholder: "What must not appear." }),
    ],
    batch: { max: 4, native: false },
    output: "image",
    eta: m.eta,
    build({ prompt, values }) {
      const { width, height } = box(String(values.aspect ?? "1:1"), String(values.resolution ?? m.defaultSize));
      return {
        endpoint: `local.${m.id}`,
        body: compact({
          components: m.components,
          required: m.required,
          vram_mib: m.vramMiB,
          prompt,
          negative_prompt: values.negative ? String(values.negative) : undefined,
          width,
          height,
          steps: Number(values.steps ?? m.steps.default),
          cfg_scale: Number(values.cfg ?? m.cfg.default),
          flow_shift: m.flowShift,
        }),
      };
    },
  };
}

const ASPECTS = ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9"];

export const localModels: ModelDef[] = [
  localImage({
    id: "moss-image-base",
    name: "MOSS Image Base",
    tagline: "OpenMOSS-Image transformer, GGUF on this machine.",
    components: {
      diffusion: "MOSS-Image-Base-UD-Q4_K_XL.gguf",
      llm: "Qwen3.5-9B-Q4_K_S.gguf",
      tokenizer: "tokenizer.json",
      vae: "flux2-vae.safetensors",
    },
    required: ["MOSS-Image-Base-UD-Q4_K_XL.gguf", "Qwen3.5-9B-Q4_K_S.gguf", "tokenizer.json", "flux2-vae.safetensors"],
    vramMiB: 11_000,
    aspects: ASPECTS,
    sizes: ["768", "1024", "1280"],
    defaultSize: "1024",
    steps: { min: 10, max: 40, default: 20 },
    cfg: { min: 1, max: 8, default: 3 },
    flowShift: 5,
    eta: 70,
    status: "available",
    featured: true,
  }),
  localImage({
    id: "moss-image-sft",
    name: "MOSS Image SFT",
    tagline: "Instruction-tuned MOSS weights, same local runner.",
    components: {
      diffusion: "MOSS-Image-SFT-UD-Q4_K_XL.gguf",
      llm: "Qwen3.5-9B-Q4_K_S.gguf",
      tokenizer: "tokenizer.json",
      vae: "flux2-vae.safetensors",
    },
    required: ["MOSS-Image-SFT-UD-Q4_K_XL.gguf", "Qwen3.5-9B-Q4_K_S.gguf", "tokenizer.json", "flux2-vae.safetensors"],
    vramMiB: 11_000,
    aspects: ASPECTS,
    sizes: ["768", "1024", "1280"],
    defaultSize: "1024",
    steps: { min: 10, max: 40, default: 20 },
    cfg: { min: 1, max: 8, default: 3 },
    flowShift: 5,
    eta: 70,
    status: "soon",
    statusNote: "Weights not on this machine yet.",
  }),
  localImage({
    id: "flux3-klein-base",
    name: "FLUX.3 Image Klein Base",
    tagline: "Black Forest Labs Klein, GGUF on this machine.",
    components: {
      diffusion: "flux-3-image-klein-base-UD-Q4_K_XL.gguf",
      llm: "Qwen3VL-4B-AWQ.gguf",
      vae: "flux2-vae.safetensors",
    },
    required: ["flux-3-image-klein-base-UD-Q4_K_XL.gguf", "Qwen3VL-4B-AWQ.gguf", "flux2-vae.safetensors"],
    vramMiB: 9_500,
    aspects: ASPECTS,
    sizes: ["768", "1024", "1280"],
    defaultSize: "1024",
    steps: { min: 10, max: 40, default: 20 },
    cfg: { min: 1, max: 8, default: 4 },
    eta: 60,
    status: "soon",
    statusNote: "Weights not on this machine yet.",
  }),
];
