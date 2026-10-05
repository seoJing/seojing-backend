import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { expect, it } from "vitest";
import { terminate } from "../src/services/readme-lab/process.js";

it("kills a SIGTERM-resistant descendant after its process leader exits", async () => {
  const descendant = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require('node:child_process');
       const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
       child.once('message', () => process.stdout.write(String(child.pid) + '\\n'));
       setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  let descendantPid: number | undefined;
  try {
    const [message] = (await once(leader.stdout, "data")) as [Buffer];
    descendantPid = Number(message.toString().trim());
    expect(descendantPid).toBeGreaterThan(1);
    const closed = once(leader, "close");
    terminate(leader);
    await closed;
    // The direct process has closed, but its descendant needs escalation.
    expect(() => process.kill(descendantPid!, 0)).not.toThrow();
    await pause(1900);
    expect(() => process.kill(descendantPid!, 0)).toThrow();
  } finally {
    for (const pid of [-leader.pid!, descendantPid]) {
      if (!pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already reaped.
      }
    }
  }
});

it("drains detached model groups and rejects late work on launcher shutdown", async () => {
  const processModule = new URL(
    "../src/services/readme-lab/process.ts",
    import.meta.url,
  ).href;
  const descendant = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
  const model = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', () => process.stdout.write(String(child.pid) + '\\n'));
    setInterval(() => {}, 1000);`;
  const server = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { spawn } from 'node:child_process';
    import { installModelShutdown, trackModelProcess, runCommand } from ${JSON.stringify(processModule)};
    installModelShutdown();
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(model)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    trackModelProcess(child);
    child.stdout.on('data', data => process.stdout.write(String(child.pid) + ':' + data));
    process.on('SIGTERM', () => {
      runCommand({ binary: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), input: '', timeoutMs: 1000, signal: new AbortController().signal })
        .then(() => process.stdout.write('late-work-started'))
        .catch(error => process.stdout.write(error.code));
    });
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let modelPid: number | undefined;
  let descendantPid: number | undefined;
  try {
    const [message] = (await once(server.stdout, "data")) as [Buffer];
    [modelPid, descendantPid] = message
      .toString()
      .trim()
      .split(":")
      .map(Number);
    expect(descendantPid).toBeGreaterThan(1);
    let output = "";
    server.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    const closed = once(server, "close");
    server.kill("SIGTERM");
    await closed;
    expect(output).toContain("engine_unavailable");
    expect(output).not.toContain("late-work-started");
    expect(() => process.kill(modelPid!, 0)).toThrow();
    expect(() => process.kill(descendantPid!, 0)).toThrow();
  } finally {
    for (const pid of [server.pid, modelPid && -modelPid, descendantPid]) {
      if (!pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already reaped */
      }
    }
  }
});
