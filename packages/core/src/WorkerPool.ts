/**
 * Simple priority-based worker pool for handling tile decoding jobs.
 */
export interface WorkerTask {
    id: string;
    priority: number; // Higher number = higher priority
    payload: any;
    transfer?: Transferable[];
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    abortController: AbortController;
}

export class WorkerPool {
    private workers: Worker[] = [];
    private activeTasks: Map<string, WorkerTask> = new Map(); // worker index -> task
    private taskQueue: WorkerTask[] = [];
    private workerStatus: boolean[] = []; // true = busy, false = free
    private workerFactory: () => Worker;
    private maxWorkers: number;
    private terminated: boolean = false;

    constructor(workerFactory: () => Worker, maxWorkers: number = 4) {
        this.workerFactory = workerFactory;
        this.maxWorkers = navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, maxWorkers) : maxWorkers;

        // Initialize workers
        for (let i = 0; i < this.maxWorkers; i++) {
            this.spawnWorker(i);
        }
    }

    private spawnWorker(index: number) {
        if (this.terminated) return;

        const worker = this.workerFactory();
        worker.onmessage = (e) => {
            const task = this.activeTasks.get(index.toString());
            if (task && e.data.id === task.id) {
                this.activeTasks.delete(index.toString());
                task.resolve(e.data);
            } else {
                // Aborted or ID mismatch or Init response
                // Just Free the worker
            }
            this.workerStatus[index] = false;
            this.processNext();
        };

        worker.onerror = (e) => {
            const task = this.activeTasks.get(index.toString());
            if (task) {
                this.activeTasks.delete(index.toString());
                this.workerStatus[index] = false;
                task.reject(e);
                this.processNext();
            }
        };

        this.workers[index] = worker;
        this.workerStatus[index] = false;
    }

    /**
     * Submit a task to the pool.
     * @param id Unique identifier for the task (used for cancellation)
     * @param payload Data to send to worker
     * @param priority Priority (higher = better)
     * @param transfer Optional transferable objects
     */
    public process(id: string, payload: any, priority: number = 0, transfer?: Transferable[]): Promise<any> {
        return new Promise((resolve, reject) => {
            const abortController = new AbortController();

            const task: WorkerTask = {
                id,
                priority,
                payload,
                transfer,
                resolve,
                reject,
                abortController
            };

            // Remove existing pending task with same ID if any (update priority/payload)
            // or just let it replace? 
            // For now, if ID exists in queue, update it.
            const existingIdx = this.taskQueue.findIndex(t => t.id === id);
            if (existingIdx !== -1) {
                // Update priority and payload
                this.taskQueue[existingIdx] = task;
            } else {
                this.taskQueue.push(task);
            }

            // Sort queue by priority (descending)
            this.taskQueue.sort((a, b) => b.priority - a.priority);

            this.processNext();
        });
    }

    /**
     * Cancel a specific task.
     * If queued, remove and reject.
     * If active, reject promise immediately but let worker finish to avoid state corruption.
     */
    public abort(id: string) {
        // Queue: remove and reject immediately
        const queueIndex = this.taskQueue.findIndex(t => t.id === id);
        if (queueIndex !== -1) {
            const task = this.taskQueue[queueIndex];
            this.taskQueue.splice(queueIndex, 1);
            task.reject(new Error('Aborted'));
            return;
        }

        // Active: leave running but reject promise now.
        // Worker will finish, trigger onmessage, free itself.
        for (const [key, task] of this.activeTasks.entries()) {
            if (task.id === id) {
                task.reject(new Error('Aborted'));
                return;
            }
        }
    }

    private processNext() {
        if (this.terminated) return;

        // Find free worker
        const freeWorkerIdx = this.workerStatus.findIndex(status => !status);
        if (freeWorkerIdx === -1) return; // No free workers

        if (this.taskQueue.length === 0) return; // No tasks

        const task = this.taskQueue.shift();
        if (!task) return;

        const worker = this.workers[freeWorkerIdx];
        this.workerStatus[freeWorkerIdx] = true;
        this.activeTasks.set(freeWorkerIdx.toString(), task);

        worker.postMessage(task.payload, task.transfer || []);
    }

    /**
     * Broadcast a message to all workers.
     * Useful for initialization or configuration.
     */
    public broadcast(payload: any) {
        this.workers.forEach(w => w.postMessage(payload));
    }

    public terminate() {
        this.terminated = true;
        this.workers.forEach(w => w.terminate());
        this.workers = [];
        this.activeTasks.clear();
        this.taskQueue = [];
    }

    public get pendingCount(): number {
        return this.taskQueue.length + this.activeTasks.size;
    }
}
