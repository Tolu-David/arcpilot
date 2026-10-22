/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['Space Grotesk', 'sans-serif'],
        body: ['DM Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      colors: {
        arc: {
          navy: '#0B1628',
          'navy-light': '#132040',
          blue: '#1A3A6B',
          accent: '#2563EB',
          'accent-light': '#3B82F6',
          muted: '#94A3B8',
          surface: 'rgba(255,255,255,0.06)',
          border: 'rgba(255,255,255,0.10)',
        },
      },
      letterSpacing: {
        display: '-0.03em',
        caps: '0.07em',
      },
    },
  },
  plugins: [],
}
