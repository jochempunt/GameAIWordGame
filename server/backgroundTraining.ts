import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { humorModelPath, readHumorPredictor } from "./predictions.js";
import type { HumorPredictor } from "./predictions.js";

/** One worker shared by all rooms. Requests during a run coalesce into one fresh pass. */
export class BackgroundModelTrainer {
    private pending = false;
    private stopped = false;
    private running: Promise<void> | null = null;
    private controller = new AbortController();

    constructor(
        public model: HumorPredictor | null,
        private train: (signal: AbortSignal) => Promise<HumorPredictor | null>,
        private log: (message: string) => void = console.log,
    ) {}

    request(): void {
        if (this.stopped) return;
        this.pending = true;
        if (!this.running) {
            this.running = this.drain().finally(() => {
                this.running = null;
                if (this.pending && !this.stopped) this.request();
            });
        }
    }

    private async drain(): Promise<void> {
        while (this.pending && !this.stopped) {
            this.pending = false;
            try {
                this.log("Background humor retraining started; gameplay uses the current model.");
                const candidate = await this.train(this.controller.signal);
                if (candidate && !this.stopped) {
                    this.model = candidate;
                    this.log("Background humor model activated.");
                }
            } catch (error) {
                if (!this.stopped) this.log(`Background humor training kept the previous model: ${error instanceof Error ? error.message : "training failed"}`);
            }
        }
    }

    async idle(): Promise<void> {
        while (this.running) await this.running;
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.pending = false;
        this.controller.abort();
        await this.idle();
    }
}

export function runTrainingProcess(command: string, args: string[], signal: AbortSignal, timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { signal, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let timedOut = false;
        const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2000); };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", code => {
            clearTimeout(timer);
            if (code === 0 && !signal.aborted) resolve();
            else reject(new Error(timedOut ? "training exceeded two-minute limit" : output.trim() || "worker stopped"));
        });
    });
}

export async function retrainHumorModel(
    snapshot: () => Promise<unknown[]>, signal: AbortSignal,
    activePath = humorModelPath(),
): Promise<HumorPredictor> {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const python = process.env.HUMOR_PYTHON ?? (existsSync(join(root, ".venv/bin/python"))
        ? join(root, ".venv/bin/python") : "python3");
    const stagingRoot = join(root, "ml/humor/artifacts/background");
    await mkdir(stagingRoot, { recursive: true });
    const stage = await mkdtemp(join(stagingRoot, "run-"));
    // A unique sibling supports atomic replacement even for a custom model path.
    const temporaryModel = `${activePath}.${basename(stage)}.tmp`;
    try {
        const games = await snapshot();
        if (signal.aborted) throw new Error("training cancelled");
        const input = join(stage, "games.json");
        await writeFile(input, JSON.stringify(games));
        await runTrainingProcess(python, [join(root, "ml/humor/retrain_humor.py"),
            "--game", input, "--output-dir", stage,
            "--parameters", join(dirname(activePath), "experiment_report.json")], signal);
        const candidate = readHumorPredictor(join(stage, "humor_ranker.cjs"));
        await mkdir(dirname(activePath), { recursive: true });
        await copyFile(join(stage, "humor_ranker.cjs"), temporaryModel);
        await copyFile(join(stage, "model.json"), join(dirname(activePath), "background_model.json"));
        await copyFile(join(stage, "background_training.json"), join(dirname(activePath), "background_training.json"));
        if (signal.aborted) throw new Error("training cancelled");
        await rename(temporaryModel, activePath);
        return candidate;
    } finally {
        await rm(temporaryModel, { force: true });
        await rm(stage, { recursive: true, force: true });
    }
}
