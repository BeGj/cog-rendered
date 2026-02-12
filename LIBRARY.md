# COG Renderer Core Library Documentation

## Overview

The `@cog-renderer/core` library is a high-performance Cloud Optimized GeoTIFF (COG) renderer built on WebGPU. It provides efficient rendering of large geospatial imagery with support for tiled loading, multi-resolution pyramids, and interactive pan/zoom capabilities.

## Architecture

The library follows a modular architecture with four main components:

```
┌─────────────────┐
│ WebGPURenderer  │  ← Main entry point
└────────┬────────┘
         │
         ├──► Viewport          (Camera/view transformation)
         ├──► TileManager       (Tile streaming & caching)
         ├──► InteractionHandler (Mouse/wheel interactions)
         └──► Worker            (Background COG decoding)
```

### Data Flow

1. User loads a COG file or URL
2. Worker initializes the TIFF and extracts pyramid metadata
3. TileManager determines visible tiles based on viewport
4. Worker decodes requested tiles in background
5. TileManager uploads decoded tiles to GPU
6. WebGPURenderer draws tiles using WebGPU pipeline

## Core Classes

### WebGPURenderer

The main renderer class that orchestrates the entire rendering pipeline.

**Constructor:**
```typescript
constructor(canvas: HTMLCanvasElement)
```

**Methods:**

#### `async init(worker: Worker): Promise<void>`
Initializes the WebGPU context, creates the rendering pipeline, and sets up the viewport.

**Parameters:**
- `worker`: A Web Worker instance for background tile decoding

**Example:**
```typescript
import { WebGPURenderer } from '@cog-renderer/core';
import DecoderWorker from './decoder.worker.ts?worker';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new WebGPURenderer(canvas);
const worker = new DecoderWorker();

await renderer.init(worker);
```

**Throws:**
- Error if WebGPU is not supported
- Error if no GPUAdapter is found
- Error if WebGPU context cannot be created

#### `load(source: File | string): void`
Loads a COG from a File object or URL string.

**Parameters:**
- `source`: Either a `File` object (for local files) or a `string` URL (for remote COGs)

**Example:**
```typescript
// Load from URL
renderer.load('https://example.com/image.tif');

// Load from file input
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  renderer.load(file);
});
```

#### `enableInteractions(): void`
Enables mouse/wheel interactions for pan and zoom. Must be called after `init()`.

**Example:**
```typescript
renderer.init(worker).then(() => {
  renderer.enableInteractions();
});
```

#### `resize(width: number, height: number): void`
Resizes the canvas and updates the viewport. Call when the canvas size changes.

**Parameters:**
- `width`: New canvas width in pixels
- `height`: New canvas height in pixels

**Example:**
```typescript
window.addEventListener('resize', () => {
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth * dpr;
  const height = window.innerHeight * dpr;
  renderer.resize(width, height);
});
```

#### `render(): void`
Internal render loop method. Called automatically via `requestAnimationFrame`. You typically don't need to call this directly.

---

### Viewport

Manages the camera/view transformation, converting world coordinates to normalized device coordinates (NDC).

**Constructor:**
```typescript
constructor(device: GPUDevice, width: number, height: number)
```

**Properties:**
- `center: vec2` - World coordinates of the viewport center
- `zoom: number` - Current zoom level (pixels per world unit)
- `size: vec2` - Canvas size in pixels [width, height]
- `minZoom: number` - Minimum allowed zoom level (default: 0.0001)

**Methods:**

#### `setCenter(x: number, y: number): void`
Sets the center point of the viewport in world coordinates.

#### `setZoom(z: number): void`
Sets the zoom level.

#### `move(dx: number, dy: number): void`
Moves the viewport by the specified world coordinate delta.

#### `zoomAt(factor: number, x: number, y: number): void`
Zooms in/out while keeping a specific screen point fixed.

**Parameters:**
- `factor`: Zoom multiplier (e.g., 1.1 for zoom in, 0.9 for zoom out)
- `x, y`: Screen coordinates to zoom towards

#### `resize(width: number, height: number): void`
Updates the viewport size when the canvas is resized.

#### `getBuffer(): GPUBuffer`
Returns the GPU uniform buffer containing viewport transformation data.

**Coordinate Systems:**

The viewport handles transformation between three coordinate systems:

1. **World Coordinates**: The COG image space (0,0 = top-left, width×height = bottom-right)
2. **Screen Coordinates**: Canvas buffer pixels (0,0 = top-left)
3. **NDC (Normalized Device Coordinates)**: WebGPU clip space (-1,-1 = top-left, 1,1 = bottom-right)

**Transform Formula:**
```
NDC = (World - Center) × Scale
where Scale = 2 × Zoom / CanvasSize
```

---

### TileManager

Manages tile streaming, caching, and GPU resource allocation for multi-resolution COG pyramids.

**Constructor:**
```typescript
constructor(device: GPUDevice, pipeline: GPURenderPipeline, worker: Worker)
```

**Properties:**
- `tiles: Map<string, Tile>` - Cache of loaded tiles
- `levels: Array` - Array of pyramid levels with metadata
- `imageWidth: number` - Full resolution image width
- `imageHeight: number` - Full resolution image height
- `tileSize: number` - Tile dimension (typically 256 or 512)
- `onInitComplete: (width, height, tileSize, levels) => void` - Callback when COG is initialized

**Methods:**

#### `init(source: File | string): void`
Initializes a new COG. Clears existing tiles and sends init message to worker.

#### `getVisibleTiles(viewport: Viewport): Tile[]`
Returns an array of tiles that should be rendered for the current viewport.

**Algorithm:**
1. Calculates the best pyramid level based on zoom
2. Determines visible tile range using viewport bounds
3. Requests missing tiles from worker
4. Returns loaded tiles sorted from low-res to high-res
5. Prunes old unused tiles from cache

**Returns:** Array of `Tile` objects ready for rendering

#### `getBestLevel(viewport: Viewport): number`
Determines the optimal pyramid level to use based on the current zoom level.

**Strategy:** Selects the highest resolution level where tiles are approximately screen resolution, avoiding unnecessary detail or pixelation.

**Tile Interface:**
```typescript
interface Tile {
  id: string;           // Unique key: "z-x-y"
  x: number;            // Tile grid X
  y: number;            // Tile grid Y
  z: number;            // Pyramid level
  loaded: boolean;      // Whether tile data is loaded
  worldX: number;       // World space X position
  worldY: number;       // World space Y position
  width: number;        // World space width
  height: number;       // World space height
  texture?: GPUTexture; // GPU texture resource
  bindGroup?: GPUBindGroup; // GPU bind group for rendering
  lastUsed: number;     // Timestamp for LRU cache
}
```

**Caching Strategy:**

The TileManager uses an LRU (Least Recently Used) cache with a limit of 500 tiles. When the limit is exceeded:
- Tiles are sorted by `lastUsed` timestamp
- Oldest tiles not used in the current frame are removed
- GPU resources (textures, buffers) are properly destroyed

---

### InteractionHandler

Handles user interactions (pan and zoom) for the viewport.

**Constructor:**
```typescript
constructor(element: HTMLElement, viewport: Viewport)
```

**Interaction Modes:**

#### Mouse Wheel Zoom
- Scroll up/down to zoom in/out
- Zoom is centered on the cursor position
- Zoom factor: `Math.pow(1.001, -deltaY)`

#### Mouse Drag Pan
- Click and drag to pan the image
- Movement is scaled by the current zoom level
- Properly handles high-DPI displays

**Methods:**

#### `disconnect(): void`
Removes all event listeners. Call when destroying the renderer.

**Implementation Notes:**

The handler properly accounts for:
- CSS pixel vs canvas buffer pixel scaling (devicePixelRatio)
- Canvas element offset from page coordinates
- Zoom-dependent pan sensitivity

---

## Worker System

The library uses a Web Worker for background tile decoding, keeping the main thread responsive.

### decoder.worker.ts

Handles COG initialization and tile decoding using the `geotiff` library.

**Message Types:**

#### `init`
Initializes a new COG file.

**Input:**
```typescript
{
  type: 'init',
  source: File | string  // Blob or URL
}
```

**Output:**
```typescript
{
  type: 'init-complete',
  levels: Array<{
    width: number,
    height: number,
    tileWidth: number,
    tileHeight: number,
    samplesPerPixel: number,
    index: number
  }>
}
```

#### `decode`
Decodes a specific tile from a pyramid level.

**Input:**
```typescript
{
  type: 'decode',
  id: string,      // Tile identifier "z-x-y"
  tileX: number,   // Pixel X coordinate in level
  tileY: number,   // Pixel Y coordinate in level
  tileZ: number,   // Pyramid level
  index: number,   // IFD index
  tileSize: number // Tile dimension
}
```

**Output:**
```typescript
{
  type: 'tile-decoded',
  id: string,
  bitmap: ImageBitmap | null  // null on error
}
```

**Pixel Format Handling:**

The worker converts various pixel formats to RGBA8:
- **1 channel** (grayscale): Replicated to RGB, alpha = 255
- **3 channels** (RGB): Alpha = 255
- **4 channels** (RGBA): Used directly
- **Other**: First channel used as grayscale

---

## WebGPU Pipeline

### Shader Architecture

The library uses a single shader with two stages:

**Vertex Shader (`vert_main`):**
- Generates a full-screen quad (2 triangles)
- Transforms tile world coordinates to NDC using viewport uniforms
- Passes texture coordinates to fragment shader

**Fragment Shader (`frag_main`):**
- Samples the tile texture using bilinear filtering
- Returns the color for the current pixel

**Uniforms:**

**Group 0 - Viewport (per frame):**
```wgsl
struct Viewport {
    center: vec2<f32>,  // World center point
    scale: vec2<f32>,   // NDC scale factors
};
```

**Group 1 - Tile (per tile):**
```wgsl
struct TileUniforms {
    position: vec2<f32>, // World position of tile
    size: vec2<f32>,     // World size of tile
};
```

**Bindings:**
- Group 0, Binding 0: Viewport uniform buffer
- Group 1, Binding 0: Tile texture (texture_2d<f32>)
- Group 1, Binding 1: Tile sampler (linear filtering)
- Group 1, Binding 2: Tile uniform buffer

### Render Pass

Each frame:
1. Clear to black background
2. Set viewport bind group (group 0)
3. For each visible tile:
   - Set tile bind group (group 1)
   - Draw 6 vertices (2 triangles)

**Alpha Blending:**
Enabled with premultiplied alpha for proper transparency handling.

---

## Performance Considerations

### Tile Streaming
- Tiles are loaded on-demand based on viewport
- Background worker prevents UI blocking
- LRU cache manages memory usage

### Multi-Resolution Pyramids
- Automatically selects appropriate detail level
- Low-res tiles rendered first (painter's algorithm)
- High-res tiles overlay progressively

### GPU Optimization
- Shared pipeline for all tiles
- Bind groups cached per tile
- Efficient uniform buffer updates
- Linear texture filtering via GPU sampler

### Memory Management
- Automatic pruning of unused tiles
- GPU resources explicitly destroyed
- Cache limit prevents unbounded growth

---

## Browser Compatibility

### Requirements
- **WebGPU Support**: Chrome 113+, Edge 113+, Safari 18+
- **Web Workers**: All modern browsers
- **ImageBitmap API**: All modern browsers
- **TypedArray**: All modern browsers

### Feature Detection

Always check for WebGPU support:
```typescript
if (!navigator.gpu) {
  throw new Error("WebGPU not supported");
}
```

---

## Error Handling

The library throws errors in several cases:

**Initialization Errors:**
- WebGPU not supported
- No GPU adapter found
- Context creation failed

**Worker Errors:**
- Invalid COG format
- Network errors (for URL sources)
- Decoding failures

**Runtime Errors:**
- Typically logged to console
- Renderer continues with available tiles

**Best Practices:**
```typescript
try {
  await renderer.init(worker);
} catch (err) {
  console.error('Initialization failed:', err);
  // Show fallback UI or error message
}
```

---

## Advanced Usage

### Custom Zoom Limits

```typescript
renderer.init(worker).then(() => {
  // Prevent zooming out too far
  renderer.viewport.minZoom = 0.1;
  renderer.enableInteractions();
});
```

### Programmatic Navigation

```typescript
// Zoom to specific world coordinates
renderer.viewport.setCenter(512, 512);
renderer.viewport.setZoom(2.0);

// Animate zoom
function animateZoom(targetZoom, duration) {
  const startZoom = renderer.viewport.zoom;
  const startTime = Date.now();
  
  function update() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const currentZoom = startZoom + (targetZoom - startZoom) * progress;
    
    renderer.viewport.setZoom(currentZoom);
    
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }
  
  update();
}
```

### Accessing Tile Metadata

```typescript
renderer.tileManager.onInitComplete = (width, height, tileSize, levels) => {
  console.log('Image size:', width, 'x', height);
  console.log('Tile size:', tileSize);
  console.log('Pyramid levels:', levels.length);
  
  levels.forEach((level, i) => {
    console.log(`Level ${i}:`, level.width, 'x', level.height);
  });
};
```

### Viewport Bounds

```typescript
function getViewportBounds() {
  const vp = renderer.viewport;
  const halfW = vp.size[0] / 2 / vp.zoom;
  const halfH = vp.size[1] / 2 / vp.zoom;
  
  return {
    minX: vp.center[0] - halfW,
    maxX: vp.center[0] + halfW,
    minY: vp.center[1] - halfH,
    maxY: vp.center[1] + halfH,
  };
}
```

---

## TypeScript Support

The library is written in TypeScript and includes type definitions.

**Import Types:**
```typescript
import { 
  WebGPURenderer, 
  Viewport, 
  TileManager,
  Tile 
} from '@cog-renderer/core';
```

**Type Safety:**
The library uses strict TypeScript checking, ensuring type safety for all public APIs.

---

## Dependencies

- **geotiff** (^2.1.3): COG parsing and decoding
- **gl-matrix** (^3.4.4): Vector/matrix math utilities

**Dev Dependencies:**
- **@webgpu/types** (^0.1.40): WebGPU TypeScript definitions
- **typescript** (^5.3.3): TypeScript compiler

---

## Building the Library

```bash
# Install dependencies
pnpm install

# Build
cd packages/core
pnpm build
```

This generates:
- `dist/index.js` - Compiled JavaScript
- `dist/index.d.ts` - TypeScript declarations
- Additional type definition files

---

## Future Enhancements

Potential improvements for future versions:

- **Color Mapping**: Support for custom color ramps and value ranges
- **Band Selection**: Choose specific bands from multi-band imagery
- **Coordinate Systems**: Support for geographic coordinates and projections
- **Annotations**: Overlay vector data (points, lines, polygons)
- **Export**: Save rendered viewport as PNG/JPEG
- **Performance**: Texture atlasing, batch rendering, compute shaders
- **Formats**: Support for other tiled formats (PMTiles, MBTiles)

---

## Contributing

When contributing to the core library:

1. Maintain the modular architecture
2. Add JSDoc comments for public APIs
3. Update this documentation for API changes
4. Test with various COG files (RGB, grayscale, different tile sizes)
5. Profile performance with large datasets
6. Ensure WebGPU best practices

---

## License

ISC License - See root package.json for details.
