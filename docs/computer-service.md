# The computer the agent works on

Supercomputer's `computer_*` tools (`src/server/super/computer.ts`) drive one machine per
member: created on first use, suspended when idle. Under `SUPER_MODE=mock` nothing is real —
a stand-in echoes commands and draws a small PNG. Under `SUPER_MODE=live` Parallax calls a
**computer service over REST**. It is a service you run yourself; nothing in this repo talks
to a third-party host any more.

```
COMPUTER_API_BASE_URL   default http://127.0.0.1:8081/api
COMPUTER_API_KEY        bearer, sent as Authorization: Bearer <key>
COMPUTER_WORKSPACE_ID   optional; otherwise the service's first workspace is used
```

The error rule is deliberate: Parallax branches on the JSON `code` field and never logs the
body, because a body can echo request details.

## The calls Parallax makes

| Call | Shape |
|---|---|
| `GET /workspaces` | `[{id}]` or `{workspaces:[{id}]}` |
| `POST /computers` | body `{workspace_id, name, os:"linux", ram, cpu, resolution}` → `{id}`; may take minutes |
| `PATCH /computers/<id>/resize` | body `{auto_stop_minutes}`; best-effort, failures ignored |
| `POST /computers/<id>/resume` | no response body needed; may take minutes |
| `POST /computers/<id>/suspend` | — |
| `GET /computers/<id>/screenshot?response_format=base64&format=png` | `{image, width, height}` |
| `POST /computers/<id>/click` | `{x, y, button, double}` |
| `POST /computers/<id>/type` | `{text}` — long text is sent in 1500-character pieces |
| `POST /computers/<id>/key` | `{key}` |
| `POST /computers/<id>/scroll` | `{x, y, direction:"up"|"down", amount}` |
| `POST /computers/<id>/bash` | `{command, timeout}` → `{output, exit_code}` |

Anything that answers those eleven routes with those shapes is a valid backend. Timeouts:
180s for create and bash, 120s for resume, 60s for everything else.

## What our own image answers

The deployment unit is one encapsulated OS image that runs Parallax, an Ariadne agent, and
this service on `127.0.0.1:8081` — so `COMPUTER_API_BASE_URL` never has to point anywhere
else and a machine is the whole product. The natural mapping inside that image:

- `create` / `resume` / `suspend` → a container or a namespace started and stopped on demand;
  `auto_stop_minutes` maps to the image's own idle reaper (Parallax also suspends on its side,
  at `SUPER_COMPUTER_IDLE_MIN`).
- `bash` → a shell inside that container, working directory jailed to the member's box,
  `timeout` enforced by the service rather than trusted to the caller.
- `screenshot` → whatever the framebuffer or X server inside the container holds, encoded PNG.
- `click` / `type` / `key` / `scroll` → injected into that display.

Two rules the backend must not skip: the key is checked per request, and one member's machine
is never reachable through another member's id. Parallax keeps the id↔member mapping in its
own database (`super_computers`), but the service is the thing that enforces isolation.

## Where it plugs in

`computerClient()` in `src/server/super/computer.ts` is the seam: one class implements
`ComputerClient` (create, resume, suspend, screenshot, click, type, key, scroll, bash), the
mock implements the same interface, and `serviceMode("computer")` chooses between them by the
presence of `COMPUTER_API_KEY`. Point `COMPUTER_API_BASE_URL` at our image and the studio's
`computer_*` tools run on it unchanged.
