import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DownloadQueue, DownloadTask } from "./download.js";

const execFileAsync = promisify(execFile);

export interface GpuStats {
  gpu_util: number | null;
  vram_used: number | null;
  vram_total: number | null;
  temp: number | null;
}

export async function getGpuStats(): Promise<GpuStats> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
    ]);
    const parts = stdout.trim().split(",").map((s) => s.trim());
    return {
      gpu_util: Number(parts[0]),
      vram_used: Number(parts[1]),
      vram_total: Number(parts[2]),
      temp: Number(parts[3]),
    };
  } catch {
    return { gpu_util: null, vram_used: null, vram_total: null, temp: null };
  }
}

interface WsLike {
  send(data: string): void;
}

function makeSend(ws: WsLike) {
  let alive = true;

  const send = (event: string, data: unknown) => {
    try {
      ws.send(JSON.stringify({ event, data, ts: Date.now() }));
    } catch {
      alive = false;
    }
  };

  return { send, isAlive: () => alive };
}

export function startTelemetryLoop(
  ws: WsLike,
  comfyuiUrl: string,
  downloadQueue: DownloadQueue,
  intervalMs = 10000,
): () => void {
  const { send, isAlive } = makeSend(ws);

  // Heartbeat interval
  const timer = setInterval(async () => {
    if (!isAlive()) {
      clearInterval(timer);
      return;
    }

    const gpu = await getGpuStats();

    let comfyui_alive = false;
    try {
      const res = await fetch(`${comfyuiUrl}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      });
      comfyui_alive = res.ok;
    } catch {
      // comfyui not reachable
    }

    send("heartbeat", { ...gpu, comfyui_alive });
  }, intervalMs);

  // Download progress hook
  const onProgress = (task: DownloadTask, bytes: number, total: number) => {
    send("download:progress", {
      task_id: task.taskId,
      bytes,
      total,
    });
  };

  // Download complete/failed hook
  const onComplete = (task: DownloadTask, status: "complete" | "failed", error?: string) => {
    const filename = task.destPath.split("/").pop() ?? task.destPath;
    if (status === "complete") {
      send("download:complete", { task_id: task.taskId, filename });
    } else {
      send("download:failed", { task_id: task.taskId, filename, error });
    }
  };

  downloadQueue.onProgress = onProgress;
  downloadQueue.onComplete = onComplete;

  // Cleanup function
  return () => {
    clearInterval(timer);
    if (downloadQueue.onProgress === onProgress) {
      downloadQueue.onProgress = null;
    }
    if (downloadQueue.onComplete === onComplete) {
      downloadQueue.onComplete = null;
    }
  };
}
