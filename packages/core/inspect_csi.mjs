import { fromUrl } from 'geotiff';

const tiffUrl = "http://umbra-open-data-catalog.s3.amazonaws.com/sar-data/tasks/Sydney%20International%20Airport%2C%20Australia/04bb2580-b703-44be-a3f0-057829d414d6/2024-02-26-11-55-07_UMBRA-04/2024-02-26-11-55-07_UMBRA-04_CSI.tif";

async function run() {
    try {
        console.log("Inspecting TIFF:", tiffUrl);
        const tiff = await fromUrl(tiffUrl);
        const image = await tiff.getImage();

        console.log("PhotometricInterpretation:", image.fileDirectory.PhotometricInterpretation);
        console.log("SamplesPerPixel:", image.fileDirectory.SamplesPerPixel);
        console.log("BitsPerSample:", image.getBitsPerSample());

        // GDAL Metadata
        let gdalMetadata = null;
        try {
            if (typeof image.getGDALMetadata === 'function') {
                gdalMetadata = image.getGDALMetadata();
            }
        } catch (e) { }
        console.log("GDAL Metadata keys:", gdalMetadata ? Object.keys(gdalMetadata) : "None");

        if (gdalMetadata) {
            Object.keys(gdalMetadata).forEach(k => {
                if (k.includes('BAND')) console.log(k, gdalMetadata[k]);
            });
        }

        // Check for COLLECT_ID in 42112
        if (image.fileDirectory.GDAL_METADATA) {
            console.log("Has GDAL_METADATA tag (42112)");
            const xml = image.fileDirectory.GDAL_METADATA;
            console.log("Preview XML:", String.fromCharCode.apply(null, xml.slice(0, 200)));
        }

    } catch (err) {
        console.error("Error:", err);
    }
}

run();
