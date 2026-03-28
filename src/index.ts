import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createProxyRoutes } from "./comfyui-proxy.js";
import { scanModels, deleteModel } from "./models.js";
import { DownloadQueue } from "./download.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const COMFYUI_URL =
  process.env.COMFYUI_URL || "http://127.0.0.1:8188";

const PORT = Number(process.env.PORT) || 19090;
const getModelsDir = () =>
  process.env.COMFYUI_MODELS_DIR || "/opt/ComfyUI/models";

export const app = new Hono();

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

export const downloadQueue = new DownloadQueue();

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

app.get("/health", async (c) => {
  try {
    const res = await fetch(`${COMFYUI_URL}/system_stats`);
    const stats = await res.json();
    return c.json({ status: "ok", comfyui: stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ status: "error", error: message }, 502);
  }
});

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`comfy-sidecar listening on :${info.port}`);
    console.log(`ComfyUI upstream: ${COMFYUI_URL}`);
  });
}
