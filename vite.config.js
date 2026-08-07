import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forwards /api/* calls to the backend proxy server during `npm run dev`.
      // In production, set VITE_API_BASE to your deployed backend URL instead.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
