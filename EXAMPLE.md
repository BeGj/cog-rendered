# COG Renderer Demo Example Documentation

## Overview

The demo application in `examples/demo` is a complete, production-ready example of using the `@cog-renderer/core` library to render Cloud Optimized GeoTIFFs (COGs) in a web browser. It demonstrates all the essential features: loading from files or URLs, pan/zoom interactions, and full-screen display.

**Live Demo:** https://begj.github.io/cog-rendered/

## Project Structure

```
examples/demo/
├── index.html          # HTML structure and styling
├── src/
│   ├── main.ts         # Application entry point
│   ├── style.css       # Additional styling
│   ├── counter.ts      # (Unused Vite template file)
│   └── typescript.svg  # (Unused Vite template file)
├── public/             # Static assets
├── package.json        # Dependencies and scripts
├── tsconfig.json       # TypeScript configuration
└── vite.config.ts      # Vite build configuration
```

## Setup Instructions

### Prerequisites

- Node.js 18+ (or compatible version)
- pnpm package manager
- A browser with WebGPU support (Chrome 113+, Edge 113+, Safari 18+)

### Installation

From the repository root:

```bash
# Install all dependencies
pnpm install

# Navigate to demo
cd examples/demo

# Run development server
pnpm dev
```

The demo will be available at `http://localhost:5173` (or another port if 5173 is in use).

### Building for Production

```bash
# From examples/demo directory
pnpm build

# Preview production build
pnpm preview
```

The production build is output to `examples/demo/dist/`.

## Code Walkthrough

### index.html

The HTML file provides the structure and inline styling for the demo.

**Key Elements:**

```html
<canvas id="canvas"></canvas>
```
The WebGPU rendering target. Styled to fill the entire viewport.

```html
<div class="controls">
  <input type="file" id="fileInput" accept=".tif,.tiff">
  <input type="text" id="urlInput" placeholder="Enter COG URL">
  <button id="loadUrlBtn">Load URL</button>
</div>
```
Control panel for loading COG files:
- File input for local TIFF files
- Text input + button for remote URLs

**Styling Highlights:**
- Dark theme (`#111` background)
- Full-screen canvas with no margins/overflow
- Semi-transparent control panel with backdrop blur
- Responsive button hover states

### main.ts

The main application logic that integrates the COG renderer.

#### 1. Imports and Setup

```typescript
import { WebGPURenderer } from '@cog-renderer/core';
import DecoderWorker from '../../../packages/core/src/worker/decoder.worker.ts?worker';
```

**Key Points:**
- Imports the core renderer from the library
- Imports the worker using Vite's `?worker` suffix
  - This tells Vite to bundle it as a separate worker file
  - The worker runs in a background thread

#### 2. DOM Element References

```typescript
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const loadUrlBtn = document.getElementById('loadUrlBtn') as HTMLButtonElement;
```

All UI elements are captured with type assertions for TypeScript safety.

#### 3. Canvas Sizing with High-DPI Support

```typescript
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
}

window.addEventListener('resize', () => {
  resize();
  if (renderer) renderer.resize(canvas.width, canvas.height);
});

resize();
```

**Why this matters:**
- `devicePixelRatio` handles high-DPI displays (Retina, 4K, etc.)
- Canvas buffer size (width/height) must match physical pixels for sharp rendering
- CSS size (via `width: 100%; height: 100%`) handles layout
- The renderer is notified of size changes to update the viewport

#### 4. Renderer Initialization

```typescript
const renderer = new WebGPURenderer(canvas);
const worker = new DecoderWorker();

renderer.init(worker).then(() => {
  console.log("Renderer initialized");
  renderer.enableInteractions();
}).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Failed to init renderer:", err);
  alert("WebGPU not supported or failed to initialize: " + message);
});
```

**Flow:**
1. Create renderer instance with canvas
2. Create worker instance for background decoding
3. Initialize renderer (async operation)
   - Requests WebGPU adapter/device
   - Configures context and pipeline
   - Sets up viewport
4. Enable interactions on success
5. Show user-friendly error on failure

**Error Handling:**
The demo shows an alert for WebGPU initialization failures, which is appropriate since:
- Without WebGPU, the app cannot function
- This is a demo, not a production app with fallbacks
- Users need clear feedback about browser compatibility

#### 5. File Input Handler

```typescript
fileInput.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    renderer.load(file);
  }
});
```

**Behavior:**
- Triggers when user selects a file via the file picker
- Extracts the first selected file (multiple files not supported)
- Passes the File object directly to the renderer
- The worker can read File objects via `fromBlob()`

**Supported Formats:**
- `.tif`, `.tiff` files
- Must be Cloud Optimized GeoTIFFs (tiled with overviews)
- RGB, grayscale, or RGBA images

#### 6. URL Input Handler

```typescript
loadUrlBtn.addEventListener('click', () => {
  const url = urlInput.value;
  if (url) {
    renderer.load(url);
  }
});
```

**Behavior:**
- Triggers when user clicks "Load URL" button
- Reads URL from text input
- Passes URL string to renderer
- The worker fetches the COG via HTTP range requests

**CORS Requirements:**
Remote COGs must:
- Be served with appropriate CORS headers
- Support HTTP range requests (for efficient tile streaming)

## Usage Examples

### Example 1: Loading a Local File

1. Click on the file input control
2. Select a `.tif` or `.tiff` file from your computer
3. The image loads and is automatically fitted to the viewport
4. Use mouse wheel to zoom
5. Click and drag to pan

### Example 2: Loading from URL

Try these sample COGs:

**Sentinel-2 RGB Image:**
```
https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/21/H/UB/2021/9/S2B_21HUB_20210915_0_L2A/TCI.tif
```

**Umbra SAR Data:**
```
https://umbra-open-data-catalog.s3.amazonaws.com/sar-data/tasks/Tanna%20Island,%20Vanuatu/9c76a918-9247-42bf-b9f6-3b4f672bc148/2023-02-12-21-33-56_UMBRA-04/2023-02-12-21-33-56_UMBRA-04_GEC.tif
```

**Steps:**
1. Copy one of the URLs above
2. Paste into the "Enter COG URL" text input
3. Click "Load URL"
4. The image streams and renders progressively

### Example 3: Interactions

**Zoom:**
- Scroll wheel up: Zoom in
- Scroll wheel down: Zoom out
- Zoom centers on cursor position

**Pan:**
- Click and hold on the image
- Drag to pan in any direction
- Release to stop panning

**Responsive:**
- Resize the browser window
- Canvas automatically adjusts to new size
- Image maintains its position and zoom

## Customization Guide

### Change Background Color

In `index.html`, modify the render pass clear color in `WebGPURenderer`:

```typescript
// In packages/core/src/WebGPURenderer.ts, line ~200
clearValue: { r: 0.1, g: 0.1, b: 0.2, a: 1.0 }, // Blue-ish background
```

Or modify the body background:
```css
body {
  background: #1a1a2e; /* Dark blue instead of black */
}
```

### Add More UI Controls

Add new elements to `index.html`:
```html
<div class="controls">
  <!-- Existing controls -->
  
  <button id="resetViewBtn">Reset View</button>
  <div id="coordDisplay">X: 0, Y: 0</div>
</div>
```

Handle in `main.ts`:
```typescript
const resetViewBtn = document.getElementById('resetViewBtn') as HTMLButtonElement;

resetViewBtn.addEventListener('click', () => {
  // Re-fit the image
  if (renderer.tileManager) {
    const width = renderer.tileManager.imageWidth;
    const height = renderer.tileManager.imageHeight;
    renderer.viewport.setCenter(width / 2, height / 2);
    renderer.viewport.setZoom(renderer.canvas.height / height * 0.95);
  }
});
```

### Display Loading State

Add a loading indicator:

```typescript
const loadingDiv = document.createElement('div');
loadingDiv.id = 'loading';
loadingDiv.textContent = 'Loading...';
loadingDiv.style.cssText = `
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 24px;
  display: none;
`;
document.getElementById('app')!.appendChild(loadingDiv);

// Show when loading starts
function loadCOG(source: File | string) {
  loadingDiv.style.display = 'block';
  renderer.load(source);
}

// Hide when initialized
renderer.tileManager.onInitComplete = (width, height) => {
  loadingDiv.style.display = 'none';
  console.log(`Loaded COG: ${width}x${height}`);
};
```

### Add Keyboard Shortcuts

```typescript
window.addEventListener('keydown', (e) => {
  const panSpeed = 50 / renderer.viewport.zoom;
  
  switch(e.key) {
    case 'ArrowUp':
      renderer.viewport.move(0, -panSpeed);
      break;
    case 'ArrowDown':
      renderer.viewport.move(0, panSpeed);
      break;
    case 'ArrowLeft':
      renderer.viewport.move(-panSpeed, 0);
      break;
    case 'ArrowRight':
      renderer.viewport.move(panSpeed, 0);
      break;
    case '+':
    case '=':
      renderer.viewport.setZoom(renderer.viewport.zoom * 1.2);
      break;
    case '-':
    case '_':
      renderer.viewport.setZoom(renderer.viewport.zoom / 1.2);
      break;
  }
});
```

### Display Image Metadata

```typescript
renderer.tileManager.onInitComplete = (width, height, tileSize, levels) => {
  const info = `
    Image: ${width}x${height}px
    Tile Size: ${tileSize}px
    Pyramid Levels: ${levels.length}
    Max Zoom: ${levels[0].width}x${levels[0].height}
    Min Zoom: ${levels[levels.length-1].width}x${levels[levels.length-1].height}
  `;
  
  console.log(info);
  // Display in UI
  document.getElementById('imageInfo')!.textContent = info;
};
```

## Common Issues and Solutions

### Issue: "WebGPU not supported"

**Solution:**
- Use Chrome 113+, Edge 113+, or Safari 18+
- Enable WebGPU in browser flags (older Chrome versions)
- Update your browser to the latest version
- Check GPU drivers are up to date

### Issue: CORS error when loading URL

**Solution:**
- Ensure the COG server sends CORS headers:
  - `Access-Control-Allow-Origin: *` (or specific origin)
  - `Access-Control-Allow-Methods: GET, HEAD`
  - `Access-Control-Allow-Headers: Range`
- Use a CORS proxy for testing (not recommended for production)
- Host the COG on a CORS-enabled service (S3, Cloud Storage, etc.)

### Issue: Image appears blank or gray

**Possible Causes:**
1. **COG is not tiled**: Must be created with tiling enabled
2. **Invalid format**: Not a valid GeoTIFF
3. **Network error**: Check browser console for failed requests
4. **Unsupported pixel format**: Very rare, but some exotic formats may not work

**Solution:**
- Verify COG with `gdalinfo -checksum <file>`
- Ensure tiling: `gdaladdo -r average <input.tif> 2 4 8 16`
- Check browser console for errors
- Test with known-good COG (Sentinel-2 examples above)

### Issue: Poor performance with large COGs

**Tips:**
1. Ensure COG has proper pyramid overviews (2, 4, 8, 16, etc.)
2. Use appropriate tile size (256 or 512)
3. Check network bandwidth for remote COGs
4. Monitor browser memory usage (DevTools Performance tab)
5. Consider the cache limit (500 tiles default)

### Issue: Zoom is too sensitive or not sensitive enough

**Adjust zoom factor:**
```typescript
// In InteractionHandler.ts, line ~22
const factor = Math.pow(1.002, -e.deltaY); // More sensitive
const factor = Math.pow(1.0005, -e.deltaY); // Less sensitive
```

## Performance Tips

### 1. Optimize Tile Size
COGs with 256×256 or 512×512 tiles perform best. Very large tiles (1024+) may cause stuttering.

### 2. Use Compression
When creating COGs, use compression:
```bash
gdal_translate -co COMPRESS=JPEG -co TILED=YES input.tif output.tif
```

### 3. Limit Zoom Range
Set reasonable zoom limits to prevent loading too many tiles:
```typescript
renderer.viewport.minZoom = 0.1; // Don't zoom out too far
```

### 4. Monitor Cache Size
The default cache holds 500 tiles. For very large images or low-memory devices:
```typescript
// In TileManager.ts, line ~259
const CACHE_LIMIT = 200; // Reduce for low-memory devices
```

### 5. Preload Common COGs
For specific use cases, you can preload a COG on page load:
```typescript
const DEFAULT_COG = 'https://example.com/default.tif';
renderer.init(worker).then(() => {
  renderer.load(DEFAULT_COG);
  renderer.enableInteractions();
});
```

## Deployment

### GitHub Pages (Static Hosting)

The demo is configured for GitHub Pages deployment:

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: pnpm/action-setup@v2
        with:
          version: 10.29.3
      
      - uses: actions/setup-node@v3
        with:
          node-version: 18
          cache: 'pnpm'
      
      - run: pnpm install
      - run: cd packages/core && pnpm build
      - run: cd examples/demo && pnpm build
      
      - uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./examples/demo/dist
```

### Vite Base Configuration

For GitHub Pages, ensure correct base path:

```typescript
// vite.config.ts
export default defineConfig({
  base: '/cog-rendered/', // Repository name
  // ... other config
});
```

### Other Hosting Options

**Netlify/Vercel:**
1. Connect your repository
2. Set build command: `cd examples/demo && pnpm build`
3. Set publish directory: `examples/demo/dist`

**AWS S3 + CloudFront:**
1. Build: `cd examples/demo && pnpm build`
2. Upload `dist/` contents to S3 bucket
3. Enable static website hosting
4. (Optional) Add CloudFront for CDN

**Docker:**
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install -g pnpm
RUN pnpm install
RUN cd packages/core && pnpm build
RUN cd examples/demo && pnpm build

FROM nginx:alpine
COPY --from=0 /app/examples/demo/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

## Next Steps

After understanding this example:

1. **Read LIBRARY.md** for deep dive into the core library
2. **Experiment with the code** - modify styling, add features
3. **Try different COGs** - RGB, grayscale, different sizes
4. **Build your own app** - integrate into a larger application
5. **Contribute** - report issues, suggest features, submit PRs

## Additional Resources

- **Sample COGs**: https://registry.opendata.aws/
- **Creating COGs**: https://gdal.org/drivers/raster/cog.html
- **WebGPU Docs**: https://www.w3.org/TR/webgpu/
- **GeoTIFF.js**: https://geotiffjs.github.io/

## License

ISC License - See root package.json for details.
