import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/fitenclosuregen/",
  plugins: [react()],
  server: {
    watch: {
      usePolling: true,
      interval: 150,
    },
  },
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["manifold-3d", "occt-import-js"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
