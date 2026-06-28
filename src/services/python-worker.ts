export type PythonWorkerTaskKind = "tts" | "qa" | "rag";

export interface PythonWorkerClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  retryAttempts?: number;
  fetchImpl?: typeof fetch;
}

export interface PythonWorkerRequestOptions {
  requestId?: string;
  signal?: AbortSignal;
}

export interface PythonWorkerHealth {
  status: "ok" | "degraded";
  worker: "seojing-python-worker";
  version?: string;
  capabilities: PythonWorkerTaskKind[];
}

export interface PythonWorkerTaskResponse<T = unknown> {
  requestId?: string;
  result: T;
}

export type PythonWorkerErrorCode =
  | "invalid_config"
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "upstream_error"
  | "bad_response";

export class PythonWorkerError extends Error {
  constructor(
    public readonly code: PythonWorkerErrorCode,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "PythonWorkerError";
  }
}

export class PythonWorkerClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PythonWorkerClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    assertLoopbackWorkerUrl(this.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retryAttempts = options.retryAttempts ?? 1;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(
    options: PythonWorkerRequestOptions = {},
  ): Promise<PythonWorkerHealth> {
    return this.request<PythonWorkerHealth>("/health", {
      method: "GET",
      options,
      retryable: true,
    });
  }

  async invoke<TResponse = unknown>(
    kind: PythonWorkerTaskKind,
    payload: unknown,
    options: PythonWorkerRequestOptions = {},
  ): Promise<PythonWorkerTaskResponse<TResponse>> {
    return this.request<PythonWorkerTaskResponse<TResponse>>(
      `/v1/tasks/${kind}`,
      {
        method: "POST",
        body: JSON.stringify({ requestId: options.requestId, payload }),
        headers: { "content-type": "application/json" },
        options,
        retryable: false,
      },
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit & {
      options: PythonWorkerRequestOptions;
      retryable: boolean;
    },
  ): Promise<T> {
    const attempts = init.retryable ? Math.max(this.retryAttempts, 1) : 1;
    let lastError: PythonWorkerError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.requestOnce<T>(path, init);
      } catch (error) {
        const mapped = mapWorkerError(error);
        if (!init.retryable || !isRetryable(mapped) || attempt === attempts) {
          throw mapped;
        }
        lastError = mapped;
      }
    }

    throw (
      lastError ??
      new PythonWorkerError("unavailable", "Python worker request failed.")
    );
  }

  private async requestOnce<T>(
    path: string,
    init: RequestInit & { options: PythonWorkerRequestOptions },
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = init.options.signal
      ? AbortSignal.any([init.options.signal, timeoutSignal])
      : timeoutSignal;

    const response = await this.fetchImpl(url, {
      method: init.method,
      headers: {
        accept: "application/json",
        "x-seojing-internal-worker": "python",
        ...(init.options.requestId
          ? { "x-request-id": init.options.requestId }
          : {}),
        ...init.headers,
      },
      body: init.body,
      signal,
    });

    if (!response.ok) {
      throw new PythonWorkerError(
        response.status >= 500 ? "upstream_error" : "bad_response",
        `Python worker responded with HTTP ${response.status}.`,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new PythonWorkerError(
        "bad_response",
        "Python worker returned a non-JSON response.",
        response.status,
      );
    }
  }
}

export function assertLoopbackWorkerUrl(url: URL): void {
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!allowedHosts.has(url.hostname)) {
    throw new PythonWorkerError(
      "invalid_config",
      "Python worker URL must be loopback-only. Expose SEOJing through the Node API, not a public Python worker port.",
    );
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new PythonWorkerError(
      "invalid_config",
      "Python worker URL must use http or https.",
    );
  }
}

function mapWorkerError(error: unknown): PythonWorkerError {
  if (error instanceof PythonWorkerError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new PythonWorkerError(
      "cancelled",
      "Python worker request was cancelled.",
    );
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new PythonWorkerError("timeout", "Python worker request timed out.");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new PythonWorkerError(
      "cancelled",
      "Python worker request was cancelled.",
    );
  }
  return new PythonWorkerError("unavailable", "Python worker is unavailable.");
}

function isRetryable(error: PythonWorkerError): boolean {
  return ["timeout", "unavailable", "upstream_error"].includes(error.code);
}
