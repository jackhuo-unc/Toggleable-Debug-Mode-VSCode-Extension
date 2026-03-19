import * as vscode from 'vscode';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { HiddenCodeOverlay } from '../../local/HiddenCodeOverlay';

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
     * Baseline for toggle - measure time to do a simple state flip (no file operations)
     * This gives us a lower bound to compare against
     */
    public async runToggleBaselineTest(iterations: number = 20): Promise<void> {
        let state = false;
        
        // Warmup
        for (let i = 0; i < 5; i++) {
            state = !state;
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        for (let i = 0; i < iterations; i++) {
            await this.framework.measure(
                'debug_mode_toggle_baseline',
                async () => {
                    // Baseline: just a simple boolean toggle + minimal async work
                    state = !state;
                    await new Promise(resolve => setTimeout(resolve, 0));
                },
                { iteration: i }
            );
        }
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

    /**
     * Measure insert mode toggle baseline (simple state flip)
     */
    public async runInsertModeToggleBaselineTest(iterations: number = 20): Promise<void> {
        let mode: 'normal' | 'debug' = 'normal';

        for (let i = 0; i < iterations; i++) {
            await this.framework.measure(
                'insert_mode_toggle_baseline',
                async () => {
                    mode = mode === 'normal' ? 'debug' : 'normal';
                    await new Promise(resolve => setTimeout(resolve, 0));
                },
                { iteration: i }
            );
        }
    }
}