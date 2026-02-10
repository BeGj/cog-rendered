import { mat3, vec2 } from 'gl-matrix';

export class Viewport {
    public center: vec2 = vec2.fromValues(0, 0);
    public zoom: number = 1;
    public rotation: number = 0;
    public size: vec2 = vec2.fromValues(800, 600); // Canvas size
    public minZoom: number = 0.0001;

    private uniformBuffer: GPUBuffer;
    private device: GPUDevice;

    constructor(device: GPUDevice, width: number, height: number) {
        this.device = device;
        this.size = vec2.fromValues(width, height);

        // Uniform buffer size: 
        // We need a matrix (mat3 is 9 floats, but std140 padding makes it tricky, let's use 3x vec4 or just manually unpack in shader or use mat4).
        // Let's use a simple struct in shader:
        // struct Uniforms {
        //    matrix: mat3x3<f32>, (padded to 48 bytes)
        //    viewportSize: vec2<f32>,
        // }
        // Actually, simpler to just pass specific values or a 4x4 Ortho projection.
        // Let's stick to pixel space. 

        this.uniformBuffer = device.createBuffer({
            size: 64, // ample space
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    resize(width: number, height: number) {
        this.size = vec2.fromValues(width, height);
        this.update();
    }

    setCenter(x: number, y: number) {
        this.center = vec2.fromValues(x, y);
        this.update();
    }

    setZoom(z: number) {
        this.zoom = z;
        this.update();
    }

    move(dx: number, dy: number) {
        vec2.add(this.center, this.center, [dx, dy]);
        this.update();
    }

    zoomAt(factor: number, x: number, y: number) {
        // x, y in screen coordinates
        // Transform screen to world, apply zoom, transform back... or just adjust center.
        // Current World = (Screen - Center) / Zoom
        // New Zoom = Zoom * Factor
        // We want World point under cursor to stay at Screen point.
        // World = (CurScreen - Center) / Zoom + CenterWorld (if Center is defined differently)

        // Let's define Center as the World coordinate at the center of the screen.

        const worldX = (x - this.size[0] / 2) / this.zoom + this.center[0];
        const worldY = (y - this.size[1] / 2) / this.zoom + this.center[1];

        this.zoom *= factor;

        // Limit zoom out?
        // User suggested: not more than image size / width * 2?
        // Current logic doesn't know image size here easily unless we pass it or store it.
        // But we can limit to some reasonable very low value or handle it in InteractionHandler.
        // Actually, let's just expose a minZoom property.


        // NewCenter = World - (Screen - Size/2) / NewZoom
        this.center[0] = worldX - (x - this.size[0] / 2) / this.zoom;
        this.center[1] = worldY - (y - this.size[1] / 2) / this.zoom;

        this.update();
    }

    update() {
        // Prepare data for GPU
        // We want to map World coordinates to Normalized Device Coordinates (-1 to 1).

        // Screen = (World - Center) * Zoom + Size/2
        // NDC = (Screen / Size) * 2 - 1
        // NDC = (((World - Center) * Zoom + Size/2) / Size) * 2 - 1
        //     = ((World - Center) * Zoom * 2 / Size) + 1 - 1
        //     = (World - Center) * (2 * Zoom / Size)

        const scaleX = 2 * this.zoom / this.size[0];
        const scaleY = -2 * this.zoom / this.size[1]; // Flip Y for WebGPU/NDC usually

        const data = new Float32Array([
            this.center[0], this.center[1], // Center
            scaleX, scaleY,                 // Scale
            // Padding
            0, 0, 0, 0
        ]);

        this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
    }

    getBuffer(): GPUBuffer {
        return this.uniformBuffer;
    }
}
