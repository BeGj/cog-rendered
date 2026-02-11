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
}).catch((err: Error) => {
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
  const url = urlInput.value;
  if (url) {
    renderer.load(url);
  }
});
