import { fromUrl } from 'geotiff';

const url = "http://umbra-open-data-catalog.s3.amazonaws.com/sar-data/tasks/Sydney%20International%20Airport%2C%20Australia/04bb2580-b703-44be-a3f0-057829d414d6/2024-02-26-11-55-07_UMBRA-04/2024-02-26-11-55-07_UMBRA-04_CSI.tif";

async function run() {
    try {
        console.log("Inspecting:", url);
        const tiff = await fromUrl(url);
        const firstImage = await tiff.getImage(0);
        const samplesPerPixel = firstImage.getSamplesPerPixel();

        console.log("SamplesPerPixel:", samplesPerPixel);

        let gdalMetadata = null;
        try {
            if (typeof firstImage.getGDALMetadata === 'function') {
                gdalMetadata = firstImage.getGDALMetadata();
            }
        } catch (e) { }

        const bandMetadata = [];
        for (let bandIdx = 0; bandIdx < samplesPerPixel; bandIdx++) {
            bandMetadata.push({ index: bandIdx, name: `Band ${bandIdx + 1}`, description: '' });
        }

        const isGeneric = bandMetadata.every(b => b.name.startsWith('Band '));
        console.log("isGeneric:", isGeneric);

        const keys = gdalMetadata ? Object.keys(gdalMetadata) : [];
        console.log("Metadata keys:", keys);

        const bitsRaw = firstImage.getBitsPerSample ? firstImage.getBitsPerSample() : "Function missing";
        console.log("BitsPerSample raw:", bitsRaw);

        if (firstImage.fileDirectory) {
            console.log("FileDirectory BitsPerSample:", firstImage.fileDirectory.BitsPerSample);
        }

        const bits = bitsRaw && bitsRaw.length ? bitsRaw[0] : undefined;
        console.log("Bits 0:", bits);

        if (samplesPerPixel === 1) {
            if (keys.includes('COLLECT_ID')) {
                console.log("Match: SAR Intensity");
            } else if (bits === 16) {
                console.log("Match: Panchromatic");
                bandMetadata[0].name = 'Panchromatic';
            } else {
                console.log("No match for bits:", bits);
            }
        }

        console.log("Final Band Name:", bandMetadata[0].name);

    } catch (err) {
        console.error("Error:", err);
    }
}

run();
