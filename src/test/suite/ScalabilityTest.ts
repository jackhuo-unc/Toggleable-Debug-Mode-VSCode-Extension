import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { MetadataManager } from '../../local/MetadataManager';
import { HiddenCodeOverlay } from '../../local/HiddenCodeOverlay';
import { saveAndCloseActiveEditor } from '../SaveAndClose';

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

                await saveAndCloseActiveEditor();

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

                await saveAndCloseActiveEditor();

            } catch (err) {
                console.error(`[ScalabilityTest] Tracked error for ${config.label}:`, err);
            }
        }

        return createdFiles;
    }

    /**
     * Test performance with different ACTUAL debug segment counts.
     * Creates metadata files FIRST, then lets extension build source files from them.
     */
    public async runSegmentCountTest(testDir: string): Promise<string[]> {
        const segmentCounts = [1, 10, 50, 100, 500];
        const baseLineCount = 500;
        const createdFiles: string[] = [];

        // Ensure metadata directory exists
        const metadataDir = path.join(testDir, '__debuggable__');
        if (!fs.existsSync(metadataDir)) {
            fs.mkdirSync(metadataDir, { recursive: true });
        }

        // Get workspace root for relative paths
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            console.error('[ScalabilityTest] No workspace root!');
            return createdFiles;
        }

        for (const targetSegmentCount of segmentCounts) {
            console.log(`\n[ScalabilityTest] ========================================`);
            console.log(`[ScalabilityTest] Creating file with ${targetSegmentCount} debug segments`);
            console.log(`[ScalabilityTest] ========================================`);

            const fileName = `segments_${targetSegmentCount}.ts`;
            const testFile = path.join(testDir, fileName);
            const metadataFile = path.join(metadataDir, `${fileName}.json`);
            const relativePath = path.relative(workspaceRoot, testFile);

            try {
                // ============================================
                // 1. Build segments array with ALTERNATING debug/non-debug
                // ============================================
                const segments: { text: string; isDebug: boolean }[] = [];
                
                const linesPerNonDebugSegment = Math.max(1, Math.floor(baseLineCount / targetSegmentCount));
                
                let lineNum = 0;
                for (let i = 0; i < targetSegmentCount; i++) {
                    // Add non-debug segment (multiple lines of normal code)
                    const normalLines: string[] = [];
                    for (let j = 0; j < linesPerNonDebugSegment && lineNum < baseLineCount; j++, lineNum++) {
                        normalLines.push(`const line${lineNum} = ${lineNum};`);
                    }
                    if (normalLines.length > 0) {
                        segments.push({
                            text: normalLines.join('\n') + '\n',
                            isDebug: false
                        });
                    }

                    // Add debug segment (single line of debug code)
                    segments.push({
                        text: `console.log("DEBUG_SEGMENT_${i}");\n`,
                        isDebug: true
                    });
                }

                // Add any remaining lines as final non-debug segment
                if (lineNum < baseLineCount) {
                    const remainingLines: string[] = [];
                    while (lineNum < baseLineCount) {
                        remainingLines.push(`const line${lineNum} = ${lineNum};`);
                        lineNum++;
                    }
                    if (remainingLines.length > 0) {
                        segments.push({
                            text: remainingLines.join('\n'),
                            isDebug: false
                        });
                    }
                }

                const debugCount = segments.filter(s => s.isDebug).length;
                const nonDebugCount = segments.filter(s => !s.isDebug).length;
                console.log(`[ScalabilityTest] Built ${segments.length} segments: ${debugCount} debug, ${nonDebugCount} non-debug`);

                // ============================================
                // 2. Create the METADATA FILE FIRST (no source file yet!)
                // ============================================
                const ledgerData = {
                    relativePath: relativePath,
                    segments: segments,
                    savedInDebugMode: true,  // Metadata was saved with debug visible
                    version: 1
                };

                fs.writeFileSync(metadataFile, JSON.stringify(ledgerData, null, 2));
                console.log(`[ScalabilityTest] Created metadata file: ${metadataFile}`);

                // Verify metadata was written correctly
                const verifyData = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
                const verifyDebugCount = verifyData.segments.filter((s: any) => s.isDebug === true).length;
                console.log(`[ScalabilityTest] Verified: metadata has ${verifyDebugCount} debug segments`);

                // ============================================
                // 3. Ensure we're in debugOn mode (so source file includes debug code)
                // ============================================
                if (this.overlayManager.getMode() !== 'debugOn') {
                    console.log('[ScalabilityTest] Switching to debugOn mode...');
                    await this.overlayManager.toggleDebugMode();
                    await new Promise(resolve => setTimeout(resolve, 300));
                }

                // ============================================
                // 4. Create empty source files
                // ============================================
                console.log(`[ScalabilityTest] Manually creating source file, do not write anything to it`);
                fs.writeFileSync(testFile, '');

                // Wait for extension to detect new file and create metadata (if it tries to)
                await new Promise(resolve => setTimeout(resolve, 500));

                // Check if extension created metadata (it should NOT have, since we already made it)
                if (fs.existsSync(metadataFile)) {
                    console.log(`[ScalabilityTest] ✅ Metadata file exists as expected: ${metadataFile}`);
                } else {
                    console.error(`[ScalabilityTest] ❌ Metadata file was NOT created by extension: ${metadataFile}`);
                }

                // Check if the file was created
                if (!fs.existsSync(testFile)) {
                    console.error(`[ScalabilityTest] ❌ Source file was NOT created by extension: ${testFile}`);
                    continue;
                }
                console.log(`[ScalabilityTest] ✅ Source file created by extension: ${testFile}`);
                createdFiles.push(testFile);

                await this.metadataManager.scanWorkspaceForFiles();
                await new Promise(resolve => setTimeout(resolve, 500));

                // Verify file content
                const createdContent = fs.readFileSync(testFile, 'utf-8');
                const hasDebugContent = createdContent.includes('DEBUG_SEGMENT_');
                console.log(`[ScalabilityTest] Source file has debug content: ${hasDebugContent}`);
                console.log(`[ScalabilityTest] Source file length: ${createdContent.length} chars`);

                // ============================================
                // 5. Now open the file - extension should load the EXISTING metadata
                // ============================================
                console.log(`[ScalabilityTest] Opening file (extension should load existing metadata)...`);
                const doc = await vscode.workspace.openTextDocument(testFile);
                const editor = await vscode.window.showTextDocument(doc, { preview: false });

                // Wait for extension to process
                await new Promise(resolve => setTimeout(resolve, 500));

                // ============================================
                // 6. Verify extension loaded the correct metadata
                // ============================================
                const loadedLedger = this.metadataManager.getLedgerForFile(testFile);
                
                if (!loadedLedger) {
                    console.error(`[ScalabilityTest] ❌ No ledger loaded!`);
                    
                    // Try scanning workspace
                    console.log('[ScalabilityTest] Triggering workspace scan...');
                    await this.metadataManager.scanWorkspaceForFiles();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                const finalLedger = this.metadataManager.getLedgerForFile(testFile);
                const actualDebugCount = finalLedger?.segments.filter(s => s.isDebug === true).length ?? 0;
                const actualTotalSegments = finalLedger?.segments.length ?? 0;

                console.log(`[ScalabilityTest] Extension loaded: ${actualDebugCount} debug segments, ${actualTotalSegments} total`);

                if (actualDebugCount === targetSegmentCount) {
                    console.log(`[ScalabilityTest] ✅ SUCCESS: Correct segment count!`);
                } else {
                    console.error(`[ScalabilityTest] ❌ MISMATCH: Expected ${targetSegmentCount} debug, got ${actualDebugCount}`);
                    
                    // Debug info
                    if (finalLedger && finalLedger.segments.length > 0) {
                        console.log('[ScalabilityTest] First 3 segments:');
                        finalLedger.segments.slice(0, 3).forEach((s, i) => {
                            const preview = s.text.length > 40 ? s.text.substring(0, 40) + '...' : s.text;
                            console.log(`  [${i}] isDebug=${s.isDebug}, text="${preview.replace(/\n/g, '\\n')}"`);
                        });
                    }
                    
                    // Check if metadata file still has correct data
                    const recheckMeta = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
                    const recheckDebug = recheckMeta.segments.filter((s: any) => s.isDebug === true).length;
                    console.log(`[ScalabilityTest] Metadata file on disk still has: ${recheckDebug} debug segments`);
                }

                // ============================================
                // 7. Run performance measurements
                // ============================================
                if (actualDebugCount > 0) {
                    // Keystroke latency
                    for (let i = 0; i < 5; i++) {
                        await this.framework.measure(
                            `keystroke_with_${targetSegmentCount}_segments`,
                            async () => {
                                const pos = editor.selection.active;
                                await editor.edit(eb => eb.insert(pos, 'x'));
                            },
                            { targetSegmentCount, actualDebugCount, iteration: i }
                        );
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }

                    // Highlight refresh
                    for (let i = 0; i < 5; i++) {
                        await this.framework.measure(
                            `highlight_refresh_${targetSegmentCount}_segments`,
                            async () => {
                                this.overlayManager.updateHighlightsForDocument(doc);
                            },
                            { targetSegmentCount, actualDebugCount, iteration: i }
                        );
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }

                    // Debug toggle
                    for (let i = 0; i < 5; i++) {
                        await this.framework.measure(
                            `debug_toggle_${targetSegmentCount}_segments`,
                            async () => {
                                await this.overlayManager.toggleDebugMode();
                            },
                            { targetSegmentCount, actualDebugCount, iteration: i }
                        );
                        // Toggle back
                        await this.overlayManager.toggleDebugMode();
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                }

                // Save and close
                await doc.save();
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (err) {
                console.error(`[ScalabilityTest] Error with ${targetSegmentCount} segments:`, err);
            }
        }

        // Ensure debugOn at end
        if (this.overlayManager.getMode() !== 'debugOn') {
            await this.overlayManager.toggleDebugMode();
        }

        return createdFiles;
    }
}