import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// RTL cleanup after each test
afterEach(() => {
  cleanup()
})
