//TODO: chrome logging
//TODO: publish
//TODO: hook up to backend
//TODO: front end for student teacher communication
//TODO: add aggregation of inputs
//TODO: track active time spent coding

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as JSONStream from 'JSONStream';
// import * as https from 'https';
// import * as os from 'os';
// import { send } from 'process';
// import { LOADIPHLPAPI } from 'dns';
// import { serialize } from 'v8';
import * as web from './web';
// import { exec } from 'child_process';
// import { glob } from 'glob';
import { LogNameManager } from './LogNameManager';
import { TrackerManager } from './TrackerManager';
import { UIManager } from './UIManager';
import { HiddenCodeOverlay } from './HiddenCodeOverlay';
import { MetadataManager } from './MetadataManager';
// import { error } from 'console';

let trackerManager: TrackerManager | null = null;
let metadataManager: MetadataManager | null = null;
let overlayManager: HiddenCodeOverlay | null = null;
let uiManager: UIManager | null = null;

const axios = require('axios');
// const { createHash } = require('crypto');
const chokidar = require('chokidar');
let terminalSessions: string[] = [];
let terminalSessionWatcher;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	console.log('[debug-toggle] activate() called');

	// 1. Initialize metadata / overlay core
	metadataManager = new MetadataManager(context);
	overlayManager = new HiddenCodeOverlay(context, metadataManager);

	// 3. Initialize UI (status bar, webview commands, etc.)
	uiManager = new UIManager(context, overlayManager);


	// 4. Register extension commands here
	// context.subscriptions.push(
	// 	vscode.commands.registerCommand('catCoding.start', async () => {
	// 		console.log('[debug-toggle] command catCoding.start fired');
	// 		uiManager?.openCatCodingWebview();
	// 	})
	// );

	context.subscriptions.push(
		vscode.commands.registerCommand('catCoding.start', () => {
			const panel = vscode.window.createWebviewPanel(
				'catCoding',
				'Action Tracking',
				vscode.ViewColumn.One,
				{
					enableScripts: true
				}
			);
			let username = LogNameManager.readUsername();
			panel.webview.html = getWebviewContent();
			panel.webview.postMessage({
				username: username,
			});
			// Handle messages from the webview
			panel.webview.onDidReceiveMessage(
				message => {
					console.log(message);
					LogNameManager.updateUsername(message);
				},
				undefined,
				context.subscriptions
			);
		})
	);

	context.subscriptions.push(
        vscode.commands.registerCommand('hiddenOverlay.toggleDebugMode', async () => {
            await overlayManager?.toggleDebugMode();
            uiManager?.updateStatusBar();
        })
    );

	// Perform any async initialization that needs to happen after wiring
	await metadataManager.init();

	// Scan workspace for existing metadata files
    await metadataManager.scanWorkspaceForFiles();

	await overlayManager.init();
	uiManager.initStatusBar();

	console.log('[debug-toggle] activate() finished');

	//5. Wire up edit interceptions
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length === 0) return;
			const isDebug = overlayManager?.getMode() === 'debugOn';
			metadataManager?.handleTextDocumentChange(event.document, event.contentChanges, isDebug);
			overlayManager?.updateHighlightsForDocument(event.document);
		})
	);

	//6. Initialize ledgers for open documents
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(async (document) => {
			await metadataManager?.ensureLedgerForDoc(document);
		})
	);

	// Init ledgers for already open documents
	for (const document of vscode.workspace.textDocuments) {
		await metadataManager?.ensureLedgerForDoc(document);
	}

	// 7. Update highlights when user switches between editor tabs
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                overlayManager?.updateHighlightsForEditor(editor);
            }
        })
    );

	// 8. Update highlights when visible editors change (e.g., split view)
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) {
                overlayManager?.updateHighlightsForEditor(editor);
            }
        })
    );

	console.log('[debug-toggle] activate() complete');

	// Save all static info in path in local machine
	LogNameManager.initializeFileStore();
	if (LogNameManager.getStaticInfo() === null) {
		LogNameManager.setStaticInfo();
		LogNameManager.saveStaticInfo();
	} else {
		let infos = LogNameManager.getStaticInfo();
		LogNameManager.machineId = infos[0];
		LogNameManager.username = infos[1];
	}

	if (LogNameManager.getDynamicInfo() === null) {
		LogNameManager.setDynamicInfo();
		LogNameManager.saveDynamicInfo();
	} else {
		let infos = LogNameManager.getDynamicInfo();
		LogNameManager.courseID = infos[0];
		LogNameManager.assignmentID = infos[1];
		LogNameManager.logSessionID = infos[2];
	}

	// 2. Initialize tracker (file edits, terminals, logging, etc.)
	trackerManager = new TrackerManager();

	// Setup log file for project under project directory
	if (!fs.existsSync(vscode.workspace.workspaceFolders[0].uri.fsPath + path.sep + "log")) {
		fs.mkdirSync(vscode.workspace.workspaceFolders[0].uri.fsPath + path.sep + "log");
	}

	trackerManager.editLogPath = vscode.workspace.workspaceFolders[0].uri.fsPath + path.sep + "log" + path.sep + 'editLog.json';



	// TODO: need to implement separate command for playing back actions.
	// reconstruction will happen by first turning off the logging, then building, then turning logging back on

	// context.subscriptions.push(
	// 	vscode.commands.registerCommand('tracker.replayActions', function (args) {
	// 		tracker.dispose();
	// 		tracker.replayActions();
	// 		tracker.initialize();
	// 	})
	// );
	await trackerManager.init();
	context.subscriptions.push(trackerManager);
}

function getWebviewContent() {
	return web.getWebContent();
}



export function deactivate(): void {
	console.log('[debug-toggle] deactivate() called');

	uiManager?.dispose();
	overlayManager?.dispose();
	metadataManager?.dispose();
	trackerManager?.dispose();

	uiManager = null;
	overlayManager = null;
	metadataManager = null;
	trackerManager = null;
}
