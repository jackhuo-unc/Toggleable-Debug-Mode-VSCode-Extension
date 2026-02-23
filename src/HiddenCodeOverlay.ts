// This is where “Debug On / Debug Off” state will live.

// It will eventually talk to MetadataManager to:
// maintain per-character IDs
// decide what “debug on view” vs “debug off view” looks like
// generate the instrumented output for build

import * as vscode from 'vscode';
import { MetadataManager } from './MetadataManager';

export type DebugMode = 'debugOn' | 'debugOff';
export type InsertMode = 'insertDebug' | 'insertNormal';

export class HiddenCodeOverlay {
	private readonly context: vscode.ExtensionContext;
	private metadataManager: MetadataManager;
	private debugMode: DebugMode = 'debugOff';
	private insertMode: InsertMode = 'insertNormal';
	private debugCharDecoration: vscode.TextEditorDecorationType | null = null;

	constructor(context: vscode.ExtensionContext, metadataManager: MetadataManager) {
		this.context = context;
		this.metadataManager = metadataManager;
		console.log('[HiddenCodeOverlay] constructed');
	}

	public async init(): Promise<void> {
		console.log('[HiddenCodeOverlay] init()');

		// Restore debug mode
        const savedDebugMode = this.context.workspaceState.get<DebugMode>('hiddenOverlay.debugMode');
        if (savedDebugMode === 'debugOn' || savedDebugMode === 'debugOff') {
            this.debugMode = savedDebugMode;
        }

		// Restore insert mode
        const savedInsertMode = this.context.workspaceState.get<InsertMode>('hiddenOverlay.insertMode');
        if (savedInsertMode === 'insertDebug' || savedInsertMode === 'insertNormal') {
            this.insertMode = savedInsertMode;
        }

		// If we're in debugOff mode, force insertNormal
        if (this.debugMode === 'debugOff') {
            this.insertMode = 'insertNormal';
        }

		console.log('[HiddenCodeOverlay] initial mode =', this.debugMode);
		console.log('[HiddenCodeOverlay] initial insertMode =', this.insertMode);

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

	public getInsertMode(): InsertMode {
		return this.insertMode;
	}

	/**
     * Returns true if newly inserted chars should be marked as debug
     */
    public shouldInsertAsDebug(): boolean {
        // Only insert as debug if BOTH conditions are met:
        // 1. We're in debugOn mode (can see debug code)
        // 2. Insert mode is set to insertDebug
        return this.debugMode === 'debugOn' && this.insertMode === 'insertDebug';
    }

	public async toggleDebugMode(): Promise<void> {
		this.debugMode = this.debugMode === 'debugOn' ? 'debugOff' : 'debugOn';
		console.log('[HiddenCodeOverlay] toggleDebugMode ->', this.debugMode);

		// When switching to debugOff, force insert mode to normal
        if (this.debugMode === 'debugOff') {
            this.insertMode = 'insertNormal';
            await this.context.workspaceState.update('hiddenOverlay.insertMode', this.insertMode);
        }

		//persist mode
		await this.context.workspaceState.update('hiddenOverlay.debugMode', this.debugMode);

		// Show progress indicator since this may take a moment
		await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Switching to ${this.debugMode === 'debugOn' ? 'Debug ON' : 'Debug OFF'} mode...`,
                cancellable: false
            },
            async () => {
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

	public async toggleInsertMode(): Promise<void> {
		// Only allow toggling insert mode when in debugOn mode
		if (this.debugMode === 'debugOff') {
            vscode.window.showWarningMessage(
                'Insert mode can only be changed while in Debug ON mode'
            );
            return;
        }

		this.insertMode = this.insertMode === 'insertDebug' ? 'insertNormal' : 'insertDebug';
        console.log('[HiddenCodeOverlay] toggleInsertMode ->', this.insertMode);

        // Persist mode
        await this.context.workspaceState.update('hiddenOverlay.insertMode', this.insertMode);

        vscode.window.showInformationMessage(
            `Insert mode: ${this.insertMode === 'insertDebug' ? 'DEBUG CODE' : 'NORMAL CODE'}`
        );

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

	/**
     * Update highlights for all visible editors
     */
    private updateHighlightsForAllEditors(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.updateHighlightsForEditor(editor);
        }
    }

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

	public updateHighlightsForEditor(editor: vscode.TextEditor): void {
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
