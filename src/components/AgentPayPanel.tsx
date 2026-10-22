import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, Zap, CheckCircle2, AlertCircle, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'

interface Endpoint {
  path: string
  price: string
  label: string
  description: string
  bodyPlaceholder: string
}

const ENDPOINTS: Endpoint[] = [
  {
    path: '/api/agent/recommend-spend',
    price: '$0.01',
    label: 'Spend Recommendation',
    description: 'AI-assisted treasury policy recommendation. Pay $0.01 USDC per call via Circle Gateway.',
    bodyPlaceholder: JSON.stringify({ context: 'low balance, obligations high' }, null, 2),
  },
  {
    path: '/api/agent/audit-summary',
    price: '$0.005',
    label: 'Audit Summary',
    description: 'Structured payment audit for agent reasoning. Pay $0.005 USDC per call.',
    bodyPlaceholder: JSON.stringify({ payments: [] }, null, 2),
  },
]

interface ResponseState {
  status: number | null
  data: unknown
  headers: Record<string, string>
}

export function AgentPayPanel() {
  const [selected, setSelected] = useState<Endpoint>(ENDPOINTS[0])
  const [body, setBody] = useState(ENDPOINTS[0].bodyPlaceholder)
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<ResponseState | null>(null)
  const [showHeaders, setShowHeaders] = useState(false)

  async function probe() {
    setLoading(true)
    setResponse(null)
    try {
      const res = await fetch(selected.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      let data: unknown
      try { data = await res.json() } catch { data = await res.text() }
      setResponse({ status: res.status, data, headers })
    } catch (e) {
      setResponse({ status: 0, data: String(e), headers: {} })
    } finally {
      setLoading(false)
    }
  }

  function handleSelectEndpoint(ep: Endpoint) {
    setSelected(ep)
    setBody(ep.bodyPlaceholder)
    setResponse(null)
  }

  const is402 = response?.status === 402
  const is200 = response?.status === 200

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
      className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm"
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-white/10 flex items-center gap-2">
        <Bot size={14} className="text-arc-accent-light" />
        <span className="font-display font-semibold text-white text-sm">Agent Payment Endpoints</span>
        <span className="ml-auto text-[10px] font-mono text-arc-muted uppercase tracking-caps px-2 py-0.5 rounded-full border border-white/10">
          x402
        </span>
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* Endpoint selector */}
        <div className="grid grid-cols-2 gap-2">
          {ENDPOINTS.map(ep => (
            <button
              key={ep.path}
              onClick={() => handleSelectEndpoint(ep)}
              className={`rounded-xl px-3 py-2.5 text-left border transition-colors ${
                selected.path === ep.path
                  ? 'border-arc-accent bg-arc-accent/10 text-white'
                  : 'border-white/10 bg-white/5 text-arc-muted hover:text-white hover:border-white/20'
              }`}
            >
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs font-semibold truncate">{ep.label}</span>
                <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-0.5 shrink-0">
                  <TokenUSDC variant="branded" size={10} />
                  {ep.price}
                </span>
              </div>
              <p className="text-[10px] text-arc-muted font-mono truncate">{ep.path}</p>
            </button>
          ))}
        </div>

        {/* Description */}
        <p className="text-xs text-arc-muted">{selected.description}</p>

        {/* Request body */}
        <div>
          <label className="text-[11px] text-arc-muted uppercase tracking-caps mb-1.5 block">
            Request body (JSON)
          </label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={4}
            spellCheck={false}
            className="w-full bg-white/10 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder:text-arc-muted border border-white/10 focus:outline-none focus:border-arc-accent resize-none"
          />
        </div>

        {/* Probe button */}
        <button
          onClick={probe}
          disabled={loading}
          className="w-full py-2.5 bg-arc-accent text-white font-semibold rounded-xl hover:bg-arc-accent-light disabled:opacity-40 transition-colors flex items-center justify-center gap-2 text-sm"
        >
          {loading ? (
            <span>Probing…</span>
          ) : (
            <>
              <Zap size={14} />
              Send unpaid probe (expect 402)
            </>
          )}
        </button>

        {/* Response */}
        <AnimatePresence>
          {response && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-xl border border-white/10 bg-white/5 overflow-hidden"
            >
              {/* Status bar */}
              <div className={`px-3 py-2 flex items-center gap-2 border-b border-white/10 ${
                is402 ? 'bg-amber-500/10' : is200 ? 'bg-emerald-500/10' : 'bg-red-500/10'
              }`}>
                {is402 ? (
                  <Zap size={13} className="text-amber-400" />
                ) : is200 ? (
                  <CheckCircle2 size={13} className="text-emerald-400" />
                ) : (
                  <AlertCircle size={13} className="text-red-400" />
                )}
                <span className={`text-xs font-mono font-semibold ${
                  is402 ? 'text-amber-400' : is200 ? 'text-emerald-400' : 'text-red-400'
                }`}>
                  HTTP {response.status}
                  {is402 ? ' — Payment Required (expected)' : is200 ? ' — Paid + Served' : ''}
                </span>
              </div>

              {/* Body */}
              <pre className="px-3 py-2.5 text-[11px] font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(response.data, null, 2)}
              </pre>

              {/* Headers toggle */}
              {is402 && Object.keys(response.headers).length > 0 && (
                <div className="border-t border-white/10">
                  <button
                    onClick={() => setShowHeaders(h => !h)}
                    className="w-full px-3 py-2 flex items-center justify-between text-[11px] text-arc-muted hover:text-white transition-colors"
                  >
                    <span>Response headers (contains payment requirements)</span>
                    {showHeaders ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  {showHeaders && (
                    <pre className="px-3 pb-3 text-[10px] font-mono text-slate-400 overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(response.headers, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* How to pay info */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 space-y-1.5">
          <p className="text-[11px] text-arc-muted font-semibold uppercase tracking-caps">How agent payments work</p>
          <p className="text-xs text-arc-muted">
            An unpaid request returns HTTP 402 with a <span className="text-white font-mono">PAYMENT-REQUIRED</span> header.
            An AI agent uses the <span className="text-white font-mono">GatewayClient</span> from{' '}
            <span className="text-white font-mono">@circle-fin/x402-batching/client</span> to sign a gasless USDC authorization
            and retry — Circle Gateway settles the payment in a batched onchain transaction.
          </p>
          <a
            href="https://developers.circle.com/gateway/nanopayments/quickstarts/seller"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-arc-accent-light hover:underline"
          >
            Circle Gateway docs <ExternalLink size={10} />
          </a>
        </div>
      </div>
    </motion.div>
  )
}
