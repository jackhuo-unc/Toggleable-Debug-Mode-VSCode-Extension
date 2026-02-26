import * as vscode from 'vscode';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { HiddenCodeOverlay } from '../../HiddenCodeOverlay';

export class ModeToggleTest {
    private framework: PerformanceTestFramework;
    private overlayManager: HiddenCodeOverlay;

    constructor(
        framework: PerformanceTestFramework,
        overlayManager: HiddenCodeOverlay
    ) {
        this.framework = framework;
        this.overlayManager = overlayManager;
    }

    /**
     * Measure debug mode toggle time
     */
    public async runToggleTest(iterations: number = 50): Promise<void> {
        await this.framework.benchmark(
            'debug_mode_toggle',
            async () => {
                await this.overlayManager.toggleDebugMode();
            },
            iterations,
            5  // warmup
        );
    }

    /**
     * Measure insert mode toggle time
     */
    public async runInsertModeToggleTest(iterations: number = 50): Promise<void> {
        await this.framework.benchmark(
            'insert_mode_toggle',
            async () => {
                await this.overlayManager.toggleInsertMode();
            },
            iterations,
            5
        );
    }
}