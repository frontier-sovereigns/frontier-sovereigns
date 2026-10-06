import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const gamePort=process.env.GAME_PORT??'3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${gamePort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${gamePort}`, ws: true, changeOrigin: true },
    },
  },
  build: { target: 'es2022' },
});
