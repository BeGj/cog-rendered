import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
