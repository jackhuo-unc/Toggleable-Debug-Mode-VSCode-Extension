import * as vscode from 'vscode';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { MetadataManager } from '../../MetadataManager';
import { HiddenCodeOverlay } from '../../HiddenCodeOverlay';

export class UndoRedoTest {
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
     * Run undo test on UNTRACKED file (baseline)
     */
    public async runUndoBaselineTest(
        editor: vscode.TextEditor,
        iterations: number = 20
    ): Promise<void> {
        for (let iter = 0; iter < iterations; iter++) {
            // Make an edit to undo
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, 'test_undo_baseline');
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            // Measure undo
            await this.framework.measure(
                'undo_baseline',
                async () => {
                    await vscode.commands.executeCommand('undo');
                },
                {
                    iteration: iter,
                    fileSize: editor.document.getText().length,
                    tracked: false
                }
            );
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    /**
     * Run undo test on TRACKED file
     */
    public async runUndoTrackedTest(
        editor: vscode.TextEditor,
        iterations: number = 20
    ): Promise<void> {
        for (let iter = 0; iter < iterations; iter++) {
            // Make an edit to undo
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, 'test_undo_tracked');
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            // Measure undo
            await this.framework.measure(
                'undo_tracked',
                async () => {
                    await vscode.commands.executeCommand('undo');
                },
                {
                    iteration: iter,
                    fileSize: editor.document.getText().length,
                    tracked: true
                }
            );
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    /**
     * Run redo test on UNTRACKED file (baseline)
     */
    public async runRedoBaselineTest(
        editor: vscode.TextEditor,
        iterations: number = 20
    ): Promise<void> {
        for (let iter = 0; iter < iterations; iter++) {
            // Make an edit, then undo it
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, 'test_redo_baseline');
            });
            await new Promise(resolve => setTimeout(resolve, 30));
            await vscode.commands.executeCommand('undo');
            await new Promise(resolve => setTimeout(resolve, 30));

            // Measure redo
            await this.framework.measure(
                'redo_baseline',
                async () => {
                    await vscode.commands.executeCommand('redo');
                },
                {
                    iteration: iter,
                    fileSize: editor.document.getText().length,
                    tracked: false
                }
            );

            // Clean up - undo the redo
            await new Promise(resolve => setTimeout(resolve, 30));
            await vscode.commands.executeCommand('undo');
            await new Promise(resolve => setTimeout(resolve, 30));
        }
    }

    /**
     * Run redo test on TRACKED file
     */
    public async runRedoTrackedTest(
        editor: vscode.TextEditor,
        iterations: number = 20
    ): Promise<void> {
        for (let iter = 0; iter < iterations; iter++) {
            // Make an edit, then undo it
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, 'test_redo_tracked');
            });
            await new Promise(resolve => setTimeout(resolve, 30));
            await vscode.commands.executeCommand('undo');
            await new Promise(resolve => setTimeout(resolve, 30));

            // Measure redo
            await this.framework.measure(
                'redo_tracked',
                async () => {
                    await vscode.commands.executeCommand('redo');
                },
                {
                    iteration: iter,
                    fileSize: editor.document.getText().length,
                    tracked: true
                }
            );

            // Clean up
            await new Promise(resolve => setTimeout(resolve, 30));
            await vscode.commands.executeCommand('undo');
            await new Promise(resolve => setTimeout(resolve, 30));
        }
    }

    /**
     * Run bulk undo test - multiple edits then multiple undos
     */
    public async runBulkUndoTest(
        editor: vscode.TextEditor,
        tracked: boolean,
        editCount: number = 10,
        iterations: number = 5
    ): Promise<void> {
        const operationName = tracked ? 'bulk_undo_tracked' : 'bulk_undo_baseline';

        for (let iter = 0; iter < iterations; iter++) {
            // Make multiple edits
            for (let i = 0; i < editCount; i++) {
                const position = editor.selection.active;
                await editor.edit(editBuilder => {
                    editBuilder.insert(position, `edit_${i}_`);
                });
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            await new Promise(resolve => setTimeout(resolve, 50));

            // Measure bulk undo
            await this.framework.measure(
                operationName,
                async () => {
                    for (let i = 0; i < editCount; i++) {
                        await vscode.commands.executeCommand('undo');
                    }
                },
                {
                    iteration: iter,
                    editCount,
                    fileSize: editor.document.getText().length,
                    tracked
                }
            );
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    /**
     * Test undo/redo of debug code specifically
     */
    public async runDebugCodeUndoRedoTest(
        editor: vscode.TextEditor,
        iterations: number = 10
    ): Promise<void> {
        // Ensure we're in debug insert mode
        if (this.overlayManager.getInsertMode() !== 'insertDebug') {
            await this.overlayManager.toggleInsertMode();
        }

        for (let iter = 0; iter < iterations; iter++) {
            // Insert debug code
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, 'console.log("debug");');
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            // Measure undo of debug code
            await this.framework.measure(
                'undo_debug_code',
                async () => {
                    await vscode.commands.executeCommand('undo');
                },
                {
                    iteration: iter,
                    fileSize: editor.document.getText().length
                }
            );
            await new Promise(resolve => setTimeout(resolve, 30));

            // Measure redo of debug code
            await this.framework.measure(
                'redo_debug_code',
                async () => {
                    await vscode.commands.executeCommand('redo');
                },
                {
                    iteration: iter,
                    fileSize: editor.document.getText().length
                }
            );
            await new Promise(resolve => setTimeout(resolve, 30));

            // Clean up
            await vscode.commands.executeCommand('undo');
            await new Promise(resolve => setTimeout(resolve, 30));
        }

        // Reset to normal mode
        if (this.overlayManager.getInsertMode() === 'insertDebug') {
            await this.overlayManager.toggleInsertMode();
        }
    }
}