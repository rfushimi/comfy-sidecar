import { readdir, unlink, access } from "node:fs/promises";
import { join, resolve } from "node:path";

const MODEL_EXTENSIONS = new Set([
  ".safetensors",
  ".ckpt",
  ".pt",
  ".pth",
  ".bin",
]);

export type ModelList = {
  checkpoints: string[];
  loras: string[];
  embeddings: string[];
};

const TYPE_TO_SUBDIR: Record<string, keyof ModelList> = {
  checkpoint: "checkpoints",
  lora: "loras",
  embedding: "embeddings",
};

function isModelFile(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return false;
  return MODEL_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

async function listModelsInDir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter(isModelFile);
  } catch {
    return [];
  }
}

export async function scanModels(modelsDir: string): Promise<ModelList> {
  const [checkpoints, loras, embeddings] = await Promise.all([
    listModelsInDir(join(modelsDir, "checkpoints")),
    listModelsInDir(join(modelsDir, "loras")),
    listModelsInDir(join(modelsDir, "embeddings")),
  ]);
  return { checkpoints, loras, embeddings };
}

export async function deleteModel(
  modelsDir: string,
  type: string,
  file: string
): Promise<{ ok: boolean; error?: string; status: number }> {
  const subdir = TYPE_TO_SUBDIR[type];
  if (!subdir) {
    return { ok: false, error: `Unknown model type: ${type}`, status: 400 };
  }

  const filePath = resolve(modelsDir, subdir, file);
  if (!filePath.startsWith(resolve(modelsDir))) {
    return { ok: false, error: "Invalid path", status: 400 };
  }
  try {
    await access(filePath);
    await unlink(filePath);
    return { ok: true, status: 200 };
  } catch {
    return { ok: false, error: "File not found", status: 404 };
  }
}
