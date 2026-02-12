import { fromUrl, fromBlob, Pool } from 'geotiff';

let tiff: any;
// let image: any; // Removed global image

self.onmessage = async (e) => {
    const { type, id, source, tileX, tileY, tileZ } = e.data;

    try {
        if (type === 'init') {
            if (source instanceof Blob) {
                tiff = await fromBlob(source);
            } else {
                tiff = await fromUrl(source);
            }
            const imageCount = await tiff.getImageCount();
            const levels: any[] = [];

            for (let i = 0; i < imageCount; i++) {
                const img = await tiff.getImage(i);
                levels.push({
                    width: img.getWidth(),
                    height: img.getHeight(),
                    tileWidth: img.getTileWidth(),
                    tileHeight: img.getTileHeight(),
                    samplesPerPixel: img.getSamplesPerPixel(),
                    index: i
                });
            }

            // Send back all levels
            // Ensure sorted by resolution (width) usually, but GeoTIFF order is usually correct (0 is largest).
            self.postMessage({ type: 'init-complete', levels });
        } else if (type === 'decode') {
            const { tileX, tileY, tileZ, index } = e.data; // index is the IFD index

            const img = await tiff.getImage(index || 0); // Default to 0 if not provided

            const tileSize = e.data.tileSize;

            // Read specific tile
            let data: any;
            try {
                data = await img.readRasters({
                    window: [tileX, tileY, tileX + tileSize, tileY + tileSize],
                    interleave: true,
                    width: tileSize,
                    height: tileSize,
                    fillValue: 0
                });
            } catch (readError) {
                // Determine if out of bounds?
                // For now, return empty/transparent?
                console.warn("Read error", readError);
                (self as any).postMessage({ type: 'tile-decoded', id, data: null, min: 0, max: 0 }, []);
                return;
            }

            const samplesPerPixel = img.getSamplesPerPixel();
            const tileArea = tileSize * tileSize;
            const floatData = new Float32Array(tileArea * 4);

            let min = Number.MAX_VALUE;
            let max = Number.MIN_VALUE;

            // data is TypedArray.

            if (samplesPerPixel >= 3) {
                // RGB or RGBA
                for (let i = 0; i < tileArea; i++) {
                    const r = data[i * samplesPerPixel];
                    const g = data[i * samplesPerPixel + 1];
                    const b = data[i * samplesPerPixel + 2];
                    // Alpha? usually ignore or 255.

                    floatData[i * 4] = r;
                    floatData[i * 4 + 1] = g;
                    floatData[i * 4 + 2] = b;
                    floatData[i * 4 + 3] = 1.0; // Full alpha (1.0 for float)

                    if (r < min) min = r;
                    if (g < min) min = g;
                    if (b < min) min = b;
                    if (r > max) max = r;
                    if (g > max) max = g;
                    if (b > max) max = b;
                }
            } else {
                // Grayscale or other
                for (let i = 0; i < tileArea; i++) {
                    const val = data[i]; // interleave true means data is flat array for 1 sample
                    floatData[i * 4] = val;
                    floatData[i * 4 + 1] = val;
                    floatData[i * 4 + 2] = val;
                    floatData[i * 4 + 3] = 1.0;

                    if (val < min) min = val;
                    if (val > max) max = val;
                }
            }

            (self as any).postMessage({
                type: 'tile-decoded',
                id,
                data: floatData,
                min,
                max
            }, [floatData.buffer]);
        }
    } catch (err) {
        console.error("Worker error:", err);
        self.postMessage({ type: 'error', id, error: err });
    }
};
