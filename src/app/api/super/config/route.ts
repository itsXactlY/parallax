import { route } from "@/server/http";
  import { LLM_MODELS, MODES, engineSettings, limits, serviceMode } from "@/server/super/config";
import { ensureSuper } from "@/server/super/loop";

/** GET /api/super/config  The composer's choices: agent modes, assistant models, limits. */
export const GET = route(() => {
  ensureSuper();
  const engine = engineSettings();
  return {
    modes: MODES,
    defaultMode: "ask",
    // An outside engine picks its own model, so there is one choice: the engine itself.
    models: engine ? [{ id: "auto", name: engine.name, description: "Runs on an Ariadne agent.", tier: "standard" }] : LLM_MODELS,
    defaultModel: "auto",
    engine: engine ? { id: "ariadne", name: engine.name } : { id: "builtin", name: "Built-in" },
    services: { llm: serviceMode("llm"), computer: serviceMode("computer"), connectors: serviceMode("connectors") },
    limits: { maxSteps: limits.maxSteps(), turnSeconds: Math.round(limits.turnMs() / 1000), maxSchedules: limits.maxSchedules, messageMaxLength: 20_000, maxFilesPerMessage: 10 },
  };
});
