import './style.css' // Optional if using basic CSS
import { WebGPURenderer } from '@cog-renderer/core';
// Import worker using relative path for dev
import DecoderWorker from '../../../packages/core/src/worker/decoder.worker.ts?worker';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const loadUrlBtn = document.getElementById('loadUrlBtn') as HTMLButtonElement;

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
}).catch(err => {
  console.error("Failed to init renderer:", err);
  alert("WebGPU not supported or failed to initialize: " + err.message);
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

const controls = document.getElementById('controls');
if (controls) {
  const adraContainer = document.createElement('div');
  adraContainer.style.marginTop = '10px';
  adraContainer.style.display = 'none'; // Hidden by default
  adraContainer.style.fontSize = '12px';

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

  adraContainer.appendChild(createSlider("Clip Low", 0, 10, 1, (v) => renderer.setADRAOptions({ clipLow: v })));
  adraContainer.appendChild(createSlider("Clip High", 90, 100, 99, (v) => renderer.setADRAOptions({ clipHigh: v })));
  adraContainer.appendChild(createSlider("Pad Low", 0, 100, 50, (v) => renderer.setADRAOptions({ padLow: v })));
  adraContainer.appendChild(createSlider("Pad High", 0, 100, 20, (v) => renderer.setADRAOptions({ padHigh: v })));
  controls.appendChild(adraContainer);

  const label = document.createElement('label');
  label.innerHTML = `
    <input type="checkbox" id="autoRangeCheckbox"> Auto Range
  `;
  label.style.marginLeft = '10px';
  label.style.color = 'white';
  controls.appendChild(label);
  controls.appendChild(adraContainer);

  const checkbox = document.getElementById('autoRangeCheckbox') as HTMLInputElement;
  checkbox.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    renderer.setAutoRange(checked);
    adraContainer.style.display = checked ? 'block' : 'none';
  });
}
