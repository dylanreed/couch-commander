/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/views/**/*.ejs'],
  theme: {
    extend: {
      colors: {
        // Evening Lounge palette
        lounge: {
          bg: '#13111a',
          surface: '#1e1b2e',
          card: '#252236',
          border: '#3d3654',
          cream: '#f8f5f0',
          muted: '#9a8eb0',
          gold: '#c9a87c',
          'gold-dim': '#a08560',
          watching: '#6ee7b7',
          queue: '#fcd34d',
          finished: '#94a3b8',
        },
      },
      fontFamily: {
        display: ['Playfair Display', 'serif'],
        body: ['Plus Jakarta Sans', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(201, 168, 124, 0.2)' },
          '100%': { boxShadow: '0 0 20px rgba(201, 168, 124, 0.4)' },
        },
      },
    },
  },
  plugins: [],
};
