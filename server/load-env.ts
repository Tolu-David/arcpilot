/**
 * server/load-env.ts
 *
 * Loads .env into process.env before the server starts.
 * Must be the FIRST import in server/index.ts.
 *
 * Why this is needed: `bun --watch` forks a worker process for hot-reload and
 * that worker process does not inherit bun's own .env loading.  `tsx` also does
 * not load .env automatically.  This module handles both cases by reading the
 * file directly with Node's fs APIs.
 *
 * Rules:
 *  - Never logs or exposes the values of any loaded variables.
 *  - Skips variables already present in the environment (respects CI/shell overrides).
 *  - Silently no-ops when .env is absent (no error thrown).
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// When bun --watch runs a script, import.meta.url may reflect the bun
// invocation CWD rather than the source file's directory.  Try the source
// file path first, then fall back to process.cwd() (which is always the
// project root when started via `bun run server` from the project dir).
const _filedir = dirname(fileURLToPath(import.meta.url))
// Walk up from _filedir: if we're in server/, go up one level; otherwise stay
const _candidate = resolve(_filedir, '..', '.env')
const _fallback  = resolve(process.cwd(), '.env')
const envPath = existsSync(_candidate) ? _candidate : _fallback

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n')
  let loaded = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (key && !(key in process.env)) {
      process.env[key] = val
      loaded++
    }
  }
  // Log how many vars were loaded (no values, ever)
  if (loaded > 0) {
    console.log(`[ArcPilot] Loaded ${loaded} variable(s) from .env`)
  }
}
