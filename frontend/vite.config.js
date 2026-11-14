import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The console talks to the API through the dev server's proxy, so the browser never
// needs CORS and the webhook secret never ships in the JS bundle: the proxy adds it
// server-side to simulated provider calls. Secret + port come from backend/.env.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(import.meta.dirname, '../backend'), '');
  const target = `http://localhost:${env.PORT || 3000}`;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api/v1/webhooks': {
          target,
          headers: env.WEBHOOK_SECRET ? { 'x-webhook-secret': env.WEBHOOK_SECRET } : {},
        },
        '/api': { target },
        '/health': { target },
      },
    },
  };
});
