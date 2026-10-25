/**
 * Shared mock factories for Vitest component tests.
 * Import and call setupWagmiMocks() at the top of each test file.
 */
import { vi } from 'vitest'

export function setupWagmiMocks() {
  vi.mock('wagmi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('wagmi')>()
    return {
      ...actual,
      useReadContracts: vi.fn(() => ({ data: undefined })),
      useReadContract: vi.fn(() => ({ data: undefined, isLoading: false })),
      useAccount: vi.fn(() => ({ isConnected: false, address: undefined })),
      useChainId: vi.fn(() => 1),
      useWriteContract: vi.fn(() => ({ writeContractAsync: vi.fn(), isPending: false })),
      useWaitForTransactionReceipt: vi.fn(() => ({ isLoading: false, isSuccess: false })),
      useSwitchChain: vi.fn(() => ({ switchChainAsync: vi.fn() })),
    }
  })
  vi.mock('connectkit', async (importOriginal) => {
    const actual = await importOriginal<typeof import('connectkit')>()
    return { ...actual, ConnectKitButton: () => null }
  })
}
