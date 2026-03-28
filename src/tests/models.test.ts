import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanModels } from "../models.js";
import { app } from "../index.js";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "comfy-models-"));

  // Create subdirectories
  await mkdir(join(tempDir, "checkpoints"));
  await mkdir(join(tempDir, "loras"));
  await mkdir(join(tempDir, "embeddings"));

  // Create fake model files
  await writeFile(join(tempDir, "checkpoints", "sd15.safetensors"), "");
  await writeFile(join(tempDir, "checkpoints", "sdxl.ckpt"), "");
  await writeFile(join(tempDir, "checkpoints", "readme.txt"), "");
  await writeFile(join(tempDir, "loras", "detail.pt"), "");
  await writeFile(join(tempDir, "loras", "style.safetensors"), "");
  await writeFile(join(tempDir, "loras", "notes.md"), "");
  await writeFile(join(tempDir, "embeddings", "neg.pth"), "");
  await writeFile(join(tempDir, "embeddings", "pos.bin"), "");
  await writeFile(join(tempDir, "embeddings", "config.json"), "");

  // Set env for HTTP route tests
  process.env.COMFYUI_MODELS_DIR = tempDir;
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.COMFYUI_MODELS_DIR;
});

describe("scanModels", () => {
  it("returns model files grouped by subdirectory", async () => {
    const result = await scanModels(tempDir);

    expect(result.checkpoints.sort()).toEqual(
      ["sd15.safetensors", "sdxl.ckpt"].sort()
    );
    expect(result.loras.sort()).toEqual(
      ["detail.pt", "style.safetensors"].sort()
    );
    expect(result.embeddings.sort()).toEqual(["neg.pth", "pos.bin"].sort());
  });

  it("excludes non-model files", async () => {
    const result = await scanModels(tempDir);

    expect(result.checkpoints).not.toContain("readme.txt");
    expect(result.loras).not.toContain("notes.md");
    expect(result.embeddings).not.toContain("config.json");
  });

  it("returns empty arrays for missing subdirectories", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "comfy-empty-"));
    const result = await scanModels(emptyDir);

    expect(result.checkpoints).toEqual([]);
    expect(result.loras).toEqual([]);
    expect(result.embeddings).toEqual([]);

    await rm(emptyDir, { recursive: true, force: true });
  });
});

describe("GET /models", () => {
  it("returns model listing as JSON", async () => {
    const res = await app.request("/models");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checkpoints).toContain("sd15.safetensors");
    expect(json.loras).toContain("style.safetensors");
    expect(json.embeddings).toContain("pos.bin");
  });
});

describe("DELETE /models/:type/:file", () => {
  it("deletes an existing model file", async () => {
    // Create a disposable file
    await writeFile(join(tempDir, "loras", "to-delete.safetensors"), "");
    const res = await app.request("/models/lora/to-delete.safetensors", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("returns 404 for non-existent file", async () => {
    const res = await app.request("/models/checkpoint/nope.safetensors", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for unknown model type", async () => {
    const res = await app.request("/models/unknown/file.safetensors", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });
});
