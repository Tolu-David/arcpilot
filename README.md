# ArcPilot

**Security-first onchain USDC treasury and AI-assisted agent-payment application.**

Built for the Arc Microgrants 2 hackathon. Deployed on Arc Testnet — a Circle EVM chain where USDC is the native gas token.

---

## What it does

- **Treasury dashboard** — live USDC balance, configurable reserve (basis points), obligations, and spendable capacity.
- **Spending policies** — allowlist payees, set per-payee daily limits, configure recurring obligations.
- **Payment execution** — owner-gated USDC payments enforced by the smart contract.
- **AI agent payments** — HTTP endpoints priced in USDC via Circle Gateway Nanopayments (x402 protocol). AI agents pay per call; no API key or account needed.
- **Audit log** — every payment is recorded onchain and readable from the UI.

---

## Directory structure

```
arcpilot/
├── contracts/          Solidity (Forge) — ArcPilot treasury contract + tests
├── src/                React + TypeScript frontend (Vite + wagmi + ConnectKit)
├── server/             Express API server (tsx, no compile step)
│   ├── catalogue.ts    Server-controlled service catalogue
│   ├── policy.ts       Deterministic policy engine (pure functions, no AI)
│   └── payment/        Adapter boundary: sim | testnet | mainnet
├── shared/             TypeScript types shared by frontend and backend
└── docs/               Architecture and security review notes
```

---

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- [Foundry](https://getfoundry.sh) (forge, anvil, cast)
- Node.js >= 20 (for tsx compatibility)

---

## Setup

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp env.example .env
# Edit .env — at minimum set VITE_WALLETCONNECT_PROJECT_ID and SELLER_ADDRESS

# 3. Start the frontend (Vite dev server, port 5173)
bun run dev

# 4. Start the API server in a second terminal (port 3001)
bun run server
```

The Vite dev server proxies `/api/*` to `localhost:3001`, so the frontend and server work together without CORS issues.

---

## Environment variables

See `env.example` for the full reference with explanations.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VITE_WALLETCONNECT_PROJECT_ID` | For QR flow | — | https://cloud.walletconnect.com |
| `VITE_ARCPILOT_CONTRACT` | After deploy | hardcoded fallback | Deployed contract address |
| `AGENT_SERVER_PORT` | No | `3001` | Express server port |
| `SELLER_ADDRESS` | For paid endpoints | — | EVM address receiving USDC |
| `PAYMENT_ADAPTER` | No | `sim` | `sim` \| `testnet` \| `mainnet` |
| `MAINNET_CONFIRMED` | For mainnet | — | Must be `true` to unlock mainnet adapter |

---

## Commands

### Frontend
```bash
bun run dev          # Vite dev server (hot reload)
bun run build        # Production build → dist/
bun run preview      # Serve the production build locally
```

### Server
```bash
bun run server       # Express server with tsx watch (hot reload)
```

### Type checking and lint
```bash
bun run check        # TypeScript check: frontend + server + shared
```

### Contract tests (Foundry)
```bash
bun run test:contracts              # All Forge tests (unit + invariant)
forge test --root . -vv             # Same, with verbose output
forge test --root . --gas-report    # Include gas report
forge build                         # Compile contracts only
```

### Policy module tests
```bash
bun run test:policy   # Node.js built-in test runner against server/policy.ts
```

---

## Deployed contract

| Network | Address | Explorer |
|---|---|---|
| Arc Testnet | `0xc10f1f2e659a61ef484c06ecbf161160f929e868` | [View on explorer](https://explorer.testnet.arc.io/address/0xc10f1f2e659a61ef484c06ecbf161160f929e868) |

Constructor args at deploy:
- `initialOwner`: Circle platform deployer wallet
- `_usdc`: `0x3600000000000000000000000000000000000000` (Arc USDC)
- `_reserveBps`: `2000` (20% reserve)

---

## Arc network

| Field | Value |
|---|---|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.testnet.arc.io` |
| USDC | `0x3600000000000000000000000000000000000000` |
| USDC decimals | 6 (ERC-20 view) |

USDC is the native gas token on Arc — one pool of funds, two views. Never show or sum the native and ERC-20 balances separately.

---

## Agent payment API

With the server running (`bun run server`), AI agents can discover and call services:

```bash
# Discover all services and their prices
curl http://localhost:3001/api/catalogue

# Free: server health
curl http://localhost:3001/api/agent/health

# Paid (sim mode — no real payment): spend recommendation
curl -X POST http://localhost:3001/api/agent/recommend-spend \
  -H 'Content-Type: application/json' \
  -d '{"context":"low balance with two payees"}'
```

In `sim` mode (default), paid endpoints pass through without collecting real USDC. Switch to `PAYMENT_ADAPTER=testnet` with a real `SELLER_ADDRESS` to enable live Circle Gateway payments.

---

## Security notes

- No private keys or credentials in source code. Use `.env` (never committed).
- The mainnet payment adapter requires `MAINNET_CONFIRMED=true` as an explicit guard.
- All monetary values are USDC integer base units (bigint). No floating-point arithmetic.
- `ArcPilot.sol` has been through a max-severity security review — see `contracts/ArcPilotTreasury-design.md` and `docs/` for findings and mitigations.
- This is a hackathon project. Do not use with real funds without an independent professional audit.

---

## License

MIT
