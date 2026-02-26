import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

export interface TimingResult {
    operation: string;
    duration: number;  // milliseconds
    timestamp: number;
    metadata?: Record<string, unknown>;
}

export interface OperationSummary {
    mean: number;
    median: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
    stdDev: number;
    count: number;
}

export interface OverheadComparison {
    name: string;
    baselineMean: number;
    trackedMean: number;
    overheadMs: number;
    overheadPercent: number;
}

export interface FileSizeComparison {
    label: string;
    lineCount: number;
    charsPerLine: number;
    totalChars: number;
    baselineMean: number;
    normalInsertMean: number;
    debugInsertMean: number;
    normalOverheadMs: number;
    normalOverheadPercent: number;
    debugOverheadMs: number;
    debugOverheadPercent: number;
    highlightRenderMs?: number;
    debugToggleMs?: number;
    fileOpenBaselineMs?: number;
    fileOpenTrackedMs?: number;
}

export interface PerformanceReport {
    testName: string;
    timestamp: Date;
    environment: {
        vscodeVersion: string;
        platform: string;
        fileSize?: number;
        segmentCount?: number;
    };
    results: TimingResult[];
    summaries: Record<string, OperationSummary>;
    overheads?: OverheadComparison[];
    fileSizeScaling?: FileSizeComparison[];
}

export class PerformanceTestFramework {
    private results: TimingResult[] = [];
    private readonly outputDir: string;

    constructor(outputDir: string) {
        this.outputDir = outputDir;
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
    }

    /**
     * Measure execution time of an async operation
     */
    public async measure<T>(
        operation: string,
        fn: () => Promise<T>,
        metadata?: Record<string, unknown>
    ): Promise<T> {
        const start = performance.now();
        try {
            return await fn();
        } finally {
            const duration = performance.now() - start;
            this.results.push({
                operation,
                duration,
                timestamp: Date.now(),
                metadata
            });
        }
    }

    /**
     * Measure execution time of a sync operation
     */
    public measureSync<T>(
        operation: string,
        fn: () => T,
        metadata?: Record<string, unknown>
    ): T {
        const start = performance.now();
        try {
            return fn();
        } finally {
            const duration = performance.now() - start;
            this.results.push({
                operation,
                duration,
                timestamp: Date.now(),
                metadata
            });
        }
    }

    /**
     * Run an operation multiple times and collect stats
     */
    public async benchmark<T>(
        operation: string,
        fn: () => Promise<T>,
        iterations: number = 100,
        warmupIterations: number = 10
    ): Promise<void> {
        // Warmup
        for (let i = 0; i < warmupIterations; i++) {
            await fn();
        }

        // Actual measurements
        for (let i = 0; i < iterations; i++) {
            await this.measure(operation, fn, { iteration: i });
        }
    }

    /**
     * Calculate statistics for a specific operation
     */
    public getStats(operation: string): OperationSummary | null {
        const timings = this.results
            .filter(r => r.operation === operation)
            .map(r => r.duration)
            .sort((a, b) => a - b);

        if (timings.length === 0) return null;

        const count = timings.length;
        const sum = timings.reduce((a, b) => a + b, 0);
        const mean = sum / timings.length;
        const median = timings[Math.floor(timings.length / 2)];
        const p95 = timings[Math.floor(timings.length * 0.95)];
        const p99 = timings[Math.floor(timings.length * 0.99)];
        const min = timings[0];
        const max = timings[timings.length - 1];

        const variance = timings.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / timings.length;
        const stdDev = Math.sqrt(variance);

        return { mean, median, p95, p99, min, max, stdDev, count };
    }

    /**
     * Generate a full report
     */
    public generateReport(testName: string, environment: Partial<PerformanceReport['environment']> = {}): PerformanceReport {
        const operations = [...new Set(this.results.map(r => r.operation))];
        const summaries: Record<string, OperationSummary> = {};

        for (const op of operations) {
            const stats = this.getStats(op);
            if (stats) {
                summaries[op] = stats;
            }
        }

        // Calculate comparisons
        const comparisons: OverheadComparison[] = [];
        const comparisonPairs = [
            { name: 'Keystroke Latency', baseline: 'keystroke_baseline', tracked: 'keystroke_tracked_normal_insert' },
            { name: 'Keystroke (Debug Insert)', baseline: 'keystroke_baseline', tracked: 'keystroke_tracked_debug_insert' },
            { name: 'Full Pipeline', baseline: 'keystroke_full_pipeline_baseline', tracked: 'keystroke_full_pipeline' },
            { name: 'Bulk Insert', baseline: 'bulk_insert_baseline', tracked: 'bulk_insert_tracked' },
            { name: 'Deletion', baseline: 'deletion_baseline', tracked: 'deletion_tracked' },
            { name: 'Debug Mode Toggle', baseline: 'debug_mode_toggle_baseline', tracked: 'debug_mode_toggle' },
            { name: 'Insert Mode Toggle', baseline: 'insert_mode_toggle_baseline', tracked: 'insert_mode_toggle' },
        ];

        for (const pair of comparisonPairs) {
            const baselineStats = summaries[pair.baseline];
            const trackedStats = summaries[pair.tracked];
            
            if (baselineStats && trackedStats) {
                comparisons.push({
                    name: pair.name,
                    baselineMean: baselineStats.mean,
                    trackedMean: trackedStats.mean,
                    overheadMs: trackedStats.mean - baselineStats.mean,
                    overheadPercent: ((trackedStats.mean / baselineStats.mean) - 1) * 100
                });
            } else {
                // Log missing data for debugging
                if (!baselineStats) {
                    console.warn(`[PerformanceTestFramework] Missing baseline for "${pair.name}": ${pair.baseline}`);
                }
                if (!trackedStats) {
                    console.warn(`[PerformanceTestFramework] Missing tracked for "${pair.name}": ${pair.tracked}`);
                }
            }
        }

        const fileSizeScaling: FileSizeComparison[] = [];
        const labels = [
            '100_lines_8K', '500_lines_40K', '1K_lines_80K', '5K_lines_400K', '10K_lines_800K',
            '500_lines_10K_short', '500_lines_60K_long', '500_lines_100K_verylong',
            '1K_lines_40K_narrow', '200_lines_40K_wide'
        ];
        
        for (const label of labels) {
            const baseline = summaries[`baseline_${label}`];
            const normal = summaries[`tracked_normal_${label}`];
            const debug = summaries[`tracked_debug_${label}`];
            const highlight = summaries[`highlight_render_${label}`];
            const toggle = summaries[`debug_toggle_${label}`];
            const fileOpenBaseline = summaries[`file_open_baseline_${label}`];
            const fileOpenTracked = summaries[`file_open_tracked_${label}`];

            if (baseline && normal && debug) {
                // Extract metrics from result metadata
                const sampleResult = this.results.find(r => r.operation === `baseline_${label}`);
                const meta = sampleResult?.metadata as Record<string, number> | undefined;

                fileSizeScaling.push({
                    label,
                    lineCount: meta?.lineCount ?? 0,
                    charsPerLine: meta?.charsPerLine ?? 80,
                    totalChars: meta?.totalChars ?? 0,
                    baselineMean: baseline.mean,
                    normalInsertMean: normal.mean,
                    debugInsertMean: debug.mean,
                    normalOverheadMs: normal.mean - baseline.mean,
                    normalOverheadPercent: ((normal.mean / baseline.mean) - 1) * 100,
                    debugOverheadMs: debug.mean - baseline.mean,
                    debugOverheadPercent: ((debug.mean / baseline.mean) - 1) * 100,
                    highlightRenderMs: highlight?.mean,
                    debugToggleMs: toggle?.mean,
                    fileOpenBaselineMs: fileOpenBaseline?.mean,
                    fileOpenTrackedMs: fileOpenTracked?.mean
                });
            }
        }

        return {
            testName,
            timestamp: new Date(),
            environment: {
                vscodeVersion: vscode.version,
                platform: process.platform,
                ...environment
            },
            results: this.results,
            summaries,
            overheads: comparisons,
            fileSizeScaling
        };
    }

    /**
     * Save report to disk
     */
    public saveReport(report: PerformanceReport): string {
        const filename = `${report.testName}_${Date.now()}.json`;
        const filepath = path.join(this.outputDir, filename);
        fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
        return filepath;
    }

    /**
     * Print a formatted summary to console
     */
    public printSummary(report: PerformanceReport): void {
        console.log('\n========== PERFORMANCE SUMMARY ==========\n');
        
        for (const [operation, stats] of Object.entries(report.summaries)) {
            console.log(`📊 ${operation} (n=${stats.count})`);
            console.log(`   Mean:   ${stats.mean.toFixed(3)} ms`);
            console.log(`   Median: ${stats.median.toFixed(3)} ms`);
            console.log(`   P95:    ${stats.p95.toFixed(3)} ms`);
            console.log(`   P99:    ${stats.p99.toFixed(3)} ms`);
            console.log(`   Min:    ${stats.min.toFixed(3)} ms`);
            console.log(`   Max:    ${stats.max.toFixed(3)} ms`);
            console.log(`   StdDev: ${stats.stdDev.toFixed(3)} ms`);
            console.log('');
        }
        
        console.log('==========================================\n');
    }

    /**
     * Clear results
     */
    public clear(): void {
        this.results = [];
    }
}