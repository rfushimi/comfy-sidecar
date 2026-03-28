import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { app } from "../index.js";

let mockComfy: Server;
let mockComfyUrl: string;

beforeAll(async () => {
  // Start a mock ComfyUI server
  mockComfy = createServer((req, res) => {
    // POST /prompt
    if (req.method === "POST" && req.url === "/prompt") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "test-prompt-123" }));
      });
      return;
    }

    // POST /queue (cancel)
    if (req.method === "POST" && req.url === "/queue") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, deleted: parsed.delete }));
      });
      return;
    }

    // GET /history/test-prompt-123
    if (req.method === "GET" && req.url === "/history/test-prompt-123") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ "test-prompt-123": { outputs: {} } })
      );
      return;
    }

    // GET /view
    if (req.method === "GET" && req.url?.startsWith("/view")) {
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(pngMagic);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    mockComfy.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = mockComfy.address();
  if (typeof addr === "object" && addr) {
    mockComfyUrl = `http://127.0.0.1:${addr.port}`;
  }
  process.env.COMFYUI_URL = mockComfyUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockComfy.close(() => resolve()));
});

describe("ComfyUI proxy endpoints", () => {
  it("POST /generate proxies to ComfyUI /prompt", async () => {
    const res = await app.request("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { "1": { class_type: "KSampler" } } }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.prompt_id).toBe("test-prompt-123");
  });

  it("GET /history/:id proxies to ComfyUI", async () => {
    const res = await app.request("/history/test-prompt-123");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json["test-prompt-123"]).toBeDefined();
    expect(json["test-prompt-123"].outputs).toBeDefined();
  });

  it("GET /view proxies image download", async () => {
    const res = await app.request("/view?filename=test.png&type=output");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  });

  it("POST /cancel/:promptId proxies to ComfyUI /queue", async () => {
    const res = await app.request("/cancel/test-prompt-123", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.deleted).toContain("test-prompt-123");
  });
});
