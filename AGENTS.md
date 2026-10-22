# ArcPilot — Project Memory

## What this is
An onchain USDC treasury management app on Arc Testnet. The owner deploys an `ArcPilot` contract, deposits USDC, configures obligations and reserve, permits payees, and executes payments — all with a verifiable onchain audit log.

## Contract
- **Source**: `contracts/ArcPilot.sol`
- **Deployed address**: (not yet deployed — ask Arc Studio to deploy)
- **Constructor args**: `_usdc` (USDC address on Arc Testnet: `0x3600000000000000000000000000000000000000`), `_reserveBps` (e.g. `2000` for 20%)
- **Chain**: Arc Testnet (chain ID 5042002)

## Frontend
- `src/App.tsx` — root composition
- `src/config.ts` — wagmi config, chain/token constants
- `src/lib/abi.ts` — ArcPilot ABI
- `src/lib/utils.ts` — formatting helpers
- `src/components/` — TreasuryCard, PolicyPanel, PayPanel, AuditLog, ContractInput, Header

## Notes
- USDC on Arc is the native gas token (ERC-20 view: 6 decimals, `0x3600...0000`)
- Only the contract owner can call `pay()`, `setObligation()`, `setPayee()`, `setReserveBps()`
- Spendable = totalBalance − obligations − reserve
