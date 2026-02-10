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
                (self as any).postMessage({ type: 'tile-decoded', id, bitmap: null }, []);
                return;
            }

            const samplesPerPixel = img.getSamplesPerPixel();
            const tileArea = tileSize * tileSize;
            let rgbaData: Uint8ClampedArray;

            // data is TypedArray.

            if (samplesPerPixel === 4) {
                rgbaData = new Uint8ClampedArray(data);
            } else if (samplesPerPixel === 3) {
                rgbaData = new Uint8ClampedArray(tileArea * 4);
                // RGB
                for (let i = 0; i < tileArea; i++) {
                    rgbaData[i * 4] = data[i * 3];
                    rgbaData[i * 4 + 1] = data[i * 3 + 1];
                    rgbaData[i * 4 + 2] = data[i * 3 + 2];
                    rgbaData[i * 4 + 3] = 255;
                }
            } else if (samplesPerPixel === 1) {
                rgbaData = new Uint8ClampedArray(tileArea * 4);
                // Grayscale
                // Normalize if float?
                // For now, just cast.
                for (let i = 0; i < tileArea; i++) {
                    const val = data[i];
                    rgbaData[i * 4] = val;
                    rgbaData[i * 4 + 1] = val;
                    rgbaData[i * 4 + 2] = val;
                    rgbaData[i * 4 + 3] = 255;
                }
            } else {
                // Fallback: take first channel
                rgbaData = new Uint8ClampedArray(tileArea * 4);
                // Assume interleaved... but if > 4?
                for (let i = 0; i < tileArea; i++) {
                    const val = data[i * samplesPerPixel];
                    rgbaData[i * 4] = val;
                    rgbaData[i * 4 + 1] = val;
                    rgbaData[i * 4 + 2] = val;
                    rgbaData[i * 4 + 3] = 255;
                }
            }

            const imageData = new ImageData(rgbaData as any, tileSize, tileSize);
            const bitmap = await createImageBitmap(imageData);

            (self as any).postMessage({ type: 'tile-decoded', id, bitmap }, [bitmap]);
        }
    } catch (err) {
        console.error("Worker error:", err);
        self.postMessage({ type: 'error', id, error: err });
    }
};
