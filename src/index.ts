import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createProxyRoutes } from "./comfyui-proxy.js";
import { scanModels, deleteModel } from "./models.js";

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
