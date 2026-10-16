import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/whaaat/' : '/',
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
});
