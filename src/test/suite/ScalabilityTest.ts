import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { MetadataManager } from '../../MetadataManager';
import { HiddenCodeOverlay } from '../../HiddenCodeOverlay';

export interface FileSizeConfig {
    lineCount: number;
    charsPerLine: number;
    totalChars: number;  // Computed
    label: string;       // Human-readable label
}

export class ScalabilityTest {
    private framework: PerformanceTestFramework;
    private metadataManager: MetadataManager;
    private overlayManager: HiddenCodeOverlay;

    constructor(
        framework: PerformanceTestFramework,
        metadataManager: MetadataManager,
        overlayManager: HiddenCodeOverlay
    ) {
        this.framework = framework;
        this.metadataManager = metadataManager;
        this.overlayManager = overlayManager;
    }

    /**
     * Get test configurations for different file sizes
     * Tests both line count and character count variations
     */
    private getFileSizeConfigs(): FileSizeConfig[] {
        return [
            // Varying line count (fixed chars per line ~80)
            { lineCount: 100, charsPerLine: 80, totalChars: 8000, label: '100_lines_8K' },
            { lineCount: 500, charsPerLine: 80, totalChars: 40000, label: '500_lines_40K' },
            { lineCount: 1000, charsPerLine: 80, totalChars: 80000, label: '1K_lines_80K' },
            { lineCount: 5000, charsPerLine: 80, totalChars: 400000, label: '5K_lines_400K' },
            { lineCount: 10000, charsPerLine: 80, totalChars: 800000, label: '10K_lines_800K' },
            
            // Varying chars per line (fixed line count = 500)
            { lineCount: 500, charsPerLine: 20, totalChars: 10000, label: '500_lines_10K_short' },
            { lineCount: 500, charsPerLine: 120, totalChars: 60000, label: '500_lines_60K_long' },
            { lineCount: 500, charsPerLine: 200, totalChars: 100000, label: '500_lines_100K_verylong' },
            
            // Same total chars, different structures
            { lineCount: 1000, charsPerLine: 40, totalChars: 40000, label: '1K_lines_40K_narrow' },
            { lineCount: 200, charsPerLine: 200, totalChars: 40000, label: '200_lines_40K_wide' },
        ];
    }

    /**
     * Generate test file with specified characteristics
     */
    public generateTestFile(
        outputPath: string,
        options: {
            lineCount: number;
            debugSegmentCount: number;
            charsPerLine?: number;
        }
    ): { path: string; actualChars: number } {
        const { lineCount, debugSegmentCount, charsPerLine = 80 } = options;
        const lines: string[] = [];
        const debugInterval = debugSegmentCount > 0 ? Math.floor(lineCount / debugSegmentCount) : 0;

        for (let i = 0; i < lineCount; i++) {
            const isDebugLine = debugSegmentCount > 0 && debugInterval > 0 && i % debugInterval === 0;
            const prefix = isDebugLine ? '// DEBUG: ' : '';
            const content = prefix + 'x'.repeat(Math.max(0, charsPerLine - prefix.length));
            lines.push(content);
        }

        const content = lines.join('\n');
        fs.writeFileSync(outputPath, content);
        return { path: outputPath, actualChars: content.length };
    }

    /**
     * Comprehensive file size test with baseline comparisons
     * Tests across multiple dimensions: line count AND character count
     */
    public async runFileSizeComparisonTest(testDir: string): Promise<string[]> {
        const configs = this.getFileSizeConfigs();
        const testString = 'abcdefghij';
        const createdFiles: string[] = [];

        // Track metadata directory
        const metadataDir = path.join(testDir, '__debuggable__');

        for (const config of configs) {
            console.log(`[ScalabilityTest] Testing: ${config.label} (${config.lineCount} lines, ~${config.totalChars} chars)`);

            // ============================================
            // BASELINE TEST (untracked file - .txt extension)
            // ============================================
            const baselineFile = path.join(testDir, `baseline_${config.label}.txt`);
            const baselineContent = ('x'.repeat(config.charsPerLine) + '\n').repeat(config.lineCount);
            fs.writeFileSync(baselineFile, baselineContent);
            const actualBaselineChars = baselineContent.length;
            createdFiles.push(baselineFile);

            try {
                const baselineDoc = await vscode.workspace.openTextDocument(baselineFile);
                const baselineEditor = await vscode.window.showTextDocument(baselineDoc);

                // Verify it's in workspace
                const wsFolder = vscode.workspace.getWorkspaceFolder(baselineDoc.uri);
                if (!wsFolder) {
                    console.error(`[ScalabilityTest] Baseline file not in workspace: ${baselineFile}`);
                    continue;
                }

                // Baseline keystrokes
                for (const char of testString + testString) {
                    await this.framework.measure(
                        `baseline_${config.label}`,
                        async () => {
                            const pos = baselineEditor.selection.active;
                            await baselineEditor.edit(eb => eb.insert(pos, char));
                        },
                        { 
                            lineCount: config.lineCount, 
                            charsPerLine: config.charsPerLine,
                            totalChars: actualBaselineChars,
                            label: config.label,
                            type: 'baseline' 
                        }
                    );
                    await new Promise(resolve => setTimeout(resolve, 5));
                }

                // Baseline file open
                await this.framework.measure(
                    `file_open_baseline_${config.label}`,
                    async () => {
                        await vscode.workspace.openTextDocument(baselineFile);
                    },
                    { lineCount: config.lineCount, totalChars: actualBaselineChars, label: config.label }
                );

                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (err) {
                console.error(`[ScalabilityTest] Baseline error for ${config.label}:`, err);
            }

            // ============================================
            // TRACKED TEST (with extension - .ts extension)
            // ============================================
            const trackedFile = path.join(testDir, `tracked_${config.label}.ts`);
            const { actualChars } = this.generateTestFile(trackedFile, { 
                lineCount: config.lineCount, 
                debugSegmentCount: 10,
                charsPerLine: config.charsPerLine
            });
            createdFiles.push(trackedFile);

            try {
                const trackedDoc = await vscode.workspace.openTextDocument(trackedFile);
                const trackedEditor = await vscode.window.showTextDocument(trackedDoc);

                // Verify it's in workspace
                const wsFolder = vscode.workspace.getWorkspaceFolder(trackedDoc.uri);
                if (!wsFolder) {
                    console.error(`[ScalabilityTest] Tracked file not in workspace: ${trackedFile}`);
                    continue;
                }

                console.log(`[ScalabilityTest] Tracked file in workspace: ${wsFolder.uri.fsPath}`);

                // File open with tracking - this should create metadata
                await this.framework.measure(
                    `file_open_tracked_${config.label}`,
                    async () => {
                        await this.metadataManager.ensureLedgerForDoc(trackedDoc);
                    },
                    { lineCount: config.lineCount, totalChars: actualChars, label: config.label }
                );

                // Small delay to allow metadata save
                await new Promise(resolve => setTimeout(resolve, 100));

                // Verify metadata was created
                const expectedMetadata = path.join(metadataDir, `tracked_${config.label}.ts.json`);
                if (fs.existsSync(expectedMetadata)) {
                    console.log(`[ScalabilityTest] ✅ Metadata created for ${config.label}`);
                } else {
                    console.log(`[ScalabilityTest] ⚠️ Metadata pending for ${config.label}`);
                }

                // --- Normal insert mode keystrokes ---
                if (this.overlayManager.getInsertMode() === 'insertDebug') {
                    await this.overlayManager.toggleInsertMode();
                }

                for (const char of testString + testString) {
                    await this.framework.measure(
                        `tracked_normal_${config.label}`,
                        async () => {
                            const pos = trackedEditor.selection.active;
                            await trackedEditor.edit(eb => eb.insert(pos, char));
                        },
                        { 
                            lineCount: config.lineCount, 
                            charsPerLine: config.charsPerLine,
                            totalChars: actualChars,
                            label: config.label,
                            insertMode: 'normal' 
                        }
                    );
                    await new Promise(resolve => setTimeout(resolve, 5));
                }

                // --- Debug insert mode keystrokes ---
                await this.overlayManager.toggleInsertMode();

                for (const char of testString + testString) {
                    await this.framework.measure(
                        `tracked_debug_${config.label}`,
                        async () => {
                            const pos = trackedEditor.selection.active;
                            await trackedEditor.edit(eb => eb.insert(pos, char));
                        },
                        { 
                            lineCount: config.lineCount, 
                            charsPerLine: config.charsPerLine,
                            totalChars: actualChars,
                            label: config.label,
                            insertMode: 'debug' 
                        }
                    );
                    await new Promise(resolve => setTimeout(resolve, 5));
                }

                // Reset to normal mode
                await this.overlayManager.toggleInsertMode();

                // --- Highlight render test ---
                await this.framework.measure(
                    `highlight_render_${config.label}`,
                    async () => {
                        this.overlayManager.updateHighlightsForDocument(trackedDoc);
                    },
                    { lineCount: config.lineCount, totalChars: actualChars, label: config.label }
                );

                // --- Debug mode toggle at this size ---
                await this.framework.measure(
                    `debug_toggle_${config.label}`,
                    async () => {
                        await this.overlayManager.toggleDebugMode();
                    },
                    { lineCount: config.lineCount, totalChars: actualChars, label: config.label }
                );
                await this.overlayManager.toggleDebugMode(); // Toggle back

                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (err) {
                console.error(`[ScalabilityTest] Tracked error for ${config.label}:`, err);
            }
        }

        return createdFiles;
    }

    /**
     * Test performance with different segment counts
     */
    public async runSegmentCountTest(testDir: string): Promise<string[]> {
        const segmentCounts = [1, 10, 50, 100, 500];
        const lineCount = 1000;
        const createdFiles: string[] = [];

        for (const debugSegmentCount of segmentCounts) {
            const testFile = path.join(testDir, `test_${debugSegmentCount}_segments.ts`);
            const { actualChars } = this.generateTestFile(testFile, { lineCount, debugSegmentCount });
            createdFiles.push(testFile);

            try {
                const doc = await vscode.workspace.openTextDocument(testFile);
                await vscode.window.showTextDocument(doc);

                await this.framework.measure(
                    `segment_count_${debugSegmentCount}`,
                    async () => {
                        await this.metadataManager.ensureLedgerForDoc(doc);
                        this.overlayManager.updateHighlightsForDocument(doc);
                    },
                    { debugSegmentCount, lineCount, totalChars: actualChars }
                );

                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (err) {
                console.error(`[ScalabilityTest] Error testing ${debugSegmentCount} segments:`, err);
            }
        }

        return createdFiles;
    }
}