import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["manifold-3d", "occt-import-js"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
