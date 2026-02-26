import * as vscode from 'vscode';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { MetadataManager } from '../../MetadataManager';
import { HiddenCodeOverlay } from '../../HiddenCodeOverlay';

export type InsertPosition = 'start' | 'middle' | 'end';

export class KeystrokeLatencyTest {
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
     * Get position in document based on location type
     */
    private getInsertPosition(editor: vscode.TextEditor, position: InsertPosition): vscode.Position {
        const doc = editor.document;
        switch (position) {
            case 'start':
                return new vscode.Position(0, 0);
            case 'middle':
                const midLine = Math.floor(doc.lineCount / 2);
                const midLineText = doc.lineAt(midLine).text;
                const midChar = Math.floor(midLineText.length / 2);
                return new vscode.Position(midLine, midChar);
            case 'end':
                const lastLine = doc.lineCount - 1;
                const lastLineText = doc.lineAt(lastLine).text;
                return new vscode.Position(lastLine, lastLineText.length);
        }
    }

    /**
     * Run baseline test at specific position
     */
    public async runBaselineTestAtPosition(
        doc: vscode.TextDocument,
        testString: string,
        position: InsertPosition,
        iterations: number = 1
    ): Promise<void> {
        for (let iter = 0; iter < iterations; iter++) {
            for (const char of testString) {
                const editor = await this.ensureActiveEditor(doc);
                const insertPos = this.getInsertPosition(editor, position);
                editor.selection = new vscode.Selection(insertPos, insertPos);

                await this.framework.measure(
                    `keystroke_baseline_${position}`,
                    async () => {
                        await editor.edit(editBuilder => {
                            editBuilder.insert(editor.selection.active, char);
                        });
                    },
                    { 
                        char, 
                        fileSize: editor.document.getText().length,
                        iteration: iter,
                        position,
                        tracked: false
                    }
                );
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
    }

    /**
     * Run tracked test at specific position
     */
    public async runTrackedTestAtPosition(
        doc: vscode.TextDocument,
        testString: string,
        position: InsertPosition,
        isDebugInsertMode: boolean,
        iterations: number = 1
    ): Promise<void> {
        const modeLabel = isDebugInsertMode ? 'debug' : 'normal';
        const operationName = `keystroke_tracked_${modeLabel}_${position}`;

        for (let iter = 0; iter < iterations; iter++) {
            for (const char of testString) {
                const editor = await this.ensureActiveEditor(doc);
                const insertPos = this.getInsertPosition(editor, position);
                editor.selection = new vscode.Selection(insertPos, insertPos);

                await this.framework.measure(
                    operationName,
                    async () => {
                        await editor.edit(editBuilder => {
                            editBuilder.insert(editor.selection.active, char);
                        });
                    },
                    { 
                        char, 
                        fileSize: editor.document.getText().length,
                        iteration: iter,
                        position,
                        tracked: true,
                        debugInsertMode: isDebugInsertMode
                    }
                );
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
    }

    /**
     * Run comprehensive position tests (baseline + tracked at all positions)
     */
    public async runPositionComparisonTest(
        baselineDoc: vscode.TextDocument,
        trackedDoc: vscode.TextDocument,
        testString: string,
        iterations: number = 2
    ): Promise<void> {
        const positions: InsertPosition[] = ['start', 'middle', 'end'];

        // Baseline tests at all positions
        console.log('[KeystrokeLatencyTest] Running baseline position tests...');
        for (const pos of positions) {
            console.log(`[KeystrokeLatencyTest] Baseline at ${pos}...`);
            await this.runBaselineTestAtPosition(baselineDoc, testString, pos, iterations);
            // Save after each position to keep file clean
            await baselineDoc.save();
        }

        // Tracked normal mode at all positions
        console.log('[KeystrokeLatencyTest] Running tracked (normal) position tests...');
        if (this.overlayManager.getInsertMode() === 'insertDebug') {
            await this.overlayManager.toggleInsertMode();
        }

        for (const pos of positions) {
            console.log(`[KeystrokeLatencyTest] Tracked (normal) at ${pos}...`);
            await this.runTrackedTestAtPosition(trackedDoc, testString, pos, false, iterations);
            await trackedDoc.save();
        }

        // Tracked debug mode at all positions
        console.log('[KeystrokeLatencyTest] Running tracked (debug) position tests...');
        await this.overlayManager.toggleInsertMode();
        
        for (const pos of positions) {
            console.log(`[KeystrokeLatencyTest] Tracked (debug) at ${pos}...`);
            await this.runTrackedTestAtPosition(trackedDoc, testString, pos, true, iterations);
            await trackedDoc.save();
        }
        
        await this.overlayManager.toggleInsertMode(); // Reset
    }

    /**
     * Run baseline test on an UNTRACKED file (no metadata, no extension processing)
     * Measures ONLY the VS Code edit API time
     */
    public async runBaselineTest(
        editor: vscode.TextEditor,
        testString: string,
        iterations: number = 1
    ): Promise<void> {
        for (let iter = 0; iter < iterations; iter++) {
            for (const char of testString) {
                await this.framework.measure(
                    'keystroke_baseline',
                    async () => {
                        const position = editor.selection.active;
                        await editor.edit(editBuilder => {
                            editBuilder.insert(position, char);
                        });
                        // DON'T add artificial delay - measure actual edit time only
                    },
                    { 
                        char, 
                        fileSize: editor.document.getText().length,
                        iteration: iter,
                        tracked: false
                    }
                );
                // Delay OUTSIDE measurement to prevent overlap
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
    }

    /**
     * Run test on a TRACKED file
     * Measures ONLY the VS Code edit API time (NOT debounced background processing)
     * 
     * The extension's overhead comes from synchronous event handlers in onDidChangeTextDocument,
     * NOT from the debounced metadata save which happens in background
     */
    public async runTrackedTest(
        editor: vscode.TextEditor,
        testString: string,
        isDebugInsertMode: boolean,
        iterations: number = 1
    ): Promise<void> {
        const operationName = isDebugInsertMode 
            ? 'keystroke_tracked_debug_insert' 
            : 'keystroke_tracked_normal_insert';

        for (let iter = 0; iter < iterations; iter++) {
            for (const char of testString) {
                await this.framework.measure(
                    operationName,
                    async () => {
                        const position = editor.selection.active;
                        await editor.edit(editBuilder => {
                            editBuilder.insert(position, char);
                        });
                        // Measure only the synchronous edit path
                        // Background debounced operations don't affect user-perceived latency
                    },
                    { 
                        char, 
                        fileSize: editor.document.getText().length,
                        iteration: iter,
                        tracked: true,
                        debugInsertMode: isDebugInsertMode
                    }
                );
                // Delay OUTSIDE measurement
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
    }

    /**
     * Full pipeline baseline (UNTRACKED) - same wait time for fair comparison
     * This isolates extension overhead from the artificial wait time
     */
    public async runFullPipelineBaselineTest(
        editor: vscode.TextEditor,
        testString: string,
        iterations: number = 1
    ): Promise<void> {
        for (let iter = 0; iter < iterations; iter++) {
            for (const char of testString) {
                await this.framework.measure(
                    'keystroke_full_pipeline_baseline',
                    async () => {
                        const position = editor.selection.active;
                        await editor.edit(editBuilder => {
                            editBuilder.insert(position, char);
                        });
                        // Same wait as tracked full pipeline for fair comparison
                        await this.waitForAllProcessing();
                    },
                    { 
                        char, 
                        fileSize: editor.document.getText().length,
                        iteration: iter
                    }
                );
            }
        }
    }

    /**
     * Measure the FULL pipeline including all async processing
     * This shows total time until everything settles, useful for understanding full overhead
     */
    public async runFullPipelineTest(
        editor: vscode.TextEditor,
        testString: string,
        iterations: number = 1
    ): Promise<void> {
        for (let iter = 0; iter < iterations; iter++) {
            for (const char of testString) {
                await this.framework.measure(
                    'keystroke_full_pipeline',
                    async () => {
                        const position = editor.selection.active;
                        await editor.edit(editBuilder => {
                            editBuilder.insert(position, char);
                        });
                        // Wait for ALL async operations to complete
                        await this.waitForAllProcessing();
                    },
                    { 
                        char, 
                        fileSize: editor.document.getText().length,
                        iteration: iter
                    }
                );
            }
        }
    }

    /**
     * Run a bulk insert test (paste-like operation)
     */
    public async runBulkInsertTest(
        editor: vscode.TextEditor,
        textToInsert: string,
        tracked: boolean,
        iterations: number = 10
    ): Promise<void> {
        const operationName = tracked ? 'bulk_insert_tracked' : 'bulk_insert_baseline';

        for (let iter = 0; iter < iterations; iter++) {
            const startPos = new vscode.Position(0, 0);
            editor.selection = new vscode.Selection(startPos, startPos);

            await this.framework.measure(
                operationName,
                async () => {
                    await editor.edit(editBuilder => {
                        editBuilder.insert(editor.selection.active, textToInsert);
                    });
                    // No artificial delay
                },
                {
                    textLength: textToInsert.length,
                    iteration: iter,
                    tracked
                }
            );

            // Cleanup OUTSIDE measurement
            await new Promise(resolve => setTimeout(resolve, 20));
            const endPos = editor.document.positionAt(editor.document.getText().length);
            await editor.edit(editBuilder => {
                editBuilder.delete(new vscode.Range(startPos, endPos));
            });
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }

    /**
     * Run deletion test
     */
    public async runDeletionTest(
        editor: vscode.TextEditor,
        tracked: boolean,
        iterations: number = 20
    ): Promise<void> {
        const operationName = tracked ? 'deletion_tracked' : 'deletion_baseline';

        for (let iter = 0; iter < iterations; iter++) {
            // Insert outside measurement
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, 'x');
            });
            await new Promise(resolve => setTimeout(resolve, 10));

            // Measure ONLY deletion
            await this.framework.measure(
                operationName,
                async () => {
                    await vscode.commands.executeCommand('deleteLeft');
                },
                {
                    iteration: iter,
                    tracked
                }
            );
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    /**
     * Wait for all async processing to complete (metadata save, etc.)
     */
    private async waitForAllProcessing(): Promise<void> {
        // This is the debounce time for metadata saves
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    /**
     * Wait for extension processing (metadata sync, highlights, etc.)
     */
    private async waitForExtensionProcessing(): Promise<void> {
        // Give time for debounced operations to settle
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    /**
     * Ensure we have a valid active editor for the given document
     */
    private async ensureActiveEditor(doc: vscode.TextDocument): Promise<vscode.TextEditor> {
        const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Double-check we got the right editor
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.fsPath !== doc.uri.fsPath) {
            throw new Error(`Failed to activate editor for ${doc.uri.fsPath}`);
        }
        return activeEditor;
    }
}