/**
 * @file vite.config.ts
 * @description Vite build configuration for PropOS frontend.
 * Responsible for: dev server, build output, path aliases.
 * NOT responsible for: deployment, environment variable injection (handled by .env files).
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
})
