/**
 * server/catalogue.ts
 *
 * Server-controlled service catalogue.  The frontend and AI agents read this
 * at runtime via GET /api/catalogue — they never hardcode endpoint prices or
 * paths.  Only the server can add, change, or remove entries.
 *
 * Prices are expressed as decimal USDC strings for the legacy ServiceItem
 * type and as canonical integer base-unit numbers for CatalogueService.
 * Recipient addresses live here; the browser must never supply or override them.
 */

import type { ServiceItem, CatalogueService, ServiceAvailability } from '../shared/types.js'

// ── Recipient addresses ───────────────────────────────────────────────────────
// In production these come from environment configuration.  The defaults point
// at the deployer/platform wallet used during testing.

const DEFAULT_RECIPIENT = (
  process.env.SELLER_ADDRESS ??
  '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42' // arc-studio-allow-onchain-literal
) as `0x${string}`

// ── Auto-approve threshold ────────────────────────────────────────────────────
// Requests for services priced at or below this amount are auto-approved.
// Requests above it get status "approval-required".
// Expressed in USDC base units (6 decimals).  Default: 1 USDC = 1_000_000.
export const AUTO_APPROVE_THRESHOLD_BASE_UNITS = Number(
  process.env.AUTO_APPROVE_THRESHOLD ?? 1_000_000,
)

// ── Allowlisted callers ───────────────────────────────────────────────────────
// In production this is loaded from a DB or env.  Here we use an env var
// containing a comma-separated list of lowercase addresses.
const ALLOWLIST: Set<string> = new Set(
  (process.env.SERVICE_ALLOWLIST ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
)

/** Returns true when an address is on the service allowlist (or the list is empty = open). */
export function isAllowlisted(address?: string): boolean {
  if (ALLOWLIST.size === 0) return true   // open access when no list is configured
  return ALLOWLIST.has((address ?? '').toLowerCase())
}

// ── Legacy catalogue (used by existing /api/agent/* routes) ──────────────────

export const CATALOGUE: ServiceItem[] = [
  {
    id: 'health',
    name: 'Health check',
    description: 'Returns server status, active adapter mode, and seller address.',
    method: 'GET',
    path: '/api/agent/health',
    priceUsdc: '',
    requiresPayment: false,
  },
  {
    id: 'treasury-status',
    name: 'Treasury status',
    description:
      'Returns the deployed contract address and chain metadata. Use this before making paid calls.',
    method: 'GET',
    path: '/api/agent/treasury-status',
    priceUsdc: '',
    requiresPayment: false,
  },
  {
    id: 'recommend-spend',
    name: 'Spend policy recommendation',
    description:
      'Given a free-text treasury context, returns a deterministic policy recommendation. ' +
      'No AI inference — output is fully reproducible for the same input.',
    method: 'POST',
    path: '/api/agent/recommend-spend',
    priceUsdc: '0.010000',
    requiresPayment: true,
    inputSchema: {
      context: 'string — describe current treasury state, e.g. "low balance with two payees"',
    },
  },
  {
    id: 'audit-summary',
    name: 'Audit summary',
    description:
      'Accepts a list of payment records and returns a structured summary suitable for agent reasoning.',
    method: 'POST',
    path: '/api/agent/audit-summary',
    priceUsdc: '0.005000',
    requiresPayment: true,
    inputSchema: {
      payments:
        'array of { to: string, amount: string, memo: string, timestamp: number }',
    },
  },
]

/**
 * Look up a legacy service item by id.
 */
export function findService(id: string): ServiceItem | undefined {
  return CATALOGUE.find((s) => s.id === id)
}

// ── Extended catalogue (CatalogueService, used by /api/catalogue v2) ─────────

/**
 * The canonical extended catalogue.  Prices and recipient addresses are
 * server-authoritative — callers must never override them.
 *
 * Three demonstration services:
 *   data-scraper        0.50 USDC   active + allowlisted  → allowed
 *   deep-analysis      50.00 USDC   active + allowlisted  → approval-required (exceeds threshold)
 *   prohibited-endpoint 150.00 USDC active, NOT allowlisted → unavailable
 */
const EXTENDED_CATALOGUE_DEFINITIONS: Omit<CatalogueService, 'availability'>[] = [
  // ── Demo services ─────────────────────────────────────────────────────────
  {
    id: 'data-scraper',
    name: 'Data Scraper',
    description:
      'Fetches and structures publicly available data for AI agent consumption. ' +
      'Returns JSON suitable for downstream reasoning pipelines.',
    priceBaseUnits: 500_000,           // 0.50 USDC
    priceDisplay: '0.50',
    recipientAddress: DEFAULT_RECIPIENT,
    active: true,
    allowlisted: true,
    method: 'POST',
    path: '/api/agent/data-scraper',
    requiresPayment: true,
    inputSchema: { query: 'string — the topic or URL to scrape' },
  },
  {
    id: 'deep-analysis',
    name: 'Deep Analysis',
    description:
      'Runs a comprehensive multi-pass analysis over a treasury snapshot and returns a ' +
      'structured report with risk ratings and recommended actions.',
    priceBaseUnits: 50_000_000,        // 50.00 USDC
    priceDisplay: '50.00',
    recipientAddress: DEFAULT_RECIPIENT,
    active: true,
    allowlisted: true,
    method: 'POST',
    path: '/api/agent/deep-analysis',
    requiresPayment: true,
    inputSchema: { snapshotId: 'string — contract address or block-scoped snapshot reference' },
  },
  {
    id: 'prohibited-endpoint',
    name: 'Prohibited Endpoint',
    description:
      'Demonstrates a service that is active in the catalogue but restricted to a specific ' +
      'allowlist. Requests from unlisted callers are rejected by policy.',
    priceBaseUnits: 150_000_000,       // 150.00 USDC
    priceDisplay: '150.00',
    recipientAddress: DEFAULT_RECIPIENT,
    active: true,
    allowlisted: false,               // caller is not on the allowlist
    method: 'POST',
    path: '/api/agent/prohibited-endpoint',
    requiresPayment: true,
  },
  // ── Production services (carried forward from legacy catalogue) ────────────
  {
    id: 'recommend-spend',
    name: 'Spend Policy Recommendation',
    description:
      'Given a free-text treasury context, returns a deterministic policy recommendation.',
    priceBaseUnits: 10_000,            // 0.01 USDC
    priceDisplay: '0.01',
    recipientAddress: DEFAULT_RECIPIENT,
    active: true,
    allowlisted: true,
    method: 'POST',
    path: '/api/agent/recommend-spend',
    requiresPayment: true,
    inputSchema: { context: 'string — current treasury state description' },
  },
  {
    id: 'audit-summary',
    name: 'Audit Summary',
    description:
      'Accepts a list of payment records and returns a structured summary for agent reasoning.',
    priceBaseUnits: 5_000,             // 0.005 USDC
    priceDisplay: '0.005',
    recipientAddress: DEFAULT_RECIPIENT,
    active: true,
    allowlisted: true,
    method: 'POST',
    path: '/api/agent/audit-summary',
    requiresPayment: true,
    inputSchema: {
      payments: 'array of { to, amount, memo, timestamp }',
    },
  },
]

/**
 * Derive the server-evaluated availability for a service definition.
 * Rules (evaluated in priority order):
 *  1. inactive → unavailable
 *  2. not allowlisted → unavailable
 *  3. price > AUTO_APPROVE_THRESHOLD → approval-required
 *  4. otherwise → allowed
 */
export function deriveAvailability(
  svc: Omit<CatalogueService, 'availability'>,
): ServiceAvailability {
  if (!svc.active) return 'unavailable'
  if (!svc.allowlisted) return 'unavailable'
  if (svc.priceBaseUnits > AUTO_APPROVE_THRESHOLD_BASE_UNITS) return 'approval-required'
  return 'allowed'
}

/** The hydrated extended catalogue (availability computed at load time). */
export const EXTENDED_CATALOGUE: CatalogueService[] = EXTENDED_CATALOGUE_DEFINITIONS.map(
  (def) => ({ ...def, availability: deriveAvailability(def) }),
)

/**
 * Look up a single extended service by id.
 * Returns undefined when not found.
 */
export function findExtendedService(id: string): CatalogueService | undefined {
  return EXTENDED_CATALOGUE.find((s) => s.id === id)
}

/**
 * Validate a service request by ID.
 * Returns { ok: true, service } on success, or { ok: false, code, reason } on failure.
 */
export function validateServiceRequest(serviceId: string): (
  | { ok: true; service: CatalogueService }
  | { ok: false; code: string; reason: string }
) {
  // Reject blank / non-string IDs
  if (!serviceId || typeof serviceId !== 'string' || !/^[a-z0-9-]+$/.test(serviceId)) {
    return { ok: false, code: 'INVALID_SERVICE', reason: `"${serviceId}" is not a valid service ID.` }
  }

  const service = findExtendedService(serviceId)
  if (!service) {
    return { ok: false, code: 'INVALID_SERVICE', reason: `No service with id "${serviceId}".` }
  }

  if (!service.active) {
    return { ok: false, code: 'SERVICE_UNAVAILABLE', reason: `Service "${serviceId}" is not currently active.` }
  }

  if (!service.allowlisted) {
    return { ok: false, code: 'POLICY_DENIED', reason: `Caller is not on the allowlist for service "${serviceId}".` }
  }

  return { ok: true, service }
}
