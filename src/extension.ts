// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as web from './web';
// import { LogNameManager } from './LogNameManager';
// import { TrackerManager } from './TrackerManager';
import { UIManager } from './UIManager';
import { HiddenCodeOverlay } from './HiddenCodeOverlay';
import { MetadataManager } from './MetadataManager';
import { UndoRedoManager } from './UndoRedoManager';

import { runAllPerformanceTests } from './test/RunPerformanceTest';

// let trackerManager: TrackerManager | null = null;
let metadataManager: MetadataManager | null = null;
let overlayManager: HiddenCodeOverlay | null = null;
let undoRedoManager: UndoRedoManager | null = null;
let uiManager: UIManager | null = null;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	console.log('[debug-toggle] activate() called');

	// 1. Init metadata / overlay core
	metadataManager = new MetadataManager(context);
	// Perform any async initialization that needs to happen after wiring
	await metadataManager.init();

	
	overlayManager = new HiddenCodeOverlay(context, metadataManager);
	await overlayManager.init();

	// 2. Init undo and redo tracker
	undoRedoManager = new UndoRedoManager(context, metadataManager, overlayManager);

	// 3. Initialize UI (status bar, webview commands, etc.)
	uiManager = new UIManager(context, overlayManager);

	metadataManager.setDebugModeChangeCallback(async (newMode) => {
		if (overlayManager) {
			await overlayManager.onExternalModeChange(newMode);
		}
		uiManager?.updateStatusBar();
	})

	context.subscriptions.push(
        vscode.commands.registerCommand('hiddenOverlay.toggleDebugMode', async () => {
            // Record state BEFORE toggle for all open documents
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                undoRedoManager?.recordModeToggle(editor.document.uri.fsPath);
            }
			
			await overlayManager?.toggleDebugMode();
            uiManager?.updateStatusBar();
        })
    );

	context.subscriptions.push(
        vscode.commands.registerCommand('hiddenOverlay.toggleInsertMode', async () => {
			const editor = vscode.window.activeTextEditor;
            if (editor) {
                undoRedoManager?.recordInsertModeToggle(editor.document.uri.fsPath);
            }
            await overlayManager?.toggleInsertMode();
            uiManager?.updateStatusBar();
        })
    );

	// Scan workspace for existing metadata files
    await metadataManager.scanWorkspaceForFiles();

	await undoRedoManager.init();
	uiManager.initStatusBar();

	// Apply highlights to currently active editor on startup
    if (vscode.window.activeTextEditor) {
        overlayManager.updateHighlightsForEditor(vscode.window.activeTextEditor);
    }

	console.log('[debug-toggle] activate() finished');

	// 5. Override undo command
    context.subscriptions.push(
        vscode.commands.registerCommand('hiddenOverlay.undo', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
			const filePath = editor.document.uri.fsPath;

			await undoRedoManager?.undo(filePath);
            uiManager?.updateStatusBar();
            overlayManager?.updateHighlightsForEditor(editor);
        })
    );

	// 6. Override redo command
    context.subscriptions.push(
        vscode.commands.registerCommand('hiddenOverlay.redo', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
			const filePath = editor.document.uri.fsPath;

            await undoRedoManager?.redo(filePath);
            uiManager?.updateStatusBar();
            overlayManager?.updateHighlightsForEditor(editor);
        })
    );

	//7. Wire up edit interceptions
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length === 0) return;
			if (!metadataManager.shouldTrackFile(event.document.uri.fsPath)) return;
			if (undoRedoManager?.isPerformingUndoRedo()) return;

			const doc = event.document;
            const editor = vscode.window.activeTextEditor;

			// Record state before edit
            if (editor && editor.document.uri.toString() === doc.uri.toString()) {
                const cursorOffset = doc.offsetAt(editor.selection.active);
                undoRedoManager?.recordBeforeEdit(doc.uri.fsPath, cursorOffset);
            }

			const isDebug = overlayManager?.shouldInsertAsDebug() ?? false;
			metadataManager?.handleTextDocumentChange(event.document, event.contentChanges, isDebug);
			overlayManager?.updateHighlightsForDocument(event.document);
		})
	);

	//8. Initialize ledgers for open documents
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(async (document) => {
			if (!metadataManager.shouldTrackFile(document.uri.fsPath)) return;
			await metadataManager?.ensureLedgerForDoc(document);
		})
	);

	// 9. Clear history when file is closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            undoRedoManager?.clearHistory(document.uri.fsPath);
        })
    );

	// 10. Init ledgers for already open documents
	for (const document of vscode.workspace.textDocuments) {
		if (!metadataManager.shouldTrackFile(document.uri.fsPath)) continue;
		await metadataManager?.ensureLedgerForDoc(document);
	}

	// 11. Update highlights when user switches between editor tabs
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                overlayManager?.updateHighlightsForEditor(editor);
            }
        })
    );

	// 12. Update highlights when visible editors change (e.g., split view)
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) {
                overlayManager?.updateHighlightsForEditor(editor);
            }
        })
    );

	// 13. Command to toggle metadata visibility in file explorer
	context.subscriptions.push(
		vscode.commands.registerCommand('hiddenOverlay.toggleMetadataVisibility', async () => {
			const config = vscode.workspace.getConfiguration('files');
            const currentExclude = config.get<Record<string, boolean>>('exclude') ?? {};
            
            const isHidden = currentExclude['**/__debuggable__'] === true;
            
            const newExclude = {
                ...currentExclude,
                '**/__debuggable__': !isHidden
            };

            await config.update('exclude', newExclude, vscode.ConfigurationTarget.Workspace);
            
            vscode.window.showInformationMessage(
                `Metadata folders are now ${!isHidden ? 'hidden' : 'visible'}`
            );
		})
	);

	console.log('[debug-toggle] activate() complete');

	context.subscriptions.push(
        vscode.commands.registerCommand('hiddenOverlay.runPerformanceTests', async () => {
            if (metadataManager && overlayManager) {
                await runAllPerformanceTests(context, metadataManager, overlayManager);
            }
        })
    );
}

function getWebviewContent() {
	return web.getWebContent();
}



export function deactivate(): void {
	console.log('[debug-toggle] deactivate() called');

	uiManager?.dispose();
	overlayManager?.dispose();
	metadataManager?.dispose();
	undoRedoManager?.dispose();
	// trackerManager?.dispose();

	uiManager = null;
	overlayManager = null;
	metadataManager = null;
	// trackerManager = null;
	undoRedoManager = null;
}
