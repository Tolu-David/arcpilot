/**
 * server/middleware/idempotency.ts
 *
 * In-memory idempotency key store.
 *
 * Prevents duplicate payment execution when a caller retries a request that
 * already succeeded.  Keys expire after TTL_MS (default 24 hours) to bound
 * memory growth.
 *
 * Limitations:
 * - In-process only: not shared across multiple server instances.
 * - Not persistent: restarting the server loses the store.
 * - For a production multi-instance deployment, replace with a Redis SET NX
 *   with a TTL — the interface is identical, only the backing store changes.
 *
 * Usage:
 *   import { idempotencyMiddleware } from './middleware/idempotency.js'
 *   router.post('/pay', idempotencyMiddleware('x-idempotency-key'), handler)
 */

import type { Request, Response, NextFunction } from 'express'

const TTL_MS = 24 * 60 * 60 * 1_000  // 24 hours

interface Entry {
  respondedAt: number
  statusCode: number
  body: unknown
}

// Module-level store — one instance per server process.
const store = new Map<string, Entry>()

// Periodic cleanup: remove entries older than TTL every hour.
setInterval(() => {
  const cutoff = Date.now() - TTL_MS
  for (const [key, entry] of store) {
    if (entry.respondedAt < cutoff) store.delete(key)
  }
}, 60 * 60 * 1_000).unref()  // .unref() so the timer doesn't prevent process exit

/**
 * Express middleware that enforces idempotency via a request header.
 *
 * @param headerName  HTTP header to read the key from (case-insensitive).
 *                    Defaults to "x-idempotency-key".
 * @param required    If true, reject requests without the header (default false).
 */
export function idempotencyMiddleware(
  headerName = 'x-idempotency-key',
  required = false,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers[headerName.toLowerCase()]
    const key = Array.isArray(raw) ? raw[0] : raw

    if (!key) {
      if (required) {
        res.status(400).json({
          error: 'MISSING_IDEMPOTENCY_KEY',
          message: `Request header "${headerName}" is required.`,
        })
        return
      }
      // No key supplied — pass through without idempotency protection.
      next()
      return
    }

    // Validate key format: must be a non-empty string, max 128 chars.
    if (typeof key !== 'string' || key.length > 128) {
      res.status(400).json({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: `"${headerName}" must be a non-empty string of at most 128 characters.`,
      })
      return
    }

    const existing = store.get(key)
    if (existing) {
      // Return the cached response — same status, same body.
      res.status(existing.statusCode).json({
        ...(existing.body as object),
        _idempotent: true,
      })
      return
    }

    // Intercept res.json to cache the response before sending.
    const originalJson = res.json.bind(res)
    res.json = (body: unknown) => {
      store.set(key, {
        respondedAt: Date.now(),
        statusCode: res.statusCode,
        body,
      })
      return originalJson(body)
    }

    next()
  }
}

/** Test helper — clears the entire store. */
export function _clearIdempotencyStore(): void {
  store.clear()
}
