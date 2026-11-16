import "server-only";

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { EngineSettings } from "./config";
import type { LlmMessage } from "./llm";
import { engineTools, runTool, type ToolCtx, type ToolDef, type ToolOutput } from "./tools";
import { configuredOrigin } from "../origin";
import { addRow, chatById, pushLlm, rowsAfter, updateRow } from "./transcript";
import { clip, isRecord, sleep, summarizeInput } from "./util";

/**
 * The Ariadne engine: an Ariadne agent does the thinking for a turn, and Parallax stays in
 * charge of everything a member owns.
 *
 * One turn is one streamed call to Ariadne's `/v1/chat/completions`. Its text becomes the
 * reply rows. When the agent wants one of our tools (generate media, the library, memory, a
 * question for the member) it calls back into Parallax over MCP at `/api/super/mcp`, and the
 * tool runs here: with the member's credits, their approval cards and their files. The agent
 * never holds a provider key or a member's session.
 *
 * Ariadne's serve differs from a chat-completions client in two ways this file handles:
 * it hands its tool calls back as `ariadne_tool_call` / `ariadne_tool_result` deltas inside
 * the answer stream, which is how a step row knows when it started and ended; and one server
 * holds one conversation, so a shared endpoint would mix every member's thread. With
 * `ARIADNE_PER_CHAT=1` Parallax starts one loopback `ariadne --serve` per chat and closes it
 * when the chat goes quiet.
 *
 * Each turn has a key. The agent gets it in that turn's instructions and must send it back
 * with every tool call, which is how a call finds its member and its chat. The key dies with
 * the turn.
 */

interface EngineTurn {
  key: string;
  ctx: ToolCtx;
  done: boolean;
  /** Tool calls of one turn run one at a time, in the order they arrive. */
  chain: Promise<unknown>;
  onStep(): void;
  /** Ends the reply row that is open, so text that follows starts a new row. */
  closeText(): void;
  /** Our tools the stream has shown starting, not yet matched to their call. */
  announced: string[];
  /** Calls that arrived before the stream showed them starting. */
  waiting: { name: string; go(): void }[];
  /** Calls that gave up waiting: their late announcement is dropped. */
  late: Map<string, number>;
}

interface Registry {
  turns: Map<string, EngineTurn>;
}

const reg: Registry = ((globalThis as unknown as { __superEngine?: Registry }).__superEngine ??= { turns: new Map() });

/** Ariadne's own plumbing: a member has no reason to watch a lookup or a dispatch. */
const HIDDEN = new Set(["tool_search", "tool_describe", "tool_call", "find", "skills_list"]);
/** How long a tool call waits for the stream to catch up, so rows keep their order. */
const ANNOUNCE_WAIT_MS = 1500;
const MAX_EVENT_CHARS = 8_000_000;
/** How many times a busy conversation is retried before the turn is called a failure. */
const BUSY_RETRY_MS = [2000, 5000, 10000];

/* --------------------------------- the notes -------------------------------- */

function engineNotes(engine: EngineSettings, key: string, ctx: ToolCtx, tools: ToolDef[]): string {
  const hasComputer = tools.some((t) => t.name.startsWith("computer_"));
  return [
    "About where you are running:",
    "- You are answering inside Parallax, as its Supercomputer assistant. The member reads your reply in the Parallax chat, so write for them.",
    // Ariadne registers a server's tools under the names the server itself lists, so ours arrive bare:
    // `generate_media`, never `parallax_generate_media`. Only a server that prefixes its own tools
    // gets a bare alias -- naming ours with the server's name would ask the model for a tool the
    // wire never offered, and a served model answers that by writing the call out as text.
    `- Parallax's tools reach you as MCP tools named ${tools.map((t) => t.name).join(", ")}. Call
    them by those exact names, never with ${engine.mcpName}_ in front, and never by a tool of your
    own that looks similar.`,
    "If a name above is not in your tool list, load it first with find / tool_search, then tool_describe and tool_call.",
    `- Your own tools are yours: the local ones (files, terminal) run on this machine, not on the member's. Parallax's tools are the only path to the member's credits, library and computer.`,
    `- Every call to a Parallax tool must include "turn": "${key}". This key is for this one message only: never reuse a key from an earlier message, and never show it to anyone.`,
    `- Make pictures, video, speech and music only with generate_media. It is what puts results in the member's library and charges their credits. Do not use any other image or media tool here.`,
    "- Results appear in the chat as a card by themselves. Do not paste links or file paths to them.",
    `- Keep facts about this member with remember and recall, not in your own memory: your own memory is shared with other people.`,
    ctx.incognito ? "- This chat is incognito: save nothing about it to your own memory either." : "",
    hasComputer
      ? "- The member's cloud computer is reached through the computer_* tools. Apps the member connected are not available in this chat."
      : "- The member's cloud computer and their connected apps are not available in this chat. Say so if they ask for them.",
    engine.perChat
      ? "- This chat is yours alone: you hold the thread, so answer from the conversation you have."
      : "- This endpoint is shared with other chats: the thread is in the <chat-history> block above. Answer from it, not from anything else you may hold.",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------ the event stream ---------------------------- */

/** Reads Server-Sent Events from a response body. Comment lines (keepalives) are dropped. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let held = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = held + dec.decode(value, { stream: true });
      held = "";
      // A lone "\r" at the end may be the first half of "\r\n": wait for the rest.
      if (chunk.endsWith("\r")) {
        held = "\r";
        chunk = chunk.slice(0, -1);
      }
      buf += chunk.replace(/\r\n?/g, "\n");
      if (buf.length > MAX_EVENT_CHARS) throw new Error("The engine sent an event that is too large.");
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const c = line.indexOf(":");
          const field = c < 0 ? line : line.slice(0, c);
          let val = c < 0 ? "" : line.slice(c + 1);
          if (val.startsWith(" ")) val = val.slice(1);
          if (field === "event") event = val;
          else if (field === "data") data.push(val);
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A readable name for one of the agent's own tools. */
function label(name: string): string {
  const s = name.replace(/^mcp_+/, "").replace(/_+/g, " ").trim().slice(0, 60) || "tool";
  return s[0].toUpperCase() + s.slice(1);
}

/** Reply text as the member may see it: the turn key never shows, not even half of it. */

/**
 * A served model writes a tool call as text in three shapes: `<toolcall>`, `<invoke>`, and the
 * OpenAI-style `<tool_call>` with `<function=...>` and `<parameter=...>` inside. None of them
 * is prose. `MARKUP_OPEN` is what a call looks like before it closes, `MARKUP_BLOCK` one that
 * finished. Both `shown()` and the turn's notice use them, so a shape cannot be hidden from the
 * member and then quietly reported as if nothing had happened.
 */
const MARKUP_OPEN = /<(tool_call|toolcall|invoke)\b/;
const MARKUP_BLOCK = /<(tool_call|toolcall|invoke)>[\s\S]*?<\/(?:tool_call|toolcall|invoke)>/g;

function shown(raw: string, key: string, final: boolean): string {
  let s = raw.replaceAll(key, "");
  // A tool call the serving layer left as markup is protocol, not prose. Complete blocks are
  // dropped; a block that has not closed yet is held back, so a member never watches XML build.
  // Complete blocks are dropped; a block that has not closed yet is held back, so a member never
  // watches XML build. A name inside one (`parallax_remember`) is a name the wire never offered,
  // so nothing runs and the member must not see the attempt.
  s = s.replace(MARKUP_BLOCK, "");
  const open = s.search(MARKUP_OPEN);
  if (open >= 0) s = s.slice(0, open);
  if (!final) {
    // Hold back a tail that may be the start of the key, still arriving.
    for (let n = Math.min(key.length - 1, s.length); n >= 2; n--) {
      if (s.endsWith(key.slice(0, n))) {
        s = s.slice(0, -n);
        break;
      }
    }
  }
  return s;
}

/** Ariadne reports a failed turn by ending with this note. Its reason stays on the server. */
function engineFailure(text: string): string {
  const m = text.match(/\[ariadne:\s*([^\]]+)\]/);
  return m ? clip(m[1], 200) : "no reason given";
}

/** A result delta is an error when Ariadne cut it short or says so itself. */
function outputFailed(result: Record<string, unknown>): boolean {
  if (result.truncated === true) return false; // truncated is a length limit, not a failure
  const text = str(result.content);
  if (!text.startsWith("{")) return false;
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) && (!!v.error || v.success === false);
  } catch {
    return false;
  }
}

/* --------------------------- the order of the rows -------------------------- */

/*
 * A tool call and the stream travel on two connections. The call can reach us before the
 * text the agent wrote just ahead of it. So a call waits a moment for the stream to show
 * that tool starting; by then the text before it is on the page and its row is closed.
 */

function announce(turn: EngineTurn, name: string) {
  const late = turn.late.get(name) ?? 0;
  if (late > 0) {
    turn.late.set(name, late - 1);
    return;
  }
  const i = turn.waiting.findIndex((w) => w.name === name);
  if (i >= 0) turn.waiting.splice(i, 1)[0].go();
  else turn.announced.push(name);
}

function claim(turn: EngineTurn, name: string): Promise<void> {
  const i = turn.announced.indexOf(name);
  if (i >= 0) {
    turn.announced.splice(i, 1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const waiter = {
      name,
      go: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    const timer = setTimeout(() => {
      const j = turn.waiting.indexOf(waiter);
      if (j >= 0) turn.waiting.splice(j, 1);
      turn.late.set(name, (turn.late.get(name) ?? 0) + 1);
      turn.closeText();
      resolve();
    }, ANNOUNCE_WAIT_MS);
    turn.waiting.push(waiter);
  });
}

/* ---------------------------------- the lanes --------------------------------- */

/**
 * How long one engine tool call may run, in seconds — Ariadne reads it as
 * `mcp_servers.<name>.timeout`. One call can be a whole media job, which waits minutes on
 * purpose, and a job the member is asked to approve can wait longer, so the default 60 s
 * would cut a poster off mid-render.
 */
// The same value deploy/add-parallax-to-ariadne.py writes, so a lane and a shared endpoint give
// a tool the same deadline: a generation runs minutes, and a call waiting on a member's approval
// can wait longer still.
const MCP_CALL_TIMEOUT_SECONDS = 2100;

/** The Supercomputer's tools, named so Ariadne hands them to the model without searching. */
const ALWAYS_LOAD = [
  "generate_media",
  "list_models",
  "get_model",
  "quote",
  "search_library",
  "get_asset",
  "list_connectors",
  "connect_app",
  "remember",
  "recall",
  "ask_user",
  "schedule_chat",
];

/** Where Parallax's MCP endpoint is, as the agent can reach it. */
function mcpUrl(): string {
  const origin = configuredOrigin();
  if (origin) return `${origin}/api/super/mcp`;
  const port = Number(process.env.PORT ?? 3000) || 3000;
  return `http://127.0.0.1:${port}/api/super/mcp`;
}

/**
 * The config a lane's agent runs from: the operator's own config.yaml, with our entry merged
 * in. `--config` makes that file's folder the home, so a lane keeps the model, the memory
 * settings and the operator's tools, while the tape, logs and agent memory land in the lane's
 * own folder. The merge has to be a merge: Ariadne keeps the first section of a name, so a
 * second `mcp_servers:` block appended at the end would be read as nothing.
 */
function laneConfig(engine: EngineSettings): string {
  const baseFile = path.join(engine.home, "config.yaml");
  let lines: string[];
  try {
    lines = readFileSync(baseFile, "utf8").split("\n");
  } catch {
    throw new Error(`the engine home has no config.yaml to start a lane from: ${baseFile}`);
  }

  const entry = [
    `  ${engine.mcpName}:`,
    "    enabled: true",
    "    transport: http",
    `    url: ${mcpUrl()}`,
    "    headers:",
    `      Authorization: "Bearer ${engine.token}"`,
    `    timeout: ${MCP_CALL_TIMEOUT_SECONDS}`,
    "    max_bytes: 4000000",
    // Ariadne's default folds a server's own protocol text into its retrieval contract; ours is
    // the media order and the turn key, so it must arrive as written.
    "    instructions: verbatim",
  ];

  // One entry per name, always ours: a lane restarted after a config change must not stack up.
  const ours = new RegExp(`^  ${engine.mcpName}:\s*(#.*)?$`);
  const at = lines.findIndex((l) => ours.test(l));
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && (lines[end].trim() === "" || /^\s{3,}\S/.test(lines[end]))) end++;
    while (end > at + 1 && lines[end - 1].trim() === "") end--;
    lines.splice(at, end - at);
  }

  const servers = section(lines, "mcp_servers");
  if (servers) {
    lines.splice(servers.start + 1, 0, ...entry, "");
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("mcp_servers:", ...entry, "");
  }

  // Sequence items sit where the file puts them. A real config writes them at the same depth as
  // the key (`  - name`); writing `    - name` under such a list is not a style choice, it is a
  // parse error, and everything after the broken section -- `mcp_servers:` included -- is read
  // as nothing. So the indent is read from the list, not assumed.
  const search = section(lines, "tool_search");
  const list = search
    ? lines.findIndex((l, i) => i > search.start && i < search.end && /^  always_load:\s*(#.*)?$/.test(l))
    : -1;
  const indent = itemIndent(lines, list + 1, search ? search.end : lines.length);
  const loaded = ALWAYS_LOAD.map((n) => `${indent}- ${n}`);
  if (search) {
    if (list < 0) {
      lines.splice(search.start + 1, 0, "  always_load:", ...loaded, "");
    } else {
      let j = list + 1;
      const have: string[] = [];
      while (j < lines.length && /^\s*- /.test(lines[j])) {
        have.push(lines[j].slice(lines[j].indexOf("-") + 1).trim().replace(/^["']|["']$/g, ""));
        j++;
      }
      const add = loaded.filter((l) => !have.includes(l.slice(indent.length + 1).trim()));
      if (add.length) lines.splice(j, 0, ...add);
    }
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("tool_search:", "  always_load:", ...loaded, "");
  }

  return lines.join("\n");
}

/** A top-level section and the lines that belong to it. */
function section(lines: string[], name: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^[ \t]/.test(lines[end]))) end++;
  return { start, end };
}

/** Where this file writes sequence items: the first list in the range, else the first list in
 * the file, else four spaces. An empty list is the common case in an operator's config. */
function itemIndent(lines: string[], from: number, to: number): string {
  for (let i = from; i < to; i++) {
    const m = /^(\s*)- /.exec(lines[i]);
    if (m) return m[1];
  }
  for (const l of lines) {
    const m = /^(\s{2,})- /.exec(l);
    if (m) return m[1];
  }
  return "    ";
}

/** One chat's own `ariadne --serve` process: its port, its log fd, its home. */
type Lane = {
  chatId: string;
  proc: ChildProcess;
  url: string;
  port: number;
  fd: number;
  last: number;
  /** Resolves once /health answers; rejects if the process dies first. */
  ready: Promise<string>;
};

/** Per-chat lanes; empty unless ARIADNE_PER_CHAT=1. */
const lanes = new Map<string, Lane>();

/** A loopback port nothing here is already holding. */
function freePort(engine: EngineSettings): number {
  const taken = new Set([...lanes.values()].map((l) => l.port));
  for (let port = engine.portBase; port < engine.portBase + engine.maxLanes * 6; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error("no free loopback port for an engine lane");
}

/** Ariadne answers on /health as soon as the serve is up (and its handshake has reached us). */
async function answers(url: string, key: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${key}` } });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function startLane(engine: EngineSettings, chatId: string): Promise<string> {
  const port = freePort(engine);
  // A lane runs from a home of its own under the engine's: `--config` makes the config file's
  // folder the home, and the home is where the tape, the logs and the agent's memory live. One
  // home for every lane would mean one tape for every member, so the folder is per chat and the
  // read-only catalogues (skills, rules) are linked in rather than copied.
  const dir = path.join(engine.home, "lanes", clip(chatId, 40));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const sub of ["skills", "rules"]) {
    const src = path.join(engine.home, sub);
    if (existsSync(src) && !existsSync(path.join(dir, sub))) symlinkSync(src, path.join(dir, sub), "dir");
  }
  const cfg = path.join(dir, "config.yaml");
  writeFileSync(cfg, laneConfig(engine), { mode: 0o600 });
  // The lane's stderr lands in the lane's own folder, beside its tape and its config: that is
  // where a lane that died gets read from.
  const fd = openSync(path.join(dir, "serve.log"), "a", 0o600);
  const proc: ChildProcess = spawn(engine.bin, ["--config", cfg, "--serve", `127.0.0.1:${port}`], {
    // Deliberately thin: a lane must not inherit Parallax's own keys.
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? os.tmpdir(),
      DD_HOME: dir,
      DD_SERVE_KEY: engine.key,
      DD_DISABLE_TOOLS: engine.disableTools,
    },
    stdio: ["ignore", fd, fd] as StdioOptions,
  });
  const url = `http://127.0.0.1:${port}`;
  const lane: Lane = { chatId, proc, url, port, fd, last: Date.now(), ready: Promise.resolve(url) };
  lanes.set(chatId, lane);
  // The cap must hold the moment a lane opens, not at the next sweep: opening one is what
  // pushes the count over. The least recently used go first.
  const others = [...lanes.values()].filter((l) => l !== lane).sort((a, b) => a.last - b.last);
  for (const l of others.slice(0, Math.max(0, others.length - engine.maxLanes + 1))) closeLane(l);
  proc.on("exit", () => {
    if (lanes.get(chatId) === lane) lanes.delete(chatId);
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  });
  lane.ready = (async () => {
    for (let i = 0; i < 120; i++) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error("The engine lane exited before it answered.");
      if (await answers(url, engine.key)) return url;
      await sleep(250);
    }
    closeLane(lane);
    throw new Error("The engine lane did not answer in time.");
  })();
  return lane.ready;
}

function closeLane(lane: Lane) {
  lanes.delete(lane.chatId);
  if (lane.proc.exitCode === null && lane.proc.signalCode === null) {
    try {
      lane.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  try {
    closeSync(lane.fd);
  } catch {
    /* already closed */
  }
}

/** Where this chat's agent answers: the shared endpoint, or a lane started for this chat. */
export async function engineEndpoint(engine: EngineSettings, chatId: string): Promise<string> {
  if (!engine.perChat) return engine.url;
  const lane = lanes.get(chatId);
  if (lane) {
    lane.last = Date.now();
    return lane.ready;
  }
  return startLane(engine, chatId);
}

/** Closes a chat's lane, so a deleted thread leaves no process behind. */
export function forgetLane(chatId: string) {
  const lane = lanes.get(chatId);
  if (lane) closeLane(lane);
}

/** Closes lanes whose chat has gone quiet, and the oldest ones when there are too many. */
export function closeIdleLanes(engine: EngineSettings | null) {
  if (!engine || !engine.perChat) return;
  const now = Date.now();
  for (const lane of [...lanes.values()]) {
    if (now - lane.last > engine.idleMinutes * 60_000) closeLane(lane);
  }
  const still = [...lanes.values()].sort((a, b) => a.last - b.last);
  for (const lane of still.slice(Math.max(0, still.length - engine.maxLanes))) closeLane(lane);
}

/* -------------------------------- the one message ------------------------------- */

/** The chat's own rows, for a shared endpoint that does not hold the thread. */
function conversationBlock(chatId: string): string {
  const rows = rowsAfter(chatId, 0, 2000).slice(-30);
  const lines: string[] = [];
  for (const r of rows) {
    const b = r.body;
    if (r.kind === "message" && b.role === "user") lines.push(`member: ${clip(str(b.text), 400)}`);
    else if (r.kind === "message" && b.role === "assistant") lines.push(`you: ${clip(str(b.text), 400)}`);
    else if (r.kind === "tool-call") lines.push(`tool ${clip(str(b.tool), 40)} ${clip(str(b.status), 12)}`);
  }
  return lines.length ? `<chat-history>\n${lines.join("\n")}\n</chat-history>` : "";
}

/**
 * Ariadne's serve builds its own prompt around the newest user message and takes no system
 * message of its own, so the instructions, the thread and the member's message ride together.
 */
function engineMessage(engine: EngineSettings, system: string, input: string, ctx: ToolCtx, tools: ToolDef[], key: string): string {
  const parts = [`<engine-instructions>\n${system}\n\n${engineNotes(engine, key, ctx, tools)}\n</engine-instructions>`];
  if (!engine.perChat) parts.push(conversationBlock(ctx.chatId));
  parts.push(input);
  return parts.filter(Boolean).join("\n\n");
}

async function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("stopped");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Posts the turn. Ariadne answers 409 when the conversation is still finishing another
 * reply, so a busy lane is waited on rather than cancelled.
 */
async function postTurn(endpoint: string, body: unknown, engine: EngineSettings, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      cache: "no-store",
      signal,
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${engine.key}` },
      body: JSON.stringify(body),
    });
    if (res.status === 409 && attempt < BUSY_RETRY_MS.length) {
      await res.body?.cancel().catch(() => {});
      await waitOrAbort(BUSY_RETRY_MS[attempt], signal);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(res.status === 401 || res.status === 403 ? "The engine did not accept our key." : `The engine answered ${res.status}.`);
    }
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      await res.body?.cancel().catch(() => {});
      throw new Error("The engine did not answer with a stream.");
    }
    return res;
  }
}

/* ---------------------------------- the turn -------------------------------- */

export interface AriadneTurn {
  engine: EngineSettings;
  ctx: ToolCtx;
  /** The same instructions the built-in engine gets. */
  system: string;
  /** The member's message, already wrapped. */
  input: string;
  /** Called once for every tool the turn runs. */
  onStep(): void;
}

/**
 * Runs one turn on the agent. Returns when the agent has finished its answer; throws when
 * the agent fails or the turn is stopped (the caller reads the stop reason from its signal).
 */
export async function runEngineTurn({ engine, ctx, system, input, onStep }: AriadneTurn): Promise<void> {
  const chatId = ctx.chatId;
  const key = `t_${randomBytes(12).toString("hex")}`;
  const tools = engineTools();
  const ours = new Set(tools.map((t) => t.name));

  // The reply, as rows. A row is closed when a tool starts; text after it opens a new row.
  const closed: string[] = []; // raw text of the closed rows, as it streamed
  const said: string[] = []; // the same, as shown
  let seq: number | null = null;
  let text = "";
  let flushed = 0;
  let ended = false;
  let settled = false; // the stream said how it ended: a finish reason, or [DONE]
  let trail: ReturnType<typeof setTimeout> | null = null;
  let failed: string | null = null;

  const flush = (final: boolean) => {
    // One answer is cut into rows at each tool call, so a row can start or end in the middle of a line.
    const s = shown(text, key, final).trim();
    if (seq == null) {
      if (!s) return;
      seq = addRow(chatId, "message", { role: "assistant", text: s, streaming: !final }).seq;
    } else updateRow(chatId, seq, { text: s, streaming: !final });
    flushed = Date.now();
  };
  const closeText = () => {
    if (!text && seq == null) return;
    flush(true);
    const s = shown(text, key, true).trim();
    if (s) said.push(s);
    closed.push(text);
    text = "";
    seq = null;
  };
  const onDelta = (delta: string) => {
    text += delta;
    if (Date.now() - flushed > 120) flush(false);
    else
      trail ??= setTimeout(() => {
        trail = null;
        if (!ended && chatById(chatId)) flush(false);
      }, 150);
  };

  const turn: EngineTurn = { key, ctx, done: false, chain: Promise.resolve(), onStep, closeText, announced: [], waiting: [], late: new Map() };
  reg.turns.set(key, turn);

  const started = new Set<string>();
  let errored = false;
  const ownRows = new Map<string, { seq: number; label: string }>();

  const toolStart = (call: Record<string, unknown>) => {
    // Ariadne registers a server's tools under the names that server lists, so ours arrive
    // unprefixed. The untag is kept for a server that prefixes its own tools with its name --
    // Ariadne only derives a bare alias in that case, never the other way round.
    const raw = str(call.name) || "tool";
    const prefix = `${engine.mcpName}_`;
    const name = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    const callId = str(call.id) || `${name}:${started.size}`;
    if (started.has(callId)) return;
    started.add(callId);
    closeText();
    if (ours.has(name)) return announce(turn, name); // its row is made where the tool runs
    if (HIDDEN.has(raw) || HIDDEN.has(name)) return;
    // One of the agent's own tools. Its input and result stay with the agent.
    const row = addRow(chatId, "tool-call", { tool: `engine.${clip(name, 80)}`, input: {}, status: "running", summary: label(name) });
    ownRows.set(callId, { seq: row.seq, label: label(name) });
    onStep();
  };
  const toolEnd = (result: Record<string, unknown>) => {
    const row = ownRows.get(str(result.id));
    if (!row) return;
    ownRows.delete(str(result.id));
    updateRow(chatId, row.seq, { status: outputFailed(result) ? "error" : "done" });
  };

  try {
    const endpoint = await engineEndpoint(engine, chatId);
    const res = await postTurn(
      endpoint,
      {
        model: engine.model,
        stream: true,
        messages: [{ role: "user", content: engineMessage(engine, system, input, ctx, tools, key) }],
      },
      engine,
      ctx.signal,
    );

    const body = res.body;
    if (!body) throw new Error("The engine did not answer with a stream.");
    for await (const ev of sse(body)) {
      if (ev.data === "[DONE]") {
        settled = true;
        break;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (!isRecord(msg)) continue;
      const choice = Array.isArray(msg.choices) ? msg.choices[0] : undefined;
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : null;
      if (delta) {
        // Its thinking, its own plumbing notes and the harness tape stay out of the chat.
        if (typeof delta.content === "string" && delta.content) onDelta(delta.content);
        if (isRecord(delta.ariadne_tool_call)) toolStart(delta.ariadne_tool_call);
        if (isRecord(delta.ariadne_tool_result)) toolEnd(delta.ariadne_tool_result);
      }
      if (choice.finish_reason === "error") {
        failed = engineFailure(text);
        settled = true;
        break;
      }
      if (choice.finish_reason === "stop") settled = true;
    }
    if (ctx.signal.aborted) return;
    if (failed) throw new Error(`The engine reported a failure: ${failed}`);
    // A stream that ends with no finish reason and no [DONE] is an answer that broke off.
    if (!settled) throw new Error("The engine's answer broke off mid-stream.");
  } catch (err) {
    // A stream that dies (a 500 from the serving layer, a broken socket) is the loop's problem
    // to report; this turn must not add a second notice on the way out.
    errored = true;
    throw err;
  } finally {
    ended = true;
    if (trail) clearTimeout(trail);
    turn.done = true;
    reg.turns.delete(key);
    for (const w of turn.waiting.splice(0)) w.go();
    if (chatById(chatId)) {
      // The engine's failure note is not for the member: close the row without it.
      text = text.replace(/\n?\[ariadne:\s*[^\]]+\]\s*$/, "");
      closeText();
      // A model that asks for a tool as markup in its text is a turn that did nothing: Ariadne
      // runs a call only when the upstream returns it as a structured tool call. Say so rather
      // than let a chat quietly receive an answer that never touched its tools.
      if (started.size === 0 && MARKUP_OPEN.test(closed.join("") + text))
        addRow(chatId, "notice", {
          level: "warning",
          code: "tool_markup",
          text: "The model asked for a tool, but its serving layer sent the call as text, so nothing ran. The upstream has to answer with a structured tool call.",
        });
      // A turn that produced neither text nor a tool call is a turn that did nothing. Say it:
      // a chat that only holds the member's message reads as a reply that never arrived. A turn
      // that errored or was stopped already gets its one notice from the loop, so this stays
      // quiet here -- two notices for one turn reads as two problems.
      if (!failed && !errored && !ctx.signal.aborted && started.size === 0 && said.length === 0)
        addRow(chatId, "notice", {
          level: "error",
          code: "empty_answer",
          text: "The engine finished this turn with no answer and no tool call. Check the lane's log under the home named by ARIADNE_HOME.",
        });
      // A step the stream never closed: say how it ended.
      for (const row of ownRows.values()) updateRow(chatId, row.seq, failed ? { status: "error", summary: `${row.label} (failed)` } : { status: "done" });
      // Keep our own record of the reply, so the chat still reads right on the built-in engine.
      if (said.length) pushLlm(chatId, { role: "assistant", content: [{ type: "text", text: said.join("\n\n") }] } satisfies LlmMessage);
    }
  }
}

/* ------------------------------ a tool call back ---------------------------- */

const refuse = (content: string): ToolOutput => ({ content, summary: content, isError: true });

/**
 * Runs one of our tools for the turn that `key` names. A missing, wrong or finished key
 * gets an error the agent can read; it never falls back to some other turn.
 */
export function callEngineTool(key: unknown, tool: ToolDef, input: Record<string, unknown>): Promise<ToolOutput> {
  const turn = typeof key === "string" ? reg.turns.get(key) : undefined;
  if (!turn || turn.done) {
    return Promise.resolve(refuse('This call needs the turn key from this message\'s instructions, passed as "turn". A key from an earlier message no longer works.'));
  }
  const job = turn.chain.then(() => runOne(turn, tool, input));
  turn.chain = job.catch(() => {});
  return job;
}

async function runOne(turn: EngineTurn, tool: ToolDef, input: Record<string, unknown>): Promise<ToolOutput> {
  const { ctx } = turn;
  if (!turn.done && !ctx.signal.aborted) await claim(turn, tool.name);
  if (turn.done || ctx.signal.aborted || !chatById(ctx.chatId)) return refuse("This reply was stopped.");
  const row = addRow(ctx.chatId, "tool-call", { tool: tool.name, input: summarizeInput(input), status: "running" });
  turn.onStep();
  const out = await runTool(tool, ctx, input);
  if (chatById(ctx.chatId)) updateRow(ctx.chatId, row.seq, { status: out.isError ? "error" : "done", summary: out.summary });
  return out;
}

/** Ariadne's serve answers /health once it is up; this is what deploy scripts check. */
export async function engineAlive(engine: EngineSettings): Promise<boolean> {
  if (!engine.perChat) return answers(engine.url, engine.key);
  for (const lane of [...lanes.values()]) {
    if (await answers(lane.url, engine.key)) return true;
  }
  return false;
}
