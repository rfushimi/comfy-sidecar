import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { createWriteStream } from "node:fs";

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
}

const DEFAULT_RETRY_DELAYS = [5000, 30000, 120000];

export class DownloadQueue {
  private queue: DownloadTask[] = [];
  private processing = false;
  private activeInfo: ActiveInfo | null = null;
  private completedIds: string[] = [];
  private failedList: FailedInfo[] = [];
  private retryDelays: number[];

  onComplete: ((task: DownloadTask, status: "complete" | "failed", error?: string) => void) | null = null;
  onProgress: ((task: DownloadTask, bytes: number, total: number) => void) | null = null;

  constructor(options?: DownloadQueueOptions) {
    this.retryDelays = options?.retryDelays ?? DEFAULT_RETRY_DELAYS;
  }

  enqueue(task: DownloadTask): void {
    this.queue.push(task);
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

    this.processing = true;
    this.activeInfo = { taskId: task.taskId, bytes: 0, total: 0 };

    try {
      await this.downloadWithRetry(task);
      this.completedIds.push(task.taskId);
      this.activeInfo = null;
      this.onComplete?.(task, "complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failedList.push({ taskId: task.taskId, error: message });
      this.activeInfo = null;
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

    // Stream response to tmp file
    const chunks: Buffer[] = [];
    let bytesReceived = 0;

    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
      bytesReceived += chunk.byteLength;
      if (this.activeInfo) {
        this.activeInfo.bytes = bytesReceived;
      }
      this.onProgress?.(task, bytesReceived, total);
    }

    // Write to tmp file then atomic rename
    await writeFile(tmpPath, Buffer.concat(chunks));
    await rename(tmpPath, task.destPath);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
