import { fromUrl, fromBlob } from 'geotiff';

let tiff: any;

self.onmessage = async (e: MessageEvent) => {
    const { type, id, source } = e.data;

    try {
        if (type === 'init') {
            if (source instanceof Blob) {
                tiff = await fromBlob(source);
            } else {
                tiff = await fromUrl(source);
            }
            const imageCount = await tiff.getImageCount();
            const levels: any[] = [];

            // Extract band metadata from the first (full resolution) image
            const firstImage = await tiff.getImage(0);
            let samplesPerPixel = firstImage.getSamplesPerPixel();
            if (firstImage.fileDirectory && firstImage.fileDirectory.SamplesPerPixel) {
                const spp = firstImage.fileDirectory.SamplesPerPixel;
                samplesPerPixel = (Array.isArray(spp) || typeof spp === 'object') && spp.length ? spp[0] : spp;
            }
            console.log("Decoder: SamplesPerPixel:", samplesPerPixel, "PI:", firstImage.fileDirectory?.PhotometricInterpretation);
            const bandMetadata: any[] = [];

            // Try to get band descriptions from GDAL metadata
            let gdalMetadata: any = null;

            try {
                if (typeof firstImage.getGDALMetadata === 'function') {
                    gdalMetadata = firstImage.getGDALMetadata();
                }
            } catch (e) { }

            // Fallback: parse Tag 42112 (GDAL_METADATA) manually
            if (!gdalMetadata && firstImage.fileDirectory && firstImage.fileDirectory.GDAL_METADATA) {
                try {
                    const xml = firstImage.fileDirectory.GDAL_METADATA;
                    let xmlStr = '';
                    if (typeof xml === 'string') {
                        xmlStr = xml;
                    } else if (xml && (xml instanceof Uint8Array || xml instanceof Uint16Array || Array.isArray(xml))) {
                        // Use TextDecoder if available, or fallback
                        if (typeof TextDecoder !== 'undefined') {
                            xmlStr = new TextDecoder().decode(xml as any);
                        } else {
                            // Fallback for older envs, safe chunking
                            const arr = xml as any;
                            for (let i = 0; i < arr.length; i += 10000) {
                                xmlStr += String.fromCharCode.apply(null, arr.slice(i, i + 10000));
                            }
                        }
                    }
                    gdalMetadata = {};
                    const regex = /<Item\s+name="([^"]+)"[^>]*>([^<]*)<\/Item>/g;
                    let match;
                    while ((match = regex.exec(xmlStr)) !== null) {
                        if (match && match.length >= 3) {
                            gdalMetadata[match[1]] = match[2];
                        }
                    }
                } catch (e) { }
            }

            for (let bandIdx = 0; bandIdx < samplesPerPixel; bandIdx++) {
                const bandNum = bandIdx + 1; // GDAL uses 1-based indexing
                let bandName = `Band ${bandNum}`;
                let bandDescription = '';

                // Look for BAND_X metadata keys
                if (gdalMetadata) {
                    const nameKey = `BAND_${bandNum}`;
                    const descKey = `BAND_${bandNum}_DESC`;

                    if (gdalMetadata[nameKey]) bandName = gdalMetadata[nameKey];
                    if (gdalMetadata[descKey]) bandDescription = gdalMetadata[descKey];
                }

                bandMetadata.push({
                    index: bandIdx,
                    name: bandName,
                    description: bandDescription
                });
            }

            // Heuristic naming
            const isGeneric = bandMetadata.every(b => b.name.startsWith('Band '));
            if (isGeneric) {
                const keys = gdalMetadata ? Object.keys(gdalMetadata) : [];

                // Maxar 8-Band (WorldView-2/3 standard)
                if (samplesPerPixel === 8) {
                    const maxar8Order = ['Coastal', 'Blue', 'Green', 'Yellow', 'Red', 'Red Edge', 'NIR1', 'NIR2'];
                    bandMetadata.forEach((b, i) => {
                        if (i < maxar8Order.length) b.name = maxar8Order[i];
                        const keyMap: { [key: number]: string } = {
                            0: 'BAND_C', 1: 'BAND_B', 2: 'BAND_G', 3: 'BAND_Y',
                            4: 'BAND_R', 5: 'BAND_RE', 6: 'BAND_N', 7: 'BAND_N2'
                        };
                        const key = keyMap[i];
                        if (gdalMetadata && gdalMetadata[key]) b.description = gdalMetadata[key];
                    });
                }
                // Maxar/Planet 4-Band (Standard Multispectral: Blue, Green, Red, NIR)
                else if (samplesPerPixel === 4) {
                    const maxar4Order = ['Blue', 'Green', 'Red', 'NIR'];
                    bandMetadata.forEach((b, i) => {
                        if (i < maxar4Order.length) b.name = maxar4Order[i];
                        const keyMap: { [key: number]: string } = {
                            0: 'BAND_B', 1: 'BAND_G', 2: 'BAND_R', 3: 'BAND_N'
                        };
                        const key = keyMap[i];
                        if (gdalMetadata && gdalMetadata[key]) b.description = gdalMetadata[key];
                    });
                }
                // Sentinel-2 L2A (12 bands)
                else if (samplesPerPixel === 12) {
                    const s2Order = ['Coastal', 'Blue', 'Green', 'Red', 'Red Edge 1', 'Red Edge 2', 'Red Edge 3', 'NIR', 'NIR Narrow', 'Water Vapor', 'SWIR 1', 'SWIR 2'];
                    bandMetadata.forEach((b, i) => { if (i < s2Order.length) b.name = s2Order[i]; });
                }
                // Sentinel-2 L1C (13 bands)
                else if (samplesPerPixel === 13) {
                    const s2Order = ['Coastal', 'Blue', 'Green', 'Red', 'Red Edge 1', 'Red Edge 2', 'Red Edge 3', 'NIR', 'NIR Narrow', 'Water Vapor', 'Cirrus', 'SWIR 1', 'SWIR 2'];
                    bandMetadata.forEach((b, i) => { if (i < s2Order.length) b.name = s2Order[i]; });
                }
                // Standard RGB (R, G, B) - Metadata or PI check
                else if (samplesPerPixel === 3 &&
                    ((keys.some(k => k.includes('BAND_R')) && keys.some(k => k.includes('BAND_B'))) ||
                        (firstImage.fileDirectory && (firstImage.fileDirectory.PhotometricInterpretation === 2 || firstImage.fileDirectory.PhotometricInterpretation === 6)))) {
                    const rgbOrder = ['Red', 'Green', 'Blue'];
                    // Check if it's Umbra CSI
                    const isCSI = keys.includes('COLLECT_ID');

                    bandMetadata.forEach((b, i) => {
                        if (i < rgbOrder.length) b.name = rgbOrder[i];
                        const keyMap: { [key: number]: string } = { 0: 'BAND_R', 1: 'BAND_G', 2: 'BAND_B' };
                        const key = keyMap[i];
                        if (gdalMetadata && gdalMetadata[key]) b.description = gdalMetadata[key];

                        if (isCSI) {
                            b.description = (b.description ? b.description + ' ' : '') + '(CSI)';
                        }
                    });
                }
                // Single Band Hints (Pan/SAR)
                else if (samplesPerPixel === 1) {
                    let bits = 0;
                    if (firstImage.getBitsPerSample) {
                        const bps = firstImage.getBitsPerSample();
                        // Handle both number (GDAL convention for single band?) and array
                        bits = (bps && typeof bps.length === 'number') ? bps[0] : bps;
                    }

                    if (keys.includes('COLLECT_ID')) {
                        bandMetadata[0].name = 'SAR Intensity';
                        bandMetadata[0].description = 'Umbra SAR';
                    } else if (bits === 16) {
                        // Likely Maxar Pan (16-bit, no metadata)
                        bandMetadata[0].name = 'Panchromatic';
                    }
                }
            }

            // Auto-detect RGB bands
            let suggestedBands: number[] = [];
            if (samplesPerPixel === 1) {
                suggestedBands = [0];
            } else if (samplesPerPixel >= 3) {
                const redIdx = bandMetadata.findIndex((b: any) => b.name.toLowerCase().includes('red') || b.description.toLowerCase().includes('red'));
                const greenIdx = bandMetadata.findIndex((b: any) => b.name.toLowerCase().includes('green') || b.description.toLowerCase().includes('green'));
                const blueIdx = bandMetadata.findIndex((b: any) => b.name.toLowerCase().includes('blue') || b.description.toLowerCase().includes('blue'));

                if (redIdx >= 0 && greenIdx >= 0 && blueIdx >= 0) suggestedBands = [redIdx, greenIdx, blueIdx];
                else suggestedBands = [0, 1, 2];
            }

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

            self.postMessage({ type: 'init-complete', id, levels, bandMetadata, suggestedBands });
        } else if (type === 'decode') {
            const { tileX, tileY, index, bandIndices } = e.data;
            const img = await tiff.getImage(index || 0);
            const tileSize = e.data.tileSize;

            const pi = img.fileDirectory.PhotometricInterpretation;
            const isYCbCr = pi === 6;

            const fillValue = 0;

            let data: any;
            try {
                data = await img.readRasters({
                    window: [tileX, tileY, tileX + tileSize, tileY + tileSize],
                    interleave: true,
                    width: tileSize,
                    height: tileSize,
                    fillValue: fillValue
                });
            } catch (readError) {
                (self as any).postMessage({ type: 'tile-decoded', id, data: null, min: 0, max: 0 }, []);
                return;
            }

            const samplesPerPixel = img.getSamplesPerPixel();
            const tileArea = tileSize * tileSize;
            const floatData = new Float32Array(tileArea * 4);

            let min = Number.POSITIVE_INFINITY;
            let max = Number.NEGATIVE_INFINITY;

            const bands = bandIndices || (samplesPerPixel >= 3 ? [0, 1, 2] : [0]);

            if (bands.length === 1) {
                const bandIdx = bands[0];
                const THRESHOLD = 5;
                for (let i = 0; i < tileArea; i++) {
                    const val = data[i * samplesPerPixel + bandIdx];
                    floatData[i * 4] = val;
                    floatData[i * 4 + 1] = val;
                    floatData[i * 4 + 2] = val;
                    // Treat near 0 as NoData/Transparent
                    floatData[i * 4 + 3] = (val < THRESHOLD) ? 0.0 : 1.0;

                    if (val < min && val >= THRESHOLD) min = val;
                    if (val > max && val >= THRESHOLD) max = val;
                }
            } else if (bands.length >= 3) {
                const rBand = bands[0];
                const gBand = bands[1];
                const bBand = bands[2];
                let alpha = 1.0;

                const THRESHOLD = 5; // Tolerance for JPEG artifacts

                for (let i = 0; i < tileArea; i++) {
                    let r = data[i * samplesPerPixel + rBand];
                    let g = data[i * samplesPerPixel + gBand];
                    let b = data[i * samplesPerPixel + bBand];
                    alpha = 1.0;

                    if (isYCbCr) {
                        const Y = data[i * samplesPerPixel + 0];
                        const Cb = data[i * samplesPerPixel + 1];
                        const Cr = data[i * samplesPerPixel + 2];

                        // Exact 0 check for padding (fillValue=0)
                        if (Y === 0 && Cb === 0 && Cr === 0) {
                            r = 0; g = 0; b = 0; alpha = 0.0;
                        } else {
                            r = Y + 1.402 * (Cr - 128);
                            g = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128);
                            b = Y + 1.772 * (Cb - 128);
                            r = Math.max(0, Math.min(255, r));
                            g = Math.max(0, Math.min(255, g));
                            b = Math.max(0, Math.min(255, b));
                        }
                    }

                    // Threshold check for noisy black (JPEG artifacts)
                    // Also handles standard RGB precise 0
                    if (r < THRESHOLD && g < THRESHOLD && b < THRESHOLD) {
                        alpha = 0.0;
                    }

                    floatData[i * 4] = r;
                    floatData[i * 4 + 1] = g;
                    floatData[i * 4 + 2] = b;
                    floatData[i * 4 + 3] = alpha;

                    if (alpha > 0) {
                        if (r < min) min = r;
                        if (g < min) min = g;
                        if (b < min) min = b;
                        if (r > max) max = r;
                        if (g > max) max = g;
                        if (b > max) max = b;
                    }
                }
            }

            (self as any).postMessage({ type: 'tile-decoded', id, data: floatData, min, max }, [floatData.buffer]);
        }
    } catch (err) {
        console.error("Worker error:", err);
        self.postMessage({ type: 'error', id, error: err });
    }
};
