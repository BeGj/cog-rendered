import { Viewport } from './Viewport';
import { TileManager } from './TileManager';
import { InteractionHandler } from './InteractionHandler';

const shaderSource = `
struct Viewport {
    center: vec2<f32>,
    scale: vec2<f32>,
};

struct TileUniforms {
    position: vec2<f32>, // World position
    size: vec2<f32>,     // World size
};

@group(0) @binding(0) var<uniform> viewport: Viewport;

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
    return textureSample(myTexture, mySampler, uv);
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

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.viewport = null as any;
    }

    enableInteractions() {
        if (!this.viewport) return;
        this.interactionHandler = new InteractionHandler(this.canvas, this.viewport);
    }

    async init(worker: Worker) {
        if (!navigator.gpu) {
            throw new Error("WebGPU not supported on this browser.");
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("No appropriate GPUAdapter found.");
        }

        this.device = await adapter.requestDevice();
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

        const shaderModule = this.device.createShaderModule({
            code: shaderSource,
        });

        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
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

        this.tileManager = new TileManager(this.device, this.pipeline, worker);
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

    render() {
        requestAnimationFrame(this.render.bind(this));

        if (!this.device || !this.context || !this.pipeline || !this.tileManager) return;

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

        // Update Viewport
        // Only if changed? For now every frame is fine.
        // Or check dirty flag.

        const viewportBindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.viewport.getBuffer(),
                    },
                },
            ],
        });
        passEncoder.setBindGroup(0, viewportBindGroup);

        const visibleTiles = this.tileManager.getVisibleTiles(this.viewport);

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
