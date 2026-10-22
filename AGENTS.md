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

## Notes
- USDC on Arc is the native gas token (ERC-20 view: 6 decimals, `0x3600...0000`)
- Only the contract owner can call `pay()`, `setObligation()`, `setPayee()`, `setReserveBps()`
- Spendable = totalBalance − obligations − reserve
