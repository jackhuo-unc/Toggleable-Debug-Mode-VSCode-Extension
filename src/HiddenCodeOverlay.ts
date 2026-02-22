// This is where “Debug On / Debug Off” state will live.

// It will eventually talk to MetadataManager to:
// maintain per-character IDs
// decide what “debug on view” vs “debug off view” looks like
// generate the instrumented output for build

import * as vscode from 'vscode';
import { MetadataManager } from './MetadataManager';

export type DebugMode = 'debugOn' | 'debugOff';

export class HiddenCodeOverlay {
	private readonly context: vscode.ExtensionContext;
	private metadataManager: MetadataManager;
	private debugMode: DebugMode = 'debugOff';
	private debugCharDecoration: vscode.TextEditorDecorationType | null = null;

	constructor(context: vscode.ExtensionContext, metadataManager: MetadataManager) {
		this.context = context;
		this.metadataManager = metadataManager;
		console.log('[HiddenCodeOverlay] constructed');
	}

	public async init(): Promise<void> {
		console.log('[HiddenCodeOverlay] init()');
		// TODO: load last-known mode from workspaceState/globalState if you want persistence
		const saved = this.context.workspaceState.get<DebugMode>('hiddenOverlay.debugMode');
		if (saved === 'debugOn' || saved === 'debugOff') {
			this.debugMode = saved;
		}
		console.log('[HiddenCodeOverlay] initial mode =', this.debugMode);

		this.debugCharDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 215, 0, 0.25)', // golden highlight
            border: '1px solid rgba(255, 165, 0, 0.7)',
            overviewRulerColor: 'orange',
            overviewRulerLane: vscode.OverviewRulerLane.Right
        });
	}

	public getMode(): DebugMode {
		return this.debugMode;
	}

	public async toggleDebugMode(): Promise<void> {
		this.debugMode = this.debugMode === 'debugOn' ? 'debugOff' : 'debugOn';
		console.log('[HiddenCodeOverlay] toggleDebugMode ->', this.debugMode);

		//persist mode
		await this.context.workspaceState.update('hiddenOverlay.debugMode', this.debugMode);

		// Show progress indicator since this may take a moment
		await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Switching to ${this.debugMode === 'debugOn' ? 'Debug ON' : 'Debug OFF'} mode...`,
                cancellable: false
            },
            async (progress) => {
                // Apply changes to ALL tracked files in workspace
                await this.applyDebugViewToAllFiles();
                
                // Update highlights for open editors
                this.updateHighlightsForAllEditors();
            }
        );

		 vscode.window.showInformationMessage(
            `Debug mode: ${this.debugMode === 'debugOn' ? 'ON' : 'OFF'}`
        );

		//Apply changes to all open editors
		// await this.applyDebugViewToAllEditors();
	}

	/**
     * Apply the debug view to ALL tracked files in the workspace
     */
    private async applyDebugViewToAllFiles(): Promise<void> {
        const showDebug = this.debugMode === 'debugOn';
        const trackedFiles = this.metadataManager.getTrackedFilePaths();

        console.log(`[HiddenCodeOverlay] Applying debug view to ${trackedFiles.length} files`);

        for (const filePath of trackedFiles) {
            await this.metadataManager.rebuildAndSaveFile(filePath, showDebug);
        }

        console.log('[HiddenCodeOverlay] Finished applying debug view to all files');
    }

	// private async applyDebugViewToAllEditors(): Promise<void> {
	// 	for (const editor of vscode.window.visibleTextEditors) {
	// 		await this.applyDebugViewToEditor(editor);
	// 	}
	// }

	/**
     * Update highlights for all visible editors
     */
    private updateHighlightsForAllEditors(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.updateHighlightsForEditor(editor);
        }
    }

	// private async applyDebugViewToEditor(editor: vscode.TextEditor): Promise<void> {
	// 	const filePath = editor.document.uri.fsPath;
	// 	console.log('[HiddenCodeOverlay] applying view to editor for', filePath);

	// 	const ledger = this.metadataManager.getCharLedgerForFile(filePath);
	// 	if (!ledger) {
	// 		console.warn('[HiddenCodeOverlay] no ledger found for', filePath);
	// 		return;
	// 	}

	// 	const showDebug = this.debugMode === 'debugOn';

	// 	// Build the visible text from ledger
    //     const newText = this.metadataManager.buildTextFromLedger(filePath, showDebug);
    //     if (newText === null) {
    //         console.warn('[HiddenCodeOverlay] failed to build text for:', filePath);
    //         return;
    //     }

	// 	// Replace entire document with the mode-specific text
    //     const currentText = editor.document.getText();
    //     if (currentText !== newText) {
    //         const fullRange = new vscode.Range(
    //             editor.document.positionAt(0),
    //             editor.document.positionAt(currentText.length)
    //         );

    //         // Use MetadataManager's apply method to avoid ledger updates
    //         await this.metadataManager.applyEditWithoutTracking(editor.document.uri, fullRange, newText);
    //     }

	// 	// Update decorations
    //     this.updateHighlightsForEditor(editor);

    //     console.log(`[HiddenCodeOverlay] Applied debugMode=${this.debugMode} view to ${filePath}`);
	// }

	public clearHighlights(): void {
        if (!this.debugCharDecoration) return;
        for (const ed of vscode.window.visibleTextEditors) {
            ed.setDecorations(this.debugCharDecoration, []);
        }
    }

	public updateHighlightsForDocument(doc: vscode.TextDocument): void {
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === doc.uri.toString()
        );
        if (editor) {
            this.updateHighlightsForEditor(editor);
        }
    }

	private updateHighlightsForEditor(editor: vscode.TextEditor): void {
        if (!this.debugCharDecoration) return;

        const showDebug = this.debugMode === 'debugOn';

        if (!showDebug) {
            editor.setDecorations(this.debugCharDecoration, []);
            return;
        }

        // Get debug segments and convert to ranges
        const segments = this.metadataManager.getDebugSegmentsForDocument(editor.document);
        const ranges = segments.map(seg => new vscode.Range(
            editor.document.positionAt(seg.start),
            editor.document.positionAt(seg.end)
        ));
        
        editor.setDecorations(this.debugCharDecoration, ranges);
    }

	public dispose(): void {
        console.log('[HiddenCodeOverlay] dispose()');
        if (this.debugCharDecoration) {
            this.debugCharDecoration.dispose();
            this.debugCharDecoration = null;
        }
    }
}
