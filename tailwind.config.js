/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scan every Angular template + TS file so class names used in components are kept.
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        // Formal "legal chambers" palette: deep indigo + brass accent.
        ink: {
          50: '#f4f6fb',
          100: '#e6ebf6',
          200: '#c9d4ea',
          500: '#3f5183',
          700: '#25315a',
          800: '#1b2445',
          900: '#131a33'
        },
        brass: {
          400: '#d6a94a',
          500: '#c2933a',
          600: '#a2782c'
        }
      },
      fontFamily: {
        // Tamil-first stack. Noto Sans Tamil is loaded in index.html.
        tamil: ['"Noto Sans Tamil"', '"Latha"', 'system-ui', 'sans-serif'],
        serifTamil: ['"Noto Serif Tamil"', '"Latha"', 'Georgia', 'serif']
      },
      keyframes: {
        // Google-Assistant-style expanding rings around the mic button.
        micWave: {
          '0%': { transform: 'scale(1)', opacity: '0.55' },
          '100%': { transform: 'scale(2.1)', opacity: '0' }
        },
        micPulse: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.06)' }
        },
        toastIn: {
          '0%': { transform: 'translateY(-12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        caretBlink: {
          '0%, 45%': { opacity: '1' },
          '50%, 95%': { opacity: '0' }
        }
      },
      animation: {
        'mic-wave': 'micWave 1.8s ease-out infinite',
        'mic-pulse': 'micPulse 1.4s ease-in-out infinite',
        'toast-in': 'toastIn 0.25s ease-out',
        'caret-blink': 'caretBlink 1.1s steps(1) infinite'
      }
    }
  },
  plugins: []
};
