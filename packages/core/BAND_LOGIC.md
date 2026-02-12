# Band Selection and YCbCr Support Documentation

This document explains the logic behind automatic band detection, heuristic naming, and support for special color spaces (YCbCr) in the COG Renderer.

## Band Detection Logic

The renderer attempts to identify and label bands intelligently, even when explicit metadata is missing. The logic resides primarily in `decoder.worker.ts`.

### 1. Metadata Sources
The system checks for band information in the following order:
1. **Standard GDAL Metadata**: Uses `getGDALMetadata()` if available.
2. **GDAL_METADATA Tag (42112)**: If the function is missing, it manually parses the XML stored in this TIFF tag.
   - **Robust Parsing**: Uses `TextDecoder` (or a chunked fallback) to safely parse large metadata strings (common in SAR images) without crashing the worker.

### 2. Heuristic Naming (Fallback Strategy)
If explicit band names (e.g., `BAND_1`, `BAND_R`) are not found, the system applies heuristics based on the number of bands (`SamplesPerPixel`):

| Band Count | Detected Profile | Band Names Applied |
| :--- | :--- | :--- |
| **8** | **Maxar Multispectral** | Coastal, Blue, Green, Yellow, Red, Red Edge, NIR1, NIR2 |
| **4** | **Standard Multispectral** | Blue, Green, Red, NIR |
| **3** | **Standard RGB / CSI** | Red, Green, Blue (suffix `(CSI)` added if `COLLECT_ID` present) |
| **1** | **Single-Band Intensity** | Panchromatic (if 16-bit), SAR Intensity (if `COLLECT_ID` present), or "Band 1" |
| **12/13** | **Sentinel-2** | Applies standard Sentinel-2 band names (Coastal, Blue... SWIR) |

> **Note**: For 3-band images, the system explicitly verifies the sample count from the `fileDirectory` to avoid browser-specific issues where YCbCr images might report an incorrect sample count.

### 3. Automatic RGB Selection
After identifying bands, the system automatically suggests the best RGB combination for default rendering:
1. **Name Matching**: Scans for bands named "Red", "Green", "Blue" (case-insensitive).
2. **Fallback**: If not found, defaults to Bands 1, 2, 3 (Indices 0, 1, 2).
3. **Single Band**: If only 1 band exists, defaults to Band 1 (Index 0).

---

## YCbCr support

Some Earth observation imagery (e.g., Maxar Visual products) uses the **YCbCr** color space with JPEG compression to reduce file size. This format requires special handling to render correctly.

### Detection
The worker detects YCbCr images by checking the TIFF tag `PhotometricInterpretation`:
- **Value 6**: Indicates YCbCr encoding.
- **Value 2**: Indicates standard RGB.

### Rendering and Conversion
When YCbCr is detected, the `decode` function applies an on-the-fly conversion for every pixel:

1. **Extraction**: Reads the raw Y (Luma), Cb (Blue-difference), and Cr (Red-difference) values.
2. **Conversion Formula**: Applies the standard JPEG conversion matrix:
   ```javascript
   R = Y + 1.402 * (Cr - 128)
   G = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128)
   B = Y + 1.772 * (Cb - 128)
   ```
3. **Clamping**: RGB values are clamped to the valid range [0, 255].
4. **Transparency Handling**:
   - YCbCr images often use `(0, 0, 0)` as the nodata value.
   - In YCbCr space, pure black is `(0, 128, 128)`. The value `(0, 0, 0)` technically converts to a deep green.
   - **Fix**: The decoder explicitly checks for `(0, 0, 0)` and treats it as transparent (`alpha = 0`) to prevent green artifacts around image borders.

---

## UI Behavior (Band Selector)

The UI component in `main.ts` adapts to the detected image type:

- **Multi-Band (RGB/Multispectral)**:
  - Shows 3 dropdowns for Red, Green, and Blue channels.
  - Pre-selects the suggested bands.
  
- **Single-Band (Pan/SAR)**:
  - Hides the Green and Blue dropdowns.
  - Updates the label to "Band:" instead of "Red:".
  - Shows an informational message (e.g., "Panchromatic image (1 band)").

**State Management Logic**:
The UI explicilty resets the visibility of dropdowns (`display: block` or `none`) every time a new image is loaded. This prevents UI state from persisting incorrectly (e.g., hiding dropdowns for a single-band image and failing to restore them when loading a subsequent multispectral image).
