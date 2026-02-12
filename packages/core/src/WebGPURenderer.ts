import { Viewport } from './Viewport';
import { TileManager, ADRAOptions } from './TileManager';
import { InteractionHandler } from './InteractionHandler';

const shaderSource = `
struct Viewport {
    center: vec2<f32>,
    scale: vec2<f32>,
};

struct Settings {
    enableAutoRange: f32,
    min: f32,
    max: f32,
    padding: f32,
};

struct TileUniforms {
    position: vec2<f32>, // World position
    size: vec2<f32>,     // World size
};

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<uniform> settings: Settings;

@group(1) @binding(0) var myTexture: texture_2d<f32>;
@group(1) @binding(1) var mySampler: sampler;
@group(1) @binding(2) var<uniform> tile: TileUniforms;

struct VertexOutput {
    @builtin(position) Position : vec4<f32>,
    @location(0) uv : vec2<f32>,
};

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );
    
    var xy = pos[VertexIndex];
    
    // World Position of vertex
    var worldPos = tile.position + xy * tile.size;
    
    // Viewport Transform
    // NDC = (World - Center) * Scale
    var ndc = (worldPos - viewport.center) * viewport.scale;
    
    var output : VertexOutput;
    output.Position = vec4<f32>(ndc, 0.0, 1.0);
    output.uv = xy;
    return output;
}

@fragment
fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
    var color = textureSample(myTexture, mySampler, uv);
    
    // Check if pixel is "no-data" (pure black or very close to it)
    // Only apply ADRA to actual image pixels
    let isNoData = color.r == 0.0 && color.g == 0.0 && color.b == 0.0;
    
    if (!isNoData) {
        // Remap color based on provided min/max
        // val = (color - min) / (max - min)
        let minVal = settings.min;
        let maxVal = settings.max;
        
        // Avoid div by zero
        let range = max(maxVal - minVal, 0.00001);
        
        color = (color - vec4<f32>(minVal)) / range;
    }
    
    color.a = 1.0;
    return color;
}

@fragment
fn frag_analysis(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
    let c = textureSample(myTexture, mySampler, uv);
    // Use max channel value as intensity proxy
    let val = max(c.r, max(c.g, c.b));
    return vec4<f32>(val, 0.0, 0.0, 1.0);
}
`;

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
    adraOptions: ADRAOptions = {
        clipLow: 1,
        clipHigh: 99,
        padLow: 50,
        padHigh: 20
    };

    // GPU ADRA Resources
    analysisPipeline: GPURenderPipeline | null = null;
    analysisTexture: GPUTexture | null = null;
    analysisBuffer: GPUBuffer | null = null;
    isAnalyzing: boolean = false;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.viewport = null as any;
    }

    enableInteractions() {
        if (!this.viewport) return;
        this.interactionHandler = new InteractionHandler(this.canvas, this.viewport);
    }

    setAutoRange(enabled: boolean) {
        this.autoRangeEnabled = enabled;
    }

    setADRAOptions(options: Partial<ADRAOptions>) {
        this.adraOptions = { ...this.adraOptions, ...options };
    }

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
            code: shaderSource,
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

        // Analysis Resources
        this.analysisTexture = this.device.createTexture({
            size: [128, 128, 1],
            format: 'rgba32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });

        this.analysisBuffer = this.device.createBuffer({
            size: 128 * 128 * 16, // 128x128 pixels * 4 channels * 4 bytes
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        // Analysis Pipeline
        this.analysisPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout, // Shared layout
            vertex: {
                module: shaderModule,
                entryPoint: 'vert_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'frag_analysis',
                targets: [
                    {
                        format: 'rgba32float',
                        // No blending needed for analysis, we just overwrite
                    },
                ],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });

        // Critical: We need to ensure TileManager uses a BindGroupLayout that works for BOTH.
        // But TileManager is initialized with `this.pipeline`.
        // If analysisPipeline generates a different internal layout object, it might technically be incompatible in strict WebGPU?
        // However, usually if descriptors match, it's okay.
        // Let's rely on that for now. If it errors, we'll need to create an explicit GPUBindGroupLayout.

        this.tileManager = new TileManager(this.device, this.pipeline, worker);
        // We might need to give tileManager access to analysisPipeline layout if it differs?
        // Or just assume compatibility.

        this.tileManager.onInitComplete = this.onTileManagerInit.bind(this);

        // Start render loop
        requestAnimationFrame(this.render.bind(this));
    }

    load(source: File | string) {
        if (this.tileManager) {
            this.tileManager.init(source);
        }
    }

    onTileManagerInit(width: number, height: number) {
        // Calculate fit
        // Canvas aspect vs Image aspect
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

        // Apply a small padding? 
        zoom *= 0.95;

        this.viewport.setZoom(zoom);
        this.viewport.setCenter(width / 2, height / 2);
    }


    updateADRA(visibleTiles: any[]) {
        if (this.isAnalyzing || !this.analysisPipeline || !this.analysisTexture || !this.analysisBuffer || !this.device || !this.viewport) return;

        this.isAnalyzing = true;

        const commandEncoder = this.device.createCommandEncoder();

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
                { binding: 0, resource: { buffer: this.viewport.getBuffer() } },
                { binding: 1, resource: { buffer: this.settingsBuffer! } }
            ]
        });

        renderPass.setBindGroup(0, viewportBindGroup);

        for (const tile of visibleTiles) {
            if (tile.bindGroup) {
                renderPass.setBindGroup(1, tile.bindGroup);
                renderPass.draw(6, 1, 0, 0);
            }
        }
        renderPass.end();

        commandEncoder.copyTextureToBuffer(
            { texture: this.analysisTexture },
            { buffer: this.analysisBuffer, bytesPerRow: 128 * 16 },
            [128, 128, 1]
        );

        this.device.queue.submit([commandEncoder.finish()]);

        this.analysisBuffer.mapAsync(GPUMapMode.READ).then(() => {
            if (!this.analysisBuffer) return;
            const arrayBuffer = this.analysisBuffer.getMappedRange();
            const data = new Float32Array(arrayBuffer);

            // Collect samples (stride 4, read only R channel)
            const samples: number[] = [];
            // Check Alpha at index+3 > 0.5 to check if pixel was written
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] > 0.5) {
                    samples.push(data[i]);
                }
            }

            this.analysisBuffer.unmap();

            if (samples.length > 0) {
                samples.sort((a, b) => a - b);

                const { clipLow, clipHigh, padLow, padHigh } = this.adraOptions;
                const pLow = Math.max(0, Math.min(100, clipLow)) / 100;
                const pHigh = Math.max(0, Math.min(100, clipHigh)) / 100;

                const p1Index = Math.floor(samples.length * pLow);
                const p99Index = Math.floor(samples.length * pHigh);

                let min = samples[p1Index];
                let max = samples[p99Index];

                if (min === undefined) min = samples[0];
                if (max === undefined) max = samples[samples.length - 1];

                const range = max - min;
                let finalMin = min - (range * (padLow / 100));
                let finalMax = max + (range * (padHigh / 100));

                if (finalMax <= finalMin) finalMax = finalMin + 0.0001;

                this.currentADRAStats = { min: finalMin, max: finalMax };
            }

            this.isAnalyzing = false;
        }).catch(err => {
            console.error("Analysis map error", err);
            this.isAnalyzing = false;
        });
    }

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

    // Change Detection State for ADRA
    lastADRAUpdateVersion: number = -1;
    lastViewportSignature: string = '';
    lastADRAOptionsSignature: string = '';
    currentADRAStats: { min: number, max: number } = { min: 0, max: 1 };
    lastADRACalcTime: number = 0;

    render() {
        requestAnimationFrame(this.render.bind(this));

        if (!this.device || !this.context || !this.pipeline || !this.tileManager || !this.settingsBuffer) return;

        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [
                {
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }, // Black background
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(this.pipeline);

        // Update Viewport & Settings
        const visibleTiles = this.tileManager.getVisibleTiles(this.viewport);

        let min = 0;
        let max = 1;

        if (this.autoRangeEnabled) {
            // Check for changes
            const vpSig = `${this.viewport.center[0].toFixed(2)},${this.viewport.center[1].toFixed(2)},${this.viewport.zoom.toFixed(2)}`;
            const optSig = JSON.stringify(this.adraOptions);
            const tmVer = this.tileManager.version;

            if (vpSig !== this.lastViewportSignature ||
                optSig !== this.lastADRAOptionsSignature ||
                tmVer !== this.lastADRAUpdateVersion) {

                const now = performance.now();
                if (now - this.lastADRACalcTime > 100) {
                    // Update Stats via GPU
                    this.updateADRA(visibleTiles);

                    // Update Signatures
                    this.lastViewportSignature = vpSig;
                    this.lastADRAOptionsSignature = optSig;
                    this.lastADRAUpdateVersion = tmVer;
                    this.lastADRACalcTime = now;
                }
            }

            min = this.currentADRAStats.min;
            max = this.currentADRAStats.max;
        } else {
            // Use Global Stats
            min = this.tileManager.globalMin;
            max = this.tileManager.globalMax;
            // Prevent zero range
            if (max <= min) max = min + 1;
        }

        const settingsData = new Float32Array([
            this.autoRangeEnabled ? 1 : 0,
            min,
            max,
            0 // padding
        ]);
        this.device.queue.writeBuffer(this.settingsBuffer, 0, settingsData);


        const viewportBindGroup = this.device.createBindGroup({
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
        passEncoder.setBindGroup(0, viewportBindGroup);


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
