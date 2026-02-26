import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PerformanceTestFramework } from './PerformanceTestFramework';
import { KeystrokeLatencyTest } from './suite/KeystrokeLatencyTest';
import { ModeToggleTest } from './suite/ModeToggleTest';
import { ScalabilityTest } from './suite/ScalabilityTest';
import { UndoRedoTest } from './suite/UndoRedoTest';
import { GitIntegrationTest } from './suite/GitIntegrationTest';
import { saveAndCloseActiveEditor, saveAndCloseAllEditors} from './SaveAndClose';

import { MetadataManager } from '../MetadataManager';
import { HiddenCodeOverlay } from '../HiddenCodeOverlay';

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

    /**
     * Helper to safely get an active editor, re-opening if needed
     */
    async function ensureEditor(filePath: string): Promise<{ doc: vscode.TextDocument; editor: vscode.TextEditor }> {
        const doc = await vscode.workspace.openTextDocument(filePath);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        // Small delay to ensure editor is fully ready
        await new Promise(resolve => setTimeout(resolve, 100));
        return { doc, editor };
    }

    const filesToCleanup: string[] = [];
    const metadataDirsToCleanup: string[] = [];
    const testString = 'the quick brown fox jumps';
    const bulkText = 'x'.repeat(1000);

     // Define file paths upfront
    const baselineFile = path.join(testDir, 'baseline_untracked.txt');
    const trackedFile = path.join(testDir, 'tracked_test.ts');

    vscode.window.showInformationMessage('Starting performance tests...');

    try {
        const keystrokeTest = new KeystrokeLatencyTest(framework, metadataManager, overlayManager);
        const undoRedoTest = new UndoRedoTest(framework, metadataManager, overlayManager);
        const gitTest = new GitIntegrationTest(framework, metadataManager, overlayManager);

        // ============================================
        // CREATE TEST FILES
        // ============================================
        console.log('[Performance] Creating test files...');
        
        // Create baseline file with enough content for position tests
        const baselineContent = '// Baseline test - not tracked\n' + ('x'.repeat(80) + '\n').repeat(100);
        fs.writeFileSync(baselineFile, baselineContent);
        filesToCleanup.push(baselineFile);

        // Create tracked file with enough content for position tests
        const trackedContent = '// Tracked test file\n' + ('const x = 1;\n').repeat(100);
        fs.writeFileSync(trackedFile, trackedContent);
        filesToCleanup.push(trackedFile);
        metadataDirsToCleanup.push(path.join(testDir, '__debuggable__'));

        // ============================================
        // 1. BASELINE TESTS (Untracked file, no extension processing)
        // ============================================
        console.log('[Performance] === BASELINE TESTS (untracked file) ===');

        let { editor: baselineEditor, doc: baselineDoc } = await ensureEditor(baselineFile);

        // // Verify baseline is NOT tracked
        // const shouldTrackBaseline = metadataManager.shouldTrackFile(baselineDoc.uri);
        // console.log(`[Performance] Baseline tracking check: ${shouldTrackBaseline ? '❌ TRACKED (BAD!)' : '✅ NOT TRACKED (GOOD)'}`);

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

        console.log('[Performance] Running undo baseline...');
        await undoRedoTest.runUndoBaselineTest(baselineEditor, 20);

        console.log('[Performance] Running redo baseline...');
        await undoRedoTest.runRedoBaselineTest(baselineEditor, 20);

        console.log('[Performance] Running bulk undo baseline...');
        await undoRedoTest.runBulkUndoTest(baselineEditor, false, 10, 5);

        // Close baseline editor
        await saveAndCloseActiveEditor();

        // ============================================
        // 2. TRACKED TESTS (With extension processing)
        // ============================================
        console.log('[Performance] === TRACKED TESTS (with extension) ===');

        let { editor: trackedEditor, doc: trackedDoc } = await ensureEditor(trackedFile);

        console.log('[Performance] Tracked file created at:', trackedFile);
        console.log('[Performance] File is in workspace:', vscode.workspace.getWorkspaceFolder(trackedDoc.uri)?.uri.fsPath);

        // Initialize tracking for this file
        await metadataManager.ensureLedgerForDoc(trackedDoc);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify metadata was created
        const expectedMetadataPath = path.join(testDir, '__debuggable__', 'tracked_test.ts.json');
        console.log('[Performance] Expected metadata at:', expectedMetadataPath);
        
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

        console.log('[Performance] Running redo tracked...');
        await undoRedoTest.runRedoTrackedTest(trackedEditor, 20);

        console.log('[Performance] Running bulk undo tracked...');
        await undoRedoTest.runBulkUndoTest(trackedEditor, true, 10, 5);

        console.log('[Performance] Running debug code undo/redo test...');
        await undoRedoTest.runDebugCodeUndoRedoTest(trackedEditor, 10);

        // Close tracked editor
        await saveAndCloseActiveEditor();

        // ============================================
        // 3. POSITION-BASED TESTS
        // ============================================
        console.log('[Performance] === POSITION-BASED TESTS ===');
        
        // // Close all editors first to ensure clean state
        await saveAndCloseAllEditors();

        // Re-open both files fresh
        const baselineDocForPosition = await vscode.workspace.openTextDocument(baselineFile);
        const trackedDocForPosition = await vscode.workspace.openTextDocument(trackedFile);

        // Run position comparison with fresh editors
        console.log('[Performance] Running position comparison tests...');
        await keystrokeTest.runPositionComparisonTest(baselineDocForPosition, trackedDocForPosition, testString, 2);

        // Clean up editors
        await saveAndCloseAllEditors();

        // ============================================
        // 4. MODE TOGGLE TESTS
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
        // 5. SCALABILITY TESTS
        // ============================================
        console.log('[Performance] === SCALABILITY TESTS ===');
        const scalabilityTest = new ScalabilityTest(framework, metadataManager, overlayManager);
        
        const scalabilityFiles = await scalabilityTest.runFileSizeComparisonTest(testDir);
        filesToCleanup.push(...scalabilityFiles);

        // ============================================
        // 6. SEGMENT COUNT TESTS
        // ============================================
        console.log('[Performance] === SEGMENT COUNT TESTS ===');
        
        const segmentFiles = await scalabilityTest.runSegmentCountTest(testDir);
        filesToCleanup.push(...segmentFiles);

        // ============================================
        // 7. GIT INTEGRATION TESTS
        // ============================================
        console.log('[Performance] === GIT INTEGRATION TESTS ===');
        await gitTest.runAllGitTests(testDir);

        // ============================================
        // VERIFICATION: Check what metadata files exist
        // ============================================
        console.log('\n[Performance] === METADATA FILE VERIFICATION ===');
        const metadataDir = path.join(testDir, '__debuggable__');
        if (fs.existsSync(metadataDir)) {
            const metadataFiles = fs.readdirSync(metadataDir);
            console.log(`[Performance] Metadata files created: ${metadataFiles.length}`);
            
            const baselineMetaFiles = metadataFiles.filter(f => f.includes('baseline'));
            const trackedMetaFiles = metadataFiles.filter(f => !f.includes('baseline'));
            
            if (baselineMetaFiles.length > 0) {
                console.error('[Performance] ❌ PROBLEM: Baseline files generated metadata:');
                baselineMetaFiles.forEach(f => console.error(`   - ${f}`));
                console.error('[Performance] This means baseline measurements may be contaminated!');
            } else {
                console.log('[Performance] ✅ No baseline files generated metadata (correct)');
            }
            
            console.log(`[Performance] Tracked files with metadata: ${trackedMetaFiles.length}`);
            trackedMetaFiles.forEach(f => console.log(`   - ${f}`));
        } else {
            console.log('[Performance] No metadata directory found');
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
        printUndoRedoComparison(report);
        printGitComparison(report);
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

/**
 * Print position-based comparison
 */
function printPositionComparison(report: any): void {
    console.log('\n========== POSITION-BASED COMPARISON ==========\n');

    const positions = ['start', 'middle', 'end'];
    
    console.log('┌───────────┬────────────┬────────────────┬───────────────┬────────────────┐');
    console.log('│ Position  │ Baseline   │ Normal Insert  │ Debug Insert  │ Overhead       │');
    console.log('├───────────┼────────────┼────────────────┼───────────────┼────────────────┤');

    for (const pos of positions) {
        const baseline = report.summaries[`keystroke_baseline_${pos}`];
        const normal = report.summaries[`keystroke_tracked_normal_${pos}`];
        const debug = report.summaries[`keystroke_tracked_debug_${pos}`];

        if (baseline && normal && debug) {
            const baselineMs = baseline.mean.toFixed(2).padEnd(10);
            const normalMs = normal.mean.toFixed(2).padEnd(14);
            const debugMs = debug.mean.toFixed(2).padEnd(13);
            const overhead = `+${(normal.mean - baseline.mean).toFixed(2)}ms`.padEnd(14);

            console.log(`│ ${pos.padEnd(9)} │ ${baselineMs} │ ${normalMs} │ ${debugMs} │ ${overhead} │`);
        } else {
            console.log(`│ ${pos.padEnd(9)} │ N/A        │ N/A            │ N/A           │ N/A            │`);
        }
    }

    console.log('└───────────┴────────────┴────────────────┴───────────────┴────────────────┘');

    // Calculate average across positions
    let totalBaseline = 0, totalNormal = 0, totalDebug = 0, count = 0;
    for (const pos of positions) {
        const baseline = report.summaries[`keystroke_baseline_${pos}`];
        const normal = report.summaries[`keystroke_tracked_normal_${pos}`];
        const debug = report.summaries[`keystroke_tracked_debug_${pos}`];
        if (baseline && normal && debug) {
            totalBaseline += baseline.mean;
            totalNormal += normal.mean;
            totalDebug += debug.mean;
            count++;
        }
    }

    if (count > 0) {
        const avgBaseline = totalBaseline / count;
        const avgNormal = totalNormal / count;
        const avgDebug = totalDebug / count;
        console.log(`\nAverage across positions:`);
        console.log(`  Baseline: ${avgBaseline.toFixed(2)}ms`);
        console.log(`  Normal:   ${avgNormal.toFixed(2)}ms (overhead: +${(avgNormal - avgBaseline).toFixed(2)}ms)`);
        console.log(`  Debug:    ${avgDebug.toFixed(2)}ms (overhead: +${(avgDebug - avgBaseline).toFixed(2)}ms)`);
    }

    console.log('\n================================================\n');
}

/**
 * Print undo/redo comparison
 */
function printUndoRedoComparison(report: any): void {
    console.log('\n========== UNDO/REDO COMPARISON ==========\n');

    const comparisons = [
        { name: 'Single Undo', baseline: 'undo_baseline', tracked: 'undo_tracked' },
        { name: 'Single Redo', baseline: 'redo_baseline', tracked: 'redo_tracked' },
        { name: 'Bulk Undo (10 edits)', baseline: 'bulk_undo_baseline', tracked: 'bulk_undo_tracked' },
        { name: 'Debug Code Undo', baseline: 'undo_baseline', tracked: 'undo_debug_code' },
        { name: 'Debug Code Redo', baseline: 'redo_baseline', tracked: 'redo_debug_code' },
    ];

    for (const comp of comparisons) {
        const baseline = report.summaries[comp.baseline];
        const tracked = report.summaries[comp.tracked];

        if (baseline && tracked) {
            const overhead = tracked.mean - baseline.mean;
            const overheadPct = ((tracked.mean / baseline.mean) - 1) * 100;

            console.log(`📊 ${comp.name}`);
            console.log(`   Baseline: ${baseline.mean.toFixed(3)} ms (n=${baseline.count})`);
            console.log(`   Tracked:  ${tracked.mean.toFixed(3)} ms (n=${tracked.count})`);
            console.log(`   Overhead: ${overhead >= 0 ? '+' : ''}${overhead.toFixed(3)} ms (${overheadPct >= 0 ? '+' : ''}${overheadPct.toFixed(1)}%)`);
            console.log('');
        } else {
            console.log(`⚠️  ${comp.name}: Missing data`);
        }
    }

    console.log('==========================================\n');
}

/**
 * Print git integration results
 */
function printGitComparison(report: any): void {
    console.log('\n========== GIT INTEGRATION ==========\n');

    const gitOps = [
        { name: 'Git Status (baseline)', key: 'git_status_baseline' },
        { name: 'Git Status (with metadata)', key: 'git_status_with_metadata' },
        { name: 'Git Add', key: 'git_add_tracked_file' },
        { name: 'Git Diff', key: 'git_diff_with_changes' },
    ];

    for (const op of gitOps) {
        const stats = report.summaries[op.key];
        if (stats) {
            console.log(`📊 ${op.name}: ${stats.mean.toFixed(3)} ms (n=${stats.count})`);
        }
    }

    // Compare status baseline vs with metadata
    const statusBaseline = report.summaries['git_status_baseline'];
    const statusWithMeta = report.summaries['git_status_with_metadata'];
    if (statusBaseline && statusWithMeta) {
        const overhead = statusWithMeta.mean - statusBaseline.mean;
        console.log(`\nGit status overhead from metadata files: ${overhead >= 0 ? '+' : ''}${overhead.toFixed(3)} ms`);
        
        if (overhead < 1) {
            console.log('✅ Negligible impact on git operations');
        } else if (overhead < 5) {
            console.log('👍 Minor impact on git operations');
        } else {
            console.log('⚠️  Consider optimizing metadata file count');
        }
    }

    // Check .gitignore result
    const gitIgnoreResult = report.results.find((r: any) => r.operation === 'git_ignore_test');
    if (gitIgnoreResult?.metadata) {
        const { passed, message } = gitIgnoreResult.metadata;
        console.log(`\n.gitignore test: ${passed ? '✅' : '❌'} ${message}`);
    }

    console.log('\n======================================\n');
}


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