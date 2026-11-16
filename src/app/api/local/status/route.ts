import { route } from "@/server/http";
import { localStatus } from "@/server/local-media";

/** GET /api/local/status — what this machine can render locally, and what it is missing. */
export const GET = route(async () => {
  const status = localStatus();
  return {
    provider: status.provider,
    renderer_present: status.binary.present,
    free_vram_mib: status.free_vram_mib,
    models: status.rows.map((row) => ({ id: row.id, ready: row.ready, missing: row.missing })),
  };
});
