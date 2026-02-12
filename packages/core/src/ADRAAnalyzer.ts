import { Viewport } from './Viewport';
import { ADRAOptions } from './TileManager';

/**
 * ADRAAnalyzer handles Automatic Dynamic Range Adjustment (ADRA) for COG imagery.
 * 
 * ADRA dynamically calculates optimal display ranges by:
 * 1. Rendering visible tiles to a small analysis texture (128x128)
 * 2. Reading back pixel values to CPU
 * 3. Computing percentile-based min/max with configurable clipping
 * 4. Applying padding to prevent edge artifacts
 * 
 * This GPU-accelerated approach is much faster than CPU-based histogram analysis.
 */
export class ADRAAnalyzer {
    private device: GPUDevice;
    private analysisPipeline: GPURenderPipeline;
    private analysisTexture: GPUTexture;
    private analysisBuffer: GPUBuffer;
    private isAnalyzing: boolean = false;

    // Change detection state
    private lastUpdateVersion: number = -1;
    private lastViewportSignature: string = '';
    private lastOptionsSignature: string = '';
    private lastCalcTime: number = 0;

    // Current statistics
    public currentStats: { min: number, max: number } = { min: 0, max: 1 };

    // Configuration
    public options: ADRAOptions;

    /**
     * Creates a new ADRAAnalyzer instance.
     * @param device - WebGPU device
     * @param shaderModule - Compiled shader module containing frag_analysis entry point
     * @param pipelineLayout - Shared pipeline layout for compatibility
     * @param options - ADRA configuration options
     */
    constructor(
        device: GPUDevice,
        shaderModule: GPUShaderModule,
        pipelineLayout: GPUPipelineLayout,
        options: ADRAOptions
    ) {
        this.device = device;
        this.options = options;

        // Create analysis texture (128x128 for performance)
        this.analysisTexture = device.createTexture({
            size: [128, 128, 1],
            format: 'rgba32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });

        // Create readback buffer
        this.analysisBuffer = device.createBuffer({
            size: 128 * 128 * 16, // 128x128 pixels * 4 channels * 4 bytes
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        // Create analysis pipeline
        this.analysisPipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vert_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'frag_analysis',
                targets: [{ format: 'rgba32float' }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
    }

    /**
     * Updates ADRA statistics based on visible tiles.
     * Uses change detection to avoid unnecessary recalculation.
     * 
     * @param visibleTiles - Array of visible tiles to analyze
     * @param viewport - Current viewport for change detection
     * @param settingsBuffer - GPU buffer containing settings
     * @param tileManagerVersion - Version number from TileManager
     * @returns Performance metrics (calculation time in ms)
     */
    update(
        visibleTiles: any[],
        viewport: Viewport,
        settingsBuffer: GPUBuffer,
        tileManagerVersion: number
    ): { updated: boolean, timeMs: number } {
        const startTime = performance.now();

        // Check if update is needed
        const vpSig = `${viewport.center[0].toFixed(2)},${viewport.center[1].toFixed(2)},${viewport.zoom.toFixed(2)}`;
        const optSig = JSON.stringify(this.options);

        const needsUpdate =
            vpSig !== this.lastViewportSignature ||
            optSig !== this.lastOptionsSignature ||
            tileManagerVersion !== this.lastUpdateVersion;

        if (!needsUpdate) {
            return { updated: false, timeMs: 0 };
        }

        // Throttle updates (100ms minimum)
        const now = performance.now();
        if (now - this.lastCalcTime < 100) {
            return { updated: false, timeMs: 0 };
        }

        // Prevent concurrent analysis
        if (this.isAnalyzing) {
            return { updated: false, timeMs: 0 };
        }

        this.isAnalyzing = true;

        // Perform GPU analysis
        this.performGPUAnalysis(visibleTiles, viewport, settingsBuffer);

        // Update signatures
        this.lastViewportSignature = vpSig;
        this.lastOptionsSignature = optSig;
        this.lastUpdateVersion = tileManagerVersion;
        this.lastCalcTime = now;

        const timeMs = performance.now() - startTime;
        return { updated: true, timeMs };
    }

    /**
     * Performs GPU-accelerated histogram analysis.
     * Renders tiles to analysis texture and reads back for statistics calculation.
     */
    private performGPUAnalysis(
        visibleTiles: any[],
        viewport: Viewport,
        settingsBuffer: GPUBuffer
    ): void {
        const commandEncoder = this.device.createCommandEncoder();

        // Render to analysis texture
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.analysisTexture.createView(),
                loadOp: 'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                storeOp: 'store'
            }]
        });

        renderPass.setPipeline(this.analysisPipeline);

        const viewportBindGroup = this.device.createBindGroup({
            layout: this.analysisPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: viewport.getBuffer() } },
                { binding: 1, resource: { buffer: settingsBuffer } }
            ]
        });

        renderPass.setBindGroup(0, viewportBindGroup);

        // Skip background tile to avoid biasing statistics
        for (const tile of visibleTiles) {
            if (tile.id === 'background') continue; // Skip placeholder tile
            if (tile.bindGroup) {
                renderPass.setBindGroup(1, tile.bindGroup);
                renderPass.draw(6, 1, 0, 0);
            }
        }
        renderPass.end();

        // Copy to readback buffer
        commandEncoder.copyTextureToBuffer(
            { texture: this.analysisTexture },
            { buffer: this.analysisBuffer, bytesPerRow: 128 * 16 },
            [128, 128, 1]
        );

        this.device.queue.submit([commandEncoder.finish()]);

        // Async readback and statistics calculation
        this.analysisBuffer.mapAsync(GPUMapMode.READ).then(() => {
            this.calculateStatistics();
            this.analysisBuffer.unmap();
            this.isAnalyzing = false;
        }).catch(err => {
            console.error("ADRA analysis error:", err);
            this.isAnalyzing = false;
        });
    }

    /**
     * Calculates percentile-based statistics from GPU readback data.
     * Implements configurable clipping and padding.
     */
    private calculateStatistics(): void {
        const arrayBuffer = this.analysisBuffer.getMappedRange();
        const data = new Float32Array(arrayBuffer);

        // Collect valid samples (alpha > 0.5 indicates written pixel)
        const samples: number[] = [];
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 0.5) {
                samples.push(data[i]); // R channel contains intensity
            }
        }

        if (samples.length === 0) {
            return; // No valid data
        }

        // Sort for percentile calculation
        samples.sort((a, b) => a - b);

        // Calculate percentile indices
        const { clipLow, clipHigh, padLow, padHigh } = this.options;
        const pLow = Math.max(0, Math.min(100, clipLow)) / 100;
        const pHigh = Math.max(0, Math.min(100, clipHigh)) / 100;

        const lowIndex = Math.floor(samples.length * pLow);
        const highIndex = Math.floor(samples.length * pHigh);

        let min = samples[lowIndex] ?? samples[0];
        let max = samples[highIndex] ?? samples[samples.length - 1];

        // Apply padding
        const range = max - min;
        min -= range * (padLow / 100);
        max += range * (padHigh / 100);

        // Prevent zero range
        if (max <= min) {
            max = min + 0.0001;
        }

        this.currentStats = { min, max };
    }

    /**
     * Updates ADRA options and invalidates cache.
     */
    setOptions(options: Partial<ADRAOptions>): void {
        this.options = { ...this.options, ...options };
        // Invalidate cache to trigger recalculation
        this.lastOptionsSignature = '';
    }

    /**
     * Cleans up GPU resources.
     */
    destroy(): void {
        this.analysisTexture.destroy();
        this.analysisBuffer.destroy();
    }
}
