/**
 * Manual mock for framer-motion in Vitest.
 * Renders children immediately with no animation delay.
 * Place in src/test/__mocks__/ and reference via vi.mock('framer-motion').
 */
import React from 'react'

type AnyProps = Record<string, unknown> & { children?: React.ReactNode }

function passthrough(tag: string) {
  return function MotionComponent({ children, initial: _i, animate: _a, exit: _e, transition: _t, variants: _v, whileHover: _wh, whileTap: _wt, layout: _l, layoutId: _li, ...rest }: AnyProps) {
    return React.createElement(tag, rest, children)
  }
}

export const motion = new Proxy(
  {} as Record<string, ReturnType<typeof passthrough>>,
  { get: (_target, tag: string) => passthrough(tag) }
)

export function AnimatePresence({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

export const useAnimation = () => ({ start: () => {}, stop: () => {} })
export const useMotionValue = (v: number) => ({ get: () => v, set: () => {} })
export const useTransform = () => ({ get: () => 0 })
export const useSpring = (v: number) => ({ get: () => v })
export const useInView = () => [null, false]
export const LayoutGroup = ({ children }: { children?: React.ReactNode }) => <>{children}</>
