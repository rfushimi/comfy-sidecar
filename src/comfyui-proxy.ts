import { Hono } from "hono";

/**
 * Creates proxy routes that forward requests to a ComfyUI instance.
 * Reads COMFYUI_URL from process.env at request time so tests can set it in beforeAll.
 */
export function createProxyRoutes(): Hono {
  const router = new Hono();

  const getUrl = () => process.env.COMFYUI_URL || "http://127.0.0.1:8188";

  // POST /generate -> ComfyUI POST /prompt
  router.post("/generate", async (c) => {
    const body = await c.req.text();
    const res = await fetch(`${getUrl()}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const data = await res.json();
    return c.json(data, res.status as 200);
  });

  // POST /cancel/:promptId -> ComfyUI POST /queue with { delete: [promptId] }
  router.post("/cancel/:promptId", async (c) => {
    const promptId = c.req.param("promptId");
    const res = await fetch(`${getUrl()}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    });
    const data = await res.json();
    return c.json(data, res.status as 200);
  });

  // GET /history/:promptId -> ComfyUI GET /history/:promptId
  router.get("/history/:promptId", async (c) => {
    const promptId = c.req.param("promptId");
    const res = await fetch(`${getUrl()}/history/${promptId}`);
    const data = await res.json();
    return c.json(data, res.status as 200);
  });

  // GET /view -> ComfyUI GET /view (pass query params, return binary)
  router.get("/view", async (c) => {
    const queryString = new URL(c.req.url).search;
    const res = await fetch(`${getUrl()}/view${queryString}`);
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      status: res.status,
      headers: { "Content-Type": contentType },
    });
  });

  return router;
}
