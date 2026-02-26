import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PerformanceTestFramework } from './PerformanceTestFramework';
import { KeystrokeLatencyTest } from './suite/KeystrokeLatencyTest';
import { ModeToggleTest } from './suite/ModeToggleTest';
import { ScalabilityTest } from './suite/ScalabilityTest';
import { MetadataManager } from '../MetadataManager';
import { HiddenCodeOverlay } from '../HiddenCodeOverlay';

async function safeDeleteFile(filePath: string, retries: number = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
        try {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            return;
        } catch (err) {
            if (i === retries - 1) {
                console.warn(`[Performance] Could not delete ${filePath}: ${err}`);
            }
        }
    }
}

/**
 * Get the test directory in the ACTIVE WORKSPACE (not extension path)
 */
function getTestDirectory(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.error('[Performance] No workspace folder open!');
        return undefined;
    }

    // Use the first workspace folder
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const testDir = path.join(workspaceRoot, '.performance-tests');
    
    console.log('[Performance] Workspace root:', workspaceRoot);
    console.log('[Performance] Test directory:', testDir);
    
    return testDir;
}

/**
 * Get the output directory for reports (can stay in extension path)
 */
function getReportDirectory(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, 'performance-reports');
}

export async function runAllPerformanceTests(
    context: vscode.ExtensionContext,
    metadataManager: MetadataManager,
    overlayManager: HiddenCodeOverlay
): Promise<void> {
    const outputDir = getReportDirectory(context);
    const framework = new PerformanceTestFramework(outputDir);

    const testDir = getTestDirectory();
    if (!testDir) {
        vscode.window.showErrorMessage('Performance tests require an open workspace folder.');
        return;
    }
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    const filesToCleanup: string[] = [];
    const metadataDirsToCleanup: string[] = [];
    const testString = 'the quick brown fox jumps';
    const bulkText = 'x'.repeat(1000);

    vscode.window.showInformationMessage('Starting performance tests...');

    try {
        const keystrokeTest = new KeystrokeLatencyTest(framework, metadataManager, overlayManager);

        // ============================================
        // 1. BASELINE TESTS (Untracked file, no extension processing)
        // ============================================
        console.log('[Performance] === BASELINE TESTS (untracked file) ===');
        
        // Create an untracked file (outside of tracked directory or with no metadata)
        const baselineFile = path.join(testDir, 'baseline_untracked.txt');
        fs.writeFileSync(baselineFile, '// Baseline test - not tracked\n');
        filesToCleanup.push(baselineFile);

        const baselineDoc = await vscode.workspace.openTextDocument(baselineFile);
        const baselineEditor = await vscode.window.showTextDocument(baselineDoc);

        // Keystroke baseline
        console.log('[Performance] Running keystroke baseline...');
        await keystrokeTest.runBaselineTest(baselineEditor, testString, 3);

        // Bulk insert baseline
        console.log('[Performance] Running bulk insert baseline...');
        await keystrokeTest.runBulkInsertTest(baselineEditor, bulkText, false, 10);

        // Deletion baseline
        console.log('[Performance] Running deletion baseline...');
        await keystrokeTest.runDeletionTest(baselineEditor, false, 20);

        console.log('[Performance] Running full pipeline baseline...');
        await keystrokeTest.runFullPipelineBaselineTest(baselineEditor, testString, 1);

        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await new Promise(resolve => setTimeout(resolve, 300));

        // ============================================
        // 2. TRACKED TESTS (With extension processing)
        // ============================================
        console.log('[Performance] === TRACKED TESTS (with extension) ===');

        // Create a tracked file (with metadata)
        const trackedFile = path.join(testDir, 'tracked_test.ts');
        fs.writeFileSync(trackedFile, '// Tracked test file\n');
        filesToCleanup.push(trackedFile);

        const trackedDoc = await vscode.workspace.openTextDocument(trackedFile);
        const trackedEditor = await vscode.window.showTextDocument(trackedDoc);

        console.log('[Performance] Tracked file created at:', trackedFile);
        console.log('[Performance] File is in workspace:', vscode.workspace.getWorkspaceFolder(trackedDoc.uri)?.uri.fsPath);

        // Initialize tracking for this file
        await metadataManager.ensureLedgerForDoc(trackedDoc);

        // Verify metadata was created
        const expectedMetadataPath = path.join(testDir, '__debuggable__', 'tracked_test.ts.json');
        console.log('[Performance] Expected metadata at:', expectedMetadataPath);

        // Give it a moment to save
        await new Promise(resolve => setTimeout(resolve, 500));
        
        if (fs.existsSync(expectedMetadataPath)) {
            console.log('[Performance] ✅ Metadata file created successfully!');
            const content = fs.readFileSync(expectedMetadataPath, 'utf-8');
            console.log('[Performance] Metadata content:', content.substring(0, 200) + '...');
        } else {
            console.log('[Performance] ⚠️ Metadata file not found yet (may be debounced)');
        }

        // Keystroke in normal insert mode
        console.log('[Performance] Running tracked keystroke (normal insert)...');
        await keystrokeTest.runTrackedTest(trackedEditor, testString, false, 3);

        // Full pipeline test (measures total time including async)
        console.log('[Performance] Running full pipeline test...');
        await keystrokeTest.runFullPipelineTest(trackedEditor, testString, 1);

        // Switch to debug insert mode
        await overlayManager.toggleInsertMode();

        // Keystroke in debug insert mode
        console.log('[Performance] Running tracked keystroke (debug insert)...');
        await keystrokeTest.runTrackedTest(trackedEditor, testString, true, 3);

        // Reset to normal mode
        await overlayManager.toggleInsertMode();

        // Bulk insert tracked
        console.log('[Performance] Running bulk insert tracked...');
        await keystrokeTest.runBulkInsertTest(trackedEditor, bulkText, true, 10);

        // Deletion tracked
        console.log('[Performance] Running deletion tracked...');
        await keystrokeTest.runDeletionTest(trackedEditor, true, 20);

        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await new Promise(resolve => setTimeout(resolve, 300));

        // ============================================
        // 3. MODE TOGGLE TESTS
        // ============================================
        console.log('[Performance] === MODE TOGGLE TESTS ===');
        const modeToggleTest = new ModeToggleTest(framework, overlayManager);
        console.log('[Performance] Running debug mode toggle baseline...');
        await modeToggleTest.runToggleBaselineTest(20);
        console.log('[Performance] Running debug mode toggle...');
        await modeToggleTest.runToggleTest(20);
        console.log('[Performance] Running insert mode toggle baseline...');
        await modeToggleTest.runInsertModeToggleBaselineTest(20);
        console.log('[Performance] Running insert mode toggle...');
        await modeToggleTest.runInsertModeToggleTest(20);

        // ============================================
        // 4. SCALABILITY TESTS
        // ============================================
        console.log('[Performance] === SCALABILITY TESTS ===');
        const scalabilityTest = new ScalabilityTest(framework, metadataManager, overlayManager);
        
        const scalabilityFiles = await scalabilityTest.runFileSizeComparisonTest(testDir);
        filesToCleanup.push(...scalabilityFiles);

        // ============================================
        // 5. SEGMENT COUNT TESTS
        // ============================================
        console.log('[Performance] === SEGMENT COUNT TESTS ===');
        
        const segmentFiles = await scalabilityTest.runSegmentCountTest(testDir);
        filesToCleanup.push(...segmentFiles);

        // ============================================
        // Wait for all metadata saves to complete
        // ============================================
        console.log('[Performance] Waiting for metadata saves to complete...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // List all created metadata files
        const metadataDir = path.join(testDir, '__debuggable__');
        if (fs.existsSync(metadataDir)) {
            const metadataFiles = fs.readdirSync(metadataDir);
            console.log('[Performance] Metadata files created:', metadataFiles.length);
            metadataFiles.forEach(f => console.log('  -', f));
        }

        // ============================================
        // GENERATE REPORT
        // ============================================
        const report = framework.generateReport('full_performance_suite');
        const reportPath = framework.saveReport(report);

        // Print summary with comparisons
        framework.printSummary(report);
        printComparison(report);
        printFileSizeComparison(report);

        vscode.window.showInformationMessage(`Performance tests complete! Report saved to: ${reportPath}`);

    } catch (err) {
        console.error('[Performance] Test failed:', err);
        vscode.window.showErrorMessage(`Performance test failed: ${err}`);
    } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise(resolve => setTimeout(resolve, 500));

        // Ask user if they want to keep test files for inspection
        const keepFiles = await vscode.window.showQuickPick(['Delete test files', 'Keep test files for inspection'], {
            placeHolder: 'What to do with test files?'
        });

        if (keepFiles === 'Delete test files') {
            // Delete test files
            for (const file of filesToCleanup) {
                await safeDeleteFile(file);
            }

            // Delete metadata directories
            for (const dir of metadataDirsToCleanup) {
                try {
                    if (fs.existsSync(dir)) {
                        fs.rmSync(dir, { recursive: true });
                    }
                } catch (err) {
                    console.warn('[Performance] Could not delete metadata dir:', dir, err);
                }
            }

            // Try to remove test directory if empty
            try {
                if (fs.existsSync(testDir) && fs.readdirSync(testDir).length === 0) {
                    fs.rmdirSync(testDir);
                }
            } catch {
                // Ignore
            }
            
            console.log('[Performance] Test files cleaned up');
        } else {
            console.log('[Performance] Test files kept at:', testDir);
            vscode.window.showInformationMessage(`Test files kept at: ${testDir}`);
        }
    }
}

/**
 * Print comparison between baseline and tracked operations
 */
function printComparison(report: any): void {
    console.log('\n========== OVERHEAD COMPARISON ==========\n');

    const comparisons = [
        {
            name: 'Keystroke Latency',
            baseline: 'keystroke_baseline',
            tracked: 'keystroke_tracked_normal_insert'
        },
        {
            name: 'Keystroke (Debug Insert)',
            baseline: 'keystroke_baseline',
            tracked: 'keystroke_tracked_debug_insert'
        },
        {
            name: 'Full Pipeline',
            baseline: 'keystroke_full_pipeline_baseline',
            tracked: 'keystroke_full_pipeline'
        },
        {
            name: 'Bulk Insert (1000 chars)',
            baseline: 'bulk_insert_baseline',
            tracked: 'bulk_insert_tracked'
        },
        {
            name: 'Deletion',
            baseline: 'deletion_baseline',
            tracked: 'deletion_tracked'
        },
        {
            name: 'Debug Mode Toggle',
            baseline: 'debug_mode_toggle_baseline',
            tracked: 'debug_mode_toggle'
        },
        {
            name: 'Insert Mode Toggle',
            baseline: 'insert_mode_toggle_baseline',
            tracked: 'insert_mode_toggle'
        }
    ];

    let hasAllData = true;

    for (const comparison of comparisons) {
        const baselineStats = report.summaries[comparison.baseline];
        const trackedStats = report.summaries[comparison.tracked];

        if (baselineStats && trackedStats) {
            const overheadMs = trackedStats.mean - baselineStats.mean;
            const overheadPercent = ((trackedStats.mean / baselineStats.mean) - 1) * 100;

            console.log(`📊 ${comparison.name}`);
            console.log(`   Baseline:  ${baselineStats.mean.toFixed(3)} ms (median: ${baselineStats.median.toFixed(3)} ms)`);
            console.log(`   Tracked:   ${trackedStats.mean.toFixed(3)} ms (median: ${trackedStats.median.toFixed(3)} ms)`);
            console.log(`   Overhead:  +${overheadMs.toFixed(3)} ms (+${overheadPercent.toFixed(1)}%)`);
            console.log('');
        } else {
            hasAllData = false;
            console.log(`⚠️  ${comparison.name}: Missing data`);
            console.log(`   Baseline (${comparison.baseline}): ${baselineStats ? 'OK' : 'MISSING'}`);
            console.log(`   Tracked (${comparison.tracked}): ${trackedStats ? 'OK' : 'MISSING'}`);
            console.log('');
        }
    }

    // Full pipeline (if measured)
    const fullPipeline = report.summaries['keystroke_full_pipeline'];
    const baseline = report.summaries['keystroke_baseline'];
    if (fullPipeline && baseline) {
        console.log(`📊 Full Pipeline (including async)`);
        console.log(`   Baseline:      ${baseline.mean.toFixed(3)} ms`);
        console.log(`   Full Pipeline: ${fullPipeline.mean.toFixed(3)} ms`);
        console.log(`   Note: Full pipeline includes debounced saves - not user-perceived`);
        console.log('');
    }

    // Rating
    const syncOverhead = report.summaries['keystroke_tracked_normal_insert'];
    if (syncOverhead && baseline) {
        const overhead = syncOverhead.mean - baseline.mean;
        let rating = '';
        if (overhead < 5) {
            rating = '✅ EXCELLENT (< 5ms overhead)';
        } else if (overhead < 15) {
            rating = '👍 GOOD (< 15ms overhead)';
        } else if (overhead < 30) {
            rating = '⚠️  ACCEPTABLE (< 30ms overhead)';
        } else if (overhead < 50) {
            rating = '🔶 NEEDS OPTIMIZATION (< 50ms overhead)';
        } else {
            rating = '🔴 POOR (> 50ms overhead) - impacts typing experience';
        }
        console.log(`Overall Rating: ${rating}`);
        console.log('');
    }

    // Diagnostic: list all available summaries
    if (!hasAllData) {
        console.log('\n--- Available Summaries (for debugging) ---');
        const availableOps = Object.keys(report.summaries).sort();
        console.log('Operations recorded:', availableOps.length);
        availableOps.forEach(op => {
            const stats = report.summaries[op];
            console.log(`  - ${op}: n=${stats.count}, mean=${stats.mean.toFixed(3)}ms`);
        });
    }

    console.log('\n==========================================\n');
}

/**
 * Print file-size-based comparison with both lines and chars
 */
function printFileSizeComparison(report: any): void {
    console.log('\n========== FILE SIZE SCALING ==========\n');

    if (!report.fileSizeScaling || report.fileSizeScaling.length === 0) {
        console.log('No file size scaling data available.');
        return;
    }

    // Sort by total chars for display
    const sorted = [...report.fileSizeScaling].sort((a: any, b: any) => a.totalChars - b.totalChars);

    console.log('--- Keystroke Overhead by File Size ---\n');
    console.log('┌──────────────────────────┬─────────┬───────────┬──────────┬────────────┬────────────┬────────────┬────────────┐');
    console.log('│ Config                   │ Lines   │ Chars/Line│ Total KB │ Baseline   │ Normal     │ Debug      │ Overhead   │');
    console.log('├──────────────────────────┼─────────┼───────────┼──────────┼────────────┼────────────┼────────────┼────────────┤');

    for (const entry of sorted) {
        const label = entry.label.substring(0, 24).padEnd(24);
        const lines = String(entry.lineCount).padEnd(7);
        const cpl = String(entry.charsPerLine).padEnd(9);
        const kb = (entry.totalChars / 1024).toFixed(1).padEnd(8);
        const baseline = entry.baselineMean.toFixed(2).padEnd(10);
        const normal = entry.normalInsertMean.toFixed(2).padEnd(10);
        const debug = entry.debugInsertMean.toFixed(2).padEnd(10);
        const overhead = `+${entry.normalOverheadMs.toFixed(2)}ms`.padEnd(10);

        console.log(`│ ${label} │ ${lines} │ ${cpl} │ ${kb} │ ${baseline} │ ${normal} │ ${debug} │ ${overhead} │`);
    }

    console.log('└──────────────────────────┴─────────┴───────────┴──────────┴────────────┴────────────┴────────────┴────────────┘');

    // Compare same total chars, different structures
    console.log('\n--- Same Size, Different Structure (40KB) ---\n');
    const same40K = sorted.filter((e: any) => e.totalChars >= 38000 && e.totalChars <= 42000);
    if (same40K.length > 1) {
        console.log('┌──────────────────────────┬─────────┬───────────┬────────────┬────────────┐');
        console.log('│ Config                   │ Lines   │ Chars/Line│ Baseline   │ Overhead   │');
        console.log('├──────────────────────────┼─────────┼───────────┼────────────┼────────────┤');
        for (const entry of same40K) {
            const label = entry.label.substring(0, 24).padEnd(24);
            const lines = String(entry.lineCount).padEnd(7);
            const cpl = String(entry.charsPerLine).padEnd(9);
            const baseline = entry.baselineMean.toFixed(2).padEnd(10);
            const overhead = `+${entry.normalOverheadMs.toFixed(2)}ms`.padEnd(10);
            console.log(`│ ${label} │ ${lines} │ ${cpl} │ ${baseline} │ ${overhead} │`);
        }
        console.log('└──────────────────────────┴─────────┴───────────┴────────────┴────────────┘');
        console.log('Note: This shows whether line count or char count affects performance more.\n');
    }

    // Debug toggle and highlight render times
    console.log('--- Other Operations by File Size ---\n');
    console.log('┌──────────────────────────┬──────────┬────────────────┬────────────────┬──────────────────┐');
    console.log('│ Config                   │ Total KB │ Highlight (ms) │ Dbg Toggle (ms)│ File Open OH (ms)│');
    console.log('├──────────────────────────┼──────────┼────────────────┼────────────────┼──────────────────┤');

    for (const entry of sorted) {
        const label = entry.label.substring(0, 24).padEnd(24);
        const kb = (entry.totalChars / 1024).toFixed(1).padEnd(8);
        const highlight = entry.highlightRenderMs !== undefined 
            ? entry.highlightRenderMs.toFixed(3).padEnd(14) 
            : 'N/A'.padEnd(14);
        const toggle = entry.debugToggleMs !== undefined 
            ? entry.debugToggleMs.toFixed(2).padEnd(14) 
            : 'N/A'.padEnd(14);
        
        let fileOpenOH = 'N/A'.padEnd(16);
        if (entry.fileOpenBaselineMs !== undefined && entry.fileOpenTrackedMs !== undefined) {
            const oh = entry.fileOpenTrackedMs - entry.fileOpenBaselineMs;
            fileOpenOH = `+${oh.toFixed(3)}`.padEnd(16);
        }

        console.log(`│ ${label} │ ${kb} │ ${highlight} │ ${toggle} │ ${fileOpenOH} │`);
    }

    console.log('└──────────────────────────┴──────────┴────────────────┴────────────────┴──────────────────┘');

    // Summary insights
    console.log('\n--- Scaling Analysis ---\n');
    
    if (sorted.length >= 2) {
        const smallest = sorted[0];
        const largest = sorted[sorted.length - 1];
        const sizeRatio = largest.totalChars / smallest.totalChars;
        const overheadRatio = largest.normalOverheadMs / smallest.normalOverheadMs;

        console.log(`File size range: ${(smallest.totalChars / 1024).toFixed(1)}KB → ${(largest.totalChars / 1024).toFixed(1)}KB (${sizeRatio.toFixed(1)}x)`);
        console.log(`Overhead range:  +${smallest.normalOverheadMs.toFixed(2)}ms → +${largest.normalOverheadMs.toFixed(2)}ms (${overheadRatio.toFixed(1)}x)`);
        
        if (overheadRatio < sizeRatio * 0.5) {
            console.log('✅ Overhead scales SUB-LINEARLY with file size (excellent!)');
        } else if (overheadRatio < sizeRatio) {
            console.log('👍 Overhead scales LESS than file size (good)');
        } else if (overheadRatio < sizeRatio * 1.5) {
            console.log('⚠️  Overhead scales LINEARLY with file size');
        } else {
            console.log('🔴 Overhead scales SUPER-LINEARLY with file size (needs optimization)');
        }
    }

    console.log('\n==========================================\n');
}