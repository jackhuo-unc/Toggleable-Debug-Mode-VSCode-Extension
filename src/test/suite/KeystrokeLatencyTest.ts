import * as vscode from 'vscode';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { MetadataManager } from '../../MetadataManager';
import { HiddenCodeOverlay } from '../../HiddenCodeOverlay';

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
     * Run baseline test on an UNTRACKED file (no metadata, no extension processing)
     * This simulates pure VS Code editing performance
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
                    },
                    { 
                        char, 
                        fileSize: editor.document.getText().length,
                        iteration: iter,
                        tracked: false
                    }
                );
                // Small delay to simulate realistic typing
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    }

    /**
     * Run test on a TRACKED file (with full extension processing)
     * This measures the overhead of the extension
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
                        // Wait for extension processing to complete
                        await this.waitForExtensionProcessing();
                    },
                    { 
                        char, 
                        fileSize: editor.document.getText().length,
                        iteration: iter,
                        tracked: true,
                        debugInsertMode: isDebugInsertMode
                    }
                );
                // Small delay to simulate realistic typing
                await new Promise(resolve => setTimeout(resolve, 10));
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
            // Reset to start of file
            const startPos = new vscode.Position(0, 0);
            editor.selection = new vscode.Selection(startPos, startPos);

            await this.framework.measure(
                operationName,
                async () => {
                    await editor.edit(editBuilder => {
                        editBuilder.insert(editor.selection.active, textToInsert);
                    });
                    if (tracked) {
                        await this.waitForExtensionProcessing();
                    }
                },
                {
                    textLength: textToInsert.length,
                    iteration: iter,
                    tracked
                }
            );

            // Clear the inserted text for next iteration
            const endPos = editor.document.positionAt(textToInsert.length);
            await editor.edit(editBuilder => {
                editBuilder.delete(new vscode.Range(startPos, endPos));
            });
            await new Promise(resolve => setTimeout(resolve, 50));
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
            // First insert a character
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, 'x');
            });
            await new Promise(resolve => setTimeout(resolve, 20));

            // Now measure deletion
            await this.framework.measure(
                operationName,
                async () => {
                    await vscode.commands.executeCommand('deleteLeft');
                    if (tracked) {
                        await this.waitForExtensionProcessing();
                    }
                },
                {
                    iteration: iter,
                    tracked
                }
            );
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }

    /**
     * Wait for extension processing (metadata sync, highlights, etc.)
     */
    private async waitForExtensionProcessing(): Promise<void> {
        // Give time for debounced operations to settle
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}