import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    base: '/cog-rendered/',
    resolve: {
        alias: {
            '@cog-renderer/core': path.resolve(__dirname, '../../packages/core/src'),
        },
    },
    worker: {
        format: 'es',
    }
});
