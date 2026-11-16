import "server-only";

import { readFileSync } from "node:fs";

/**
 * Settings for the agent chat. Each outside service is live only when SUPER_MODE=live
 * and its own key is set; otherwise that one service runs as a mock.
 *
 * The assistant itself can also run on an outside engine: an Ariadne agent (SUPER_ENGINE=ariadne).
 * Then Ariadne does the thinking and Parallax serves it our tools; see `ariadne.ts`.
 */

export type Service = "llm" | "computer" | "connectors";

const KEYS: Record<Service, string> = {
  llm: "ANTHROPIC_API_KEY",
  computer: "COMPUTER_API_KEY",
  connectors: "COMPOSIO_API_KEY",
};

export function serviceMode(service: Service): "live" | "mock" {
  if (service === "llm" && engineSettings()) return "live";
  return process.env.SUPER_MODE === "live" && !!process.env[KEYS[service]] ? "live" : "mock";
}

/** A secret from NAME, or from the file that NAME_FILE names. Never logged. */
export function secret(name: string): string | null {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`]?.trim();
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** What an outside engine needs to be reached, and how Parallax reaches it. */
export interface EngineSettings {
  /** Where the agent's API server answers, with no trailing slash. Empty in per-chat mode. */
  url: string;
  /** The bearer the agent's endpoint expects (`serve.api_key` / `DD_SERVE_KEY`). */
  key: string;
  /** What the agent must show us when it calls our tools. */
  token: string;
  model: string;
  /** The name members see in the composer. */
  name: string;
  /** The name of our entry in the agent's `mcp_servers`. */
  mcpName: string;
  /**
   * One agent process per chat. Ariadne's server owns one conversation, so a shared
   * endpoint would mix every member's chats; per-chat mode starts one `ariadne --serve`
   * on loopback for each chat and recycles it when it goes idle.
   */
  perChat: boolean;
  /** The agent binary and the home it runs from, for per-chat mode. */
  bin: string;
  home: string;
  /** First loopback port per-chat lanes bind to; each lane takes the next free one. */
  portBase: number;
  /** Minutes a lane may sit unused before it is closed. */
  idleMinutes: number;
  /** How many lanes one server may hold at once. */
  maxLanes: number;
  /** Tools left out of the agent's deck, comma-separated. Its own shell and files by default. */
  disableTools: string;
}

/** Ariadne leaves its own tools off a Parallax lane unless the operator names a narrower set. */
const DEFAULT_DISABLED_TOOLS = "run_terminal,write_file,edit_file,list_dir,read_file,delegate_task,job,view_image";

let warned = false;

/** The Ariadne engine's settings, or null when the built-in engine is in charge. */
export function engineSettings(): EngineSettings | null {
  if ((process.env.SUPER_ENGINE ?? "").trim().toLowerCase() !== "ariadne") return null;
  const perChat = (process.env.ARIADNE_PER_CHAT ?? "").trim().toLowerCase() === "1";
  let url = "";
  if (!perChat) {
    try {
      const u = new URL(process.env.ARIADNE_URL ?? "");
      if (u.protocol === "http:" || u.protocol === "https:") url = (u.origin + u.pathname).replace(/\/+$/, "");
    } catch {
      /* not an address */
    }
  }
  const key = secret("ARIADNE_API_KEY");
  const token = secret("SUPER_ENGINE_TOKEN");
  const home = process.env.ARIADNE_HOME?.trim() ?? "";
  if (!url && !perChat || perChat && !home || !key || !token || token.length < 24) {
    if (!warned) {
      warned = true;
      const missing = [
        !url && !perChat && "ARIADNE_URL",
        perChat && !home && "ARIADNE_HOME (the lane home a serve starts from)",
        !key && "ARIADNE_API_KEY",
        (!token || token.length < 24) && "SUPER_ENGINE_TOKEN (24+ characters)",
      ].filter(Boolean);
      console.error(`[super] SUPER_ENGINE=ariadne is set but incomplete (${missing.join(", ")}). Using the built-in engine.`);
    }
    return null;
  }
  return {
    url,
    key,
    token,
    model: process.env.ARIADNE_MODEL?.trim() || "ariadne",
    name: (process.env.SUPER_ENGINE_NAME?.trim() || "Ariadne").slice(0, 40),
    mcpName: (process.env.ARIADNE_MCP_NAME?.trim() || "parallax").replace(/[^A-Za-z0-9_]/g, "_"),
    perChat,
    bin: process.env.ARIADNE_BIN?.trim() || "ariadne",
    home,
    portBase: num("ARIADNE_PORT_BASE", 8643, 1024, 65535),
    idleMinutes: num("ARIADNE_LANE_IDLE_MIN", 20, 1, 24 * 60),
    maxLanes: num("ARIADNE_MAX_LANES", 8, 1, 64),
    disableTools: process.env.ARIADNE_DISABLE_TOOLS?.trim() ?? DEFAULT_DISABLED_TOOLS,
  };
}

/**
 * Whether this engine's endpoint is per-chat, from settings or from the lane a chat already
 * has. `loop.ts` asks it before reading any shared address, so a chat bound to a lane can never
 * dial the shared endpoint or take another chat's lane.
 */
export function engineIsPerChat(): boolean {
  const eng = engineSettings();
  if (eng?.perChat) return true;
  const base = (process.env.SUPER_ENGINE ?? "").trim().toLowerCase();
  return base === "ariadne" && (process.env.ARIADNE_PER_CHAT ?? "").trim().toLowerCase() === "1";
}

function num(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
}

export const limits = {
  /** Model calls in one turn before it is cut off. */
  maxSteps: () => num("SUPER_MAX_STEPS", 12, 1, 50),
  /** Working time of one turn, not counting time spent waiting for the member. */
  turnMs: () => num("SUPER_TURN_MS", 5 * 60_000, 5_000, 30 * 60_000),
  /** How long an approval card waits before it expires. */
  approvalMs: () => num("SUPER_APPROVAL_MS", 30 * 60_000, 10_000, 24 * 3_600_000),
  /** How long a generation may take before the turn stops waiting for it. */
  jobWaitMs: () => num("SUPER_JOB_WAIT_MS", 10 * 60_000, 5_000, 60 * 60_000),
  /** Idle minutes before a member's computer is suspended. */
  computerIdleMs: () => num("SUPER_COMPUTER_IDLE_MIN", 20, 1, 24 * 60) * 60_000,
  maxSchedules: 10,
  maxChats: 500,
};

/** The assistant's own model choices. `auto` lets the server pick. */
export const LLM_MODELS = [
  { id: "auto", name: "Auto", description: "Picks the model for you.", tier: "standard" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", description: "Strongest planning and tool use.", tier: "high" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "Fast and capable for everyday work.", tier: "medium" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", description: "Quickest replies for simple asks.", tier: "low" },
] as const;

export function resolveLlmModel(setting: string): string {
  if (setting && setting !== "auto" && LLM_MODELS.some((m) => m.id === setting)) return setting;
  return process.env.SUPER_LLM_MODEL || "claude-opus-5-5";
}

export const MODES = [
  { id: "ask", name: "Ask before generating", description: "Shows the model, prompt and price, and waits for your yes before spending credits." },
  { id: "auto", name: "Generate without asking", description: "Starts generations straight away and spends credits as it goes." },
] as const;
export type Mode = "ask" | "auto";
