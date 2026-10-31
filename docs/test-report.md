# ArcPilot — Test Report

**Date:** 2026-10-28  
**Contract:** `ArcPilotTreasury` v3 at `0xc6e83868695525aa7f42032504491b82d7b841d0` (Arc Testnet, chain ID 5042002)  
**Run scope:** All available test suites — Foundry contracts, server unit, Vitest UI, end-to-end integration.

---

## Summary

| Suite | Command | Pass | Fail | Skip | Total |
|---|---|---|---|---|---|
| Foundry contracts | `bun run test:contracts` | 148 | 0 | 0 | 148 |
| Server — spending policy | `bun run test:spending-policy` | 65 | 0 | 0 | 65 |
| Server — payment prepare | `bun run test:payment-prepare` | 79 | 0 | 0 | 79 |
| Server — AI recommend | `bun run test:ai-recommend` | 75 | 0 | 0 | 75 |
| Server — reconciler | `bun run test:reconciler` | 42 | 0 | 0 | 42 |
| Server — audit fixes | `bun run test:audit-fixes` | 41 | 0 | 0 | 41 |
| Vitest UI | `bun run test:ui` | 319 | 0 | 0 | 319 |
| End-to-end integration | `bun run test:e2e` | 9 | 0 | 0 | 9 |
| **Total** | | **778** | **0** | **0** | **778** |

**No failures.** One bug was found and fixed during this run: `UNAUTHORIZED_WALLET` had been demoted to a non-blocking warning in a prior turn, causing 3 UI test failures. The fix restores it as a hard pre-flight block (fail-safe: unknown owner = block, not pass).

---

## Failures Found and Fixed

### UI-1 · UNAUTHORIZED_WALLET demoted to non-blocking warning

**Files:** `src/hooks/usePaymentExecution.ts`, `src/components/ReviewPaymentModal.tsx`

**Symptom:**
```
× returns UNAUTHORIZED_WALLET when owner address is undefined (not yet fetched)
× disables the Confirm Payment button  (unauthorized wallet suite)
× shows UNAUTHORIZED_WALLET and blocks submission  (owner not yet resolved suite)
```

**Root cause:** A prior change made `runPreFlightChecks` skip the owner check when `ownerAddress` is `undefined` (still loading), and made the modal treat `UNAUTHORIZED_WALLET` as a non-blocking warning. Both changes violated the fail-safe rule: if the owner address hasn't loaded, we cannot know whether the connected wallet is authorised, so the safe default is to block.

**Fix:** Restored `UNAUTHORIZED_WALLET` as a hard block in both `runPreFlightChecks` (block when `ownerAddress` is `undefined` OR mismatched) and `ReviewPaymentModal` (`canSubmit = !currentPreFlightErr` — all codes block).

**Severity:** Authorization (second priority). An unloaded owner could have allowed an unauthorized wallet to submit a transaction that would then revert on-chain. The fix ensures the block happens before the wallet signs, not after the gas is spent.

---

## Evidence Against Required Properties

### Denied requests do not transfer funds

**Contract level (Foundry):** `test_Pay_NotAllowedPayee_Reverts`, `test_Pay_ExceedsSpendable_Reverts`, `test_Pay_WhenPaused_Reverts` — all assert that `pay()` reverts before the `SafeERC20.safeTransfer` call is reached. No `Transfer` event is emitted on revert.

**Server level:** `bun run test:spending-policy` — 65 tests verify that `evaluateSpendingPolicy` returns `allowed=false` for every denial case. `bun run test:payment-prepare` — policy denial returns `{ ok: false }` and the `appendPayment` call is never reached (verified by checking that no log entry exists after denial).

**E2E (observed):** Scenario 2 — `prohibited-endpoint` denied with `SERVICE_NOT_ALLOWLISTED` (HTTP 422). The server confirmed `no log entry` and the on-chain balance read immediately after was `25,000,000 base units — unchanged`.

---

### Duplicate requests are blocked

**Contract level:** `test_Pay_DuplicateRequestId_Reverts` — the contract maps `requestIdUsed[requestId] = true` before the transfer and reverts on any second call with the same `requestId`.

**Server level (`bun run test:payment-prepare`):**
- `second call with same idempotency key returns cached receipt` — same key + same payload returns the stored receipt with `cached: true`. No second log entry.
- `IDEMPOTENCY_KEY_CONFLICT returned for same key + different payload` — ensures the idempotency key cannot be reused to authorise a different amount or recipient.

**E2E (observed):** Scenario 5 — first prepare returned `prepId=24f55f70`; retry with same key returned `cached=true` and the same `prepId`. Payload-change attempt returned HTTP 409 `IDEMPOTENCY_KEY_CONFLICT`. Single log entry confirmed via `GET /api/payments/by-request/:requestId`.

---

### Transaction status is based on verified receipts

**Frontend unit (`bun run test:ui` — `verifyTransaction.test.ts`, 55 tests):**
- `verifyTransactionReceipt` checks: contract address matches receipt, EVM status `success`, `PaymentExecuted` event present, event fields (`requestId`, `to`, `amount`) match the receipt, ERC-20 `Transfer` log present.
- Tests cover: wrong contract address → `contract-mismatch`; EVM revert → `reverted`; missing `PaymentExecuted` event → `event-missing`; mismatched `requestId` → `request-id-mismatch`; receipt timeout → `unknown` (never `confirmed`).

**Modal security tests (`ReviewPaymentModal.test.tsx`):**
- `shows confirmed banner when txReceipt.status is success` — only after successful `verifyTransactionReceipt`.
- `shows reverted banner when txReceipt.status is reverted`.
- The hook never calls `markConfirmed` from client state; it only confirms after the receipt verifier returns `outcome === 'confirmed'`.

**E2E (observed):** Scenario 6 — `RPC timeout` sets `flowState=Unknown` with `txHash` preserved. No second payment submitted. Scenario 1 — `flowState=Confirmed` only reached after the `/confirmed` endpoint received a `VerifiedEventSummary` with matching `eventRequestId`, `eventRecipient`, `eventAmountBaseUnits`.

---

### AI failures cannot bypass policy

**Server unit (`bun run test:ai-recommend`, 75 tests):**
- `a paused treasury policy denial is not overridden by AI recommend` — `evaluateSpendingPolicy` runs first; AI is only called when policy passes.
- `a daily-limit denial is not overridden by AI recommend`.
- `throws AI_TIMEOUT when the provider does not respond within the timeout` — timeout produces `aiError` in the response; `policy` field is returned unchanged.
- `throws AI_PROVIDER_ERROR`, `AI_MALFORMED_OUTPUT`, `AI_SCHEMA_VIOLATION` — all leave the policy result unmodified.
- `AI must not supply recipient addresses` — `ADDRESS_PATTERN` in `validateAiOutput` rejects any reasoning or warning containing a hex address.

**E2E (observed):** Scenario 9 — `prohibited-endpoint` was denied `SERVICE_NOT_ALLOWLISTED` regardless of AI recommendation. The `policy` field in the recommend response contains the deterministic verdict; `aiRecommendation` is advisory only and is not checked before a denial is returned.

---

## Coverage of Contract Policy Boundaries

All 12 `SpendingPolicyReasonCode` values are exercised:

| Code | Covered by |
|---|---|
| `STALE_STATE` | `test:spending-policy` (explicit boundary at 60 000 ms) + E2E scenario 8 |
| `SERVICE_NOT_FOUND` | `test:spending-policy`, `test:payment-prepare`, `test:ai-recommend` |
| `SERVICE_UNAVAILABLE` | `test:spending-policy` (unavailable service catalogue entry) |
| `SERVICE_NOT_ALLOWLISTED` | `test:spending-policy` + E2E scenarios 2 and 9 |
| `INVALID_AMOUNT` | `test:spending-policy` (zero-amount, non-integer string) |
| `TX_LIMIT_EXCEEDED` | `test:spending-policy` + Foundry `test_Pay_ExceedsMaxTxAmount_Reverts` |
| `DAILY_LIMIT_EXCEEDED` | `test:spending-policy` + Foundry `test_C1_PerPayeeAtLimit_ThenOneOverReverts`, `test_C3_GlobalAtLimit_ThenOneOverReverts` |
| `RESERVE_BREACH` | `test:spending-policy` + E2E scenario 3 (one below spendable limit) |
| `INSUFFICIENT_FUNDS` | `test:spending-policy` + E2E scenario 4 (obligations consume all funds) |
| `TREASURY_PAUSED` | `test:spending-policy` + Foundry `test_Pay_WhenPaused_Reverts` |
| `APPROVAL_REQUIRED` | `test:spending-policy` + `test:payment-prepare` (deep-analysis service) |
| `POLICY_OK` | All happy-path tests |

**Exact boundary values tested (server):** every check is tested at `price === limit`, `price === limit - 1`, and `price === limit + 1` in `test:spending-policy`.

**Contract day-reset boundary (Foundry):** `test_C5_WarpPastOneDay_PerPayeeWindowResets`, `test_C6_ExactWindowBoundary` — verify that the rolling 24-hour window resets correctly and that the double-spend window (H-1/M-1 fix) cannot be exploited.

**`setPayee` regression (Foundry — Group J):** verifies that calling `setPayee` on an existing payee does not reset `spentToday` or `dayStart`.

---

## Remaining Untested Behaviour and Known Limitations

### Not tested — requires live owner wallet

The following require the caller to be the contract owner (platform deployer wallet), which cannot be impersonated in these test environments:

1. **`pay()` happy path on-chain:** All E2E payment flows use mock receipts posted via the server API. The actual on-chain `pay()` call, `PaymentExecuted` event emission, and ERC-20 `Transfer` are tested in Foundry unit tests (which deploy and fund a fresh contract with a controlled owner) but not verified against the live deployed contract. On the live contract, `requestIdUsed` reads back `false` for all E2E scenario 1 calls — confirming no real transaction was broadcast.

2. **`deposit()` and `withdraw()`:** Covered in Foundry tests; not exercised against the live contract.

3. **`setPauser`, `setRescuer`, `pause`, `unpause`, `rescueToken`:** Covered in Foundry tests; live contract still has the platform deployer as pauser and rescuer (documented unrotated production action).

4. **`transferOwnership` + `acceptOwnership` two-step handoff:** Covered in Foundry tests for the `Ownable2Step` path; not run on the live contract.

### Not tested — multi-process / persistent state

5. **Idempotency store TTL eviction under real time:** The TTL eviction interval (hourly, 24-hour TTL) is tested for logic correctness in `test:audit-fixes` but not for actual time-based expiry in a running server. A long-running process test would require a test harness that advances the system clock.

6. **Reconciler production RPC path:** `test:reconciler` uses a mock `ReceiptFetcher`. The reconciler has never fetched a receipt from `https://rpc.testnet.arc.io` in tests — only in the running server.

7. **Server crash / restart persistence:** The payment log and idempotency store are in-process Maps. State is lost on server restart. No test covers this because it is a documented limitation (production requires a database replacement).

### Not tested — browser / wallet interaction

8. **MetaMask / WalletConnect wallet flow:** The Vitest tests mock `wagmi` hooks. Real wallet signature, gas estimation, and tx broadcasting are untested.

9. **Chain-switch prompt:** The `WRONG_NETWORK` error is tested at the pre-flight level. The UI's network-switch call to the wallet provider is not tested.

### Audit findings not yet addressed

10. **`vite.config.ts` `allowedHosts: true`:** Noted in the security review as a DNS-rebinding risk. Not changed — required for the E2B preview to reach the Vite dev server. Would be replaced with an explicit list in a self-hosted production deployment.

11. **CORS `ALLOWED_ORIGIN` defaults to `http://localhost:5173`:** Correct for the sandbox; must be set explicitly for any production deployment.

12. **Pauser and Rescuer not rotated:** Both still equal the platform deployer (`0x5B12Ce...`). This is a production action, not a code fix.
