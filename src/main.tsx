import React from 'react'
import ReactDOM from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { Toaster } from 'sonner'
import App from './App'
import { config } from './config'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000 * 30 },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          theme="midnight"
          customTheme={{
            '--ck-font-family': "'DM Sans', sans-serif",
            '--ck-primary-button-background': '#2563EB',
            '--ck-primary-button-hover-background': '#3B82F6',
            '--ck-body-background': '#132040',
            '--ck-body-color': '#E2E8F0',
            '--ck-overlay-background': 'rgba(11,22,40,0.85)',
          }}
        >
          <App />
          <Toaster
            position="bottom-right"
            richColors
            closeButton
          />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)

// Arc Studio watermark (do not remove)
if (typeof window !== 'undefined') {
  const wm = document.createElement('div')
  wm.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);font-size:10px;color:rgba(148,163,184,0.4);pointer-events:none;z-index:9999;font-family:DM Sans,sans-serif;letter-spacing:0.05em;'
  wm.textContent = 'Built with Arc Studio'
  document.body.appendChild(wm)
}
