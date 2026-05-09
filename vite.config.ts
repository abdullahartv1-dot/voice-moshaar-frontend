import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://127.0.0.1:8080"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: BACKEND_URL,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
