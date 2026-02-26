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
            { name: 'Bulk Insert', baseline: 'bulk_insert_baseline', tracked: 'bulk_insert_tracked' },
            { name: 'Deletion', baseline: 'deletion_baseline', tracked: 'deletion_tracked' },
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
            overheads: comparisons
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