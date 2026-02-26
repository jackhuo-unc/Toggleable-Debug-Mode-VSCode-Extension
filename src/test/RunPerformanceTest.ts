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

export async function runAllPerformanceTests(
    context: vscode.ExtensionContext,
    metadataManager: MetadataManager,
    overlayManager: HiddenCodeOverlay
): Promise<void> {
    const outputDir = path.join(context.extensionPath, 'performance-reports');
    const framework = new PerformanceTestFramework(outputDir);

    const testDir = path.join(context.extensionPath, 'test-files');
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    const filesToCleanup: string[] = [];
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

        // Initialize tracking for this file
        await metadataManager.ensureLedgerForDoc(trackedDoc);

        // Keystroke in normal insert mode
        console.log('[Performance] Running tracked keystroke (normal insert)...');
        await keystrokeTest.runTrackedTest(trackedEditor, testString, false, 3);

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
        await modeToggleTest.runToggleTest(20);
        await modeToggleTest.runInsertModeToggleTest(20);

        // ============================================
        // 4. SCALABILITY TESTS
        // ============================================
        console.log('[Performance] === SCALABILITY TESTS ===');
        const scalabilityTest = new ScalabilityTest(framework, metadataManager, overlayManager);
        
        const scalabilityFiles = await scalabilityTest.runFileSizeTest(testDir);
        filesToCleanup.push(...scalabilityFiles);
        
        const segmentFiles = await scalabilityTest.runSegmentCountTest(testDir);
        filesToCleanup.push(...segmentFiles);

        // ============================================
        // GENERATE REPORT
        // ============================================
        const report = framework.generateReport('full_performance_suite');
        const reportPath = framework.saveReport(report);

        // Print summary with comparisons
        framework.printSummary(report);
        printComparison(report);

        vscode.window.showInformationMessage(`Performance tests complete! Report saved to: ${reportPath}`);

    } catch (err) {
        console.error('[Performance] Test failed:', err);
        vscode.window.showErrorMessage(`Performance test failed: ${err}`);
    } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise(resolve => setTimeout(resolve, 500));

        for (const file of filesToCleanup) {
            await safeDeleteFile(file);
        }

        try {
            const remaining = fs.readdirSync(testDir);
            if (remaining.length === 0) {
                fs.rmdirSync(testDir);
            }
        } catch {
            // Ignore
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
            name: 'Bulk Insert (1000 chars)',
            baseline: 'bulk_insert_baseline',
            tracked: 'bulk_insert_tracked'
        },
        {
            name: 'Deletion',
            baseline: 'deletion_baseline',
            tracked: 'deletion_tracked'
        }
    ];

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
            console.log(`⚠️  ${comparison.name}: Missing data`);
            console.log(`   Baseline (${comparison.baseline}): ${baselineStats ? 'OK' : 'MISSING'}`);
            console.log(`   Tracked (${comparison.tracked}): ${trackedStats ? 'OK' : 'MISSING'}`);
            console.log('');
        }
    }

    // Debug insert mode comparison
    const normalInsert = report.summaries['keystroke_tracked_normal_insert'];
    const debugInsert = report.summaries['keystroke_tracked_debug_insert'];
    
    if (normalInsert && debugInsert) {
        const diff = debugInsert.mean - normalInsert.mean;
        console.log(`📊 Debug vs Normal Insert Mode`);
        console.log(`   Normal Insert: ${normalInsert.mean.toFixed(3)} ms`);
        console.log(`   Debug Insert:  ${debugInsert.mean.toFixed(3)} ms`);
        console.log(`   Difference:    ${diff > 0 ? '+' : ''}${diff.toFixed(3)} ms`);
        console.log('');
    }

    console.log('==========================================\n');
}