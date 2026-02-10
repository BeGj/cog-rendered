import { Viewport } from './Viewport';

export class InteractionHandler {
    element: HTMLElement;
    viewport: Viewport;
    isDragging: boolean = false;
    lastX: number = 0;
    lastY: number = 0;

    constructor(element: HTMLElement, viewport: Viewport) {
        this.element = element;
        this.viewport = viewport;

        this.element.addEventListener('wheel', this.onWheel.bind(this), { passive: false });
        this.element.addEventListener('mousedown', this.onMouseDown.bind(this));
        window.addEventListener('mousemove', this.onMouseMove.bind(this));
        window.addEventListener('mouseup', this.onMouseUp.bind(this));
    }

    onWheel(e: WheelEvent) {
        e.preventDefault();
        const factor = Math.pow(1.001, -e.deltaY);
        const rect = this.element.getBoundingClientRect();

        // Map CSS pixels to Canvas Buffer pixels
        const canvas = this.element as HTMLCanvasElement;
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        this.viewport.zoomAt(factor, x, y);
    }

    onMouseDown(e: MouseEvent) {
        this.isDragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
    }

    onMouseMove(e: MouseEvent) {
        if (!this.isDragging) return;

        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;

        this.lastX = e.clientX;
        this.lastY = e.clientY;

        const rect = this.element.getBoundingClientRect();
        const canvas = this.element as HTMLCanvasElement;
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        // Convert screen delta to world delta (using buffer scale)
        const bufferDx = dx * scaleX;
        const bufferDy = dy * scaleY;

        const worldDx = -bufferDx / this.viewport.zoom;
        const worldDy = -bufferDy / this.viewport.zoom;

        this.viewport.move(worldDx, worldDy);
    }

    onMouseUp() {
        this.isDragging = false;
    }

    disconnect() {
        this.element.removeEventListener('wheel', this.onWheel.bind(this));
        this.element.removeEventListener('mousedown', this.onMouseDown.bind(this));
        window.removeEventListener('mousemove', this.onMouseMove.bind(this));
        window.removeEventListener('mouseup', this.onMouseUp.bind(this));
    }
}
