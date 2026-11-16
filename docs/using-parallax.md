# Using Parallax

TLDR, then the paths, then the wire. Everything here was run on this machine; the traces are quoted from
real output, not written as an ideal.

## TLDR

Parallax is a media-generation platform with an agent in front of it. You ask in ordinary language; it
chooses a model, spends credits, generates, files the result in your library, and answers in the same
thread. Three things make it worth wiring to another agent:

1. **It is an MCP server.** An engine pointed at `/api/super/mcp` gets the whole product as tools:
   `generate_media`, `list_models`, `get_model`, `quote`, `search_library`, `get_asset`, `remember`,
   `recall`, `ask_user`, `schedule_chat` (10 here; the `computer_*` tools and the connector tools appear
   only when those services are live). That is how Ariadne drives it.
2. **One lane per chat.** `ARIADNE_PER_CHAT=1` spawns one `ariadne --serve` per conversation, each with
   its own home, config and log. Two chats are two isolated agents; a crashed one takes only its lane.
3. **The work survives the process.** Generations run detached, with an idempotency key per step, so a
   killed server resumes instead of re-spending.

Run it, then drive one conversation with plain `curl`. `npm run dev` answers with the stand-in
engine and needs no keys; the chain below was run against `deploy/start.sh mock` with an Ariadne
lane behind the same chat, and the requests are identical either way.

```bash
cd ~/projects/parallax
npm ci && PARALLAX_DEMO_SEED=1 npm run dev      # http://localhost:3000
```

```bash
J=/tmp/p.json; C=/tmp/p.jar
curl -c $C -b $C -X POST localhost:3000/api/auth/guest -o $J      # a throwaway account
curl -b $C -X POST localhost:3000/api/super/chats -d '{}' -o $J   # a conversation
CHAT=$(python3 -c "import json;print(json.load(open('$J'))['chat']['id'])")
curl -b $C -X POST localhost:3000/api/super/chats/$CHAT/messages \
  -d '{"text":"a 512x512 image of a fox in snow","mode":"auto","model":"auto"}' -o $J
echo '{"rows":[]}' > $J
REV=0
until python3 -c "import json,sys;d=json.load(open('$J'));sys.exit(0 if any(r['kind']=='card' and r['body'].get('card')=='result' and r['body'].get('status')=='succeeded' for r in d['rows']) else 1)"; do
  curl -s -b $C "localhost:3000/api/super/chats/$CHAT/rows?after=$REV" -o $J
  REV=$(python3 -c "import json;print(json.load(open('$J'))['rev'])")
  sleep 5
done
curl -b $C "localhost:3000/api/assets?limit=5" -o $J                     # the asset is filed by then
curl -b $C -o fox.png localhost:3000/api/assets/$(python3 -c "import json;print(json.load(open('$J'))['assets'][0]['id'])")/file
```

## The engines and the services

`SUPER_ENGINE` decides who answers. `SUPER_MODE=live` decides whether the services are real or fake.

| env | what it does |
|---|---|
| `SUPER_ENGINE=ariadne` | Ariadne answers. Unset or anything else: the built-in engine stays in charge. |
| `SUPER_MODE=live` + `ANTHROPIC_API_KEY` | the built-in engine calls a real model. Without it: scripted mock. |
| `TREG_TOKEN` | the media gateway (treg.to). Without it every model returns a sample file, and credits are simulated. `TREG_DAILY_BUDGET_USD` caps real spend. |
| `ORGO_API_KEY`, `COMPOSIO_API_KEY` | the agent's cloud computer and its connected apps, both only under `SUPER_MODE=live`. |
| `SUPER_ENGINE_TOKEN` (or `..._FILE`) | the bearer the engine sends to `/api/super/mcp`. At least 24 characters; **required** for Ariadne. It is a spending credential. |
| `ARIADNE_API_KEY` (or `..._FILE`) | the bearer Parallax sends to the agent's serve — its `DD_SERVE_KEY` / `serve.api_key`. |
| `ARIADNE_BIN` | path to the `ariadne` binary (`--serve` build). |
| `ARIADNE_URL` | shared OpenAI-compatible endpoint instead of lanes. |
| `ARIADNE_HOME` | the home lanes build under, and whose `config.yaml` they inherit. |
| `ARIADNE_PER_CHAT=1` | one lane per chat instead of one shared serve. |
| `ARIADNE_DISABLE_TOOLS` | Ariadne's own tools left out of a lane. Default: `run_terminal,write_file,edit_file,list_dir,read_file,delegate_task,job,view_image`. |
| `ARIADNE_MODEL`, `ARIADNE_MCP_NAME` | the name in the model pill; the name of Parallax's entry in the agent's `mcp_servers` (`parallax`). |
| `ARIADNE_PORT_BASE`, `ARIADNE_LANE_IDLE_MIN`, `ARIADNE_MAX_LANES` | first loopback port (8643), quiet minutes before a lane closes (20), lanes open at once (8). |
| `SUPER_TURN_MS` | how long one turn may run (300000 ms, honoured up to 30 minutes). A local model needs minutes per step. |

Secrets can be handed as `*_FILE` instead of inline; Parallax reads the file and never puts a value in a
log or a child environment beyond what that child needs.

## How to reach it

| file | what lives there |
|---|---|
| `src/app/` | the product: library, cinema, ads, community, profile, credits, developer console |
| `src/app/supercomputer/` | the agent UI: composer, thread, approvals |
| `src/server/super/loop.ts` | the built-in turn loop |
| `src/server/super/ariadne.ts` | the Ariadne engine, the lane pool, the lane config writer |
| `src/server/super/engine-mcp.ts` | the tools the engine sees, each call keyed by turn |
| `src/app/api/super/mcp/route.ts` | the MCP door: initialize, tools/list, tools/call, JSON-RPC error codes |
| `src/server/super/config.ts` | every env setting above |
| `src/server/developer/` | public API keys, scopes, rate windows, OpenAPI |
| `docs/api/` | the wire contract |
| `tests/` | `tests/run.py <file>`; `super_ariadne.py` is the engine contract |
| `run/engine-home/lanes/<chat>/` | a lane's home, `config.yaml`, `serve.log` |
| `data/` | the SQLite database when you run `npm run dev` (`PARALLAX_DATA_DIR` overrides it) |
| `deploy/run/data/` | the database, files and log when you run `deploy/start.sh` |

## The thread protocol

A conversation is a row log. Every row has `seq` (its position) and `updatedSeq` (when it last changed).

| row kind | body | what it is |
|---|---|---|
| `message` | `role: "user"` — text, `fileIds`, `mode` | what you typed |
| `message` | `role: "assistant"`, `streaming: true` while it grows | the reply, edited in place |
| `tool-call` | `tool`, `input`, `status: running\|done\|failed`, `summary` | one tool call the engine made |
| `card` | `card: "approval"\|"question"\|"result"\|"connect"`, `approvalId`, `status` | something the member must answer, or the outcome |
| `notice` | `level`, `code`, `text` | a failure the thread shows: `time_limit`, `tool_markup` |
| `event` | turn lifecycle | step counts, turn end |

A row is identified by `seq`; a reply grows, so a row's `updatedSeq` moves. Ask for rows changed after
the last one you saw and upsert by `seq`:

- `GET /api/super/events` — Server-Sent Events deltas for every chat of this member (cookie session;
  curl needs the jar to read it).
- `GET /api/super/chats/:id/rows?after=<updatedSeq>&limit=` — the same thing as a poll, plus `chat` and
  `rev`, so a page that missed the stream can catch up.
- `POST /api/super/chats/:id/messages` `{ text, fileIds?, mode?, model? }` — queue a turn. The reply is
  not in this response; it arrives as rows.
- `POST /api/super/chats/:id/stop`, `/close`, and `POST /api/super/approvals/:id` `{ decision }` — stop a
  turn, delete a chat, answer an approval or a question.

`mode` is `ask` (default: every `generate_media` first posts an approval card) or `auto` (spends without
asking, up to the turn's ceiling). An approval card carries the price from Parallax's own quote:
`{ card: "approval", approvalId, tool: "generate_media", status: "pending", cost }`, and it expires if
nobody answers.

## Driving it from an agent: `/api/super/mcp`

One endpoint, MCP `tools/list` + `tools/call`, bearer `SUPER_ENGINE_TOKEN`. Names are exactly what
`tools/list` returns: `generate_media`, `list_models`, `get_model`, `quote`, `search_library`,
`get_asset`, `remember`, `recall`, `ask_user`, `schedule_chat`, plus `computer_*` when
`PARALLAX_COMPUTER_ENABLED=1` and `list_connectors` / `connect_app` when connectors are configured.

Every call carries a `turn` key, which the engine minted for its own turn and Parallax re-verifies on
arrival. It binds the call to that chat, to the turn's spend ceiling, and to the idempotency ledger — a
forged or reused key is refused, and a replayed `generate_media` costs nothing a second time.

## Wiring Ariadne

```bash
ARIADNE_BIN=$HOME/projects/ariadne/build/ariadne \
ARIADNE_HOME=$HOME/ariadne \
ARIADNE_PER_CHAT=1 \
ARIADNE_MODEL=anthropic/claude-opus-5-5 \
SUPER_ENGINE=ariadne \
SUPER_ENGINE_TOKEN=$(openssl rand -hex 32) \
deploy/start.sh live
```

Parallax then writes, per lane, `<ARIADNE_HOME>/lanes/<chat>/config.yaml`: your own config plus
`mcp_servers.parallax` pointed at `/api/super/mcp`, and Parallax's tool names added to the top-level
`tool_search.always_load` (Ariadne keeps MCP tools out of the prompt until `find()` or `tool_search()`
loads them, so without that list the agent can only reach the studio by searching for it). `tools.approval.auto_approve` is kept as you set it.

**Tool names are bare.** Ariadne registers an MCP server's tools under the names the server itself lists.
The `mcp_servers.<name>` entry is the toolset they are grouped under, never a prefix on the wire name. A
config or prompt that says `parallax_generate_media` describes a tool the wire never offered, and the
model writes the call out as text and nothing runs.

The same wiring without lanes (`ARIADNE_PER_CHAT` unset) points at any OpenAI-compatible endpoint:

```bash
ARIADNE_URL=http://127.0.0.1:8080/v1 ARIADNE_API_KEY_FILE=/secrets/engine.key SUPER_ENGINE=ariadne \
SUPER_ENGINE_TOKEN=$(openssl rand -hex 32) deploy/start.sh live
```

## The endpoints, by area

| area | addresses | who may reach |
|---|---|---|
| account | `POST /api/auth/signup\|login\|guest\|logout`, `GET /api/auth/me`, `/api/account/*` (handle, password, preferences, profile, sessions, referral) | cookie session |
| studios | `/api/jobs`, `/api/jobs/:id`, `/api/assets`, `/api/assets/:id`, `/api/assets/:id/file`, `/api/elements`, `/api/folders/*` | cookie session |
| library | `GET /api/library?kind=&source=&favorite=&folder=&model=&q=&sort=&limit=&cursor=`, `/api/library/summary`, `/api/library/bulk`, `/api/library/trash` + `restore` | cookie session |
| cinema | `/api/cinema/catalog`, `/projects`, `/projects/:id/scenes|shots|elements|takes|batch|render|export`, `/api/cinema/compose` | cookie session |
| ads | `/api/ads/products`, `/formats`, `/items/:id`, `/campaigns/:id/run|rerun|quote|duplicate`, `/copy`, `/brands` | cookie session |
| community | `/api/community/posts`, `/posts/:id/like|save|comments|view|recreate|report`, `/contests`, `/profiles/:handle/follow` | cookie session |
| credits | `/api/wallet`, `/api/wallet/topup`, `/api/billing/*`, `/api/notifications/*` (SSE at `/notifications/stream`) | cookie session |
| super | `/api/super/chats`, `/chats/:id/messages|rows|stop|close`, `/api/super/events`, `/api/super/approvals/:id`, `/api/super/config`, `/api/super/memory`, `/api/super/skills`, `/api/super/schedules`, `/api/super/projects`, `/api/super/computer[/screenshot]`, `/api/super/connectors/*`, `/api/super/showcase` | cookie session |
| the engine's door | `POST /api/super/mcp` | bearer `SUPER_ENGINE_TOKEN` only |
| developer API | `/api/v1/models`, `/v1/models/:id`, `/v1/quote`, `/v1/generations[/:id][/cancel]`, `/v1/files[/:id][/content]`, `/v1/balance`, `/v1/openapi.json`, `/api/mcp`, `/api/developer/keys[/:id][/rotate|test]`, `/api/developer/webhooks/*`, `/api/developer/usage` | `Authorization: Bearer <api key>` with the right scope |

`/api/developer/keys` answers with `secret` once — store it, it is never shown again. `POST
/api/v1/generations` honours `Idempotency-Key`: a replayed request returns the same jobs with
`Idempotent-Replayed: true` and spends nothing twice.

## Two worked traces on this machine

Both are the row log as the database holds it, from `deploy/run/data/parallax.db`.

**Memory through a lane** (`ARIADNE_PER_CHAT=1`, the Architect, one serve for one chat):

```
message    user        Remember that in this project I prefer 3:2 aspect ratio for posters.
tool-call  remember    done     Saved to memory
message    assistant   Done — saved: posters default to 3:2 for this project.
```

The lane booted at **96 tools** with `mcp_servers.btquant/mazemaker/parallax` and `pulse` intact and
`tool_search.always_load` at 23 names; the handshake discovered Parallax's 10. The denylist is why it is
96 and not 104: `ARIADNE_DISABLE_TOOLS` takes Ariadne's own shell, file and delegation tools out of the
deck (measured on this home: 104 tools without it, 96 with it). The memory row landed in Parallax's
own store, not in Ariadne's maze — `recall` reads back what Parallax saved.

**Questions, approval, generation** (Ask mode, same engine):

```
message    user        Make me a poster of a lighthouse at dusk, 16:9. Ask me first.
tool-call  list_models done     Listed 8 models
tool-call  ask_user    done     Got an answer      card question answered
tool-call  get_model   done     Read Nano Banana Pro
tool-call  ask_user    done     Got an answer      card question answered
tool-call  generate_media running
                                card approval pending, then status allowed
tool-call  generate_media done  Made 1 file
card       result      succeeded  cost 4200   asset ast_HGV7UtxndDxs2ylN   job job_yduWMDBAX0JKusjH
tool-call  remember    done     Saved to memory
message    assistant   Done — a 16:9 dusk poster, generated on Nano Banana Pro at 2K.
```

The price came from Parallax's quote, the charge hit the member's balance, and the file went into their
library. The generation key never reached the agent.

**A generation on a lane with no provider keys** (same Ariadne setup, mock media, guest account):

```
message    user        a 512x512 image of a fox in snow
tool-call  list_models done     Listed 8 models
tool-call  get_model   done     Read FLUX Schnell
tool-call  get_model   done     Read GPT Image 2.5 Flare
tool-call  get_model   done     Read Image-01
tool-call  generate_media done  Made 1 file
card       result      succeeded  cost 100   asset ast_38V6jFMoy55djzJe   job job_H2f68WsZ9ixCSTVh
message    assistant   Generated — a red fox in fresh snow, square framing.
```

`GET /api/assets/ast_38V6jFMoy55djzJe/file` returns the bytes: a 1024x1024 PNG, 581,678 bytes, filed
under `source: generated`, and `GET /api/assets?job=job_H2f68WsZ9ixCSTVh` finds it by job. With no
provider key the file is Parallax's sample and the 100 credits are simulated; with `TREG_TOKEN` the same
chain spends real money, capped by `TREG_DAILY_BUDGET_USD`.

**What a slow model looks like.** A local serve can take minutes per step. One lane hit the ceiling:

```
tool-call  ask_user    done     No answer
card       question    expired
notice     error       time_limit   This reply took too long and was stopped.
```

That is `SUPER_TURN_MS` (default 300000 ms, honoured up to 30 minutes). Set it higher in
`deploy/run/env` for a lane on a local model — this machine runs 1800000.

## Where to reach for more

- `docs/ariadne-on-orgo.md` — this wiring, the two traces, the failure modes.
- `docs/api/super.md` — every Super endpoint, status codes, error shapes, and the engine's tool
  server (`/api/super/mcp`) with its turn keys.
- `docs/api/developer.md` — the REST API and the developer MCP at `/api/mcp`: keys, scopes,
  idempotency, webhooks.
- `docs/api/core.md`, `library.md`, `cinema.md`, `ads.md`, `community.md`, `apps.md`, `account.md`,
  `notify.md` — one page per product area, each ending with an "Open improvements" list.
- `SECURITY.md` — what a lane can see, what a key can spend.

## When it does not behave

| symptom | cause | fix |
|---|---|---|
| serve boots with ~6 tools, model says "there is no remember tool" | the lane config's `always_load` list was indented deeper than the base file's sequence items, so YAML failed at `- tools:` and everything after it read as nothing | fixed in `ariadne.ts` (`itemIndent()`); rebuild Parallax |
| the model describes a tool call in text, nothing runs | the prompt or config named a prefixed tool the wire never offers | name tools bare; rebuild |
| tool call never executes, reply streams fine | the upstream returned markup (`<toolcall>`) instead of structured `tool_calls` deltas — the serve runs only structured calls | use a model that returns structured calls; Parallax drops the markup and posts `notice:tool_markup` |
| `engine is not configured` on `/api/super/config` | `SUPER_ENGINE != ariadne`, or a half-set engine (missing token / bin / home / URL) | set the whole set; the log names the missing key, never the value |
| lane dies after `serve timeout (30000ms)` | the lane's binary died, or the port was already taken | read `run/engine-home/lanes/<chat>/serve.log`; the first connect retries once |
| two chats mixed into one thread | `ARIADNE_PER_CHAT` unset — one shared serve holds one conversation | set `ARIADNE_PER_CHAT=1` |
| a reply stops mid-work with `time_limit` | the turn ran past `SUPER_TURN_MS` | raise it in `deploy/run/env`; a local model needs minutes per step |

