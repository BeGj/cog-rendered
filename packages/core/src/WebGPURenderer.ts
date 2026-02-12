import { Viewport } from './Viewport';
import { TileManager, ADRAOptions, BandMetadata } from './TileManager';
import { InteractionHandler } from './InteractionHandler';
import { ADRAAnalyzer } from './ADRAAnalyzer';
import tileShaderSource from './shaders/tile.wgsl?raw';

/**
 * WebGPURenderer handles rendering of Cloud Optimized GeoTIFF (COG) imagery using WebGPU.
 * 
 * Features:
 * - Tiled rendering with automatic LOD selection
 * - Interactive pan/zoom
 * - Optional ADRA (Automatic Dynamic Range Adjustment) for enhanced visualization
 * - Float32 texture support for high dynamic range imagery
 */
export class WebGPURenderer {
    canvas: HTMLCanvasElement;
    device: GPUDevice | null = null;
    context: GPUCanvasContext | null = null;
    pipeline: GPURenderPipeline | null = null;
    viewport: Viewport;
    tileManager: TileManager | null = null;
    interactionHandler: InteractionHandler | null = null;

    settingsBuffer: GPUBuffer | null = null;
    autoRangeEnabled: boolean = false;
    adraAnalyzer: ADRAAnalyzer | null = null;

    // Cached bind groups for performance
    private cachedViewportBindGroup: GPUBindGroup | null = null;
    private lastSettingsSignature: string = '';
    private pendingBandsCallback: ((bands: BandMetadata[], suggestedBands: number[]) => void) | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.viewport = null as any;
    }

    /**
     * Enables mouse/touch interactions for pan and zoom.
     */
    enableInteractions() {
        if (!this.viewport) return;
        this.interactionHandler = new InteractionHandler(this.canvas, this.viewport);
    }

    /**
     * Enables or disables ADRA (Automatic Dynamic Range Adjustment).
     * @param enabled - Whether to enable ADRA
     */
    setAutoRange(enabled: boolean) {
        this.autoRangeEnabled = enabled;
    }

    /**
     * Updates ADRA configuration options.
     * @param options - Partial ADRA options to update
     */
    setADRAOptions(options: Partial<ADRAOptions>) {
        if (this.adraAnalyzer) {
            this.adraAnalyzer.setOptions(options);
        }
    }

    /**
     * Gets the available band metadata from the loaded image.
     * @returns Array of band metadata or empty array if not initialized
     */
    getBandMetadata(): BandMetadata[] {
        return this.tileManager?.bandMetadata || [];
    }

    /**
     * Sets which bands to render.
     * @param bandIndices - Array of band indices (0-based). For RGB: [redIdx, greenIdx, blueIdx]. For grayscale: [bandIdx]
     */
    setBands(bandIndices: number[]) {
        if (this.tileManager) {
            this.tileManager.setBands(bandIndices);
        }
    }

    /**
     * Gets the currently selected band indices.
     * @returns Array of selected band indices
     */
    getSelectedBands(): number[] {
        return this.tileManager?.selectedBands || [];
    }

    /**
     * Sets a callback to be notified when band metadata is available.
     * @param callback - Function to call with band metadata and suggested bands
     */
    onBandsInitialized(callback: (bands: BandMetadata[], suggestedBands: number[]) => void) {
        if (this.tileManager) {
            this.tileManager.onBandsInitialized = callback;
        } else {
            this.pendingBandsCallback = callback;
        }
    }

    /**
     * Initializes the WebGPU renderer.
     * @param worker - Web Worker for COG decoding
     */
    async init(worker: Worker) {

        if (!navigator.gpu) {
            throw new Error("WebGPU not supported on this browser.");
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("No appropriate GPUAdapter found.");
        }

        const requiredFeatures: GPUFeatureName[] = [];
        if (adapter.features.has('float32-filterable')) {
            requiredFeatures.push('float32-filterable');
        }

        this.device = await adapter.requestDevice({ requiredFeatures });
        this.context = this.canvas.getContext("webgpu");

        if (!this.context) {
            throw new Error("Could not get WebGPU context.");
        }

        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: presentationFormat,
            alphaMode: 'premultiplied',
        });

        this.viewport = new Viewport(this.device, this.canvas.width, this.canvas.height);

        // Settings Buffer
        this.settingsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const shaderModule = this.device.createShaderModule({
            code: tileShaderSource,
        });

        // Define Explicit Bind Group Layouts to ensure compatibility between pipelines
        const group0Layout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, // Viewport
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } } // Settings
            ]
        });

        const group1Layout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // Texture
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }, // Sampler
                { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } } // Tile Uniform
            ]
        });

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [group0Layout, group1Layout]
        });

        // Main Pipeline
        this.pipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vert_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'frag_main',
                targets: [
                    {
                        format: presentationFormat,
                        blend: {
                            color: {
                                srcFactor: 'src-alpha',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                            alpha: {
                                srcFactor: 'one',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                        }
                    },
                ],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });

        // Initialize ADRA Analyzer
        this.adraAnalyzer = new ADRAAnalyzer(
            this.device,
            shaderModule,
            pipelineLayout,
            {
                clipLow: 1,
                clipHigh: 99,
                padLow: 50,
                padHigh: 20
            }
        );

        this.tileManager = new TileManager(this.device, this.pipeline, worker);
        // We might need to give tileManager access to analysisPipeline layout if it differs?
        // Or just assume compatibility.

        this.tileManager.onInitComplete = this.onTileManagerInit.bind(this);

        if (this.pendingBandsCallback) {
            this.tileManager.onBandsInitialized = this.pendingBandsCallback;
            this.pendingBandsCallback = null;
        }

        // Start render loop
        requestAnimationFrame(this.render.bind(this));
    }

    /**
     * Loads a COG file from a File object or URL.
     * @param source - File object or URL string
     */
    load(source: File | string) {
        if (this.tileManager) {
            this.tileManager.init(source);
        }
    }

    /**
     * Callback when TileManager completes initialization.
     * Automatically fits the image to the viewport.
     */
    onTileManagerInit(width: number, height: number) {
        // Calculate fit
        const canvasAspect = this.canvas.width / this.canvas.height;
        const imageAspect = width / height;

        let zoom = 1;
        if (canvasAspect > imageAspect) {
            // Canvas is wider than image (relative to height) -> Fit Height
            zoom = this.canvas.height / height;
        } else {
            // Canvas is taller -> Fit Width
            zoom = this.canvas.width / width;
        }

        // Apply a small padding
        zoom *= 0.95;

        this.viewport.setZoom(zoom);
        this.viewport.setCenter(width / 2, height / 2);
    }

    /**
     * Resizes the renderer canvas and viewport.
     * @param width - New canvas width
     * @param height - New canvas height
     */
    resize(width: number, height: number) {
        if (!this.device || !this.context) return;
        this.canvas.width = width;
        this.canvas.height = height;
        this.context.configure({
            device: this.device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'premultiplied',
        });
        this.viewport.resize(width, height);
    }

    /**
     * Main render loop. Renders visible tiles with optional ADRA.
     */
    render() {
        requestAnimationFrame(this.render.bind(this));

        if (!this.device || !this.context || !this.pipeline || !this.tileManager || !this.settingsBuffer) return;

        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [
                {
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(this.pipeline);

        const visibleTiles = this.tileManager.getVisibleTiles(this.viewport);

        let min = 0;
        let max = 1;

        if (this.autoRangeEnabled && this.adraAnalyzer) {
            // Update ADRA statistics
            const metrics = this.adraAnalyzer.update(
                visibleTiles,
                this.viewport,
                this.settingsBuffer,
                this.tileManager.version
            );

            // Log performance metrics (optional)
            if (metrics.updated && metrics.timeMs > 0) {
                console.debug(`ADRA updated in ${metrics.timeMs.toFixed(2)}ms`);
            }

            min = this.adraAnalyzer.currentStats.min;
            max = this.adraAnalyzer.currentStats.max;
        } else {
            // Use Global Stats
            min = this.tileManager.globalMin;
            max = this.tileManager.globalMax;
            // Prevent zero range
            if (max <= min) max = min + 1;
        }

        // Update settings buffer
        const settingsData = new Float32Array([
            min,
            max,
            0, // padding1
            0  // padding2
        ]);
        this.device.queue.writeBuffer(this.settingsBuffer, 0, settingsData);

        // Cache bind group if settings haven't changed
        const settingsSignature = `${min.toFixed(4)}-${max.toFixed(4)}`;
        if (settingsSignature !== this.lastSettingsSignature || !this.cachedViewportBindGroup) {
            this.cachedViewportBindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.viewport.getBuffer(),
                        },
                    },
                    {
                        binding: 1,
                        resource: {
                            buffer: this.settingsBuffer,
                        },
                    },
                ],
            });
            this.lastSettingsSignature = settingsSignature;
        }

        passEncoder.setBindGroup(0, this.cachedViewportBindGroup);

        for (const tile of visibleTiles) {
            if (tile.bindGroup) {
                passEncoder.setBindGroup(1, tile.bindGroup);
                passEncoder.draw(6, 1, 0, 0);
            }
        }

        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }
}
