#!/usr/bin/env bash
# Runs the built Parallax app in the background, so it survives your terminal closing.
#
#   deploy/start.sh         real generations (TREG_TOKEN in .env.local, with its daily budget)
#   deploy/start.sh mock    free sample files instead of real generations
#
# Build first: npm ci && npm run build
#
# Everything this script keeps lives in deploy/run/ (ignored by git):
#   data/          the database and the files people make
#   server.log     the log
#   env            optional extra settings, one NAME=value per line
#   origin.txt     optional: the public https address, if the app sits behind a link or proxy
#   engine/        optional: run Supercomputer on an Ariadne agent (see docs/ariadne-agent.md)
#     ariadne.key      the bearer the Ariadne serve endpoint expects (empty when it runs on
#                      loopback with no key; absent when the endpoint has no key)
#     engine.token     the token the agent uses to call Parallax's tools
#     name.txt         the name members see (default: Ariadne)
#     url.txt          where the agent's API is (default: http://127.0.0.1:8642, the port
#                     `ariadne --serve 127.0.0.1:8642` listens on; tunnel.sh's local end is 18642)
#     home.txt         an Ariadne HOME directory (config.yaml + .env). With it, Parallax starts ONE
#                     `ariadne --serve` per chat from that home's config.yaml, each in its own lane
#                     under <home>/lanes/<chat-id>/ (config.yaml 0600, serve.log, tape, agent
#                     memory) -- the default in this deployment. Parallax adds its own MCP entry to
#                     each lane's config, so the home's config.yaml does not need one. Without it
#                     the app talks to url.txt, which holds ONE conversation for every chat.
#     bin.txt          the ariadne binary (default: ariadne on PATH)
#     port_base.txt    first port the lanes listen on (default: 8643; lane N takes the next
#                      free one). Keep it clear of the port a serve you start yourself binds.
#     off              an empty file with this name turns the engine off
#
# PORT (default 3000) and BIND (default 0.0.0.0) can be set when calling the script.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
RUN_DIR="$DEPLOY_DIR/run"
PORT="${PORT:-3000}"
BIND="${BIND:-0.0.0.0}"

if [ ! -d "$APP_DIR/.next" ]; then echo "not built yet: run npm ci && npm run build"; exit 1; fi
mkdir -p "$RUN_DIR"
"$DEPLOY_DIR/stop.sh" > /dev/null 2>&1 || true

# A clean environment: the only keys the server can see are the ones in .env.local and the
# files named below. SUPER_MODE stays mock unless deploy/run/env says otherwise, so
# Supercomputer cannot start cloud computers or connect outside apps by accident.
vars=(
  "PATH=$PATH" "HOME=$HOME" "NODE_ENV=production"
  "PARALLAX_DATA_DIR=$RUN_DIR/data"
  "SUPER_MODE=mock"
)
if [ -s "$RUN_DIR/origin.txt" ]; then
  origin="$(tr -d ' \n\r' < "$RUN_DIR/origin.txt")"
  vars+=("PARALLAX_ORIGIN=$origin")
  case "$origin" in https://*) vars+=("COOKIE_SECURE=1") ;; esac
fi
if [ "${1:-}" = "mock" ]; then vars+=("TREG_MODE=mock"); fi

ENGINE_DIR="$RUN_DIR/engine"
engine="built-in"
if [ -s "$ENGINE_DIR/engine.token" ] && [ ! -e "$ENGINE_DIR/off" ]; then
  url="http://127.0.0.1:8642"
  if [ -s "$ENGINE_DIR/url.txt" ]; then url="$(tr -d ' \n\r' < "$ENGINE_DIR/url.txt")"; fi
  name="Ariadne"
  if [ -s "$ENGINE_DIR/name.txt" ]; then name="$(head -n 1 "$ENGINE_DIR/name.txt")"; fi
  vars+=(
    "SUPER_ENGINE=ariadne" "ARIADNE_URL=$url" "SUPER_ENGINE_NAME=$name"
    "SUPER_ENGINE_TOKEN_FILE=$ENGINE_DIR/engine.token"
  )
  # A serve endpoint on loopback with no key needs no bearer; a path that is not there is not a key.
  if [ -s "$ENGINE_DIR/ariadne.key" ]; then vars+=("ARIADNE_API_KEY_FILE=$ENGINE_DIR/ariadne.key"); fi
  engine="$name (Ariadne)"
  # A HOME turns it into lanes: Parallax starts one `ariadne --serve` per chat from that home's
  # config.yaml, each with its own home under lanes/<chat-id>/. One serve holds one conversation,
  # so two chats that share one endpoint share its thread -- which is the reason this exists.
  if [ -s "$ENGINE_DIR/home.txt" ]; then
    home="$(tr -d ' \n\r' < "$ENGINE_DIR/home.txt")"
    vars+=("ARIADNE_PER_CHAT=1" "ARIADNE_HOME=$home")
    if [ -s "$ENGINE_DIR/bin.txt" ]; then vars+=("ARIADNE_BIN=$(tr -d ' \n\r' < "$ENGINE_DIR/bin.txt")"); fi
    if [ -s "$ENGINE_DIR/port_base.txt" ]; then vars+=("ARIADNE_PORT_BASE=$(tr -d ' \n\r' < "$ENGINE_DIR/port_base.txt")"); fi
    engine="$name (Ariadne, one serve per chat under $home)"
  fi
fi

# Extra settings last, so they can override the defaults above.
# A key named twice is refused rather than silently resolved by position: a leftover
# SD_CPP_BIN=/tmp/stub-sd/sd-cli further down this file once turned every real render into a
# 1x1 stub that the app stored as the member's picture.
if [ -s "$RUN_DIR/env" ]; then
  seen=" "
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    case "$seen" in
      *" $key "*) echo "run/env names $key twice: keep one line"; exit 1 ;;
    esac
    seen="$seen$key "
    vars+=("$line")
  done < "$RUN_DIR/env"
fi

cd "$APP_DIR"
setsid nohup env -i "${vars[@]}" node node_modules/next/dist/bin/next start -H "$BIND" -p "$PORT" \
  >> "$RUN_DIR/server.log" 2>&1 < /dev/null &
echo $! > "$RUN_DIR/server.pid"
echo "started, pid $(cat "$RUN_DIR/server.pid"), port $PORT, mode ${1:-live}, chat engine: $engine"
