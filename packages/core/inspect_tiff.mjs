import { fromUrl } from 'geotiff';

const url = "http://umbra-open-data-catalog.s3.us-west-2.amazonaws.com/sar-data/tasks/Sydney%20International%20Airport%2C%20Australia/04bb2580-b703-44be-a3f0-057829d414d6/2024-02-26-11-55-07_UMBRA-04/2024-02-26-11-55-07_UMBRA-04_GEC.tif";
// const url = "https://maxar-opendata.s3.dualstack.us-west-2.amazonaws.com/events/Kahramanmaras-turkey-earthquake-23/ard/37/031133102210/2022-07-20/10300100D6740900-visual.tif";
// const url = "https://maxar-opendata.s3.dualstack.us-west-2.amazonaws.com/events/Kahramanmaras-turkey-earthquake-23/ard/37/031133102210/2022-07-20/10300100D6740900-ms.tif";
// const url = "https://maxar-opendata.s3.dualstack.us-west-2.amazonaws.com/events/Kahramanmaras-turkey-earthquake-23/ard/37/031133102210/2022-07-20/10300100D6740900-pan.tif";
async function run() {
    try {
        console.log("Inspecting:", url);
        const tiff = await fromUrl(url);
        const image = await tiff.getImage(0);
        console.log("PhotometricInterpretation:", image.fileDirectory.PhotometricInterpretation);
        console.log("SamplesPerPixel:", image.fileDirectory.SamplesPerPixel);
        console.log("Compression:", image.fileDirectory.Compression);
        console.log("BitsPerSample:", image.fileDirectory.BitsPerSample);
        console.log("PlanarConfiguration:", image.fileDirectory.PlanarConfiguration);
        console.log("ExtraSamples:", image.fileDirectory.ExtraSamples);

        const gdal = image.getGDALMetadata();
        console.log("GDAL Metadata keys:", gdal ? Object.keys(gdal) : "None");

        if (image.fileDirectory.GDAL_METADATA) {
            console.log("Tag 42112 found (length):", image.fileDirectory.GDAL_METADATA.length);
            console.log("Tag 42112 preview:", image.fileDirectory.GDAL_METADATA.substring(0, 100));
        }
    } catch (e) {
        console.error("Error:", e);
    }
}
run();
