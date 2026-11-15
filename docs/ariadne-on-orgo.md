# Supercomputer on an Ariadne agent, on Orgo

Supercomputer is Parallax's agent chat. Out of the box it answers with a scripted stand-in
(`SUPER_MODE=mock`). This guide swaps in a real agent: an **Ariadne** agent serving
`/v1/chat/completions` runs the conversation, and Parallax gives it the studio's tools.

```
member ──▶ Parallax ──POST /v1/chat/completions (stream)──▶ Ariadne agent (on an Orgo computer)
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
- An Orgo computer for the agent to live on (any Linux machine works the same way).
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
  cat > deploy/run/engine/ariadne.key                       # paste DD_SERVE_KEY, Enter, Ctrl-D
  echo "Ariadne" > deploy/run/engine/name.txt               # the name members see
)
```

`deploy/run/` is ignored by git.

## Step 3. Let the two reach each other

Parallax calls the agent, and the agent calls Parallax back. Pick the case that fits.

### A. Same computer (simplest)

Run Parallax on the Orgo computer the agent lives on. Everything stays on `127.0.0.1`:

| | Address |
|---|---|
| Parallax → agent (`ARIADNE_URL`) | `http://127.0.0.1:8642` |
| agent → Parallax (the MCP `url`) | `http://127.0.0.1:3000/api/super/mcp` |

```bash
echo "http://127.0.0.1:8642" > deploy/run/engine/url.txt
```

To open the app to a browser, make an Orgo public URL for Parallax's port (3000) and write
that address to `deploy/run/origin.txt`, for example `https://your-link.example`. Leave
port 8642 private.

### B. Two computers (Parallax here, the agent on Orgo)

Neither side needs a port open to the internet. One SSH connection carries both directions.

1. Turn on **Direct SSH** for the agent's Orgo computer (dashboard, or the
   `enable computer SSH` API call) with a key made for this purpose. Orgo may ask for a
   restart of the computer, which interrupts the agent, so pick a quiet moment.
2. Write `deploy/run/engine/ssh.conf` on the Parallax machine:
   ```
   Host agent
     HostName <host Orgo gives you>
     Port <port Orgo gives you>
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

The last line should end with `chat engine: Ariadne (Ariadne)`. `start.sh` switches engines by
itself when `deploy/run/engine/` holds both secret files; an empty file named `off` in that
folder switches back.

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

## What the agent can and cannot do in Parallax

Offered: `generate_media`, `list_models`, `get_model`, `quote`, `search_library`,
`get_asset`, `remember`, `recall`, `ask_user`, `schedule_chat`. Every call runs as the
member who sent the message, so it uses their credits and their library.

Not offered: Parallax's connected apps (the agent has its own), and the `computer_*` tools
unless Parallax's own cloud computer is live (`SUPER_MODE=live` with an Orgo key).

The technical reference is the "Engines" section of [`docs/api/super.md`](api/super.md).

## Next steps, if you want to build on this

- **Run it against a live agent on Orgo and report back.** The loop has been proven here
  against a local serve; the remote pairing has not.
- **A one-command setup.** A script that makes the secrets, enables Direct SSH through the
  Orgo API, writes `ssh.conf` and runs the config script on the agent.
- **A ready-made narrow agent.** An Ariadne home with `DD_DISABLE_TOOLS` and nothing personal,
  for public deployments.
- **An Orgo template.** One computer image with Parallax and an Ariadne agent already joined.
- **Per-member agents.** Today every member talks to the same agent, or to a lane that dies
  with the chat. One Orgo computer per member would give each their own workspace.
- **Show the agent's own steps in full.** Today its own tools appear as a name only.
- **Connectors through the agent.** Let approval cards cover the agent's own app actions.
