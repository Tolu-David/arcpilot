# ArcPilot Architecture

## Overview

ArcPilot is a three-layer application: a React frontend, an Express backend, and a Solidity smart contract. Each layer has a clearly bounded responsibility and a defined interface to the others.

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│  src/ — React + wagmi + ConnectKit                          │
│  • Reads chain state via eth_call (wagmi useReadContract)   │
│  • Writes via wallet-signed transactions (useWriteContract) │
│  • Calls /api/* via Vite proxy (fetch, no CORS issue)       │
└────────────────────────┬────────────────────────────────────┘
                         │ /api/* (Vite proxy → localhost:3001)
┌────────────────────────▼────────────────────────────────────┐
│  server/ — Express + tsx                                    │
│  • catalogue.ts  : read-only service registry               │
│  • policy.ts     : deterministic rules engine               │
│  • payment/      : adapter boundary (sim/testnet/mainnet)   │
│  • middleware/   : idempotency, input validation            │
│  • routes/       : thin handlers (validate → policy → pay) │
└────────────────────────┬────────────────────────────────────┘
                         │ eth_call / eth_sendRawTransaction
┌────────────────────────▼────────────────────────────────────┐
│  Arc Testnet                                                 │
│  contracts/ArcPilot.sol                                     │
│  • USDC ERC-20 via SafeERC20                               │
│  • Ownable2Step + ReentrancyGuard                          │
│  • Obligations, reserve, payee allowlist, audit log        │
└─────────────────────────────────────────────────────────────┘
```

---

## Payment adapter boundary

The payment adapter boundary (`server/payment/`) isolates environment-specific payment behaviour from all other server code. Route handlers call `getAdapter()` and use the returned interface; they never import `sim.ts` or `gateway.ts` directly.

```
server/payment/
├── adapter.ts   Interface definition + environment selector
├── sim.ts       Development simulation — no blockchain calls, simulated=true always
└── gateway.ts   Arc Testnet/Mainnet — Circle Gateway x402 middleware
```

### Selection rules

| `PAYMENT_ADAPTER` | Adapter | Requires |
|---|---|---|
| unset or `sim` | `SimAdapter` | nothing |
| `testnet` | `GatewayAdapter('testnet')` | `SELLER_ADDRESS` |
| `mainnet` | `GatewayAdapter('mainnet')` | `SELLER_ADDRESS` + `MAINNET_CONFIRMED=true` |

The `mainnet` guard (`MAINNET_CONFIRMED=true`) is a hard code-level check, not just documentation. It cannot be bypassed by a misconfigured env file that sets `PAYMENT_ADAPTER=mainnet` without also explicitly setting `MAINNET_CONFIRMED=true`.

### Adding a new adapter

1. Create `server/payment/my-adapter.ts` implementing `PaymentAdapter`.
2. Add a `case 'my-adapter'` to the switch in `adapter.ts`.
3. Add `my-adapter` to the `PaymentAdapterMode` union in `shared/types.ts`.
4. No other files change.

---

## Policy module

`server/policy.ts` contains all treasury policy logic as pure TypeScript functions.

**Rules:**
- No I/O, no external calls, no AI provider imports.
- All monetary values are `bigint` in USDC base units (6 decimals).
- Same input always produces same output — fully testable without mocking.
- Thresholds are exported constants, not magic numbers.

Two entry points:
- `evaluatePolicy(snapshot)` — full structural evaluation of a `TreasurySnapshot`.
- `recommendFromContext(text)` — text-driven recommendation for agent endpoints.

---

## Service catalogue

`server/catalogue.ts` is the authoritative list of all API endpoints, their prices, and their input schemas. The frontend and AI agents must fetch `/api/catalogue` at startup rather than hardcoding endpoint details. Only the server can change the catalogue.

---

## Shared types

`shared/types.ts` contains TypeScript interfaces and enums imported by both `src/` and `server/`. It contains no runtime code — no class instances, no function calls, no imports from Node.js or browser globals. This means it can be safely imported by the Vite bundler and by tsx without any special configuration.

---

## Data flow: AI agent payment call

```
Agent  →  POST /api/agent/recommend-spend
           │
           ├─ idempotencyMiddleware checks X-Idempotency-Key header
           ├─ adapter.requirePayment('0.010000') verifies x402 authorization
           │     sim mode: injects fake payment context, passes through
           │     testnet:  validates Circle Gateway signature, collects USDC
           ├─ route handler: validateInput → recommendFromContext → respond
           └─ response: { recommendation, paidBy, network, simulated, timestamp }
```

---

## What is NOT in the architecture

- No database. State lives onchain (contract) or in-process (idempotency store).
- No AI inference. `policy.ts` is deterministic rule evaluation, not an LLM call.
- No authentication. The server is meant to run behind a Vite proxy for the UI; the agent-payment endpoints are gated by USDC payment, not by API keys.
- No upgradeability. The contract is immutable post-deploy. Migration = new contract + new address.
