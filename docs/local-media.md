# Local media: models that run on this machine

Parallax has two media providers. They are chosen per model, not per deployment.

| Provider | Endpoint prefix | What it does | What it costs |
| --- | --- | --- | --- |
| Treg (paid gateway) | `openai.*`, `google-ai.*`, `fal.*`, … | sends the request to the gateway, polls for the result, downloads the files | the catalog price, held as credits |
| Local (this machine) | `local.*` | runs sd-cpp on the GPU in front of you | nothing: 0 credits, 0 USD |

A local job goes through the same queue, the same job row, the same asset ingest and the same
wallet screen. Only the execution differs: `src/server/worker.ts` calls
`src/server/local-media.ts` instead of `tregCall`.

Mock mode (`TREG_MODE=mock`, or no gateway token) fakes *provider* calls. A local render is not a
provider call, so the worker dispatches `local.*` jobs before the mock short-circuit: a local job
renders on this machine even when every paid model is being answered with a stand-in. That is why
the local dispatch sits above the mock branch in `worker.ts`, and why a `local.*` asset is never a
generated placeholder.

## The GPU is shared, so a render takes a lease

The machine has one GPU (16 GiB). While the LLM server holds it, a renderer has almost nothing:

```
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader
14977 MiB, 1052 MiB        # the served model is resident: 1052 MiB left
```

MOSS Image Base needs the whole stack loaded:

| Component | File | Size |
| --- | --- | --- |
| transformer | `MOSS-Image-Base-UD-Q4_K_XL.gguf` | 3262 MiB |
| text encoder | `Qwen3.5-9B-Q4_K_S.gguf` | 5145 MiB |
| VAE | `flux2-vae.safetensors` | 321 MiB |
| tokenizer | `tokenizer.json` | 20 MiB |
| **weights** | | **8748 MiB**, ~11 GiB with activations |

So a local render must take the GPU from the serving server and give it back. That is the lease:

```
POST {MEDIA_GPU_LEASE_URL}/unload?wait=240   → {"status":"unloaded"}  (waits for the turn in flight)
                                       409    → {"status":"busy"}      → the job retries, nothing was spent
POST {MEDIA_GPU_LEASE_URL}/load              → {"status":"loaded"}    (hand it back)
```

`wait` is the serving server's own patience: it does not cut off a turn that is generating. A
render that cannot get the GPU fails with `gpu_busy` and the job is requeued. Renders are
serialized in one process — two renderers on one GPU oversubscribe it and both fail.

**One Parallax process per GPU** is the invariant behind that serialization: the queue that keeps
two renders apart (`state.inflight`, one promise chain) lives in the process, and a second process
would see free VRAM after the first unloaded the serving model and skip the lease entirely. Run
local media on a single instance — the rest of the app scales horizontally, this does not.

The lease is an HTTP call to whatever serves `/unload` and `/load`. Strata's server does; the URL
is `MEDIA_GPU_LEASE_URL`, default `http://127.0.0.1:8080`. It is sent without an `Origin`, which is
what that server accepts for control routes — a browser page cannot reach them, only the server can.

**A render started while a chat turn is generating will wait for that turn and then unload the
model.** The next chat request reloads it, which costs the load time. Fire local models when the
lane is quiet, or set `MEDIA_PROVIDER=treg` to keep every job on the paid gateway.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEDIA_PROVIDER` | `auto` | `auto` runs `local.*` here; `treg` refuses them (`provider_off`) |
| `SD_CPP_BIN` | `/run/media/alca/store/comfy/sd-cpp/build-master/bin/sd-cli` | the renderer binary |
| `SD_CPP_MODEL_DIR` | `/run/media/alca/store/comfy/models` | weight dirs, searched by file name (`:` separated) |
| `MEDIA_GPU_LEASE_URL` | `http://127.0.0.1:8080` | the server that serves `/unload` and `/load` |
| `MEDIA_GPU_LEASE_WAIT_S` | `240` | how long the lease waits for a turn in flight |
| `MEDIA_LOCAL_TIMEOUT_MS` | `1200000` | a render longer than this is killed |
| `MEDIA_LOCAL_CPU_OFFLOAD` | off | `1` passes `--offload-to-cpu` (slow, but survives a tight GPU) |
| `MEDIA_VRAM_FREE_MIB` | unset | test seam: name the free VRAM instead of asking the GPU |

`GET /api/local/status` answers what this machine can render: provider mode, whether the binary is
there, free VRAM, and per model which weights are missing.

## Models

The registry rows live in `src/registry/local.ts`. They carry file *names*, not paths — the
registry is shared with the browser, the weight directories are a deployment fact.

| Row | Status | Needs |
| --- | --- | --- |
| `moss-image-base` | available, staged | MOSS-Image-Base UD-Q4_K_XL, Qwen3.5-9B Q4_K_S, `tokenizer.json`, `flux2-vae.safetensors` |
| `moss-image-sft` | soon | the SFT transformer; the other three are already here |
| `flux3-klein-base` | soon | a FLUX.3 Klein GGUF and a Qwen3-VL-4B GGUF text encoder |

Dimensions are multiples of 16 (the DiT latents demand it), sizes 768/1024/1280, steps 10-40,
guidance 1-8. Batch max 4, one sd-cpp process per result — the seed comes from the job id, so the
four results of one press differ.

## How a render runs

```
sd-cli --diffusion-model <transformer> --llm <text encoder> --tokenizer <tokenizer.json> \
       --vae <vae> -p "<prompt>" [-n "<avoid>"] -W 1024 -H 1024 --steps 20 --cfg-scale 3 \
       --flow-shift 5 --seed <from job id> -o <tmp>/out.png
```

The PNG is read back and goes through `saveAsset`, like any provider result. Nothing is uploaded
anywhere; there is no gateway call, no reference-file URL, no idempotency key.

### What one render costs in wall clock

Measured on this machine (`npm run fire:local`, prompt "a red fox sitting on a mossy rock at golden
hour", seed from the job id), with the 131k-context model holding the card until the lease unloaded it:

| Quantity | Value |
| --- | --- |
| `1024x1024`, 20 steps, cfg 3, flow-shift 5 | **270 472 ms** of `sd-cli` (13.5 s per step) |
| PNG | 1024x1024 RGB, **2 459 038 bytes** |
| the reload that follows on the next chat request | 17.19 GiB of experts page-locked in 67 s, 8437 cache slots filled in 26.1 s |

Two numbers matter for how this feels to a member: a render is **minutes, not seconds**, and the
lease's real price is paid by the *next chat turn*, which reloads the model the render unloaded. The
renderer also gets the whole card only after the served model is gone, so the idle cost is incurred
once per render batch, not per image.

`fire:local` on purpose does not wait for the handback: when the `/load` lands on a server that is
still restarting, `release()` logs

```
[local-media] the GPU was rendered on and not handed back; the serving server reloads on the next request
```

and the job stays a success — the lease is not a resource that can leak, because the serving server
brings the engine back on its next request. A queued worker render behaves the same way: the render
outlives nothing, the serve reloads.

## Running beside the served model, without unloading it

The build on this machine is sd-cpp master (`version master-810-db99efd-296-g532d2c1+`), which can
split work across devices and budget it, so a renderer does not have to claim the whole card:

```
--backend  cpu,vae=cuda0,diffusion=cuda0     # which module runs where
--max-vram cuda0=6                           # a GiB budget for weights and runner buffers
--offload-to-cpu                             # weights live in RAM, streamed into VRAM per step
```

That is the route to a partition — keep a smaller model served and give the renderer a slice. The
8748 MiB of MOSS weights plus activations do not fit in the 1052 MiB that is free while the 131k
context model is resident, so today the lease unloads; the arithmetic changes when the served
model is smaller. The executor does not pass these yet; `MEDIA_LOCAL_CPU_OFFLOAD` is the only
partition knob wired, and it is the slow path.

## Proof

`npm run test:local-media` runs the provider against a stub renderer and a stub lease server, with
no GPU and no weights: the registry builds a 16-aligned box and prices it at zero, a missing
weight or binary fails before the GPU is asked, a busy lease reports `gpu_busy`, a failing
renderer reports `render_failed` with its exit code, and two renders never overlap
(`/unload`, `/load`, `/unload`, `/load`).

`npm run check:registry` also asserts the local rows are exactly zero-priced, so a local model can
never show a price the machine will not charge.

`npm run fire:local` fires a real render through the same code path and writes the PNG out — it
takes the GPU lease, so run it when the lane is quiet.

`tests/run.py` runs the API suite with `MEDIA_PROVIDER=treg`, so no walk-through can take the lease:
a `local.` model submitted by a browser test would unload the model serving the operator and hold
the card for minutes. The local path is covered by `npm run test:local-media` instead, which needs
no GPU at all.

## What is not local yet

Video (Wan2.2 T2V A14B high+low is ~19 GiB of weights, more than this GPU), image editing
(sd-cpp Kontext/FLUX.3 edit recipes), speech and music. Those stay on the paid gateway.

The picker also still lists the `local.*` rows on a deployment that refuses them
(`MEDIA_PROVIDER=treg`): the registry is bundled into the client, so hiding them needs
`GET /api/local/status` in the picker, which the UI does not do yet. Pressing one answers
`provider_off` — the job fails before any credit is held, and says why.
