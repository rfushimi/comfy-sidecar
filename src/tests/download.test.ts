import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { DownloadQueue, type DownloadTask } from "../download.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server;
let baseUrl: string;
let tempDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "5" });
      res.end("hello");
      return;
    }
    if (req.url === "/404") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    if (req.url === "/500") {
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (typeof addr === "object" && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dl-test-"));
});

describe("DownloadQueue", () => {
  it("downloads a file successfully", async () => {
    const queue = new DownloadQueue({ retryDelays: [50, 100, 200] });
    const destPath = join(tempDir, "subdir", "output.bin");

    const task: DownloadTask = {
      url: `${baseUrl}/ok`,
      destPath,
      taskId: "task-ok",
    };

    const result = await new Promise<{ task: DownloadTask; status: string }>((resolve) => {
      queue.onComplete = (t, status) => {
        resolve({ task: t, status });
      };
      queue.enqueue(task);
    });

    expect(result.status).toBe("complete");
    expect(result.task.taskId).toBe("task-ok");

    const content = await readFile(destPath, "utf-8");
    expect(content).toBe("hello");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("reports failure for 404 without retrying", async () => {
    const queue = new DownloadQueue({ retryDelays: [50, 100, 200] });
    const destPath = join(tempDir, "notfound.bin");

    const task: DownloadTask = {
      url: `${baseUrl}/404`,
      destPath,
      taskId: "task-404",
    };

    const result = await new Promise<{ task: DownloadTask; status: string; error?: string }>((resolve) => {
      queue.onComplete = (t, status, error) => {
        resolve({ task: t, status, error });
      };
      queue.enqueue(task);
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("404");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("getStatus() returns correct structure", async () => {
    const queue = new DownloadQueue({ retryDelays: [50, 100, 200] });

    // Enqueue a successful task and a failing task, wait for both
    const dest1 = join(tempDir, "file1.bin");
    const dest2 = join(tempDir, "file2.bin");

    let completedCount = 0;
    const done = new Promise<void>((resolve) => {
      queue.onComplete = () => {
        completedCount++;
        if (completedCount === 2) resolve();
      };
    });

    queue.enqueue({ url: `${baseUrl}/ok`, destPath: dest1, taskId: "s1" });
    queue.enqueue({ url: `${baseUrl}/404`, destPath: dest2, taskId: "s2" });

    // Check status while processing — should have pending items
    const midStatus = queue.getStatus();
    // At minimum, pending + active should account for the tasks not yet completed
    expect(midStatus).toHaveProperty("active");
    expect(midStatus).toHaveProperty("pending");
    expect(midStatus).toHaveProperty("completed");
    expect(midStatus).toHaveProperty("failed");

    await done;

    const status = queue.getStatus();
    expect(status.active).toBeNull();
    expect(status.pending).toHaveLength(0);
    expect(status.completed).toContain("s1");
    expect(status.failed).toEqual([{ taskId: "s2", error: expect.stringContaining("404") }]);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("retries on 500 then fails after max retries", async () => {
    const queue = new DownloadQueue({ retryDelays: [50, 100, 200] });
    const destPath = join(tempDir, "server-error.bin");

    const task: DownloadTask = {
      url: `${baseUrl}/500`,
      destPath,
      taskId: "task-500",
    };

    const result = await new Promise<{ task: DownloadTask; status: string; error?: string }>((resolve) => {
      queue.onComplete = (t, status, error) => {
        resolve({ task: t, status, error });
      };
      queue.enqueue(task);
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("500");

    await rm(tempDir, { recursive: true, force: true });
  });
});
