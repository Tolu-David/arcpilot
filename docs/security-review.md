# ArcPilotTreasury.sol — Security Review & Design Decisions

**Contract:** `contracts/ArcPilotTreasury.sol`  
**Reviewed at:** max severity (3 rounds, both rule-corpus and functional auditors)  
**Slither version:** 0.11.x  
**Date:** 2026-10-22  
**Status:** All Critical/High/Medium findings resolved. One Low accepted (documented below).

---

## Review summary

| Round | Findings | Resolved | Accepted |
|---|---|---|---|
| Round 1 | 2 High, 1 Low | 2 High (modifier order, O(1) payeeCount) | 1 Low (design-intentional) |
| Round 2 | 1 Medium | 1 Medium (renounceOwnership) | — |
| Round 3 | 0 | — | — |

Slither: 1 Low (`timestamp` detector). Accepted — see below.

**108/108 Forge unit tests pass.** 4 fuzz/invariant suites included.

---

## Every security-sensitive choice explained

### 1. `nonReentrant` placed first in modifier order

**Why it matters:** Modifiers execute in declaration order. If `nonReentrant` fires after `whenNotPaused` or `onlyOwner`, those preceding modifiers run outside the reentrancy lock. A future change to a preceding modifier that added an external call or state mutation would execute without the lock.

**Choice:** `nonReentrant` is unconditionally first on `deposit`, `withdraw`, and `pay`. This makes the lock the outermost guard regardless of what the other modifiers do.

### 2. CEI (Checks-Effects-Interactions) discipline in `pay()`

**Why it matters:** `pay()` calls `usdc.safeTransfer(to, amount)` as its last action. Any state that affects the outcome — `requestIdUsed`, `globalSpentToday`, `policy.spentToday`, the `PaymentRecord`, and `paymentCount` — is written **before** the transfer. The event is also emitted before the transfer. This means:

- If the transfer reverts, no state was permanently changed (the whole transaction reverts atomically).
- A reentrant call (even if `nonReentrant` were somehow bypassed) would see `requestIdUsed[requestId] == true` and revert `DuplicateRequestId` before spending again.

`deposit` and `withdraw` also follow CEI (state/events before the external call).

### 3. `requestId` replay prevention

**Why it matters:** Without deduplication, the owner could accidentally submit the same payment request twice (e.g. a retry after a UI timeout), causing a double-spend.

**Choice:** `mapping(bytes32 => bool) public requestIdUsed`. Set to `true` before `safeTransfer`, never unset. A second call with the same ID hits `if (requestIdUsed[requestId]) revert DuplicateRequestId(requestId)` before any accounting is touched.

**Assumption still needing off-chain discipline:** The caller must generate non-colliding IDs. Recommended derivation: `keccak256(abi.encode(block.chainid, address(this), invoiceNumber))`. The contract enforces uniqueness; it cannot enforce semantic correctness.

### 4. `renounceOwnership()` disabled

**Why it matters:** `Ownable2Step` inherits `renounceOwnership()` from `Ownable`. If called, it immediately sets `owner` to `address(0)`. On this contract that would permanently lock all Owner-gated functions — `pay`, `withdraw`, `setPayee`, `setPauser`, etc. — with USDC inside, because `rescueToken` explicitly blocks USDC rescue.

**Choice:** Override `renounceOwnership()` to `revert("ArcPilotTreasury: renounceOwnership disabled")`. Ownership can only be transferred two-step via `transferOwnership` + `acceptOwnership`.

### 5. `Ownable2Step` instead of `Ownable`

**Why it matters:** A one-step `transferOwnership` to a mistyped address permanently loses control of the treasury.

**Choice:** `Ownable2Step` — `transferOwnership(newOwner)` sets a pending owner; `acceptOwnership()` from that address finalises it. A mistyped address cannot accept, so the mistake is recoverable.

### 6. Separate `Pauser` role (not the owner)

**Why it matters:** If the Pauser key is compromised, the attacker can only halt fund movement — not drain the treasury. The Pauser's blast radius is limited to a denial-of-service on outbound transfers.

**Choice:** `onlyPauser` modifier gating `pause()` and `unpause()` only. No Pauser function touches balances or configures policy. The owner can replace the Pauser via `setPauser()`.

### 7. Separate `Rescuer` role

**Why it matters:** The Rescuer role exists only to recover accidentally-sent non-USDC tokens. If compromised, the attacker can only redirect those accidentally-sent tokens — never USDC.

**`rescueToken` explicitly reverts on `address(usdc)`** — this is security assertion S8 from the spec. No code path can accidentally pass USDC through this function.

**rescueToken operates while paused** — this is a deliberate, spec-approved design choice (§9.4, §15 of the design doc). Pause is for halting intended treasury flows; rescuing stuck tokens in an emergency is a recovery action. This creates an inconsistent pause surface (noted in round 1), which was explicitly accepted as intentional.

### 8. `SafeERC20` wraps every token call

**Why it matters:** Non-standard ERC-20 tokens (especially for `rescueToken` which accepts arbitrary tokens) may return `false` instead of reverting on failure. A bare `transfer()` call would silently proceed.

**Choice:** `using SafeERC20 for IERC20;` applied to all token calls including the arbitrary token in `rescueToken`. Every call either succeeds or reverts — no silent failures.

### 9. `spendableBalance()` floor at zero — no underflow

**Why it matters:** If obligations + reserve exceed the balance (possible if balance drops after obligations are set), integer subtraction would underflow in Solidity pre-0.8.

**Choice:** Solidity 0.8's checked arithmetic would catch the underflow and revert — but that would make `pay()` and `withdraw()` permanently unusable. Instead: `return bal > locked ? bal - locked : 0`. The floor ensures the function always returns a valid value, and both `pay()` and `withdraw()` check `amount > spendable` to prevent any actual over-spend.

### 10. `activeObligationsTotal` — O(1) obligation accounting

**Why it matters:** An early version iterated all obligations to sum them (O(n)). A large enough `n` would make `totalObligations()` — called inside `pay()` and `withdraw()` — prohibitively expensive or reverting.

**Choice:** `activeObligationsTotal` is maintained atomically: `setObligation` subtracts the old amount (if active) and adds the new one; `removeObligation` subtracts. `totalObligations()` returns it directly. The invariant `activeObligationsTotal == Σ(obligations[i].amount for all active i)` is verified by the fuzz suite.

### 11. `activePayeeCount` — O(1) payee count

**Why it matters:** `payeeCount()` previously iterated `_payeeList`. As more payees are added and removed, the list grows without bound (only soft-deletes). An O(n) view in an offchain-only context costs gas on every call.

**Choice:** `activePayeeCount` tracks the count of currently-allowed payees. Incremented in `setPayee` when transitioning from disallowed → allowed. Decremented in `removePayee`. `payeeCount()` returns it in O(1).

`_payeeEverAdded` mapping prevents duplicate `_payeeList` pushes when re-allowlisting a previously-removed payee. Without it, a re-allowlisted address would be pushed again, and later enumeration would encounter it twice.

### 12. No arbitrary token address at payment time

**Why it matters:** If `pay()` accepted an arbitrary token address, an attacker could trick the owner into authorising a payment in a different token.

**Choice:** `usdc` is `immutable` — set once in the constructor, never changeable. `pay()` only calls `usdc.safeTransfer`. The only function that touches an arbitrary token is `rescueToken`, and that function explicitly blocks `usdc`.

### 13. No unlimited approvals

**Why it matters:** A contract that holds an open `approve` to a spender creates an attack surface — the approved address can drain the contract at any time.

**Choice:** This contract never calls `approve` on any token. Depositors approve the treasury contract from their own wallets; the treasury does not approve anyone.

### 14. `block.timestamp` for 24-hour windows

**Why it matters:** Miners can nudge `block.timestamp` by approximately ±15 seconds.

**Choice:** Accepted. A 15-second nudge on an 86,400-second (24-hour) window is 0.017% drift — negligible for treasury operations. This is not used for randomness, only for a daily spending window. Documented as a spec-approved tradeoff (design doc §17).

---

## Known assumptions requiring off-chain verification or production discipline

| # | Assumption | Risk if violated |
|---|---|---|
| A1 | Arc USDC at `0x3600000000000000000000000000000000000000` is a standard Circle ERC-20 (no fee-on-transfer, no rebase, no callbacks). | Fee-on-transfer: `totalBalance()` would overcount. Rebase: accounting would diverge. |
| A2 | The Owner in production is a Gnosis Safe or equivalent multisig, not a single EOA. | Single key compromise = full treasury drain. |
| A3 | `requestId` values are generated uniquely off-chain (e.g. `keccak256(abi.encode(chainId, contract, invoiceNumber))`). | Collision = second pay() call reverts (not a double-spend, but an operational failure). |
| A4 | Arc `block.timestamp` behaves as expected (no unusual drift or timestamp manipulation by sequencer). | Daily window could be reset early or delayed. Acceptable tolerance: ~15 seconds on 86,400-second window. |
| A5 | OZ 5.1.0 is pinned and not upgraded to ≥5.2.0 without re-testing Paris EVM compatibility. | 5.2.0+ uses `mcopy` (Cancun-only) in `utils/Bytes.sol`; breaks Paris compile. |
| A6 | The `Pauser` and `Rescuer` addresses are secured. | Pauser compromise → pause-based DoS. Rescuer compromise → accidentally-sent non-USDC tokens redirected. Neither can touch USDC. |

---

## Slither findings

| Detector | Impact | Accepted? | Reason |
|---|---|---|---|
| `timestamp` | Low | Yes | `block.timestamp` is used only for 24-hour rolling windows. ~15s miner manipulation is negligible on an 86,400s window. Not used for randomness. Documented in design spec §17. |

---

## This review is not a professional audit

This security review was conducted with automated tooling and structured rule-corpus analysis. It is a best-effort review and is **not a substitute for a paid third-party audit** before deploying to mainnet or holding significant funds. The analysis is based on the contract source at the time of review; any future changes require a new review.
