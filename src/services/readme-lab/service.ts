import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ReadmeUploadInput } from "../readme-upload.js";
import type {
  EventPayload,
  JobView,
  Note,
  PrepareView,
  Question,
  ResumeDocument,
} from "./contracts.js";
import type { Reasoner } from "./codex.js";
import type { Classifier } from "./laya.js";
import type { JevReader } from "./jev.js";
import { readSemanticPrefix } from "./semantic-reader.js";
import { LabError, errorCode, preparationFailureReason } from "./errors.js";
import { judgePrefix } from "./judgment.js";
import {
  createMemory,
  finishReading,
  readPrefix,
  type ReaderMemory,
} from "./reader.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const id = () => randomBytes(24).toString("base64url");
interface Session {
  owner: string;
  invitation: string;
  expires: number;
}
interface Owned {
  owner: string;
  controller: AbortController;
  expires: number;
  lastPoll: number;
}
interface Preparation extends Owned {
  view: PrepareView;
  jobId?: string;
}
interface Reading extends Owned {
  view: JobView;
  preparation: Preparation;
  notes: Note[];
  questions: Question[];
  memory?: ReaderMemory;
}
export interface LabOptions {
  invitations: string[];
  reasoner: Reasoner;
  parse: (
    input: ReadmeUploadInput,
    signal: AbortSignal,
  ) => Promise<ResumeDocument>;
  classifier?: (signal: AbortSignal) => Promise<Classifier>;
  jev?: (signal: AbortSignal) => Promise<JevReader>;
  dailyLimit?: number;
  now?: () => number;
  ttlMs?: number;
  leaseMs?: number;
  onPrepareFailure?: (event: {
    stage: "document" | "profile";
    reason: string;
    elapsed_ms: number;
  }) => void;
}

export class ReadmeLab {
  private readonly sessions = new Map<string, Session>();
  private readonly preparations = new Map<string, Preparation>();
  private readonly readings = new Map<string, Reading>();
  private readonly quota = new Map<string, { day: number; count: number }>();
  private readonly invitations: Buffer[];
  private readonly clock: () => number;
  private readonly ttl: number;
  private readonly lease: number;
  private readonly janitor: ReturnType<typeof setInterval>;
  private readonly queue: Array<{
    signal: AbortSignal;
    work: () => Promise<void>;
  }> = [];
  private active = false;
  private closed = false;
  constructor(private readonly options: LabOptions) {
    if (Boolean(options.classifier) === Boolean(options.jev))
      throw new Error("Exactly one Lab reading engine must be configured");
    if (
      !options.invitations.length ||
      options.invitations.some((code) => code.length < 16)
    )
      throw new Error(
        "README lab requires invitation codes of at least 16 characters",
      );
    this.invitations = options.invitations.map((code) =>
      Buffer.from(hash(code), "hex"),
    );
    this.clock = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 2 * 60 * 60 * 1000;
    this.lease = options.leaseMs ?? 60000;
    this.janitor = setInterval(() => this.sweep(), 10000);
    this.janitor.unref();
  }
  session(
    code: string,
    consent: boolean,
    consentVersion?: string,
  ): { access_token: string; expires_at: string } {
    this.sweep();
    const candidate = Buffer.from(hash(code), "hex");
    if (!this.invitations.some((value) => timingSafeEqual(value, candidate)))
      throw new LabError("invite_invalid", 401);
    if (!consent || (this.options.jev && consentVersion !== "readme-jev-v1"))
      throw new LabError("cloud_consent_required", 400);
    if (this.sessions.size >= 200) throw new LabError("queue_full", 429);
    const token = id();
    const expires = this.clock() + this.ttl;
    this.sessions.set(hash(token), {
      owner: id(),
      invitation: candidate.toString("hex"),
      expires,
    });
    return { access_token: token, expires_at: new Date(expires).toISOString() };
  }
  authenticate(token: string): Session {
    const session = this.sessions.get(hash(token));
    if (!session || session.expires <= this.clock())
      throw new LabError("invite_invalid", 401);
    return session;
  }
  private owned<T extends Owned>(value: T | undefined, session: Session): T {
    if (!value || value.owner !== session.owner)
      throw new LabError("not_found", 404);
    if (value.expires <= this.clock()) throw new LabError("expired", 410);
    value.lastPoll = this.clock();
    return value;
  }
  private ensureRoom(): void {
    if (this.closed) throw new LabError("engine_unavailable", 503);
    // Cancelled queued work must release capacity immediately, even while a
    // slow active model call is still finishing. Active work retains its slot.
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i]!.signal.aborted) this.queue.splice(i, 1);
    if (this.queue.length + Number(this.active) >= 4)
      throw new LabError("queue_full", 429);
  }
  private enqueue(signal: AbortSignal, work: () => Promise<void>): void {
    this.queue.push({ signal, work });
    this.pump();
  }
  private pump(): void {
    if (this.active || this.closed) return;
    let next = this.queue.shift();
    while (next?.signal.aborted) next = this.queue.shift();
    if (!next) return;
    this.active = true;
    void next
      .work()
      .catch(() => undefined)
      .finally(() => {
        this.active = false;
        this.pump();
      });
  }
  prepare(session: Session, input: ReadmeUploadInput): PrepareView {
    this.ensureRoom();
    const day = Math.floor(this.clock() / 86400000);
    const quota = this.quota.get(session.invitation);
    const count = quota?.day === day ? quota.count : 0;
    if (count >= (this.options.dailyLimit ?? 3))
      throw new LabError("daily_limit_reached", 429);
    this.quota.set(session.invitation, { day, count: count + 1 });
    const prepareId = id();
    const expires = Math.min(session.expires, this.clock() + this.ttl);
    const value: Preparation = {
      owner: session.owner,
      expires,
      lastPoll: this.clock(),
      controller: new AbortController(),
      view: {
        prepare_id: prepareId,
        input_hash: hash(JSON.stringify(input)),
        status: "queued",
        expires_at: new Date(expires).toISOString(),
      },
    };
    this.preparations.set(prepareId, value);
    this.enqueue(value.controller.signal, async () => {
      if (value.controller.signal.aborted) return;
      const timer = setTimeout(() => value.controller.abort(), 180000);
      const started = this.clock();
      let stage: "document" | "profile" = "document";
      try {
        value.view.status = "extracting";
        const document = await this.options.parse(
          input,
          value.controller.signal,
        );
        if (value.controller.signal.aborted) return;
        value.view.document = document;
        value.view.status = "analyzing_job";
        stage = "profile";
        const job = await this.options.reasoner.profile(
          input.job_text,
          value.controller.signal,
        );
        if (value.controller.signal.aborted) return;
        value.view.job = job;
        value.view.status = "ready";
      } catch (error) {
        try {
          this.options.onPrepareFailure?.({
            stage,
            reason: preparationFailureReason(error),
            elapsed_ms: this.clock() - started,
          });
        } catch {
          /* Telemetry must not change the preparation outcome. */
        }
        if (value.view.status !== "cancelled") {
          value.view.status = "failed";
          value.view.error = errorCode(error);
        }
      } finally {
        clearTimeout(timer);
        if (
          value.controller.signal.aborted &&
          value.view.status !== "cancelled"
        ) {
          value.view.status = "failed";
          value.view.error = "engine_timeout";
        }
      }
    });
    return structuredClone(value.view);
  }
  getPrepare(session: Session, prepareId: string): PrepareView {
    return structuredClone(
      this.owned(this.preparations.get(prepareId), session).view,
    );
  }
  cancelPrepare(session: Session, prepareId: string): void {
    const value = this.owned(this.preparations.get(prepareId), session);
    if (value.jobId) this.cancel(session, value.jobId);
    value.view.status = "cancelled";
    value.controller.abort();
    delete value.view.document;
    delete value.view.job;
  }
  start(
    session: Session,
    prepareId: string,
    inputHash: string,
    confirmed: boolean,
  ): JobView {
    const preparation = this.owned(this.preparations.get(prepareId), session);
    if (!confirmed) throw new LabError("confirmation_required", 400);
    if (preparation.view.input_hash !== inputHash)
      throw new LabError("prepare_input_changed", 409);
    if (
      preparation.view.status !== "ready" ||
      !preparation.view.document ||
      !preparation.view.job
    )
      throw new LabError("prepare_not_ready", 409);
    if (preparation.jobId) return this.getJob(session, preparation.jobId, 0);
    this.ensureRoom();
    const jobId = id();
    const document = preparation.view.document;
    const job = preparation.view.job;
    if (this.options.jev && !job.reader_profile)
      throw new LabError("engine_input_invalid", 503);
    const reading: Reading = {
      owner: session.owner,
      expires: preparation.expires,
      lastPoll: this.clock(),
      controller: new AbortController(),
      preparation,
      notes: [],
      questions: [],
      ...(job.reader_profile
        ? { memory: createMemory(job, this.options.jev ? "jev" : "laya") }
        : {}),
      view: {
        job_id: jobId,
        status: "queued",
        events: [],
        next_seq: 0,
        progress: {
          read_unit_count: 0,
          total_unit_count: document.units.length,
          current_window: null,
        },
        report: null,
        error: null,
        generation: {
          engine: this.options.jev ? "jev" : "laya",
          policy_version: job.reader_profile
            ? "readme-prefix-v2"
            : "readme-prefix-v1",
          model: this.options.jev
            ? {
                model: "jev-1.13.0",
                provider: "typesafe",
                execution: "remote",
                calibrated_for_readme: false,
              }
            : null,
          prepare_engine: "codex_cli",
          report_engine: "codex_cli",
          codex_model: this.options.reasoner.model,
        },
        expires_at: preparation.view.expires_at,
      },
    };
    preparation.jobId = jobId;
    this.readings.set(jobId, reading);
    this.enqueue(reading.controller.signal, async () => {
      if (reading.controller.signal.aborted) return;
      let classifier: Classifier | undefined;
      let jev: JevReader | undefined;
      const timer = setTimeout(
        () => reading.controller.abort(),
        10 * 60 * 1000,
      );
      try {
        reading.view.status = "reading";
        if (this.options.jev) {
          jev = await this.options.jev(reading.controller.signal);
          reading.view.generation.model = jev.metadata;
        } else {
          classifier = await this.options.classifier!(
            reading.controller.signal,
          );
          reading.view.generation.model = classifier.metadata;
        }
        for (let i = 0; i < document.units.length; i++) {
          if (reading.controller.signal.aborted)
            throw new LabError("cancelled");
          const windowId = `w${i + 1}`;
          const unitIds = [document.units[i]!.id];
          reading.view.progress.current_window = windowId;
          this.emit(reading, {
            type: "window_started",
            window_id: windowId,
            unit_ids: unitIds,
          });
          if (jev && reading.memory)
            await readSemanticPrefix(
              document.units.slice(0, i + 1),
              job,
              jev,
              reading.memory,
              reading.notes,
              reading.questions,
              (event) => this.emit(reading, event),
              reading.controller.signal,
            );
          else if (reading.memory)
            await readPrefix(
              document.units.slice(0, i + 1),
              job,
              classifier!,
              reading.memory,
              reading.notes,
              reading.questions,
              (event) => this.emit(reading, event),
            );
          else
            await judgePrefix(
              document.units.slice(0, i + 1),
              job,
              classifier!,
              reading.notes,
              reading.questions,
              (event) => this.emit(reading, event),
            );
          if (reading.controller.signal.aborted)
            throw new LabError("cancelled");
          reading.view.progress.read_unit_count = i + 1;
          this.emit(reading, {
            type: "window_completed",
            window_id: windowId,
            unit_ids: unitIds,
          });
        }
        classifier?.close();
        if (jev?.contextReviews && reading.memory)
          reading.memory.context_reviews = structuredClone(jev.contextReviews);
        jev?.close();
        jev = undefined;
        classifier = undefined;
        if (reading.memory)
          finishReading(reading.memory, reading.questions, (event) =>
            this.emit(reading, event),
          );
        reading.view.progress.current_window = null;
        this.emit(reading, { type: "reading_completed" });
        reading.view.status = "reporting";
        const report = await this.options.reasoner.report(
          document,
          job,
          reading.notes,
          reading.questions,
          reading.controller.signal,
          reading.memory,
        );
        if (reading.controller.signal.aborted) throw new LabError("cancelled");
        reading.view.report = report;
        reading.view.status = "completed";
        this.emit(reading, { type: "report_completed" });
      } catch (error) {
        if (reading.view.status !== "cancelled") {
          reading.view.status = "failed";
          reading.view.error = reading.controller.signal.aborted
            ? "engine_timeout"
            : errorCode(error);
          this.emit(reading, {
            type: "failed",
            error: reading.view.error,
            partial: reading.view.progress.read_unit_count > 0,
          });
        }
      } finally {
        classifier?.close();
        jev?.close();
        clearTimeout(timer);
      }
    });
    return this.getJob(session, jobId, 0);
  }
  private emit(reading: Reading, event: EventPayload): void {
    if (reading.view.status === "cancelled" && event.type !== "cancelled")
      return;
    reading.view.events.push({ ...event, seq: ++reading.view.next_seq });
  }
  getJob(session: Session, jobId: string, afterSeq: number): JobView {
    const view = this.owned(this.readings.get(jobId), session).view;
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      afterSeq > view.next_seq
    )
      throw new LabError("invalid_cursor", 400);
    return structuredClone({
      ...view,
      events: view.events.filter((event) => event.seq > afterSeq),
    });
  }
  cancel(session: Session, jobId: string): void {
    const reading = this.owned(this.readings.get(jobId), session);
    if (["completed", "failed", "cancelled"].includes(reading.view.status))
      return;
    reading.view.status = "cancelled";
    reading.view.error = "cancelled";
    reading.controller.abort();
    this.emit(reading, { type: "cancelled" });
  }
  sweep(): void {
    const now = this.clock();
    for (const [key, session] of this.sessions)
      if (session.expires <= now) this.sessions.delete(key);
    for (const [key, value] of this.preparations) {
      if (value.expires <= now) {
        value.controller.abort();
        this.preparations.delete(key);
      } else if (
        ["queued", "extracting", "analyzing_job"].includes(value.view.status) &&
        now - value.lastPoll > this.lease
      ) {
        value.view.status = "cancelled";
        value.view.error = "expired";
        value.controller.abort();
      }
    }
    for (const [key, value] of this.readings) {
      if (value.expires <= now) {
        value.controller.abort();
        this.readings.delete(key);
      } else if (
        ["queued", "reading", "reporting"].includes(value.view.status) &&
        now - value.lastPoll > this.lease
      ) {
        value.view.status = "cancelled";
        value.view.error = "expired";
        value.controller.abort();
        this.emit(value, { type: "cancelled" });
      }
    }
  }
  close(): void {
    this.closed = true;
    clearInterval(this.janitor);
    for (const value of [
      ...this.preparations.values(),
      ...this.readings.values(),
    ])
      value.controller.abort();
    this.queue.length = 0;
    this.sessions.clear();
    this.preparations.clear();
    this.readings.clear();
  }
}
