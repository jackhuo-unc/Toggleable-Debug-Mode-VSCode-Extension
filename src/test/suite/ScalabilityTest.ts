import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { MetadataManager } from '../../MetadataManager';
import { HiddenCodeOverlay } from '../../HiddenCodeOverlay';

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
     * Generate test file with specified characteristics
     */
    public generateTestFile(
        outputPath: string,
        options: {
            lineCount: number;
            debugSegmentCount: number;
            charsPerLine?: number;
        }
    ): string {
        const { lineCount, debugSegmentCount, charsPerLine = 80 } = options;
        const lines: string[] = [];
        const debugInterval = Math.floor(lineCount / debugSegmentCount) || 1;

        for (let i = 0; i < lineCount; i++) {
            const isDebugLine = i % debugInterval === 0 && debugSegmentCount > 0;
            const prefix = isDebugLine ? '// DEBUG: ' : '';
            const content = prefix + 'x'.repeat(charsPerLine - prefix.length);
            lines.push(content);
        }

        const content = lines.join('\n');
        fs.writeFileSync(outputPath, content);
        return outputPath;
    }

    /**
     * Test performance at different file sizes
     */
    public async runFileSizeTest(testDir: string): Promise<string[]> {
        const sizes = [100, 500, 1000, 5000, 10000];
        const createdFiles: string[] = [];

        for (const lineCount of sizes) {
            const testFile = path.join(testDir, `test_${lineCount}_lines.ts`);
            this.generateTestFile(testFile, { lineCount, debugSegmentCount: 10 });
            createdFiles.push(testFile);

            const doc = await vscode.workspace.openTextDocument(testFile);
            const editor = await vscode.window.showTextDocument(doc);

            // Measure file open with metadata loading
            await this.framework.measure(
                'file_open',
                async () => {
                    await this.metadataManager.ensureLedgerForDoc(doc);
                },
                { lineCount, fileSize: doc.getText().length }
            );

            // Measure keystroke at this file size
            await this.framework.measure(
                'keystroke_by_size',
                async () => {
                    const position = editor.selection.active;
                    await editor.edit(eb => eb.insert(position, 'a'));
                },
                { lineCount, fileSize: doc.getText().length }
            );

            // Cleanup
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            fs.unlinkSync(testFile);
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
            this.generateTestFile(testFile, { lineCount, debugSegmentCount });
            createdFiles.push(testFile);

            try {
                const doc = await vscode.workspace.openTextDocument(testFile);
                await vscode.window.showTextDocument(doc);

                await this.framework.measure(
                    'highlight_render',
                    async () => {
                        await this.metadataManager.ensureLedgerForDoc(doc);
                        this.overlayManager.updateHighlightsForDocument(doc);
                    },
                    { debugSegmentCount, lineCount }
                );

                // Close editor before next iteration
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                await new Promise(resolve => setTimeout(resolve, 300));
            } catch (err) {
                console.error(`[ScalabilityTest] Error testing ${debugSegmentCount} segments:`, err);
            }
        }
        return createdFiles;
    }
}