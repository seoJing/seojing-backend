import { spawn, type ChildProcess } from "node:child_process";
import { LabError } from "./errors.js";

const modelProcesses = new Set<ChildProcess>();
let closing = false;
let shutdownInstalled = false;

export const modelShutdownStarted = (): boolean => closing;

export function trackModelProcess(child: ChildProcess): void {
  if (!child.pid) return;
  modelProcesses.add(child);
  child.once("close", () => {
    try {
      // Closing stdout does not prove that the entire detached group exited.
      process.kill(-child.pid!, 0);
      terminate(child);
      setTimeout(() => modelProcesses.delete(child), 1800).unref();
    } catch {
      modelProcesses.delete(child);
    }
  });
}

/** Installed only by the dedicated production launcher, never by tests/apps. */
export function installModelShutdown(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    for (const child of modelProcesses) terminate(child);
    // Keep the parent alive until group escalation has run, including groups
    // whose leader exits immediately. New model calls fail closed meanwhile.
    setTimeout(() => process.exit(0), 1800);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", () => {
    for (const child of modelProcesses) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already reaped. SIGKILL/host failure itself cannot run this hook.
      }
    }
  });
}

// Do not inherit server credentials (DB, Cloudflare, API keys) into a model CLI.
export function modelEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"].flatMap(
      (key) => (process.env[key] ? [[key, process.env[key]]] : []),
    ),
  );
}
export function terminate(child: ChildProcess): void {
  if (!child.pid) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 1500);
  timer.unref();
  // The leader can exit while a descendant still ignores SIGTERM. Keep the
  // process-group escalation alive through the grace period in that case.
}
export interface Command {
  binary: string;
  args: string[];
  cwd: string;
  input: string;
  timeoutMs: number;
  signal: AbortSignal;
}
export function runCommand(command: Command): Promise<string> {
  if (command.signal.aborted) return Promise.reject(new LabError("cancelled"));
  if (closing) return Promise.reject(new LabError("engine_unavailable", 503));
  return new Promise((resolve, reject) => {
    const child = spawn(command.binary, command.args, {
      cwd: command.cwd,
      env: modelEnvironment(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackModelProcess(child);
    let stdout = "";
    let bytes = 0;
    let failure: LabError | undefined;
    const stop = (code: string) => {
      failure ??= new LabError(code, 503);
      terminate(child);
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("engine_timeout"), command.timeoutMs);
    command.signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1_000_000) stop("engine_output_invalid");
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) stop("engine_output_invalid");
    });
    child.stdin.on("error", () => {
      /* exit handler reports failures */
    });
    child.on("error", () => {
      failure ??= new LabError("engine_unavailable", 503);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      command.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new LabError("engine_unavailable", 503));
      else resolve(stdout);
    });
    child.stdin.end(command.input);
  });
}
