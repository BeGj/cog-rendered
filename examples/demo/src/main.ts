import './style.css' // Optional if using basic CSS
import { WebGPURenderer } from '@cog-renderer/core';
import type { BandMetadata } from '@cog-renderer/core';
// Import worker using relative path for dev
import DecoderWorker from '../../../packages/core/src/worker/decoder.worker.ts?worker';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const loadUrlBtn = document.getElementById('loadUrlBtn') as HTMLButtonElement;
const urlSelect = document.getElementById('urlSelect') as HTMLSelectElement;
const toggleControlsBtn = document.getElementById('toggleControls') as HTMLButtonElement;
const controls = document.getElementById('controls');


// Make canvas full screen
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

const renderer = new WebGPURenderer(canvas);

// Initialize with worker
const worker = new DecoderWorker();
renderer.init(worker).then(() => {
  console.log("Renderer initialized");
  renderer.enableInteractions();
}).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Failed to init renderer:", err);
  alert("WebGPU not supported or failed to initialize: " + message);
});

fileInput.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    renderer.load(file);
  }
});

loadUrlBtn.addEventListener('click', () => {
  const url = urlInput.value || "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/21/H/UB/2021/9/S2B_21HUB_20210915_0_L2A/TCI.tif";
  urlInput.value = url; // Show it
  if (url) {
    renderer.load(url);
  }
});

// Populate dropdown
const demoImages = [
  { name: "Sentinel-2 L2A (TCI)", url: "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/21/H/UB/2021/9/S2B_21HUB_20210915_0_L2A/TCI.tif" },
  { name: "Maxar ARD (MSI)", url: "https://maxar-opendata.s3.dualstack.us-west-2.amazonaws.com/events/Kahramanmaras-turkey-earthquake-23/ard/37/031133102210/2022-07-20/10300100D6740900-ms.tif" },
  { name: "Maxar ARD (PAN)", url: "https://maxar-opendata.s3.dualstack.us-west-2.amazonaws.com/events/Kahramanmaras-turkey-earthquake-23/ard/37/031133102210/2022-07-20/10300100D6740900-pan.tif" },
  { name: "Maxar ARD (VIS)", url: "https://maxar-opendata.s3.dualstack.us-west-2.amazonaws.com/events/Kahramanmaras-turkey-earthquake-23/ard/37/031133102210/2022-07-20/10300100D6740900-visual.tif" },
];

if (urlSelect) {
  demoImages.forEach(img => {
    const option = document.createElement('option');
    option.value = img.url;
    option.textContent = img.name;
    urlSelect.appendChild(option);
  });

  urlSelect.addEventListener('change', () => {
    const url = urlSelect.value;
    if (url) {
      urlInput.value = url;
      renderer.load(url);
    }
  });
}

// Toggle controls
if (toggleControlsBtn && controls) {
  toggleControlsBtn.addEventListener('click', () => {
    controls.classList.toggle('collapsed');
  });
}

// Mobile Touch Handling
let lastTouchX = 0;
let lastTouchY = 0;
let initialPinchDistance = 0;
let isPanning = false;
let isZooming = false;

canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    isPanning = true;
    isZooming = false;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    isPanning = false;
    isZooming = true;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.cancelable) e.preventDefault(); // Prevent scrolling

  if (!renderer.viewport) return;

  if (isPanning && e.touches.length === 1) {
    const touch = e.touches[0];
    const dx = touch.clientX - lastTouchX;
    const dy = touch.clientY - lastTouchY;

    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const bufferDx = dx * scaleX;
    const bufferDy = dy * scaleY;

    renderer.viewport.move(-bufferDx / renderer.viewport.zoom, -bufferDy / renderer.viewport.zoom);

  } else if (isZooming && e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const currentDistance = Math.sqrt(dx * dx + dy * dy);

    if (initialPinchDistance > 0) {
      const factor = currentDistance / initialPinchDistance;

      const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      const x = (centerX - rect.left) * scaleX;
      const y = (centerY - rect.top) * scaleY;

      renderer.viewport.zoomAt(factor, x, y);
      initialPinchDistance = currentDistance;
    }
  }
}, { passive: false });

canvas.addEventListener('touchend', () => {
  isPanning = false;
  isZooming = false;
});
if (controls) {
  // Band selector container
  const bandContainer = document.createElement('div');
  bandContainer.id = 'bandSelector';
  bandContainer.style.marginTop = '15px';
  bandContainer.style.display = 'none';
  bandContainer.style.fontSize = '12px';
  bandContainer.style.borderTop = '1px solid #444';
  bandContainer.style.paddingTop = '10px';

  const bandTitle = document.createElement('h4');
  bandTitle.textContent = 'Band Selection';
  bandTitle.style.margin = '0 0 10px 0';
  bandTitle.style.fontSize = '14px';
  bandContainer.appendChild(bandTitle);

  const bandInfo = document.createElement('div');
  bandInfo.id = 'bandInfo';
  bandInfo.style.marginBottom = '10px';
  bandInfo.style.fontSize = '11px';
  bandInfo.style.color = '#aaa';
  bandContainer.appendChild(bandInfo);

  // RGB band selectors
  const createBandSelector = (label: string, color: string) => {
    const div = document.createElement('div');
    div.style.marginBottom = '8px';
    div.innerHTML = `
      <label style="display: block; margin-bottom: 3px; color: ${color};">${label}:</label>
      <select style="width: 100%; padding: 4px; background: #222; color: white; border: 1px solid #444; border-radius: 3px;">
      </select>
    `;
    return div;
  };

  const redSelector = createBandSelector('Red', '#ff6b6b');
  const greenSelector = createBandSelector('Green', '#51cf66');
  const blueSelector = createBandSelector('Blue', '#339af0');

  bandContainer.appendChild(redSelector);
  bandContainer.appendChild(greenSelector);
  bandContainer.appendChild(blueSelector);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply Band Selection';
  applyBtn.style.width = '100%';
  applyBtn.style.marginTop = '10px';
  bandContainer.appendChild(applyBtn);

  controls.appendChild(bandContainer);

  // Handle band initialization
  renderer.onBandsInitialized((bands: BandMetadata[], suggestedBands: number[]) => {
    console.log('Bands initialized:', bands, 'Suggested:', suggestedBands);

    if (bands.length === 0) {
      bandContainer.style.display = 'none';
      return;
    }

    bandContainer.style.display = 'block';

    // Update band info
    if (bands.length === 1) {
      bandInfo.textContent = `Panchromatic image (1 band)`;
    } else {
      bandInfo.textContent = `Multi-band image (${bands.length} bands detected)`;
    }

    // Populate selectors
    const redSelect = redSelector.querySelector('select') as HTMLSelectElement;
    const greenSelect = greenSelector.querySelector('select') as HTMLSelectElement;
    const blueSelect = blueSelector.querySelector('select') as HTMLSelectElement;

    redSelect.innerHTML = '';
    greenSelect.innerHTML = '';
    blueSelect.innerHTML = '';

    bands.forEach((band) => {
      const optionR = document.createElement('option');
      optionR.value = band.index.toString();
      optionR.textContent = `${band.name}${band.description ? ' - ' + band.description : ''}`;
      redSelect.appendChild(optionR);

      const optionG = optionR.cloneNode(true) as HTMLOptionElement;
      greenSelect.appendChild(optionG);

      const optionB = optionR.cloneNode(true) as HTMLOptionElement;
      blueSelect.appendChild(optionB);
    });

    // Set suggested bands
    if (suggestedBands.length >= 3) {
      // Ensure selectors are visible and reset labels
      greenSelector.style.display = 'block';
      blueSelector.style.display = 'block';

      redSelector.querySelector('label')!.textContent = 'Red:';
      (redSelector.querySelector('label') as HTMLElement).style.color = '#ff6b6b';

      redSelect.value = suggestedBands[0].toString();
      greenSelect.value = suggestedBands[1].toString();
      blueSelect.value = suggestedBands[2].toString();
    } else if (suggestedBands.length === 1) {
      // For panchromatic, hide green/blue selectors
      greenSelector.style.display = 'none';
      blueSelector.style.display = 'none';
      redSelector.querySelector('label')!.textContent = 'Band:';
      (redSelector.querySelector('label') as HTMLElement).style.color = '#fff';
      redSelect.value = suggestedBands[0].toString();
    }
  });

  // Apply band selection
  applyBtn.addEventListener('click', () => {
    const redSelect = redSelector.querySelector('select') as HTMLSelectElement;
    const greenSelect = greenSelector.querySelector('select') as HTMLSelectElement;
    const blueSelect = blueSelector.querySelector('select') as HTMLSelectElement;

    const bands = renderer.getBandMetadata();

    if (bands.length === 1) {
      // Panchromatic
      renderer.setBands([parseInt(redSelect.value)]);
    } else {
      // RGB
      renderer.setBands([
        parseInt(redSelect.value),
        parseInt(greenSelect.value),
        parseInt(blueSelect.value)
      ]);
    }
  });

  // ADRA controls
  const adraContainer = document.createElement('div');
  adraContainer.style.marginTop = '15px';
  adraContainer.style.display = 'none';
  adraContainer.style.fontSize = '12px';
  adraContainer.style.borderTop = '1px solid #444';
  adraContainer.style.paddingTop = '10px';

  const defaultSettings = { clipLow: 1, clipHigh: 99, padLow: 50, padHigh: 20 };

  const createSlider = (label: string, min: number, max: number, value: number, onChange: (val: number) => void) => {
    const div = document.createElement('div');
    div.style.marginBottom = '5px';
    div.innerHTML = `
      <div style="display: flex; justify-content: space-between;">
        <span>${label}</span>
        <span id="val-${label.replace(/\s/g, '')}">${value}%</span>
      </div>
      <input type="range" min="${min}" max="${max}" value="${value}" style="width: 100%">
    `;
    const input = div.querySelector('input') as HTMLInputElement;
    const valSpan = div.querySelector('span:last-child') as HTMLSpanElement;
    input.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      valSpan.textContent = `${v}%`;
      onChange(v);
    });
    return div;
  };

  adraContainer.appendChild(createSlider("Clip Low", 0, 10, defaultSettings.clipLow, (v) => renderer.setADRAOptions({ clipLow: v })));
  adraContainer.appendChild(createSlider("Clip High", 90, 100, defaultSettings.clipHigh, (v) => renderer.setADRAOptions({ clipHigh: v })));
  adraContainer.appendChild(createSlider("Pad Low", 0, 100, defaultSettings.padLow, (v) => renderer.setADRAOptions({ padLow: v })));
  adraContainer.appendChild(createSlider("Pad High", 0, 100, defaultSettings.padHigh, (v) => renderer.setADRAOptions({ padHigh: v })));
  controls.appendChild(adraContainer);

  const label = document.createElement('label');
  label.innerHTML = `
    <input type="checkbox" id="autoRangeCheckbox"> Auto Range
  `;
  label.style.marginLeft = '10px';
  label.style.color = 'white';
  controls.appendChild(label);

  const checkbox = document.getElementById('autoRangeCheckbox') as HTMLInputElement;
  checkbox.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    renderer.setAutoRange(checked);
    adraContainer.style.display = checked ? 'block' : 'none';
  });
}
