import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createProxyRoutes } from "./comfyui-proxy.js";
import { scanModels, deleteModel } from "./models.js";
import { DownloadQueue } from "./download.js";
import { startTelemetryLoop } from "./telemetry.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { checkAndUpdate } from "./updater.js";

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const COMFYUI_URL =
  process.env.COMFYUI_URL || "http://127.0.0.1:8188";

const PORT = Number(process.env.PORT) || 19090;
const getModelsDir = () =>
  process.env.COMFYUI_MODELS_DIR || "/opt/ComfyUI/models";

export const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.route("/", createProxyRoutes());

app.get("/models", async (c) => {
  const models = await scanModels(getModelsDir());
  return c.json(models);
});

app.delete("/models/:type/:file", async (c) => {
  const { type, file } = c.req.param();
  const result = await deleteModel(getModelsDir(), type, file);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 404);
  }
  return c.json({ ok: true });
});

// Type-to-subdirectory mapping for model downloads
const MODEL_TYPE_MAP: Record<string, string> = {
  checkpoint: "checkpoints",
  lora: "loras",
  vae: "vae",
  controlnet: "controlnet",
  clip: "clip",
  clip_vision: "clip_vision",
  upscale: "upscale_models",
  embedding: "embeddings",
  unet: "unet",
};

export const downloadQueue = new DownloadQueue({
  persistPath: "/tmp/comfy-sidecar-queue.json",
});

app.post("/models/download", async (c) => {
  const body = await c.req.json<{ url: string; type: string; filename: string }>();
  const { url, type, filename } = body;

  const subdir = MODEL_TYPE_MAP[type] ?? type;
  const destPath = join(getModelsDir(), subdir, filename);
  const taskId = randomUUID();

  downloadQueue.enqueue({ url, destPath, taskId });

  return c.json({ task_id: taskId });
});

app.get("/models/downloads", (c) => {
  return c.json(downloadQueue.getStatus());
});

app.post("/admin/update", async (c) => {
  try {
    const result = await checkAndUpdate(REPO_DIR);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

app.get(
  "/ws/telemetry",
  upgradeWebSocket(() => {
    let cleanup: (() => void) | null = null;
    return {
      onOpen(_evt, ws) {
        cleanup = startTelemetryLoop(ws.raw!, COMFYUI_URL, downloadQueue);
      },
      onClose() {
        cleanup?.();
        cleanup = null;
      },
    };
  }),
);

app.get("/health", async (c) => {
  let comfyui: "reachable" | "unreachable" = "unreachable";
  let systemStats: unknown = null;
  try {
    const res = await fetch(`${COMFYUI_URL}/system_stats`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      comfyui = "reachable";
      systemStats = await res.json();
    }
  } catch {
    // ComfyUI not running — sidecar itself is fine
  }
  // Disk usage for the models directory
  let disk: { total_gb: number; free_gb: number; used_pct: number } | null = null;
  try {
    const { execSync } = await import("child_process");
    const df = execSync("df -k / 2>/dev/null || df -k . 2>/dev/null", { encoding: "utf-8" });
    const lines = df.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const totalKB = parseInt(parts[1] || "0");
      const usedKB = parseInt(parts[2] || "0");
      const freeKB = parseInt(parts[3] || "0");
      if (totalKB > 0) {
        disk = {
          total_gb: Math.round(totalKB / 1048576 * 10) / 10,
          free_gb: Math.round(freeKB / 1048576 * 10) / 10,
          used_pct: Math.round(usedKB / totalKB * 100),
        };
      }
    }
  } catch { /* ignore */ }

  return c.json({ status: "ok", comfyui, system_stats: systemStats, disk });
});

if (process.env.NODE_ENV !== "test") {
  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`comfy-sidecar listening on :${info.port}`);
    console.log(`ComfyUI upstream: ${COMFYUI_URL}`);
  });
  injectWebSocket(server);
}
