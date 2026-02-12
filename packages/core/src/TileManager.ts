import { Viewport } from './Viewport';
// We'll trust the user to provide the worker URL or a factory function for now.
// Or we can use a Blob for the worker if we inline the source, but that's complex for a library build.
// Lets assume the user passes a Worker instance or URL.

export interface BandMetadata {
    index: number;
    name: string;
    description: string;
}

export class TileManager {
    device: GPUDevice;
    pipeline: GPURenderPipeline; // We need the bind group layout

    // We need a worker.
    worker: Worker;

    // Cache
    // Map key: "z-x-y"
    tiles: Map<string, Tile> = new Map();

    // LRU?
    // Array of keys? 
    // Simply clear if too many?

    tileSize: number = 256; // Default, will read from metadata
    imageWidth: number = 0;
    imageHeight: number = 0;

    // Global Stats (for when ADRA is off)
    globalMin: number = 0;
    globalMax: number = 1; // Default
    hasGlobalStats: boolean = false;

    // Band metadata
    bandMetadata: BandMetadata[] = [];
    selectedBands: number[] = [];
    onBandsInitialized: ((bands: BandMetadata[], suggestedBands: number[]) => void) | null = null;

    grayBindGroup: GPUBindGroup | undefined;
    grayUniformBuffer: GPUBuffer | undefined;

    constructor(device: GPUDevice, pipeline: GPURenderPipeline, worker: Worker) {
        this.device = device;
        this.pipeline = pipeline;
        this.worker = worker;

        this.worker.onmessage = this.handleWorkerMessage.bind(this);
        this.initGrayPlaceholder();
    }

    initGrayPlaceholder() {
        // 1x1 Gray Texture
        const texture = this.device.createTexture({
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        const data = new Uint8Array([50, 50, 50, 255]); // Dark gray
        this.device.queue.writeTexture(
            { texture },
            data,
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 1]
        );

        // Uniform Buffer
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

    levels: any[] = [];

    onInitComplete: ((width: number, height: number, tileSize: number, levels: any[]) => void) | null = null;

    version: number = 0;

    handleWorkerMessage(e: MessageEvent) {
        const { type, id, bitmap, levels, bandMetadata, suggestedBands } = e.data;
        if (type === 'init-complete') {
            this.levels = levels;
            // Level 0 is full res
            this.imageWidth = levels[0].width;
            this.imageHeight = levels[0].height;
            this.tileSize = levels[0].tileWidth;

            // Store band metadata
            if (bandMetadata) {
                this.bandMetadata = bandMetadata;
                this.selectedBands = suggestedBands || [];
            }

            // Update gray tile uniform to cover the whole image
            if (this.grayUniformBuffer) {
                const data = new Float32Array([
                    0, 0, // x, y (World)
                    this.imageWidth, this.imageHeight // width, height (World)
                ]);
                this.device.queue.writeBuffer(this.grayUniformBuffer, 0, data);
            }

            // Notify about bands first
            if (this.onBandsInitialized && bandMetadata) {
                this.onBandsInitialized(this.bandMetadata, this.selectedBands);
            }

            if (this.onInitComplete) {
                this.onInitComplete(this.imageWidth, this.imageHeight, this.tileSize, this.levels);
            }
        } else if (type === 'tile-decoded') {
            const tile = this.tiles.get(id);
            if (tile) {
                const { data, min, max } = e.data;
                if (data) {
                    // Update Global Stats
                    if (!this.hasGlobalStats) {
                        this.globalMin = min;
                        this.globalMax = max;
                        this.hasGlobalStats = true;
                    } else {
                        // Expand global range
                        if (min < this.globalMin) this.globalMin = min;
                        if (max > this.globalMax) this.globalMax = max;
                    }

                    // Upload to GPU
                    this.uploadTile(tile, data);
                    tile.loaded = true;
                    tile.min = min;
                    tile.max = max;

                    // Increment version to signal data change
                    this.version++;
                } else {
                    // Failed to decode (likely out of bounds or error). 
                    tile.loaded = true;
                }
            }
        }
    }

    init(source: File | string) {
        // Cleanup existing tiles
        for (const tile of this.tiles.values()) {
            if (tile.texture) tile.texture.destroy();
        }
        this.tiles.clear();
        this.levels = [];
        this.imageWidth = 0;
        this.imageHeight = 0;

        // Reset band metadata
        this.bandMetadata = [];
        this.selectedBands = [];

        // Reset global stats to prevent stale data from previous file
        this.globalMin = 0;
        this.globalMax = 1;
        this.hasGlobalStats = false;

        // Reset version for change detection
        this.version = 0;

        this.worker.postMessage({
            type: 'init',
            source
        });
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

    getVisibleTiles(viewport: Viewport): Tile[] {
        const visibleTiles: Tile[] = [];
        const currentFrameTime = Date.now();

        // Always add background tile first if ready
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

        // Render from Lowest Res (High Index) to Highest Res (Low Index)
        // This ensures high-res tiles are drawn ON TOP of low-res tiles (Painter's Algorithm)
        const sortedLevels = [...this.levels].sort((a, b) => b.index - a.index);

        for (const level of sortedLevels) {
            const levelIndex = level.index;
            const downscale = this.levels[0].width / level.width;

            // Viewport bounds in World Coordinates (Level 0)
            const halfW = viewport.size[0] / 2 / viewport.zoom;
            const halfH = viewport.size[1] / 2 / viewport.zoom;

            const minX = viewport.center[0] - halfW;
            const maxX = viewport.center[0] + halfW;
            const minY = viewport.center[1] - halfH;
            const maxY = viewport.center[1] + halfH;

            // Map Level 0 bounds to Level bounds
            const lMinX = minX / downscale;
            const lMaxX = maxX / downscale;
            const lMinY = minY / downscale;
            const lMaxY = maxY / downscale;

            const tileW = level.tileWidth;
            const tileH = level.tileHeight;

            const startX = Math.max(0, Math.floor(lMinX / tileW));
            const endX = Math.min(Math.ceil(level.width / tileW), Math.ceil(lMaxX / tileW));
            const startY = Math.max(0, Math.floor(lMinY / tileH));
            const endY = Math.min(Math.ceil(level.height / tileH), Math.ceil(lMaxY / tileH));

            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    const key = `${levelIndex}-${x}-${y}`;
                    let tile = this.tiles.get(key);

                    // If this is the TARGET level, we MUST ensure the tile exists and is requested
                    if (levelIndex === targetLevelIndex) {
                        if (!tile) {
                            const worldX = x * tileW * downscale;
                            const worldY = y * tileH * downscale;
                            const worldW = tileW * downscale;
                            const worldH = tileH * downscale;

                            tile = {
                                id: key,
                                x, y, z: levelIndex,
                                loaded: false,
                                worldX, worldY,
                                width: worldW,
                                height: worldH,
                                lastUsed: currentFrameTime
                            };
                            this.tiles.set(key, tile);
                            this.requestTile(tile, level.index);
                        }
                    }

                    if (tile) {
                        // If loaded, we render it
                        if (tile.loaded && tile.bindGroup) {
                            tile.lastUsed = currentFrameTime;
                            visibleTiles.push(tile);
                        } else if (levelIndex === targetLevelIndex) {
                            // Keep it alive if it's being requested
                            tile.lastUsed = currentFrameTime;
                        } else if (!tile.loaded) {
                            // Also keep alive other-level tiles if they exist (maybe loading)
                            tile.lastUsed = currentFrameTime;
                        }
                    }
                }
            }
        }

        this.prune(currentFrameTime);

        return visibleTiles;
    }

    prune(activeTime: number) {
        const CACHE_LIMIT = 500; // Increased from 100
        if (this.tiles.size <= CACHE_LIMIT) return;

        const entries = Array.from(this.tiles.entries());
        // Sort: oldest lastUsed first
        entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);

        // We want to remove tiles until we reach a safe limit (e.g. CACHE_LIMIT - 50 buffer)
        // BUT strictly do NOT remove tiles used this frame (activeTime).

        const targetSize = CACHE_LIMIT - 50;
        let removedCount = 0;
        const toRemoveCount = Math.max(0, this.tiles.size - targetSize);

        for (const [key, tile] of entries) {
            if (removedCount >= toRemoveCount) break;

            // Critical check: fail-safe against deleting visible tiles
            if (tile.lastUsed === activeTime) continue;

            // Destroy GPU resources
            if (tile.texture) tile.texture.destroy();
            this.tiles.delete(key);
            removedCount++;
        }
    }

    screenToWorld(sx: number, sy: number, viewport: Viewport) {
        // Just for reference, not used if we use bounding box logic above
        // World = (Screen - Size/2) / Zoom + Center
        const wx = (sx - viewport.size[0] / 2) / viewport.zoom + viewport.center[0];
        const wy = (sy - viewport.size[1] / 2) / viewport.zoom + viewport.center[1];
        return { x: wx, y: wy };
    }

    createTile(x: number, y: number, z: number): Tile {
        // Deprecated by getVisibleTiles logic but kept for interface compatibility if needed
        return {
            id: `${z}-${x}-${y}`,
            x, y, z,
            loaded: false,
            worldX: 0, worldY: 0, width: 0, height: 0, lastUsed: 0
        };
    }

    requestTile(tile: Tile, index: number) {
        this.worker.postMessage({
            type: 'decode',
            id: tile.id,
            tileX: tile.x * (this.levels[tile.z].tileWidth),
            tileY: tile.y * (this.levels[tile.z].tileHeight),
            tileZ: tile.z,
            index: index, // IFD index
            tileSize: this.levels[tile.z].tileWidth,
            bandIndices: this.selectedBands.length > 0 ? this.selectedBands : undefined
        });
    }

    /**
     * Set the bands to render. Pass band indices (0-based).
     * For RGB, pass [redIdx, greenIdx, blueIdx].
     * For grayscale, pass [bandIdx].
     */
    setBands(bandIndices: number[]) {
        this.selectedBands = bandIndices;
        // Clear tiles to force reload with new bands
        for (const tile of this.tiles.values()) {
            if (tile.texture) tile.texture.destroy();
        }
        this.tiles.clear();
        // Reset global stats since they may change with different bands
        this.globalMin = 0;
        this.globalMax = 1;
        this.hasGlobalStats = false;
        this.version++;
    }

    uploadTile(tile: Tile, data: Float32Array) {
        // Data is Float32Array (RGBA)
        const dim = Math.sqrt(data.length / 4);

        if (dim % 1 !== 0) {
            console.error("Invalid tile dimensions derived from data length:", data.length, dim);
        }

        const bytesPerRow = dim * 16;
        // WebGPU requires bytesPerRow to be 256-byte aligned
        const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;
        const needsPadding = bytesPerRow !== alignedBytesPerRow;

        let uploadData = data;
        if (needsPadding) {
            // Create padded buffer
            const paddedSize = (alignedBytesPerRow / 16) * dim * 4; // total floats needed
            const paddedData = new Float32Array(paddedSize);

            // Copy row by row with padding
            for (let row = 0; row < dim; row++) {
                const srcOffset = row * dim * 4;
                const dstOffset = row * (alignedBytesPerRow / 4);
                paddedData.set(data.subarray(srcOffset, srcOffset + dim * 4), dstOffset);
            }
            uploadData = paddedData;
        }

        const texture = this.device.createTexture({
            size: [dim, dim, 1],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this.device.queue.writeTexture(
            { texture: texture },
            uploadData as any,
            { bytesPerRow: alignedBytesPerRow, rowsPerImage: dim },
            [dim, dim]
        );

        tile.texture = texture;

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

        // Create Bind Group
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
