// Framework-free browser adapter. Render block.text as text, never as HTML.
import type {
  JobView,
  Note,
  PrepareView,
  ReadingEvent,
  Question,
} from "./contracts.js";

export interface ReadingState {
  last_seq: number;
  events: ReadingEvent[];
  notes: Note[];
  questions: Question[];
  view: JobView | null;
}
export const emptyReading = (): ReadingState => ({
  last_seq: 0,
  events: [],
  notes: [],
  questions: [],
  view: null,
});
export function mergeJob(state: ReadingState, incoming: JobView): ReadingState {
  if (state.view && state.view.job_id !== incoming.job_id)
    throw new Error("job_changed");
  const fresh = incoming.events.filter((event) => event.seq > state.last_seq);
  fresh.forEach((event, index) => {
    if (event.seq !== state.last_seq + index + 1) throw new Error("event_gap");
  });
  const lastSeq = fresh.at(-1)?.seq ?? state.last_seq;
  if (incoming.next_seq !== lastSeq) throw new Error("event_gap");
  const events = [...state.events, ...fresh];
  const questions = new Map(
    state.questions.map((question) => [question.id, structuredClone(question)]),
  );
  for (const event of fresh) {
    if (event.type !== "question_updated") continue;
    if (incoming.generation.policy_version !== "readme-prefix-v2")
      throw new Error("question_policy_mismatch");
    const previous = questions.get(event.question_id);
    if (
      event.question.id !== event.question_id ||
      event.question.status !== event.status ||
      event.question.state_version !== event.state_version ||
      event.state_version !== (previous?.state_version ?? 0) + 1 ||
      event.previous_status !== (previous?.status ?? null) ||
      JSON.stringify(event.evidence_unit_ids) !==
        JSON.stringify(event.question.evidence_unit_ids ?? [])
    )
      throw new Error("question_state_gap");
    questions.set(event.question_id, structuredClone(event.question));
  }
  return {
    last_seq: lastSeq,
    events,
    notes: events.flatMap((event) =>
      event.type === "note" ? [event.note] : [],
    ),
    questions: [...questions.values()],
    view: incoming,
  };
}
export class LabClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
export interface ConnectionUpdate {
  status: "connected" | "reconnecting" | "disconnected";
  attempt: number;
  retry_in_ms: number;
  error: string | null;
}
const retryDelays = [1000, 2000, 4000];
function retryable(error: unknown): error is LabClientError {
  return (
    error instanceof LabClientError &&
    (error.status === 0 ||
      [408, 429, 500, 502, 503, 504].includes(error.status) ||
      (error.status >= 520 && error.status <= 527))
  );
}
export class ReadmeLabClient {
  constructor(
    private readonly base = "/api/readme/lab",
    private readonly token = "",
  ) {}
  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      cache: "no-store",
    }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      throw new LabClientError("upstream_unavailable", 0);
    });
    if (!response.ok) {
      // Proxies may return HTML. Never expose that body or leak SyntaxError to UI.
      const value: unknown = await response.json().catch(() => null);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new LabClientError(
        value &&
          typeof value === "object" &&
          "error" in value &&
          typeof value.error === "string"
          ? value.error
          : response.status >= 500
            ? "upstream_unavailable"
            : "request_failed",
        response.status,
      );
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (signal?.aborted) throw error;
      // A stream can fail after headers arrived; a JSON SyntaxError is different.
      if (error instanceof TypeError)
        throw new LabClientError("upstream_unavailable", 0);
      throw new LabClientError("response_invalid", response.status);
    }
  }
  session(
    invite_code: string,
    cloud_consent: boolean,
    signal?: AbortSignal,
    consent_version?: string,
  ): Promise<{ access_token: string; expires_at: string }> {
    return this.request(
      "/session",
      "POST",
      {
        invite_code,
        cloud_consent,
        ...(consent_version !== undefined ? { consent_version } : {}),
      },
      signal,
    );
  }
  prepare(
    input: {
      job_text: string;
      resume_filename: string;
      resume_media_type: string;
      resume_base64: string;
    },
    signal?: AbortSignal,
  ): Promise<PrepareView> {
    return this.request("/prepare", "POST", input, signal);
  }
  getPrepare(id: string, signal?: AbortSignal): Promise<PrepareView> {
    return this.request(
      `/prepare/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      signal,
    );
  }
  start(prepare: PrepareView, signal?: AbortSignal): Promise<JobView> {
    return this.request(
      "/jobs",
      "POST",
      {
        prepare_id: prepare.prepare_id,
        input_hash: prepare.input_hash,
        confirmed: true,
      },
      signal,
    );
  }
  getJob(id: string, afterSeq = 0, signal?: AbortSignal): Promise<JobView> {
    return this.request(
      `/jobs/${encodeURIComponent(id)}?after_seq=${afterSeq}`,
      "GET",
      undefined,
      signal,
    );
  }
  cancel(id: string): Promise<void> {
    return this.request(`/jobs/${encodeURIComponent(id)}`, "DELETE");
  }
  discardPrepare(id: string): Promise<void> {
    return this.request(`/prepare/${encodeURIComponent(id)}`, "DELETE");
  }
  async *watchJob(
    id: string,
    signal: AbortSignal,
    onConnection?: (update: ConnectionUpdate) => void,
  ): AsyncGenerator<ReadingState, void, unknown> {
    let state = emptyReading();
    let failures = 0;
    while (!signal.aborted) {
      let incoming: JobView;
      try {
        incoming = await this.pollJob(id, state.last_seq, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const retryIn = retryable(error) ? retryDelays[failures] : undefined;
        if (retryIn === undefined) {
          onConnection?.({
            status: "disconnected",
            attempt: failures,
            retry_in_ms: 0,
            error:
              error instanceof LabClientError ? error.code : "request_failed",
          });
          throw error;
        }
        failures++;
        onConnection?.({
          status: "reconnecting",
          attempt: failures,
          retry_in_ms: retryIn,
          error: (error as LabClientError).code,
        });
        await delay(retryIn, signal);
        continue;
      }
      // Integrity failures are not transport failures; never retry or skip a gap.
      state = mergeJob(state, incoming);
      onConnection?.({
        status: "connected",
        attempt: failures,
        retry_in_ms: 0,
        error: null,
      });
      failures = 0;
      yield state;
      if (
        state.view &&
        ["completed", "failed", "cancelled"].includes(state.view.status)
      )
        return;
      await delay(1000, signal);
    }
  }
  private async pollJob(
    id: string,
    cursor: number,
    signal: AbortSignal,
  ): Promise<JobView> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    // Four attempts + backoff finish within the server's 60-second idle budget.
    const timer = setTimeout(abort, 10_000);
    try {
      return await this.getJob(id, cursor, controller.signal);
    } catch (error) {
      if (!signal.aborted && controller.signal.aborted)
        throw new LabClientError("upstream_unavailable", 0);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
