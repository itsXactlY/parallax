# Supercomputer on an Ariadne agent

Supercomputer is Parallax's agent chat. Out of the box it answers with a scripted stand-in
(`SUPER_MODE=mock`). This guide swaps in a real agent: an **Ariadne** agent serving
`/v1/chat/completions` runs the conversation, and Parallax gives it the studio's tools.

```
member ──▶ Parallax ──POST /v1/chat/completions (stream)──▶ Ariadne agent (on a computer you run)
               ▲                                            │
               └────── POST /api/super/mcp (tools) ◀────────┘
```

What you get:

- The agent thinks, plans and talks. It keeps the thread on its side, or Parallax does.
- When it wants a picture, a video or audio, it calls Parallax's `generate_media` tool. The
  member sees an approval card with the price, and pays with their own credits.
- The generation key (Treg) stays inside Parallax. The agent never sees it.
- Members see one chat. The model picker shows your agent's name.

> **Status, honestly.** The engine is tested end to end against a stand-in agent that speaks
> the same wire (`tests/super_ariadne.py`) and in a browser, and against a live
> `ariadne --serve` on this machine. `deploy/tunnel.sh` has not been used on a real pair of
> machines. Expect to fix small things. Reports and pull requests are welcome.

## What you need

- Parallax, built and running (see the [README](../README.md)). Node 22.13 or newer.
- An Ariadne agent that can serve: `ariadne --serve 127.0.0.1:<port> --home <dir>`.
- A computer for the agent to live on. Any Linux machine you can reach works; the
  shape is the same whether it is a VPS, a box under your desk, or a machine from a
  computer service.
- Ten minutes.

## Read this first: which agent?

**The agent's own tools are not behind Parallax's approval cards.** An Ariadne agent has a
shell, file access, its own memory graph, and every tool its harness mounts. Anyone who can
open the chat can ask it to use them. They show up in the chat as a step with a name, and
nothing asks first. Its memory is also shared: what it learns from one chat is there for the
next one.

So:

- **Do not point a public Parallax at your personal agent.**
- For anything other people can open, give it a **dedicated home** (`--home`, its own
  `DD_HOME`) with the file and terminal tools switched off (`ARIADNE_DISABLE_TOOLS=run_terminal,write_file,edit_file,list_dir,read_file`) and no personal keys.
- A personal agent is fine while you are the only one who can reach the app.

One more thing the warning does not cover: **a lane inherits the engine home's `mcp_servers`.**
The lane's config is the home's config plus Parallax's entry, so every server that home carries
is offered to every chat -- a shell-capable tool pack, a memory graph, a research pod. Parallax
switches Ariadne's own shell and file tools off (`ARIADNE_DISABLE_TOOLS`), and nothing else. Pick
the home accordingly: the same home you drive interactively is fine for yourself, and is not a
safe home for strangers.

## Step 1. Turn on the agent's serve

On the agent's computer, with its key in the environment:

```bash
DD_SERVE_KEY=<a long random value> ariadne --serve 127.0.0.1:8642 --home ~/ariadne
```

`--serve` binds loopback only, answers `/health` and `/v1/models`, and needs the exact header
`Authorization: Bearer <DD_SERVE_KEY>` on `/v1/chat/completions`. Check from the same computer:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8642/health          # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8642/v1/chat/completions \
  -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'   # 401 without the key
```

One serve answers **one turn at a time**: a second call while a turn is running is answered
with 409, and Parallax waits and retries rather than dropping the message. That is why the
shared-endpoint setup is best for a single operator, and a lane per chat (Step 5) is better
when several people chat at once.

## Step 2. Make the two secrets on the Parallax side

Parallax needs the agent's serve key, and the agent needs a token to call Parallax back.
Keep both in files, not in your shell history:

```bash
mkdir -p deploy/run/engine && chmod 700 deploy/run/engine
( umask 077
  openssl rand -hex 32 > deploy/run/engine/engine.token     # the agent uses this to call Parallax
  openssl rand -hex 32 > deploy/run/engine/ariadne.key      # the bearer the serve expects
  echo "Ariadne" > deploy/run/engine/name.txt               # the name members see
)
```

`deploy/run/` is ignored by git.

`ariadne.key` is the serve's `DD_SERVE_KEY`, and who sets it depends on Step 5:

- **Shared endpoint** (`ARIADNE_URL`): you start the serve yourself, so the key has to be in its
  environment -- `DD_SERVE_KEY="$(cat deploy/run/engine/ariadne.key)" ariadne --serve ...`.
- **One lane per chat** (`ARIADNE_PER_CHAT=1`): Parallax starts each serve and passes that value
  as `DD_SERVE_KEY` in the lane's environment. You never set it; the file is the shared secret.

## Step 3. Let the two reach each other

Parallax calls the agent, and the agent calls Parallax back. Pick the case that fits.

### A. Same computer (simplest)

Run Parallax on the same machine the agent lives on. Everything stays on `127.0.0.1`:

| | Address |
|---|---|
| Parallax → agent (`ARIADNE_URL`) | `http://127.0.0.1:8642` |
| agent → Parallax (the MCP `url`) | `http://127.0.0.1:3000/api/super/mcp` |

```bash
echo "http://127.0.0.1:8642" > deploy/run/engine/url.txt
```

To open the app to a browser, put a public URL in front of Parallax's port (3000) — a
reverse proxy, a tunnel, or the public URL your computer service gives you — and write
that address to `deploy/run/origin.txt`, for example `https://your-link.example`. Leave
port 8642 private.

### B. Two machines (Parallax here, the agent somewhere else)

Neither side needs a port open to the internet. One SSH connection carries both directions.

1. Give the agent's machine an SSH endpoint you control: your own host, a VPS, or the
   `enable computer SSH` call of a computer service, with a key made for this purpose.
   A service may need to restart the machine to turn SSH on, which interrupts the
   agent, so pick a quiet moment.
2. Write `deploy/run/engine/ssh.conf` on the Parallax machine:
   ```
   Host agent
    HostName <host you point at>
    Port <port you point at>
     User root
     IdentityFile /absolute/path/to/deploy/run/engine/id_ed25519
     UserKnownHostsFile /absolute/path/to/deploy/run/engine/known_hosts
     IdentitiesOnly yes
   ```
3. Open the pipe and check it:
   ```bash
   deploy/tunnel.sh start
   deploy/tunnel.sh status      # process: yes, Parallax -> agent: yes
   ```

| | Address |
|---|---|
| Parallax → agent (`ARIADNE_URL`) | `http://127.0.0.1:18642` (the default, nothing to write) |
| agent → Parallax (the MCP `url`) | `http://127.0.0.1:13100/api/super/mcp` |

`tunnel.sh` reads `PORT` if Parallax is not on 3000. "agent -> Parallax" turns to yes once
Parallax is running (step 5).

## Step 4. Give the agent Parallax's tools

Copy `deploy/add-parallax-to-ariadne.py` and `engine.token` to the agent's computer and run
it there:

```bash
python3 add-parallax-to-ariadne.py --token-file ./engine.token \
  --url http://127.0.0.1:13100/api/super/mcp      # case B; use port 3000 for case A
rm ./engine.token
```

It adds this to the agent's `config.yaml`, keeps a dated copy of the old file, and refuses to
write if any other setting would change. `--dry-run` checks without writing; `--remove` takes
it out again.

```yaml
mcp_servers:
  parallax:
    enabled: true
    transport: http
    url: "http://127.0.0.1:13100/api/super/mcp"
    headers:
      Authorization: "Bearer <engine token>"
    timeout: 2100          # seconds; Ariadne's default of 60 cuts a render off mid-flight
    max_bytes: 4000000     # Ariadne's default of 1 MiB is smaller than some results
    instructions: verbatim   # Parallax's own protocol text (the media order, the turn key) reaches the model as written; the default folds a server's instructions into Ariadne's retrieval contract and would drop them
```

and, unless you pass `--no-always-load`, the Supercomputer's tools under the top-level
`tool_search.always_load`. Ariadne keeps MCP tools out of the prompt until `find()` or
`tool_search()` loads them; that list is what puts `generate_media`, `quote` and `ask_user` in
front of the model every turn. The names are the ones Parallax's endpoint offers, unprefixed --
Ariadne registers a server's tools under the names that server lists, and `parallax` is the
toolset they are grouped under, not part of the name. **Ariadne reads `config.yaml` once at
boot, so restart the agent after this edit.**

## Step 5. Start Parallax on the Ariadne engine

```bash
npm run build
deploy/start.sh mock        # sample files, spends nothing. Drop "mock" for real generations.
```

The last line names the engine. It reads `chat engine: Ariadne (Ariadne)` for a shared endpoint,
and `chat engine: Ariadne (Ariadne, one serve per chat under <home>)` when
`deploy/run/engine/home.txt` exists. `start.sh` switches engines by itself when that folder holds
both secret files; an empty file named `off` in it switches back, and a missing or too-short
secret falls back with a line in `deploy/run/server.log` naming what is missing.

Not using the deploy scripts? These are the settings (`.env.local` or the environment):

```bash
SUPER_ENGINE=ariadne
ARIADNE_URL=http://127.0.0.1:8642
ARIADNE_API_KEY_FILE=/absolute/path/to/ariadne.key
SUPER_ENGINE_TOKEN_FILE=/absolute/path/to/engine.token
SUPER_ENGINE_NAME=Ariadne
```

### One lane per chat, instead of one shared agent

By default every chat talks to the same serve, and Parallax carries each chat's history in the
message. Set `ARIADNE_PER_CHAT=1` and Parallax starts a serve of its own for each chat:

```bash
ARIADNE_PER_CHAT=1
ARIADNE_HOME=/absolute/path/to/agent-home      # the home whose config.yaml every lane is built from
ARIADNE_BIN=ariadne                            # the binary to start
ARIADNE_DISABLE_TOOLS=run_terminal,write_file,edit_file,list_dir,read_file
```

Each lane gets a folder of its own: `<ARIADNE_HOME>/lanes/<chat-id>/`, with a `config.yaml` in it
that is the engine home's config plus Parallax's `mcp_servers.parallax` entry. Ariadne makes the
folder a config file lives in its home, so the lane's tape, its logs and the agent's own memory
are written there and nowhere else — two chats cannot read each other's thread, which is the
whole reason for lanes. `skills/` and `rules/` are symlinked in from the engine home rather than
copied, and the lane's stderr goes to `serve.log` beside its config. A lane never edits the
engine's own config.yaml.

Each lane is started as `ariadne --config <that config> --serve 127.0.0.1:<port>` on a loopback
port from `ARIADNE_PORT_BASE` (8643). Parallax waits for `/health`, keeps the lane for that chat,
and closes it when the chat is deleted, after `ARIADNE_LANE_IDLE_MIN` (20) minutes of quiet, or
when `ARIADNE_MAX_LANES` (8) is reached, oldest first. A lane gets its own `DD_SERVE_KEY` and
`DD_HOME`, plus `DD_DISABLE_TOOLS`; it is not given Parallax's keys. The agent holds the thread,
so no history block is sent and deleting the chat really removes it. The lane folders are
Parallax's to create; they hold conversation content, so keep `ARIADNE_HOME` private.

## Worked example: one machine, lanes, a real agent

This is what a same-machine deployment looks like when it works, on a host running a local
served model. It was run exactly as written below, end to end.

```bash
deploy/start.sh mock
# started, pid ..., port 3000, mode mock,
# chat engine: Ariadne (Ariadne, one serve per chat under .../run/engine-home)
```

Send one message to a new chat. The lane starts, and the serve boots with every server the home
carries plus Parallax's tools (10 in mock mode; `computer_*` and the connector tools
join only when those services are live):

```
run/engine-home/lanes/sch_.../
  config.yaml   0600  the home's config + mcp_servers.parallax
  serve.log     ariadne serve: http://127.0.0.1:8643 · Architect · 96 tools · bearer token required
  state/ cache/ logs/ learn/      the lane's own tape, memory and logs -- nothing else sees them
```

A real turn in **Ask** mode, message *"Make me a poster of a lighthouse at dusk, 16:9. Ask me
first."*, answered by the member as the cards arrive:

```
tool      list_models   done     Listed 8 models
card      question      pending  Before I generate -- what look do you want for the poster?
                          answered with { "choice": "16:9" }
tool      get_model     done     Read Nano Banana Pro
card      question      pending  Ratio locked to 16:9. One more: which look?
                          answered with { "choice": "typographic" }
tool      generate_media running
card      approval      pending  price 4200 credits
                          approved with { "decision": "allow" }
card      result        succeeded  ast_HGV7UtxndDxs2ylN   model nano-banana-pro
tool      remember      done     Saved to memory
message   assistant     Done -- a 16:9 dusk poster, generated on Nano Banana Pro at 2K.
```

Nothing about the generation key reached the agent: the price came from Parallax's quote, the
charge hit the member's own balance, and the file went into their library.

Three things this machine taught, all documented above and worth checking on your own:

- **A local served model is slow.** One step took minutes, so a turn with several tool calls can
  pass the 5-minute `SUPER_TURN_MS` and end with `time_limit`. Raise it (`deploy/run/env`) for a
  lane on a local model; the setting is honoured up to a 30-minute ceiling.
- **`always_load` is what makes the tools reachable.** Without it the agent answered "there is no
  remember tool in my tool list": the tools existed, they were just behind `find()`.
- **A served model can hand a call back as text.** When it does, nothing runs. Parallax hides the
  markup and says so (`notice:tool_markup`); the wire only runs a call that arrives as structured
  `tool_calls`. The notes Parallax sends name the tools exactly as the wire offers them
  (`generate_media`, never `parallax_generate_media`), which is what stops a model from inventing
  a name and writing the call out by hand.

## Step 6. Try it

1. Open `/supercomputer` and send: *"Make me a poster of a lighthouse at dusk."*
2. The model pill should show your agent's name once the chat exists.
3. The agent should call `generate_media`. You get an approval card with the price.
4. Approve. The picture appears in the chat and in your library.

## When it does not work

| What you see | Likely cause |
|---|---|
| The server log says an Ariadne setting is missing, and the chat is the scripted stand-in | A secret file is empty or missing, or the token is shorter than 24 characters. Parallax falls back to the built-in engine. |
| The reply fails at once | `ARIADNE_URL` is wrong, the serve is off, or the tunnel is down (`deploy/tunnel.sh status`). The server log has the reason. |
| "The engine did not accept our key." | `ariadne.key` is not the serve's `DD_SERVE_KEY`. Ariadne compares the whole header against `Bearer <key>`, so a stray space fails. |
| The agent answers but never makes anything | The `parallax` MCP entry is missing, or its `url` does not reach Parallax from the agent's computer. Try `curl -s -o /dev/null -w '%{http_code}' <url>` there: 401 means it reaches Parallax (no token sent), anything else means it does not. |
| The agent says it has no Parallax tools | The entry is there but the tools are behind `find()`. Run `add-parallax-to-ariadne.py` without `--no-always-load`, and restart the agent — `config.yaml` is read once at boot. |
| 401 in the agent's MCP log | The token in `config.yaml` is not the one in `engine.token`. |
| 404 from `/api/super/mcp` | Parallax is running the built-in engine. |
| A long render is cut off | `timeout` in the MCP entry is too low. Ariadne's default is 60 seconds; keep it above 2100. |
| A reply starts with "the conversation is still working" | Another chat is using the same serve. Serve one lane per chat (`ARIADNE_PER_CHAT=1`), or send one chat at a time. |
| "This reply took too long and was stopped." (`time_limit`) | A turn ran past `SUPER_TURN_MS` (5 minutes of working time, not counting waits for you). A local served model can take minutes *per step*, so a four-step turn does not fit. Raise it in `deploy/run/env` or `.env.local`: `SUPER_TURN_MS=1800000`. |
| The member sees raw `<tool_call>` / `<toolcall>` XML | The serving layer handed the model's call back as text instead of structured `tool_calls`, so nothing ran. Parallax hides the markup and says the tool did not run (`notice:tool_markup`); if you still see markup, that shape is not covered -- report it. |

## What the agent can and cannot do in Parallax

Offered: `generate_media`, `list_models`, `get_model`, `quote`, `search_library`,
`get_asset`, `remember`, `recall`, `ask_user`, `schedule_chat`. Every call runs as the
member who sent the message, so it uses their credits and their library.

Not offered: Parallax's connected apps (the agent has its own), and the `computer_*` tools
unless Parallax's own computer service is live (`SUPER_MODE=live` with `COMPUTER_API_KEY`).

The technical reference is the "Engines" section of [`docs/api/super.md`](api/super.md).

## Next steps, if you want to build on this

- **Run it against a live agent on your own machine and report back.** The loop has been
  proven here against a local serve; the remote pairing has not.
- **A one-command setup.** A script that makes the secrets, opens the SSH endpoint,
  writes `ssh.conf`, and runs the config script on the agent.
- **A ready-made narrow agent.** An Ariadne home with `DD_DISABLE_TOOLS` and nothing personal,
  for public deployments.
- **Our own encapsulated OS.** One image we build and control: Parallax and an Ariadne
  agent already joined inside it, the computer service on `127.0.0.1:8081` serving the
  REST shape in [`docs/computer-service.md`](computer-service.md), and the whole thing
  deployed as one unit. That replaces the vendor template, and it is the path to an
  instant deploy on any machine.
- **Per-member agents.** Today every member talks to the same agent, or to a lane that dies
  with the chat. One machine per member would give each their own workspace.
- **Show the agent's own steps in full.** Today its own tools appear as a name only.
- **Connectors through the agent.** Let approval cards cover the agent's own app actions.
