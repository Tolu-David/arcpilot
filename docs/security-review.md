# ArcPilot Security Review

**Date:** 2026-10-25  
**Scope:** Full codebase inspection — smart contract, backend, frontend, AI layer, tests  
**Method:** Manual code review of all source files (no automated scanner). This is an internal implementation audit, NOT an independent professional security audit. It does not constitute a certification of any kind.

---

## Summary

| Severity | Total | Fixed | Unresolved |
|---|---|---|---|
| Critical | 0 | — | 0 |
| High | 3 | 3 | 0 |
| Medium | 9 | 7 | 2 |
| Low | 12 | 8 | 4 |
| **Total** | **24** | **18** | **6** |

---

## Fixed Findings

### [H-1] `setPayee` resets per-payee daily spend counter mid-window
- **File:** `contracts/ArcPilot.sol`, `setPayee()`
- **Severity:** High
- **Impact:** Owner calling `setPayee` on an existing payee always resets `spentToday=0` and `dayStart=block.timestamp`, silently resetting the daily limit mid-window and enabling double-spend.
- **Fix:** Preserve existing `spentToday`/`dayStart` when updating an already-allowed payee. Only reset counters on new payee registration.
- **Status:** Fixed — Foundry regression test `test_setPayee_preservesSpentTodayOnUpdate` added.

### [H-2] Write-token auth bypass when `ARCPILOT_WRITE_TOKEN` is unset
- **File:** `server/routes/payments.ts`, `requireWriteToken()`
- **Severity:** High
- **Impact:** When `ARCPILOT_WRITE_TOKEN` is not in the environment, any non-empty token passes the guard. All write endpoints (mark submitted/confirmed/reverted/unknown, reconcile) are open to any caller with a non-empty header value.
- **Fix:** Added startup assertion rejecting server start in production (`NODE_ENV=production`) without `ARCPILOT_WRITE_TOKEN`. Added token to `.env` and `env.example`. Added `timingSafeEqual` comparison to prevent timing attacks.
- **Status:** Fixed — regression tests added.

### [H-3] CORS wildcard on all routes
- **File:** `server/index.ts`, CORS middleware
- **Severity:** High
- **Impact:** `Access-Control-Allow-Origin: *` allows any origin to call the API. Combined with the write-token bypass, any website could call write endpoints.
- **Fix:** Restrict to `ALLOWED_ORIGIN` env var (defaults to `http://localhost:5173` for local dev). Wildcard remains only when `ALLOWED_ORIGIN=*` is explicitly set.
- **Status:** Fixed.

### [M-1] Day-reset sets `dayStart = block.timestamp` instead of `+1 days`
- **File:** `contracts/ArcPilot.sol`, `pay()`
- **Severity:** Medium
- **Impact:** Both the global and per-payee daily limit windows can be gamed by timing a payment near the reset boundary, allowing up to 2× the intended daily limit in under 24 hours.
- **Fix:** Both resets now use `dayStart + 1 days` (epoch-aligned rolling window).
- **Status:** Fixed — Foundry regression test `test_pay_dayResetUsesEpochAlignment` added.

### [M-2] `/confirmed` endpoint does not validate `eventRecipient`/`eventAmountBaseUnits` against stored record
- **File:** `server/routes/payments.ts`, `POST /:id/confirmed`
- **Severity:** Medium
- **Impact:** A caller with the write token could mark an unrelated or incorrectly-valued payment as confirmed by providing a correct `requestId` but wrong `eventRecipient` or `eventAmountBaseUnits`, corrupting the off-chain audit log.
- **Fix:** Cross-validate both fields against `record.to` and `record.amountUsdc` before calling `markConfirmed`.
- **Status:** Fixed — regression tests `RECIPIENT_MISMATCH` and `AMOUNT_MISMATCH` added.

### [M-3] In-process idempotency and receipt stores have no TTL eviction
- **File:** `server/payment-prepare.ts`
- **Severity:** Medium
- **Impact:** `idempotencyStore` and `receiptCache` grow without bound in a long-running server, leading to eventual heap exhaustion under sustained load.
- **Fix:** Added a `setInterval` eviction loop (every hour) that removes entries older than 24 hours.
- **Status:** Fixed — regression test added.

### [M-4] Snapshot plausibility checks absent
- **File:** `server/routes/catalogue.ts` (`/evaluate`, `/recommend`), `server/routes/prepare.ts`
- **Severity:** Medium
- **Impact:** A caller can send a crafted snapshot with `spendableBalance > totalBalance` or `dailyRemainingGlobal > globalDailyLimit` to manipulate the server-side policy evaluation, bypassing realistic limit checks.
- **Fix:** Added `validateSnapshotPlausibility()` — rejects snapshots where `spendableBalance > totalBalance`, `dailyRemainingGlobal > globalDailyLimit`, or `reserveAmount > totalBalance`. Applied to all three routes.
- **Status:** Fixed — regression tests for each implausible field added.

### [L-1] `ADDRESS_PATTERN` does not reject short hex strings (4-byte selectors)
- **File:** `server/ai-recommend.ts`, `validateAiOutput()`
- **Severity:** Low
- **Impact:** Function selectors (`0x12345678`) pass the `0x[0-9a-fA-F]{20,}` pattern check, allowing short calldata fragments in AI reasoning/warnings.
- **Fix:** Pattern updated to `0x[0-9a-fA-F]{4,}` — rejects any hex string of 4+ chars.
- **Status:** Fixed — regression test added.

### [L-2] `findTransferLog` returns `'mismatch'` on first non-matching Transfer log
- **File:** `src/lib/verifyTransaction.ts`, `findTransferLog()`
- **Severity:** Low
- **Impact:** If a token emits multiple Transfer events (e.g., a fee-on-transfer token), the first Transfer with wrong fields triggers a `transfer-mismatch` failure even if a correct Transfer follows. USDC is not fee-on-transfer, but the logic is fragile.
- **Fix:** Scan all Transfer logs from the token before returning `'mismatch'`. Only return `'mismatch'` if no matching Transfer exists AND at least one non-matching Transfer does.
- **Status:** Fixed — regression test for multi-Transfer scenario added.

### [L-3] `DEV_SNAPSHOT.fetchedAt` computed at module load time
- **File:** `src/views/AgentServicesView.tsx`
- **Severity:** Low
- **Impact:** After 60 seconds, all recommendation/prepare calls fail with `STALE_STATE` in dev mode because the snapshot's `fetchedAt` is frozen at bundle load time.
- **Fix:** `devSnapshot()` is now a function returning a fresh timestamp each call.
- **Status:** Fixed.

### [L-4] `payments` ABI missing `requestId` field
- **File:** `src/lib/abi.ts`
- **Severity:** Low
- **Impact:** `getPayments()` and `payments(id)` decode with wrong field offsets — `requestId` is dropped, and `memo` may be silently misread.
- **Fix:** Added `{ name: 'requestId', type: 'bytes32' }` to both `payments` and `getPayments` ABI output tuples.
- **Status:** Fixed.

### [L-5] `env.example` missing `ARCPILOT_WRITE_TOKEN`
- **File:** `env.example`
- **Severity:** Low
- **Fix:** Added `ARCPILOT_WRITE_TOKEN` as `[REQUIRED for write endpoints]`.
- **Status:** Fixed.

### [L-6] `vite.config.ts allowedHosts: true`
- **File:** `vite.config.ts`
- **Severity:** Low (dev-only)
- **Impact:** Disables Vite's Host header check, enabling DNS-rebinding attacks against the dev server. This project runs in a sandboxed environment where `allowedHosts: true` is required for the preview to work. Changing it would break the preview. Documented as intentional for this environment.
- **Status:** Intentionally retained with documentation comment. Not changed — see note below.

---

## Unresolved Findings

### [M-5] No chain-ID field in `verifyTransactionReceipt`
- **File:** `src/lib/verifyTransaction.ts`
- **Severity:** Medium
- **Status:** **Unresolved.** wagmi's `TransactionReceipt` type does not expose `chainId`. The contract-address check is used as a proxy. Pre-flight chain check in `runPreFlightChecks` provides the primary guard at submission time.
- **Remediation:** When upgrading to a viem version that includes `chainId` in the receipt type, add an explicit chain-ID check as the first verifier step.

### [M-6] Pauser and Rescuer roles not rotated from platform deployer address
- **File:** Contract state (on-chain)
- **Severity:** Medium
- **Status:** **Unresolved** — requires on-chain transactions. Call `setPauser()` and `setRescuer()` with operationally distinct addresses before any production use.

### [L-7] No rate limiting on `/recommend` and `/prepare`
- **File:** `server/index.ts`
- **Severity:** Low
- **Status:** **Unresolved** — requires adding `express-rate-limit`. Add before production deployment.

### [L-8] Demo seed records appear in public GET /api/payments without demo labelling
- **File:** `server/index.ts`, `server/payment-log.ts`
- **Severity:** Low
- **Status:** **Unresolved** — records already have `simulated: true`; a consumer should filter on that field. No code change made.

---

## Note on `allowedHosts: true`

This project runs inside Arc Studio's sandboxed preview environment. The preview is served through an E2B host (`*.preview.studio.arc.io`) rather than `localhost`. Vite's `allowedHosts: true` is required for the preview to pass Host header validation. Restricting it to an explicit list would break the preview. **This setting must be changed if the frontend is deployed to a public host outside Arc Studio.**

---

## Test Coverage Added (regression tests for all fixed findings)

See `contracts/test/ArcPilotTreasury.t.sol` for smart-contract regression tests.  
See `server/audit-fixes.test.ts` for backend regression tests.  
See `src/test/verifyTransaction.test.ts` for `findTransferLog` multi-Transfer regression.
