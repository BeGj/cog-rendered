# Cog-Renderer

WebGPU based COG renderer with support for Web Workers.

## Features

- **High Performance**: WebGPU-accelerated rendering with tiled LOD system
- **ADRA (Automatic Dynamic Range Adjustment)**: GPU-based histogram analysis for optimal visualization
- **Interactive**: Pan and zoom with mouse/touch support
- **Float32 Precision**: Support for high dynamic range imagery
- **Web Workers**: Asynchronous COG decoding for smooth performance

## Demo

The live demo is available at: https://begj.github.io/cog-rendered/

## ADRA (Automatic Dynamic Range Adjustment)

ADRA is a GPU-accelerated feature that dynamically adjusts the display range of imagery based on visible tiles. This is particularly useful for:

- Low-contrast imagery (e.g., thermal, elevation data)
- Imagery with extreme outliers
- Multi-band imagery with varying dynamic ranges

### How it Works

1. Renders visible tiles to a small analysis texture (128×128)
2. Reads back pixel values to CPU
3. Computes percentile-based min/max with configurable clipping
4. Applies padding to prevent edge artifacts
5. Updates display range in real-time as you pan/zoom

### Configuration

ADRA can be configured with four parameters:

- **Clip Low** (0-10%): Percentile to clip at the low end (default: 1%)
- **Clip High** (90-100%): Percentile to clip at the high end (default: 99%)
- **Pad Low** (0-100%): Padding below min value as % of range (default: 50%)
- **Pad High** (0-100%): Padding above max value as % of range (default: 20%)

### Usage Example

```typescript
import { WebGPURenderer } from '@cog-rendered/core';
import DecoderWorker from '@cog-rendered/core/worker/decoder.worker?worker';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new WebGPURenderer(canvas);
const worker = new DecoderWorker();

await renderer.init(worker);

// Enable ADRA
renderer.setAutoRange(true);

// Configure ADRA options
renderer.setADRAOptions({
  clipLow: 2,    // Clip bottom 2%
  clipHigh: 98,  // Clip top 2%
  padLow: 30,    // 30% padding below
  padHigh: 10    // 10% padding above
});

// Load a COG
renderer.load('https://example.com/image.tif');
```

## Example Cogs:

### URLS
- https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/21/H/UB/2021/9/S2B_21HUB_20210915_0_L2A/TCI.tif
- https://umbra-open-data-catalog.s3.amazonaws.com/sar-data/tasks/Tanna%20Island,%20Vanuatu/9c76a918-9247-42bf-b9f6-3b4f672bc148/2023-02-12-21-33-56_UMBRA-04/2023-02-12-21-33-56_UMBRA-04_GEC.tif


### Downloadable cogs (https error on bucket)
- http://umbra-open-data-catalog.s3-website.us-west-2.amazonaws.com/?prefix=sar-data/tasks/Port%20of%20Rotterdam%2C%20Netherlands/00864c2c-0b0f-49ef-b283-997735b27878/2025-07-29-11-17-12_UMBRA-08/ from Umbra Open Data https://registry.opendata.aws/umbra-open-data/
