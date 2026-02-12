import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    base: process.env.VITE_BASE_PATH || '/',
    resolve: {
        alias: {
            '@cog-renderer/core': path.resolve(__dirname, '../../packages/core/src'),
        },
    },
    worker: {
        format: 'es',
    }
});
