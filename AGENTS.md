# ArcPilot — Project Memory

## What this is
An onchain USDC treasury management app on Arc Testnet. The owner deploys an `ArcPilot` contract, deposits USDC, configures obligations and reserve, permits payees, and executes payments — all with a verifiable onchain audit log.

## Contract
- **Source**: `contracts/ArcPilot.sol`
- **Deployed address**: `0xc10f1f2e659a61ef484c06ecbf161160f929e868`
- **Explorer**: https://explorer.testnet.arc.io/address/0xc10f1f2e659a61ef484c06ecbf161160f929e868
- **Constructor args**: `initialOwner` (platform deployer: `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42`), `_usdc` (`0x3600000000000000000000000000000000000000`), `_reserveBps` (`2000` = 20%)
- **Deployed at**: 2026-10-22
- **Chain**: Arc Testnet (chain ID 5042002)

## Frontend
- `src/App.tsx` — root composition
- `src/config.ts` — wagmi config, chain/token constants
- `src/lib/abi.ts` — ArcPilot ABI
- `src/lib/utils.ts` — formatting helpers
- `src/components/` — TreasuryCard, PolicyPanel, PayPanel, AuditLog, ContractInput, Header

## Agent Payment Server (Milestone 2)
- **Source**: `server/index.ts`
- **Start**: `SELLER_ADDRESS=0x... bun run server` (port 3001)
- **Vite proxy**: `/api/agent/*` → `http://localhost:3001`
- **Paid endpoints**:
  - `POST /api/agent/recommend-spend` — $0.01 USDC / call
  - `POST /api/agent/audit-summary` — $0.005 USDC / call
- **Free endpoints**: `GET /api/agent/health`, `GET /api/agent/treasury-status`
- **Protocol**: Circle Gateway Nanopayments (`@circle-fin/x402-batching@3.5.0`)
- **Facilitator**: `https://gateway-api-testnet.circle.com` (testnet)
- **Required env vars**: `SELLER_ADDRESS` (EVM address receiving USDC)
- **Buyer**: use `GatewayClient` from `@circle-fin/x402-batching/client` with `chain: "arcTestnet"`

## ArcPilotTreasury (v3 — security-fixed, current)
- **Source**: `contracts/ArcPilotTreasury.sol`
- **Deployed address**: `0xc6e83868695525aa7f42032504491b82d7b841d0`
- **Tx hash**: `0x59d6009505533acd3ec8ba138d4b7bd469299dfef8842aba0174e6935ea48b26`
- **Explorer**: https://explorer.testnet.arc.io/address/0xc6e83868695525aa7f42032504491b82d7b841d0
- **Chain**: Arc Testnet (chain ID 5042002)
- **Deployed at**: 2026-10-27T16:47:46Z
- **VITE_ARCPILOT_CONTRACT**: `0xc6e83868695525aa7f42032504491b82d7b841d0`

## ArcPilotTreasury (v2 — pre-fix, superseded)
- **Deployed address**: `0x28a05d2996207b3db64b5ad171a2db5d71c9a8f3`
- **Tx hash**: `0x47ca16178ccad1a87cb15e13a5f7c96b710f722b7b1a6a4ed60cce83a0e293f7`
- **Explorer**: https://explorer.testnet.arc.io/address/0x28a05d2996207b3db64b5ad171a2db5d71c9a8f3
- **Chain**: Arc Testnet (chain ID 5042002)
- **Deployed at**: 2026-10-22T11:03:24Z
- **Constructor args**:
  - `initialOwner`: `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` (platform deployer)
  - `initialPauser`: `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` ⚠️ rotate before production use
  - `initialRescuer`: `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` ⚠️ rotate before production use
  - `_usdc`: `0x3600000000000000000000000000000000000000`
  - `_reserveBps`: `1000` (10%)
  - `_maxTxAmount`: `10000000000` (10,000 USDC)
  - `_globalDailyLimit`: `50000000000` (50,000 USDC)
- **Tests**: 148/148 pass (ArcPilotTreasury.t.sol + ArcPilotTreasuryFull.t.sol)
- **Security audit completed**: see `docs/security-review.md`. 18/24 findings fixed.
  - [H-1] `setPayee` no longer resets daily-spend counter on existing payees.
  - [M-1] Day-reset advances by epoch (`+1 days`), not `block.timestamp`.
  - NOTE: The deployed contract (`0x28a05...`) has the pre-fix code. Deploy a new instance to get the fixed version.
- **Post-deploy verified**: owner, pauser, rescuer, usdc, reserveBps, maxTxAmount, globalDailyLimit, totalBalance, spendableBalance, activeObligationsTotal, paused, paymentCount, activePayeeCount, dailyRemainingGlobal — all match constructor args

## Agent Services Page — Recommendation Flow

`AgentServicesView` is wired to `POST /api/catalogue/recommend`. Clicking "Request" on a service card:
1. Calls `fetchRecommendation(serviceId, userIntent, snapshot)` — never sends price or address from browser.
2. Shows `RecommendationPanel`: service + canonical price, AI advisory section, deterministic policy section (with reason code when denied), budget context (spendable + daily remaining), and action buttons.
3. Actions gate on `policy.allowed` only — AI verdict is advisory and cannot unblock a denial.
4. "Review Payment" opens `ReviewPaymentPanel` with the server-authoritative price and a policy-recheck notice. No transaction is submitted.
5. `requestService` (payment adapter) is only invoked for the "Request Approval" path.

Test files: `src/test/RecommendationPanel.test.tsx` (40 tests) + updated `AgentServicesView.test.tsx` (34 tests).

## Test suite (Vitest)
- `bun run test:ui` — 202/202 pass (8 files)
  - `utils.test.ts` — 21 pure utility unit tests
  - `treasury-adapter.test.ts` — 9 adapter/fixture invariant tests
  - `OverviewView.test.tsx` — 24 render tests across 7 states
  - `TreasuryView.test.tsx` — 24 render tests across 7 states
  - `AgentServicesView.test.tsx` — 34 render/interaction tests (catalogue render, selection, card states, request→recommendation binding; old banner tests replaced with new recommendation flow tests)
  - `RecommendationPanel.test.tsx` — 40 tests (loading, AI unavailable, policy denied, approval required, eligible + Review Payment, AI verdict display, budget section, canonical price authority, close/dismiss, server errors, intent input)
  - `PaymentsView.test.tsx` — 34 tests (all 6 payment statuses, confirmed+service-failed, missing tx hash, pagination, simulated flag, policy verdict badges)
  - `AuditLogView.test.tsx` — 21 tests (no-contract, loading, error, empty, success table, row count, on-chain/off-chain provenance notices)
- `bun run test:ai-recommend` — 75/75 pass (Node --test runner, tsx)
  - Provider: Google AI Studio (@google/genai v2.31.0, GoogleGenAI client)
  - Credentials: AI_STUDIO_API_KEY (required), AI_STUDIO_project_name / AI_studio_name (available for reference)
  - Model: gemini-2.0-flash (override with AI_STUDIO_MODEL env var)
  - AI response contract: { recommendation, serviceId, reasoning, warnings: string[], alternatives: string[] }
  - Structured output: responseMimeType='application/json' + responseSchema (JSON Schema, additionalProperties:false)
  - 13 suites: validateAiOutput (valid + invalid), buildMessages, getAiRecommendation (success, errors, missing key), prompt injection defence, price/recipient authority, AI-vs-policy conflicts, buildRecommendationResponse (incl. spendable/dailyRemaining), unknown service, stale snapshot, configuration constants
  - Every AI error code tested: AI_STUDIO_KEY_MISSING, AI_TIMEOUT, AI_MALFORMED_OUTPUT, AI_SCHEMA_VIOLATION, AI_PROVIDER_ERROR, AI_REFUSAL
  - Endpoint: POST /api/catalogue/recommend — body: { serviceId, userIntent, snapshot }
- `bun run test:spending-policy` — 65/65 pass (Node --test runner, tsx)
- `bun run test:payment-prepare` — 79/79 pass (Node --test runner, tsx)
- Vitest UI tests — 319/319 pass (10 test files)
- `bun run test:reconciler` — 42/42 pass (Node --test, tsx)
  - All 12 reason codes: STALE_STATE, SERVICE_NOT_FOUND, SERVICE_UNAVAILABLE, SERVICE_NOT_ALLOWLISTED, INVALID_AMOUNT, TX_LIMIT_EXCEEDED, DAILY_LIMIT_EXCEEDED, RESERVE_BREACH, INSUFFICIENT_FUNDS, TREASURY_PAUSED, APPROVAL_REQUIRED, POLICY_OK
  - Boundary values at every check (price === limit, price === limit ± 1)
  - Check ordering verified (stale → service → paused → tx cap → daily → reserve → approval)
  - AI import guard: verifies evaluateSpendingPolicy is a plain Function, not a streaming LLM call
- wagmi mocked via `importOriginal` (preserves `createConfig`/`getDefaultConfig`)
- framer-motion mocked via inline factory returning element-passthrough functions
- RTL cleanup called in `afterEach` via `src/test/setup.ts`

## Notes
- USDC on Arc is the native gas token (ERC-20 view: 6 decimals, `0x3600...0000`)
- Only the contract owner can call `pay()`, `setObligation()`, `setPayee()`, `setReserveBps()`
- Spendable = totalBalance − obligations − reserve
