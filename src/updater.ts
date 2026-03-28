import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface UpdateResult {
  updated: boolean;
  previousHead: string;
  currentHead: string;
  restarting: boolean;
}

export async function checkAndUpdate(
  repoDir: string,
): Promise<UpdateResult> {
  const { stdout: prevHead } = await execFile(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoDir },
  );

  await execFile("git", ["pull", "origin", "main"], { cwd: repoDir });

  const { stdout: newHead } = await execFile(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoDir },
  );

  const previousHead = prevHead.trim().slice(0, 8);
  const currentHead = newHead.trim().slice(0, 8);
  const updated = previousHead !== currentHead;

  if (updated) {
    await execFile("pnpm", ["install", "--frozen-lockfile"], {
      cwd: repoDir,
    });
    await execFile("pnpm", ["build"], { cwd: repoDir });
    setTimeout(() => {
      execFile("pm2", ["restart", "comfy-sidecar"]).catch((err) => {
        console.error("pm2 restart failed:", err);
      });
    }, 500);
  }

  return { updated, previousHead, currentHead, restarting: updated };
}
