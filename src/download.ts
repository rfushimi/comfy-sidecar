import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface DownloadTask {
  url: string;
  destPath: string;
  taskId: string;
  hash?: string;
}

interface ActiveInfo {
  taskId: string;
  bytes: number;
  total: number;
}

interface FailedInfo {
  taskId: string;
  error: string;
}

interface DownloadStatus {
  active: ActiveInfo | null;
  pending: string[];
  completed: string[];
  failed: FailedInfo[];
}

interface DownloadQueueOptions {
  retryDelays?: number[];
  persistPath?: string;
}

const DEFAULT_RETRY_DELAYS = [5000, 30000, 120000];

export class DownloadQueue {
  private queue: DownloadTask[] = [];
  private processing = false;
  private activeInfo: ActiveInfo | null = null;
  private _activeDest: string | null = null;
  private completedIds: string[] = [];
  private completedDests = new Set<string>();
  private failedList: FailedInfo[] = [];
  private retryDelays: number[];
  private persistPath: string | null;

  onComplete: ((task: DownloadTask, status: "complete" | "failed", error?: string) => void) | null = null;
  onProgress: ((task: DownloadTask, bytes: number, total: number) => void) | null = null;

  constructor(options?: DownloadQueueOptions) {
    this.retryDelays = options?.retryDelays ?? DEFAULT_RETRY_DELAYS;
    this.persistPath = options?.persistPath ?? null;
    this.loadPersisted();
  }

  enqueue(task: DownloadTask): void {
    // Deduplicate by destPath — skip if already queued, active, or completed
    const dest = task.destPath;
    if (
      this.completedDests.has(dest) ||
      this._activeDest === dest ||
      this.queue.some((t) => t.destPath === dest)
    ) {
      return; // silently skip duplicate
    }
    this.queue.push(task);
    this.persist();
    this.processNext();
  }

  getStatus(): DownloadStatus {
    return {
      active: this.activeInfo,
      pending: this.queue.map((t) => t.taskId),
      completed: [...this.completedIds],
      failed: [...this.failedList],
    };
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    const task = this.queue.shift();
    if (!task) return;

    this.persist();
    this.processing = true;
    this._activeDest = task.destPath;
    this.activeInfo = { taskId: task.taskId, bytes: 0, total: 0 };

    try {
      await this.downloadWithRetry(task);
      this.completedIds.push(task.taskId);
      this.completedDests.add(task.destPath);
      this.activeInfo = null;
      this._activeDest = null;
      this.onComplete?.(task, "complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failedList.push({ taskId: task.taskId, error: message });
      this.activeInfo = null;
      this._activeDest = null;
      this.onComplete?.(task, "failed", message);
    }

    this.processing = false;
    this.processNext();
  }

  private async downloadWithRetry(task: DownloadTask): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      try {
        await this.downloadFile(task);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on 404
        if (lastError.message.includes("404")) {
          throw lastError;
        }

        if (attempt < this.retryDelays.length) {
          await this.delay(this.retryDelays[attempt]);
        }
      }
    }

    throw lastError!;
  }

  private async downloadFile(task: DownloadTask): Promise<void> {
    // Skip if already downloaded (e.g. completed before restart)
    if (existsSync(task.destPath)) return;

    const tmpPath = task.destPath + ".tmp";

    // Ensure parent directory exists
    await mkdir(dirname(task.destPath), { recursive: true });

    const res = await fetch(task.url);

    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status} for ${task.url}`);
    }

    const total = Number(res.headers.get("content-length") || 0);
    this.activeInfo = { taskId: task.taskId, bytes: 0, total };

    if (!res.body) {
      throw new Error("No response body");
    }

    // Stream response directly to disk via tmp file
    let bytesReceived = 0;
    const fileStream = createWriteStream(tmpPath);

    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        const canContinue = fileStream.write(buf);
        bytesReceived += chunk.byteLength;
        if (this.activeInfo) {
          this.activeInfo.bytes = bytesReceived;
        }
        this.onProgress?.(task, bytesReceived, total);
        // Respect backpressure
        if (!canContinue) {
          await new Promise<void>((resolve) => fileStream.once("drain", resolve));
        }
      }

      // Wait for the file stream to finish
      await new Promise<void>((resolve, reject) => {
        fileStream.end(() => resolve());
        fileStream.on("error", reject);
      });
    } catch (err) {
      fileStream.destroy();
      // Clean up tmp file on error
      await unlink(tmpPath).catch(() => {});
      throw err;
    }

    // Atomic rename
    await rename(tmpPath, task.destPath);
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const data = this.queue.map((t) => ({
        url: t.url,
        destPath: t.destPath,
        taskId: t.taskId,
        ...(t.hash ? { hash: t.hash } : {}),
      }));
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch {
      // Best-effort — don't crash the queue over persistence
    }
  }

  private loadPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const tasks: DownloadTask[] = JSON.parse(raw);
      if (!Array.isArray(tasks)) return;
      for (const task of tasks) {
        if (task.url && task.destPath && task.taskId) {
          this.enqueue(task);
        }
      }
    } catch {
      // Corrupt or unreadable file — skip silently
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
