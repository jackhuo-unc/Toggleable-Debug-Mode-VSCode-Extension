// This is all UI-facing behavior:

// Status bar item that reflects current Debug Mode (ON/OFF).
// Webview panel (this keeps your catCoding.start functionality in a single, reusable place).
// Any future decorators / ghost overlays in the editor can also live here.

import * as vscode from 'vscode';
import { HiddenCodeOverlay } from './HiddenCodeOverlay';
import { getWebContent } from './web';
// import { MetadataManager } from './MetaDataManager';

export class UIManager {
    private readonly context: vscode.ExtensionContext;
    private hiddenCodeOverlay: HiddenCodeOverlay;
    private statusBarItem: vscode.StatusBarItem | null = null;
	private currentPanel: vscode.WebviewPanel | null = null;

    constructor(context: vscode.ExtensionContext, hiddenCodeOverlay: HiddenCodeOverlay) {
		this.context = context;
		this.hiddenCodeOverlay = hiddenCodeOverlay;
		console.log('[hidden-overlay][UIManager] constructed');
	}

    public initStatusBar(): void {
		console.log('[hidden-overlay][UIManager] initStatusBar()');

		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			100
		);
		this.statusBarItem.command = 'hiddenOverlay.toggleDebugMode';
		this.updateStatusBar();
		this.statusBarItem.show();

		this.context.subscriptions.push(this.statusBarItem);
	}

    public updateStatusBar(): void {
		if (!this.statusBarItem) {
			return;
		}
		const mode = this.hiddenCodeOverlay.getMode();
		this.statusBarItem.text = mode === 'debugOn'
			? '$(beaker) Debug Overlay: ON'
			: '$(beaker) Debug Overlay: OFF';
		this.statusBarItem.tooltip = 'Toggle Debug Overlay Mode';
	}

    /**
	 * Opens (or reveals) a simple webview panel.
	 * Mirrors your existing `catCoding.start` behavior, but isolated.
	 */
    public openCatCodingWebview(): void {
		// Reuse panel if it's already open
		if (this.currentPanel) {
			this.currentPanel.reveal(vscode.ViewColumn.One);
			console.log('[hidden-overlay][UIManager] revealing existing webview');
			return;
		}

		console.log('[hidden-overlay][UIManager] creating new webview panel');

		this.currentPanel = vscode.window.createWebviewPanel(
			'hiddenOverlay.catCoding',
			'Cat Coding 🐱',
			vscode.ViewColumn.One,
			{
				enableScripts: true
			}
		);

		this.currentPanel.webview.html = getWebContent();
		this.currentPanel.onDidDispose(
			() => {
				console.log('[hidden-overlay][UIManager] webview disposed');
				this.currentPanel = null;
			},
			null,
			this.context.subscriptions
		);
	}

    public dispose(): void {
		console.log('[hidden-overlay][UIManager] dispose()');
		if (this.currentPanel) {
			this.currentPanel.dispose();
			this.currentPanel = null;
		}
		// statusBarItem is disposed by context.subscriptions automatically, but we'll be safe:
		if (this.statusBarItem) {
			this.statusBarItem.dispose();
			this.statusBarItem = null;
		}
	}
}