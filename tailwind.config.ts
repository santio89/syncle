import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          900: "#050608",
          800: "#0a0c10",
          700: "#10131a",
          600: "#181c25",
          500: "#252a36",
          400: "#3a4150",
          300: "#5a6272",
        },
        bone: {
          50: "#f5f5f0",
          100: "#eceae0",
          200: "#d8d4c4",
        },
        accent: {
          DEFAULT: "#3da9ff",
          400: "#5cb8ff",
          500: "#3da9ff",
          600: "#1c8de8",
          700: "#0e6cba",
          glow: "#7cc4ff",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        brut: "6px 6px 0 0 rgba(0,0,0,1)",
        "brut-sm": "3px 3px 0 0 rgba(0,0,0,1)",
        "brut-accent": "6px 6px 0 0 rgba(61,169,255,0.6)",
      },
    },
  },
  plugins: [],
};

export default config;
