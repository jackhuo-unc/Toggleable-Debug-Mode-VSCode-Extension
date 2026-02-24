import * as vscode from 'vscode';
import { HiddenCodeOverlay } from './HiddenCodeOverlay';
import { getWebContent } from './web';

export class UIManager {
    private readonly context: vscode.ExtensionContext;
    private hiddenCodeOverlay: HiddenCodeOverlay;
    private debugModeStatusBar: vscode.StatusBarItem | null = null;
	private insertModeStatusBar: vscode.StatusBarItem | null = null;
	private currentPanel: vscode.WebviewPanel | null = null;

    constructor(context: vscode.ExtensionContext, hiddenCodeOverlay: HiddenCodeOverlay) {
		this.context = context;
		this.hiddenCodeOverlay = hiddenCodeOverlay;
		console.log('[hidden-overlay][UIManager] constructed');
	}

    public initStatusBar(): void {
		console.log('[hidden-overlay][UIManager] initStatusBar()');

		//Debug mode status bar (left)
		this.debugModeStatusBar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			100
		);
		this.debugModeStatusBar.command = 'hiddenOverlay.toggleDebugMode';
		this.context.subscriptions.push(this.debugModeStatusBar);

		//Insert mode status bar (left, next to debug mode)
		this.insertModeStatusBar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			99
		);
		this.insertModeStatusBar.command = 'hiddenOverlay.toggleInsertMode';
		this.context.subscriptions.push(this.insertModeStatusBar);

		this.updateStatusBar();
		this.debugModeStatusBar.show();
		this.insertModeStatusBar.show();
	}

    public updateStatusBar(): void {
		const debugMode = this.hiddenCodeOverlay.getMode();
		const insertMode = this.hiddenCodeOverlay.getInsertMode();

		if (this.debugModeStatusBar) {
            if (debugMode === 'debugOn') {
                this.debugModeStatusBar.text = '$(eye) Debug: ON';
                this.debugModeStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else {
                this.debugModeStatusBar.text = '$(eye-closed) Debug: OFF';
                this.debugModeStatusBar.backgroundColor = undefined;
            }
            this.debugModeStatusBar.tooltip = 'Click to toggle debug code visibility';
        }

		if (this.insertModeStatusBar) {
            if (debugMode === 'debugOff') {
                // In debug off mode, insert mode is always normal and disabled
                this.insertModeStatusBar.text = '$(edit) Insert: Normal';
                this.insertModeStatusBar.backgroundColor = undefined;
                this.insertModeStatusBar.tooltip = 'Switch to Debug ON mode to insert debug code';
            } else if (insertMode === 'insertDebug') {
                this.insertModeStatusBar.text = '$(beaker) Insert: DEBUG';
                this.insertModeStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                this.insertModeStatusBar.tooltip = 'Click to switch to normal code insertion';
            } else {
                this.insertModeStatusBar.text = '$(edit) Insert: Normal';
                this.insertModeStatusBar.backgroundColor = undefined;
                this.insertModeStatusBar.tooltip = 'Click to switch to debug code insertion';
            }
        }
	}

    /**
	 * Opens (or reveals) a simple webview panel.
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
	
		if (this.debugModeStatusBar) {
			this.debugModeStatusBar.dispose();
			this.debugModeStatusBar = null;
		}

		if (this.insertModeStatusBar) {
			this.insertModeStatusBar.dispose();
			this.insertModeStatusBar = null;
		}
	}
}