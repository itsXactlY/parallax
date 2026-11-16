<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## The Supercomputer engine

`/supercomputer` can run on three things: a scripted stand-in (default), Parallax's own loop
(`SUPER_MODE=live`), or an Ariadne agent (`SUPER_ENGINE=ariadne`). The Ariadne engine starts one
`ariadne --serve` per chat under `ARIADNE_HOME/lanes/<chat-id>/` and serves the studio's tools to
it over MCP at `/api/super/mcp`. Read `docs/api/super.md` (Engines) and
`docs/ariadne-on-orgo.md` before changing `src/server/super/ariadne.ts`.

Two rules that are easy to break:

- Ariadne registers an MCP server's tools under the names that server lists, so Parallax's tools
  arrive bare (`generate_media`, `remember`). A model only runs a call that arrives as structured
  `tool_calls`; a call it writes as text markup never runs.
- `python3 tests/run.py tests/super_ariadne.py` proves the engine against a stand-in agent with
  every key stripped from the environment. `npm test` does the same for the whole app.
