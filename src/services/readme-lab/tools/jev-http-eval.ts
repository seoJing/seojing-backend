/** Synthetic, opt-in real-provider loopback queue/quality probe. Never deploys. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import Fastify from "fastify";
import { registerReadmeLabRoutes } from "../../../routes/readme-lab.js";
import { CodexReasoner } from "../codex.js";
import type { JobView, PrepareView } from "../contracts.js";
import { openJev } from "../jev.js";
import { parseDocument } from "../parser.js";
import { ReadmeLab } from "../service.js";

assert(process.argv.includes("--allow-remote-synthetic"));
const argument = (name: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const output = argument("out");
assert(output, "output_directory_required");
const out = resolve(output);
await mkdir(out, { recursive: false });
const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
assert(key && key.length >= 16, "jev_key_missing");
const save = (name: string, value: unknown) =>
  writeFile(resolve(out, name), JSON.stringify(value, null, 2) + "\n");
const hashes: Record<string, string> = {};
const root = resolve("src/services/readme-lab");
async function freeze(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "__pycache__") await freeze(path);
    else if (entry.isFile() && /\.(ts|py)$/u.test(entry.name)) {
      const name = relative(root, path),
        bytes = await readFile(path);
      hashes[name] = createHash("sha256").update(bytes).digest("hex");
      const frozen = resolve(out, "source", name);
      await mkdir(dirname(frozen), { recursive: true });
      await writeFile(frozen, bytes);
    }
  }
}
await freeze(root);
const routeBytes = await readFile("src/routes/readme-lab.ts");
await writeFile(resolve(out, "source", "http-route.ts"), routeBytes);
hashes["http-route.ts"] = createHash("sha256").update(routeBytes).digest("hex");
const fixturePaths = [
  "test/fixtures/readme/jev-realistic-50-v1.json",
  "test/fixtures/readme/jev-launch-regression-v1.json",
];
const fixtures = await Promise.all(
  fixturePaths.map(async (path) => {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      synthetic: boolean;
      human_reviewed: boolean;
      text: string;
      job_text: string;
    };
    assert(value.synthetic === true && value.human_reviewed === false);
    assert(
      typeof value.text === "string" && typeof value.job_text === "string",
    );
    return value;
  }),
);
await save("freeze.json", {
  synthetic: true,
  human_reviewed: false,
  source_sha256: hashes,
  fixtures,
  scenario:
    "two simultaneous clients, serial service queue; two queued cancellations and overflow; real models",
});
const start = Date.now(),
  elapsed = () => Date.now() - start;
const spans: Array<{ phase: string; start_ms: number; end_ms?: number }> = [];
const providerFailures: Array<{ code: string; at_ms: number }> = [];
const usage: Array<{
  calls: number;
  input_tokens: number;
  output_tokens: number;
  omitted_proofs: number;
}> = [];
let activePhases = 0,
  maxActivePhases = 0;
function phase(name: string) {
  const span: (typeof spans)[number] = { phase: name, start_ms: elapsed() };
  spans.push(span);
  activePhases++;
  maxActivePhases = Math.max(activePhases, maxActivePhases);
  return () => {
    span.end_ms = elapsed();
    activePhases--;
  };
}
const codex = new CodexReasoner(
  process.env.README_CODEX_BIN ?? "/opt/homebrew/bin/codex",
  process.env.README_CODEX_MODEL,
);
const invites = Array.from({ length: 5 }, () =>
  randomBytes(24).toString("base64url"),
);
const lab = new ReadmeLab({
  invitations: invites,
  parse: async (...args) => {
    const end = phase("parse");
    try {
      return await parseDocument(...args);
    } finally {
      end();
    }
  },
  reasoner: {
    model: codex.model,
    profile: async (...args) => {
      const end = phase("profile");
      try {
        return await codex.profile(...args);
      } finally {
        end();
      }
    },
    report: async (...args) => {
      const end = phase("report");
      try {
        return await codex.report(...args);
      } finally {
        end();
      }
    },
  },
  jev: async (signal) => {
    const end = phase("reading");
    try {
      const reader = await openJev(signal, {
        apiKey: key,
        script: resolve(out, "source", "python", "jev_runtime.py"),
        onFailure: (code) => providerFailures.push({ code, at_ms: elapsed() }),
      });
      let closed = false;
      return {
        metadata: reader.metadata,
        metrics: reader.metrics,
        readStep: (input, stepSignal) => reader.readStep(input, stepSignal),
        close() {
          if (closed) return;
          closed = true;
          usage.push({ ...reader.metrics });
          reader.close();
          end();
        },
      };
    } catch (error) {
      end();
      throw error;
    }
  },
});
const app = Fastify({ logger: false });
registerReadmeLabRoutes(app, lab);
const base = await app.listen({ host: "127.0.0.1", port: 0 });
const requests: Array<{
  method: string;
  route: string;
  status: number;
  ms: number;
  at_ms: number;
}> = [];
// Required completion checks start false so preparation failure cannot pass
// merely because no job assertions were reached.
const assertions: Record<string, boolean> = {
  completed_0: false,
  completed_1: false,
};
const tokens: string[] = [];
async function request<T>(
  method: string,
  path: string,
  owner: number,
  body?: unknown,
) {
  const begin = elapsed();
  const response = await fetch(base + "/readme/lab" + path, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(tokens[owner] ? { authorization: `Bearer ${tokens[owner]}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value =
    response.status === 204 ? undefined : ((await response.json()) as T);
  requests.push({
    method,
    route: path.replace(/\/(prepare|jobs)\/[^/?]+/u, "/$1/:id"),
    status: response.status,
    ms: elapsed() - begin,
    at_ms: begin,
  });
  assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
  return { status: response.status, value: value as T };
}
const input = (n: number) => ({
  job_text: fixtures[n]!.job_text,
  resume_filename: `synthetic-${n}.md`,
  resume_media_type: "text/markdown",
  resume_base64: Buffer.from(fixtures[n]!.text).toString("base64"),
});
const histories: Array<
  Array<{ phase: string; status: string; at_ms: number }>
> = [[], []];
const results: unknown[] = [];
let failure: string | undefined;
try {
  for (let owner = 0; owner < invites.length; owner++) {
    const session = await request<{ access_token: string }>(
      "POST",
      "/session",
      owner,
      {
        invite_code: invites[owner],
        cloud_consent: true,
        consent_version: "readme-jev-v1",
      },
    );
    assert.equal(session.status, 200);
    tokens[owner] = session.value.access_token;
  }
  const preparations: PrepareView[] = [];
  for (let owner = 0; owner < 4; owner++) {
    const response = await request<PrepareView>(
      "POST",
      "/prepare",
      owner,
      input(owner === 0 ? 0 : 1),
    );
    assert.equal(response.status, 202);
    preparations.push(response.value);
  }
  const overflow = await request<{ error: string }>(
    "POST",
    "/prepare",
    4,
    input(1),
  );
  assertions.fifth_request_rejected =
    overflow.status === 429 && overflow.value.error === "queue_full";
  for (const method of ["GET", "DELETE"])
    assertions[`foreign_prepare_${method}_denied`] =
      (await request(method, `/prepare/${preparations[0]!.prepare_id}`, 1))
        .status === 404;
  for (const owner of [2, 3]) {
    assert.equal(
      (
        await request(
          "DELETE",
          `/prepare/${preparations[owner]!.prepare_id}`,
          owner,
        )
      ).status,
      204,
    );
    const cancelled = await request<PrepareView>(
      "GET",
      `/prepare/${preparations[owner]!.prepare_id}`,
      owner,
    );
    assertions[`queued_cancel_${owner}`] =
      cancelled.value.status === "cancelled";
  }
  const replacement = await request<PrepareView>(
    "POST",
    "/prepare",
    4,
    input(1),
  );
  assertions.cancelled_slot_reusable = replacement.status === 202;
  assert.equal(replacement.status, 202);
  assert.equal(
    (await request("DELETE", `/prepare/${replacement.value.prepare_id}`, 4))
      .status,
    204,
  );
  async function client(owner: number) {
    let prep = preparations[owner]!;
    let last = "";
    while (true) {
      if (prep.status !== last) {
        histories[owner]!.push({
          phase: "prepare",
          status: prep.status,
          at_ms: elapsed(),
        });
        last = prep.status;
        console.log(
          JSON.stringify({
            owner,
            phase: "prepare",
            status: prep.status,
            at_ms: elapsed(),
          }),
        );
      }
      if (["ready", "failed", "cancelled"].includes(prep.status)) break;
      assert(elapsed() < 20 * 60 * 1000, "overall_deadline");
      await pause(1000);
      const polled = await request<PrepareView>(
        "GET",
        `/prepare/${prep.prepare_id}`,
        owner,
      );
      assert.equal(polled.status, 200);
      prep = polled.value;
    }
    if (prep.status !== "ready") return { owner, preparation: prep };
    const body = {
      prepare_id: prep.prepare_id,
      input_hash: prep.input_hash,
      confirmed: true,
    };
    const [started, again] = await Promise.all([
      request<JobView>("POST", "/jobs", owner, body),
      request<JobView>("POST", "/jobs", owner, body),
    ]);
    assert.equal(started.status, 202);
    let view = started.value;
    assert.equal(view.generation.engine, "jev");
    assertions[`idempotent_start_${owner}`] =
      again.status === 202 && again.value.job_id === view.job_id;
    for (const method of ["GET", "DELETE"])
      assertions[`foreign_job_${owner}_${method}_denied`] =
        (await request(method, `/jobs/${view.job_id}`, 1 - owner)).status ===
        404;
    const events = [...view.events];
    let cursor = view.next_seq;
    last = "";
    while (true) {
      if (view.status !== last) {
        histories[owner]!.push({
          phase: "job",
          status: view.status,
          at_ms: elapsed(),
        });
        last = view.status;
        console.log(
          JSON.stringify({
            owner,
            phase: "job",
            status: view.status,
            at_ms: elapsed(),
          }),
        );
      }
      if (["completed", "failed", "cancelled"].includes(view.status)) break;
      assert(elapsed() < 20 * 60 * 1000, "overall_deadline");
      await pause(1000);
      const polled = await request<JobView>(
        "GET",
        `/jobs/${view.job_id}?after_seq=${cursor}`,
        owner,
      );
      assert.equal(polled.status, 200);
      view = polled.value;
      events.push(...view.events);
      cursor = view.next_seq;
    }
    assertions[`ordered_unique_events_${owner}`] =
      events.every((e, i) => e.seq === i + 1) &&
      events.length === view.next_seq;
    assertions[`completed_${owner}`] = view.status === "completed";
    const result = {
      owner,
      preparation: prep,
      job: { ...view, events },
      elapsed_ms: elapsed(),
    };
    await save(`client-${owner}.json`, result);
    return result;
  }
  const clients = await Promise.allSettled([client(0), client(1)]);
  for (const [owner, result] of clients.entries()) {
    if (result.status === "fulfilled") results.push(result.value);
    else {
      assertions[`completed_${owner}`] = false;
      results.push({ owner, error: "client_probe_failed" });
    }
  }
  assertions.only_two_profiles =
    spans.filter((span) => span.phase === "profile").length === 2;
  assertions.serial_execution = maxActivePhases === 1;
  assertions.cancelled_work_not_run =
    spans.filter((span) => span.phase === "parse").length === 2;
} catch (error) {
  failure =
    error instanceof Error ? error.name + ": " + error.message : "probe_failed";
} finally {
  lab.close();
  await app.close();
  await save("run.json", {
    synthetic: true,
    human_reviewed: false,
    http_serving_tested: true,
    public_serving_tested: false,
    results,
    assertions,
    histories,
    spans,
    max_active_phases: maxActivePhases,
    provider_failures: providerFailures,
    usage,
    requests,
    elapsed_ms: elapsed(),
    failure,
    transport_passed: !failure && Object.values(assertions).every(Boolean),
    semantic_quality_requires_review: true,
  });
}
console.log(
  JSON.stringify({
    stage: "completed",
    assertions,
    failure,
    elapsed_ms: elapsed(),
    usage,
  }),
);
if (failure || !Object.values(assertions).every(Boolean)) process.exitCode = 1;
