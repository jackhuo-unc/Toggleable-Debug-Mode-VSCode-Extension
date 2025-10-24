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

	constructor(context: vscode.ExtensionContext, metadataManager: MetadataManager) {
		this.context = context;
		this.metadataManager = metadataManager;
		console.log('[hidden-overlay][HiddenCodeOverlay] constructed');
	}

	public async init(): Promise<void> {
		console.log('[hidden-overlay][HiddenCodeOverlay] init()');
		// TODO: load last-known mode from workspaceState/globalState if you want persistence
		const saved = this.context.workspaceState.get<DebugMode>('hiddenOverlay.debugMode');
		if (saved === 'debugOn' || saved === 'debugOff') {
			this.debugMode = saved;
		}
		console.log('[hidden-overlay][HiddenCodeOverlay] initial mode =', this.debugMode);
	}

	public getMode(): DebugMode {
		return this.debugMode;
	}

	public async toggleDebugMode(): Promise<void> {
		this.debugMode = this.debugMode === 'debugOn' ? 'debugOff' : 'debugOn';
		console.log('[hidden-overlay][HiddenCodeOverlay] toggleDebugMode ->', this.debugMode);

		//persist mode
		await this.context.workspaceState.update('hiddenOverlay.debugMode', this.debugMode);

		// TODO:
		// - rebuild virtual "debug on" or "debug off" view of open editors
		// - update decorations / ghosted overlay visual
		// - optionally append to metadata changeLog with timestamp
		this.metadataManager.appendChangeLog({
			timestamp: Date.now(),
			action: 'toggleDebugMode',
			data: { mode: this.debugMode }
		});

		// Apply changes to active editor
		await this.applyDebugView();
	}

	/**
	 * Example hook to fill in later
	 * Generate the "instrumented" (debug-on) text for a file by applying overlay chars.
	 */
	public buildInstrumentedTextForFile(absPath: string): string | null {
		console.log('[hidden-overlay][HiddenCodeOverlay] buildInstrumentedTextForFile', absPath);

		// TODO:
		// 1. read char ledger for absPath from MetadataManager
		// 2. read overlay/mode delta info
		// 3. synthesize final "debug on" string
		// For now just stub:
		return null;
	}

	/**
 * Build and apply the "debug on/off" view to the currently open file.
 */
	private async applyDebugView(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			console.warn('[hidden-overlay][HiddenCodeOverlay] no active editor found');
			return;
		}

		const filePath = editor.document.uri.fsPath;
		console.log('[hidden-overlay][HiddenCodeOverlay] applying view for', filePath);

		// For now, seed a fake ledger (once per file)
		let ledger = this.metadataManager.getCharLedgerForFile(filePath);
		if (!ledger) {
			this.metadataManager.seedLedgerForFile(filePath);
			ledger = this.metadataManager.getCharLedgerForFile(filePath);
		}

		if (!ledger) {
			console.warn('[hidden-overlay][HiddenCodeOverlay] ledger still missing after seed');
			return;
		}

		const showDebug = this.debugMode === 'debugOn';

		// Build text string based on mode
		const visibleChars = ledger.chars
			.filter(c => !c.isDeleted && (showDebug || !c.isDebug))
			.sort((a, b) => a.id - b.id)
			.map(c => c.ch)
			.join('');

		// Replace entire document with the mode-specific text
		const fullRange = new vscode.Range(
			editor.document.positionAt(0),
			editor.document.positionAt(editor.document.getText().length)
		);

		await editor.edit(editBuilder => {
			editBuilder.replace(fullRange, visibleChars);
		});

		console.log(`[hidden-overlay][HiddenCodeOverlay] Applied debugMode=${this.debugMode} view.`);
	}

	public dispose(): void {
		console.log('[hidden-overlay][HiddenCodeOverlay] dispose()');
	}
}
