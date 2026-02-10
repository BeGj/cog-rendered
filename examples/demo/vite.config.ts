import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@cog-renderer/core': path.resolve(__dirname, '../../packages/core/src'),
        },
    },
    worker: {
        format: 'es',
    }
});
