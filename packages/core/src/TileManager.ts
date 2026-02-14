import { Viewport } from './Viewport';
import { WorkerPool } from './WorkerPool';

export interface BandMetadata {
    index: number;
    name: string;
    description: string;
}

export class TileManager {
    device: GPUDevice;
    pipeline: GPURenderPipeline;

    workerPool: WorkerPool;

    // Cache
    tiles: Map<string, Tile> = new Map();

    tileSize: number = 256;
    imageWidth: number = 0;
    imageHeight: number = 0;

    // Global Stats
    globalMin: number = 0;
    globalMax: number = 255; // Default 8-bit
    hasGlobalStats: boolean = false;

    // Band metadata
    bandMetadata: BandMetadata[] = [];
    selectedBands: number[] = [];
    onBandsInitialized: ((bands: BandMetadata[], suggestedBands: number[]) => void) | null = null;

    grayBindGroup: GPUBindGroup | undefined;
    grayUniformBuffer: GPUBuffer | undefined;

    levels: any[] = [];
    onInitComplete: ((width: number, height: number, tileSize: number, levels: any[]) => void) | null = null;
    version: number = 0;

    constructor(device: GPUDevice, pipeline: GPURenderPipeline, workerFactory: () => Worker) {
        this.device = device;
        this.pipeline = pipeline;
        this.workerPool = new WorkerPool(workerFactory);
        this.initGrayPlaceholder();
    }

    initGrayPlaceholder() {
        const texture = this.device.createTexture({
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        const data = new Uint8Array([50, 50, 50, 255]);
        this.device.queue.writeTexture(
            { texture },
            data,
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 1]
        );

        this.grayUniformBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        this.grayBindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: sampler },
                { binding: 2, resource: { buffer: this.grayUniformBuffer } },
            ]
        });
    }

    async init(source: File | string) {
        // Cleanup existing tiles
        for (const tile of this.tiles.values()) {
            if (tile.texture) tile.texture.destroy();
        }
        this.tiles.clear();
        this.levels = [];
        this.imageWidth = 0;
        this.imageHeight = 0;
        this.bandMetadata = [];
        this.selectedBands = [];
        this.globalMin = 0;
        this.globalMax = 1;
        this.hasGlobalStats = false;
        this.version = 0;

        // Initialize workers and fetch metadata
        // 1. Broadcast init to all workers providing the source
        this.workerPool.broadcast({ type: 'init', source });

        // 2. Send a specific task to one worker to retrieve the metadata response
        // Note: Sending 'init' again is safe as it's idempotent for metadata retrieval
        const response = await this.workerPool.process('init-task', { type: 'init', source, id: 'init-task' }, 100);

        // Handle response
        const { levels, bandMetadata, suggestedBands } = response;
        this.levels = levels;
        this.imageWidth = levels[0].width;
        this.imageHeight = levels[0].height;
        this.tileSize = levels[0].tileWidth;

        if (bandMetadata) {
            this.bandMetadata = bandMetadata;
            this.selectedBands = suggestedBands || [];
        }

        if (this.grayUniformBuffer) {
            const data = new Float32Array([
                0, 0,
                this.imageWidth, this.imageHeight
            ]);
            this.device.queue.writeBuffer(this.grayUniformBuffer, 0, data);
        }

        if (this.onBandsInitialized && bandMetadata) {
            this.onBandsInitialized(this.bandMetadata, this.selectedBands);
        }

        if (this.onInitComplete) {
            this.onInitComplete(this.imageWidth, this.imageHeight, this.tileSize, this.levels);
        }
    }

    getBestLevel(viewport: Viewport): number {
        if (!this.levels.length) return 0;
        const targetRes = 1 / viewport.zoom;
        let bestLevel = 0;
        for (let i = 0; i < this.levels.length; i++) {
            const levelRes = this.imageWidth / this.levels[i].width;
            if (levelRes <= targetRes) {
                bestLevel = i;
            } else {
                break;
            }
        }
        return bestLevel;
    }

    /**
     * Determine which tiles are visible and strictly request them.
     * Cancels filtered-out tiles.
     */
    getVisibleTiles(viewport: Viewport): Tile[] {
        const visibleTiles: Tile[] = [];
        const currentFrameTime = Date.now();

        if (this.grayBindGroup) {
            visibleTiles.push({
                id: 'background',
                x: 0, y: 0, z: -1,
                loaded: true,
                worldX: 0, worldY: 0,
                width: this.imageWidth,
                height: this.imageHeight,
                lastUsed: currentFrameTime,
                bindGroup: this.grayBindGroup
            });
        }

        if (this.levels.length === 0) return visibleTiles;

        const targetLevelIndex = this.getBestLevel(viewport);
        const sortedLevels = [...this.levels].sort((a, b) => b.index - a.index);

        // Track requested tiles this frame to identify what to Cancel
        const requiredTiles = new Set<string>();

        // Collect new requests to sort by priority
        const pendingRequests: { tile: Tile, index: number, priority: number }[] = [];

        for (const level of sortedLevels) {
            const levelIndex = level.index;
            const downscale = this.levels[0].width / level.width;
            const tileW = level.tileWidth;
            const tileH = level.tileHeight;

            // Viewport bounds calculation
            const halfW = viewport.size[0] / 2 / viewport.zoom;
            const halfH = viewport.size[1] / 2 / viewport.zoom;
            const minX = viewport.center[0] - halfW;
            const maxX = viewport.center[0] + halfW;
            const minY = viewport.center[1] - halfH;
            const maxY = viewport.center[1] + halfH;

            const lMinX = minX / downscale;
            const lMaxX = maxX / downscale;
            const lMinY = minY / downscale;
            const lMaxY = maxY / downscale;

            const startX = Math.max(0, Math.floor(lMinX / tileW));
            const endX = Math.min(Math.ceil(level.width / tileW), Math.ceil(lMaxX / tileW));
            const startY = Math.max(0, Math.floor(lMinY / tileH));
            const endY = Math.min(Math.ceil(level.height / tileH), Math.ceil(lMaxY / tileH));

            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    const key = `${levelIndex}-${x}-${y}`;
                    requiredTiles.add(key);

                    let tile = this.tiles.get(key);

                    if (levelIndex === targetLevelIndex) {
                        if (!tile) {
                            const worldX = x * tileW * downscale;
                            const worldY = y * tileH * downscale;

                            tile = {
                                id: key,
                                x, y, z: levelIndex,
                                loaded: false,
                                worldX, worldY,
                                width: tileW * downscale,
                                height: tileH * downscale,
                                lastUsed: currentFrameTime
                            };
                            this.tiles.set(key, tile);

                            // Calculate Priority: Distance from center
                            const tileCenterW = worldX + (tile.width / 2);
                            const tileCenterH = worldY + (tile.height / 2);
                            const dx = tileCenterW - viewport.center[0];
                            const dy = tileCenterH - viewport.center[1];
                            const distSq = dx * dx + dy * dy;
                            // Invert distance for priority (closer = higher)
                            // Use arbitrary large number - distance
                            const priority = 1000000000000 - distSq;

                            // Queue request instead of sending immediately
                            pendingRequests.push({ tile, index: level.index, priority });
                        } else if (!tile.loaded) {
                            // If tile exists but not loaded, ensure it's prioritized?
                            // It might be already in progress or queued.
                            // WorkerPool handles duplicate task IDs by updating priority.
                            // So we can re-request it to update priority if user panned.
                            // Recalculate priority
                            const tileCenterW = tile.worldX + (tile.width / 2);
                            const tileCenterH = tile.worldY + (tile.height / 2);
                            const dx = tileCenterW - viewport.center[0];
                            const dy = tileCenterH - viewport.center[1];
                            const distSq = dx * dx + dy * dy;
                            const priority = 1000000000000 - distSq;
                            pendingRequests.push({ tile, index: level.index, priority });
                        }
                    }

                    if (tile) {
                        tile.lastUsed = currentFrameTime;
                        if (tile.loaded && tile.bindGroup) {
                            visibleTiles.push(tile);
                        } else if (levelIndex !== targetLevelIndex) {
                            // keep alive
                        }
                    }
                }
            }
        }

        // Process collected requests sorted by priority
        pendingRequests.sort((a, b) => b.priority - a.priority);
        for (const req of pendingRequests) {
            this.requestTile(req.tile, req.index, req.priority);
        }

        // Cancel pending tiles that are no longer required
        // Iterate all tiles, if not loaded and not in requiredTiles, abort.
        for (const [key, tile] of this.tiles.entries()) {
            if (!tile.loaded && !requiredTiles.has(key)) {
                // Abort loading if tile is no longer visible
                this.workerPool.abort(key);
            }
        }

        this.prune(currentFrameTime);
        return visibleTiles;
    }

    prune(activeTime: number) {
        const CACHE_LIMIT = 1000; // Increased limit
        if (this.tiles.size <= CACHE_LIMIT) return;
        const entries = Array.from(this.tiles.entries());
        entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);

        const targetSize = CACHE_LIMIT - 50;
        let removed = 0;
        const toRemove = Math.max(0, this.tiles.size - targetSize);

        for (const [key, tile] of entries) {
            if (removed >= toRemove) break;
            if (tile.lastUsed === activeTime) continue;

            if (tile.texture) tile.texture.destroy();
            this.workerPool.abort(key); // Ensure aborted
            this.tiles.delete(key);
            removed++;
        }
    }

    screenToWorld(sx: number, sy: number, viewport: Viewport) {
        const wx = (sx - viewport.size[0] / 2) / viewport.zoom + viewport.center[0];
        const wy = (sy - viewport.size[1] / 2) / viewport.zoom + viewport.center[1];
        return { x: wx, y: wy };
    }

    requestTile(tile: Tile, index: number, priority: number) {
        const req = {
            type: 'decode',
            id: tile.id,
            tileX: tile.x * (this.levels[tile.z].tileWidth),
            tileY: tile.y * (this.levels[tile.z].tileHeight),
            tileZ: tile.z,
            index: index,
            tileSize: this.levels[tile.z].tileWidth,
            bandIndices: this.selectedBands.length > 0 ? this.selectedBands : undefined
        };

        this.workerPool.process(tile.id, req, priority)
            .then(data => {
                if (data && data.data) {
                    this.handleTileDecoded(tile, data);
                }
            })
            .catch(err => {
                // If aborted or error, remove tile so it can be retried if needed
                if (this.tiles.has(tile.id)) {
                    const t = this.tiles.get(tile.id);
                    if (t && t.texture) t.texture.destroy();
                    this.tiles.delete(tile.id);
                }
            });
    }

    handleTileDecoded(tile: Tile, result: any) {
        const { data, min, max } = result;
        if (!data) return;

        // Update Global Stats
        if (!this.hasGlobalStats) {
            this.globalMin = min;
            this.globalMax = max;
            this.hasGlobalStats = true;
        } else {
            if (min < this.globalMin) this.globalMin = min;
            if (max > this.globalMax) this.globalMax = max;
        }

        this.uploadTile(tile, data);
        tile.loaded = true;
        tile.min = min;
        tile.max = max;
        this.version++;
    }

    setBands(bandIndices: number[]) {
        this.selectedBands = bandIndices;
        for (const tile of this.tiles.values()) {
            if (tile.texture) tile.texture.destroy();
            this.workerPool.abort(tile.id);
        }
        this.tiles.clear();
        this.globalMin = 0;
        this.globalMax = 1;
        this.hasGlobalStats = false;
        this.version++;
    }

    uploadTile(tile: Tile, data: Float32Array) {
        const dim = Math.sqrt(data.length / 4);
        const bytesPerRow = dim * 16;
        const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;
        const needsPadding = bytesPerRow !== alignedBytesPerRow;

        let uploadData = data;
        if (needsPadding) {
            const padded = new Float32Array((alignedBytesPerRow / 4) * dim);
            for (let y = 0; y < dim; y++) {
                const srcRow = data.subarray(y * dim * 4, (y + 1) * dim * 4);
                const dstOffset = (y * alignedBytesPerRow) / 4;
                padded.set(srcRow, dstOffset);
            }
            uploadData = padded;
        }

        tile.texture = this.device.createTexture({
            size: [dim, dim, 1],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this.device.queue.writeTexture(
            { texture: tile.texture },
            uploadData as any,
            { bytesPerRow: alignedBytesPerRow, rowsPerImage: dim },
            [dim, dim, 1]
        );

        // Create Uniform Buffer for Tile Transform
        const uniformBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const uniformData = new Float32Array([
            tile.worldX, tile.worldY,
            tile.width, tile.height
        ]);
        this.device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        // Use non-filtering sampler by default to match rgba32float support
        const sampler = this.device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        tile.bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: tile.texture.createView() },
                { binding: 1, resource: sampler },
                { binding: 2, resource: { buffer: uniformBuffer } },
            ]
        });
    }

    get pendingRequests(): number {
        return this.workerPool.pendingCount;
    }
}

export interface Tile {
    id: string;
    x: number;
    y: number;
    z: number;
    loaded: boolean;
    worldX: number;
    worldY: number;
    width: number;
    height: number;
    texture?: GPUTexture;
    bindGroup?: GPUBindGroup;
    lastUsed: number;
    min?: number;
    max?: number;
}

export interface ADRAOptions {
    clipLow: number;  // 0-100
    clipHigh: number; // 0-100
    padLow: number;   // 0-100 (percent of range)
    padHigh: number;  // 0-100 (percent of range)
}
