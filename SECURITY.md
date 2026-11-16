# Security

Parallax is young software. Treat it as a starting point, not a hardened service.

**Reporting a problem.** Please do not open a public issue for a security problem. Use
GitHub's "Report a vulnerability" button on this repository (Security tab), and include the
steps to reproduce it.

**Before you put it on the internet**

- Serve it over HTTPS and set `COOKIE_SECURE=1` and `PARALLAX_ORIGIN`.
- Set `TREG_DAILY_BUDGET_USD`. It caps what the server can spend in a day.
- Payments are not connected. Credits are granted by the app itself; do not sell them.
- If Supercomputer runs on an Ariadne agent, read the warning in
  [`docs/ariadne-on-orgo.md`](docs/ariadne-on-orgo.md): the agent's own tools are not behind
  Parallax's approval cards. Use a narrow agent for anything public.
  With `ARIADNE_PER_CHAT=1` each lane keeps its own conversation, logs and agent memory under
  `ARIADNE_HOME/lanes/<chat-id>/`, and its config file holds the engine token. Keep that
  directory private (mode `0700`/`0600`) and delete it when you delete the chat.
- Keys live in `.env.local` or in files named by `*_FILE` settings. Never commit them. The
   engine's two secrets are `deploy/run/engine/engine.token` (what the agent sends to
   `POST /api/super/mcp`) and `ariadne.key` (what Parallax sends to the agent). Keep the folder
   `0700` and each file `0600`. `deploy/run/` and `run/` are git-ignored, so neither the secrets
   nor a lane's conversation ever gets committed.
- **A lane inherits the engine home's MCP servers.** A lane's `config.yaml` is the home's config
  plus Parallax's entry, so whatever `mcp_servers` that home carries -- a shell-capable tool
  pack, a memory graph, a research pod -- is offered to every chat. Parallax disables Ariadne's
  own shell and file tools (`ARIADNE_DISABLE_TOOLS`), but nothing else. For a deployment other
  people can open, use a home whose servers are the ones you are willing to expose.
- **The engine token is a spending credential**, not a read-only key: hold it and you can call
  `generate_media` and charge the member's balance. Every call also carries a turn key the engine
  minted for its own turn, so a captured call cannot be replayed or aimed at another chat.
  `GET /api/super/config` is a signed-in member's view; there is no public health endpoint.
- **Adding Parallax to an interactive agent's config is a real capability grant.**
  `deploy/add-parallax-to-ariadne.py` puts the studio's tools in front of the model every turn
  (`tool_search.always_load`). Anyone driving that agent can then spend the credits of whoever
  holds a Parallax session. Do not add the entry to a config you run for someone else without
  meaning that.
