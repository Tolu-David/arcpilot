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
        ap: {
          // Primary surfaces
          bg:        '#102338',   // primary navy canvas
          surface:   '#263D56',   // alternate navy — cards, sidebar
          elevated:  '#1C3048',   // slightly lighter — hover states, inner panels
          // Text
          text:      '#F3F0E8',   // primary text
          muted:     '#A8B2B5',   // secondary text, labels
          // Accent
          gold:      '#D4B477',   // muted gold accent
          'gold-dim':'#A88B4F',   // dimmed gold for icons/borders
          // Borders
          border:    '#34465A',   // standard border
          'border-subtle': 'rgba(52,70,90,0.6)', // faint border
          // Semantic
          success:   '#4CAF82',
          danger:    '#E05C5C',
          warning:   '#D4A853',
          info:      '#5B9BD5',
          // Glass surfaces
          glass:     'rgba(38,61,86,0.7)',
          'glass-border': 'rgba(52,70,90,0.8)',
        },
      },
      letterSpacing: {
        display: '-0.03em',
        caps:    '0.07em',
      },
      boxShadow: {
        card:    '0 1px 3px 0 rgba(0,0,0,0.3), 0 1px 2px -1px rgba(0,0,0,0.3)',
        panel:   '0 4px 16px 0 rgba(0,0,0,0.4)',
        glow:    '0 0 0 3px rgba(212,180,119,0.25)',
        'glow-focus': '0 0 0 3px rgba(212,180,119,0.35)',
      },
      backgroundImage: {
        'sidebar-gradient': 'linear-gradient(180deg, #1C3048 0%, #102338 100%)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.25, 0.1, 0.25, 1.0)',
      },
    },
  },
  plugins: [],
}
