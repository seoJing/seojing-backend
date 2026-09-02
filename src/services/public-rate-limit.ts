import type { FastifyReply, FastifyRequest } from "fastify";

interface PublicRateLimitOptions {
  max: number;
  windowMs: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const defaultOptions: PublicRateLimitOptions = {
  max: 120,
  windowMs: 60_000,
};
const maxBuckets = 10_000;

function isLoopbackAddress(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function pruneBuckets(
  buckets: Map<string, RateLimitBucket>,
  now: number,
): void {
  if (buckets.size < maxBuckets) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  while (buckets.size >= maxBuckets) {
    const oldestKey = buckets.keys().next().value;
    if (!oldestKey) return;
    buckets.delete(oldestKey);
  }
}

/**
 * Small in-process guard for unauthenticated public endpoints.
 * Cloudflare is the primary edge layer; this limits cheap scanner bursts that
 * reach the single local Node process through the tunnel.
 */
export function registerPublicRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  buckets: Map<string, RateLimitBucket>,
  options: PublicRateLimitOptions = defaultOptions,
): boolean {
  if (
    request.url === "/health" ||
    request.url === "/health/ready" ||
    request.url === "/docs" ||
    request.url.startsWith("/docs/") ||
    request.url === "/openapi.json" ||
    request.url.startsWith("/admin/") ||
    request.url.startsWith("/community/auth/")
  ) {
    return true;
  }

  const now = Date.now();
  pruneBuckets(buckets, now);
  const forwarded = request.headers["cf-connecting-ip"];
  const forwardedAddress = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const key =
    isLoopbackAddress(request.ip) && forwardedAddress
      ? forwardedAddress
      : request.ip;
  const existing = buckets.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + options.windowMs };

  bucket.count += 1;
  buckets.set(key, bucket);
  reply.header("X-RateLimit-Limit", options.max);
  reply.header(
    "X-RateLimit-Remaining",
    Math.max(0, options.max - bucket.count),
  );

  if (bucket.count <= options.max) {
    return true;
  }

  reply.header("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
  void reply.status(429).send({ error: "Too many requests" });
  return false;
}
