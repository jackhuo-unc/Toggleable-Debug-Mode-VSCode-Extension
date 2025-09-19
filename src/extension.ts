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
import * as https from 'https';
import * as os from 'os';
import { send } from 'process';
import { LOADIPHLPAPI } from 'dns';
import { serialize } from 'v8';
import * as web from './web';
import { exec } from 'child_process';
import { glob } from 'glob';
import { LogNameMannager } from './LogNameManager';
import { error } from 'console';


const axios = require('axios');
const { createHash } = require('crypto');
const chokidar = require('chokidar');
let terminalSessions: string[] = [];
let terminalSessionWatcher;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	//Init web (For non-static info)
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
			let username = LogNameMannager.readUsername();
			panel.webview.html = getWebviewContent();
			panel.webview.postMessage({
				username: username,
			});
			// Handle messages from the webview
			panel.webview.onDidReceiveMessage(
				message => {
					console.log(message);
					LogNameMannager.updateUsername(message);
				},
				undefined,
				context.subscriptions
			);
		})
	);

	// Save all static info in path in local machine
	LogNameMannager.initializeFileStore();
	if (LogNameMannager.getStaticInfo() === null) {
		LogNameMannager.setStaticInfo();
		LogNameMannager.saveStaticInfo();
	} else {
		let infos = LogNameMannager.getStaticInfo();
		LogNameMannager.machineId = infos[0];
		LogNameMannager.username = infos[1];
	}

	if (LogNameMannager.getDynamicInfo() === null) {
		LogNameMannager.setDynamicInfo();
		LogNameMannager.saveDynamicInfo();
	} else {
		let infos = LogNameMannager.getDynamicInfo();
		LogNameMannager.courseID = infos[0];
		LogNameMannager.assignmentID = infos[1];
		LogNameMannager.logSessionID = infos[2];
	}

	// Setup log file for project under project directory
	let tracker = new Tracker();
	context.subscriptions.push(
		vscode.commands.registerCommand('catCoding.toggleDebugMode', () => {
			tracker.toggleDebugMode();
		})
	);
	if (!fs.existsSync(vscode.workspace.workspaceFolders[0].uri.fsPath + path.sep + "log")) {
		fs.mkdirSync(vscode.workspace.workspaceFolders[0].uri.fsPath + path.sep + "log");
	}

	tracker.editLogPath = vscode.workspace.workspaceFolders[0].uri.fsPath + path.sep + "log" + path.sep + 'editLog.json';



	// TODO: need to implement separate command for playing back actions.
	// reconstruction will happen by first turning off the logging, then building, then turning logging back on

	// context.subscriptions.push(
	// 	vscode.commands.registerCommand('tracker.replayActions', function (args) {
	// 		tracker.dispose();
	// 		tracker.replayActions();
	// 		tracker.initialize();
	// 	})
	// );
	context.subscriptions.push(tracker);
	tracker.initialize();
}

function getWebviewContent() {
	return web.getWebContent();
}

interface DebugEdit {
	documentUri: vscode.Uri;
	range: vscode.Range;
	oldText: string;
	newText: string;
}

export class Tracker {
	private disposable: vscode.Disposable;
	constructor() { }
	private editLogFile;
	public editLogPath;
	private fsWatcher;
	private debugMode: boolean = false;
	private debugEdits: DebugEdit[] = [];
	private debugEditListener: vscode.Disposable | undefined;
	//TODO: set the above equal to fs.watch in initialize, and then close it when dispose method is called.
	private readonly maxLogFileSize = 19;

	public initialize(): void {
		this.editLogFile = fs.createWriteStream(this.editLogPath, { flags: 'a' });
		this.initializeTerminalLog();
		this.setupOverridenCommands();
		this.sendLogFileToServer();
		this.detactTerminalExceptions();
		// setInterval(async () => {
		// 	const result = await this.sendLogFileToServer();

		// 	// Perform actions based on the result
		// 	if (result === true) {
		// 	  // Perform specific action
		// 	  LogNameMannager.updateLogSessionID();
		// 	  fs.writeFileSync(this.editLogPath, '');
		// 	}
		//   }, 10000);
	}

	public async toggleDebugMode(): Promise<void> {
		this.debugMode = !this.debugMode;
		const mode = this.debugMode ? "debug on" : "debug off";
		this.logEdits('Mode Change', mode, "", false);

		if(this.debugMode) {
			await this.rollForwardDebugEdits();
			this.startDebugEditTracking();
		} else {
			await this.rollbackDebugEdits();
			this.stopDebugEditTracking();
		}
		this.writeDebugEditsToFile();
		vscode.window.showInformationMessage(`Debug mode is now ${this.debugMode ? "ON" : "OFF"}`);
	}

	private startDebugEditTracking() {
		this.debugEdits = [];
		const activeDocUri = vscode.window.activeTextEditor?.document.uri.toString();
		this.debugEditListener = vscode.workspace.onDidChangeTextDocument(event => {
			if (!this.debugMode) {return;}
			//For now, only track edits for the currently active file.
			if (event.document.uri.toString() !== activeDocUri) {return;}
			for (const change of event.contentChanges) {
				const oldText = event.document.getText(change.range);
				this.debugEdits.push({
					documentUri: event.document.uri,
					range: change.range,
					oldText: oldText,
					newText: change.text
				});
			}
		});
	}

	private stopDebugEditTracking() {
		if (this.debugEditListener) {
			this.debugEditListener.dispose();
			this.debugEditListener = undefined;
		}
	}

	private async rollbackDebugEdits() {
		const activeDocUri = vscode.window.activeTextEditor?.document.uri.toString();
		//Roll back in reverse order
		for (const edit of this.debugEdits.slice().reverse()) {
			if (edit.documentUri.toString() !== activeDocUri) { continue; }
			const doc = await vscode.workspace.openTextDocument(edit.documentUri);
			const editor = await vscode.window.showTextDocument(doc, { preview: false });
			await editor.edit(editBuilder => {
				editBuilder.replace(edit.range, edit.oldText);
			});
		}
	}

	private async rollForwardDebugEdits() {
		const activeDocUri = vscode.window.activeTextEditor?.document.uri.toString();
		//Reapply edits
		for (const edit of this.debugEdits) {
			if (edit.documentUri.toString() !== activeDocUri) { continue; }
			const doc = await vscode.workspace.openTextDocument(edit.documentUri);
			const editor = await vscode.window.showTextDocument(doc, { preview: false });
			await editor.edit(editBuilder => {
				editBuilder.replace(edit.range, edit.newText);
			});
		}
	}

	private writeDebugEditsToFile() {
		const debugEditsPath = path.join(
			vscode.workspace.workspaceFolders[0].uri.fsPath || '',
			"log",
			"debugEdits.json"
		);

		const serializableEdits = this.debugEdits.map(edit => ({
			documentUri: edit.documentUri.toString(),
			range: {
				start: { line: edit.range.start.line, character: edit.range.start.character },
				end: { line: edit.range.end.line, character: edit.range.end.character }
			},
			oldText: edit.oldText,
			newText: edit.newText
		}));
		fs.writeFileSync(debugEditsPath, JSON.stringify(serializableEdits, null, 2));
	}

	public dispose(): void {
		this.disposable.dispose();
		this.fsWatcher.dispose();
	}

	private fileWatcher(): void {
		for (let file of terminalSessions){
			try {
				let content = fs.readFileSync(file, 'utf8');
			} catch (err) {
				console.error(`Error reading file at ${file}:`, err);
			}
		}
	}

	private async initializeTerminalLog(): Promise<void> {
		var workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
		var curTerminal = vscode.window.terminals[vscode.window.terminals.length - 1];
		var terminalPid = await curTerminal.processId;
		var fileName = terminalPid + ".txt";
		var filePath = path.join(workspaceFolder, "VSCODE-config", "IO-Log", fileName);
		fs.writeFileSync(filePath, '');
		fs.chmodSync(filePath, '777');
		curTerminal.sendText("script -q -F -t 0 " + filePath);
		let args = {
			'pid': terminalPid
		};
		this.logEdits("openTerminal", JSON.stringify(args));
	}

	private async sendLogFileToServer(): Promise<boolean> {
		// console.log(fs.readFile(this.editLogPath).toString())
		let exceedSize = false;
		if (!fs.existsSync(this.editLogFile)) {
			return;
		}
		fs.readFile(this.editLogPath, (err, data) => {
			if (err) {
				console.log(err);
				return;
			}
			if (data.length === 0) { return; }

			let dataContent = '[' + data.toString().substring(0, data.length - 1) + ']';
			dataContent = JSON.parse(dataContent);
			// console.log(dataContent);

			let content = JSON.stringify({
				"body": {
					"password": "password",
					"course_id": LogNameMannager.courseID, // need to specification on the course
					"machine_id": LogNameMannager.machineId, // hashed mac address
					"log_id": LogNameMannager.username + '_' + LogNameMannager.courseID + '_' + LogNameMannager.assignmentID + '_' + LogNameMannager.logSessionID, // db assumes unique, override if same
					"log_type": "VSCODE_TEST", // VSCODE
					"log": {
						"Sample": dataContent
					}
				}
			});
			// let config = {
			// method: 'post',
			// maxBodyLength: Infinity,
			// url: 'https://us-south.functions.appdomain.cloud/api/v1/web/ORG-UNC-dist-seed-james_dev/cyverse/add-cyverse-log',
			// headers: { 
			// 	'Content-Type': 'application/json'
			// },
			// data : content
			// };

			// axios.request(config)
			// .then((response) => {
			// // console.log(JSON.stringify(response.data));
			// })
			// .catch((error) => {
			// console.log(error);
			// });
			fs.stat(this.editLogPath, (err, stats) => {
				if (err) {
					console.error('Error occurred while getting file stats:', err);
					return;
				}
				const fileSizeInBytes = stats.size;
				const fileSizeInKilobytes = fileSizeInBytes / 1024;
				const fileSizeInMegabytes = fileSizeInKilobytes / 1024;
				if (fileSizeInMegabytes >= this.maxLogFileSize) {
					exceedSize = true;
				}
			});

		});
		return exceedSize;
	}

	private detactTerminalExceptions(): void {
		const onFileChange = (path) => {
			console.log(`File ${path} has been changed. Reading new content...`);
			fs.readFile(path, 'utf8', (err, data) => {
				if (err) {
					console.error(`Error reading file: ${err}`);
					return;
				}
				fs.appendFileSync(path, '');
				console.log(`New content in ${path}: ${data}`);
			});
		};
		terminalSessionWatcher = chokidar.watch(terminalSessions, {
			ignored: /(^|[\/\\])\../, // ignore dotfiles
			persistent: true
		});
		terminalSessionWatcher
		.on('change', onFileChange)
		.on('error', error => console.error(`Watcher error: ${error}`));
		console.log(`Watching for changes in the following files: ${terminalSessions.join(', ')}`);
	}

	private setupOverridenCommands(): void {
		let subscriptions: vscode.Disposable[] = [];

		//TODO: create a map with all opened textdocuments,
		//check to see if the document was changed after it was last opened/saved/closed
		// if so, log opening it. otherwise don't. use timestamps for both change, and last open.
		let textDocumentInfoMap = new Map();

		//TODO: this might be useful in the future to only limit tracking to certain workspace folders
		// vscode.workspace.onDidChangeWorkspaceFolders((event) => {
		// }, this, subscriptions);

		this.fsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], "**/*.{java,py,ts,js,csv,json,html,css}"));
		this.fsWatcher.onDidCreate(uri =>{
			var path = uri.path;
			var position = false;
			this.logEdits('createFile', 'createFile', path, position);
		});
		// this.fsWatcher.onDidChange(uri =>{
		// 	console.log("change" + uri);
		// });
		this.fsWatcher.onDidDelete(uri =>{
			var path = uri.path;
			var position = false;
			this.logEdits('deleteFile', 'deleteFile', path, position);
		});

		//capture saving text doc
		vscode.workspace.onDidSaveTextDocument((event) => {
			let args = {
				'fileName': event.fileName,
				'contents': event.getText()
			};
			this.logEdits('save', JSON.stringify(args));
		}, this, subscriptions);
		//capture closing text doc
		vscode.workspace.onDidCloseTextDocument((event) => {
			let args = {
				'fileName': event.fileName,
				'contents': event.getText()
			};
			this.logEdits('close', JSON.stringify(args));
		}, this, subscriptions);
		//capture opening text doc
		vscode.workspace.onDidOpenTextDocument((event) => {
			let args = {
				'fileName': event.fileName,
				'contents': event.getText()
			};
			this.logEdits('open', JSON.stringify(args));
		}, this, subscriptions);

		//setting up paste command override

		var pasteDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardPasteAction', () => {
			vscode.env.clipboard.readText().then((text) => {
				this.logEdits('paste', text);
			});
			pasteDisposable.dispose();
			vscode.commands.executeCommand("editor.action.clipboardPasteAction").then(() => {
				pasteDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardPasteAction', pasteOverride);
				subscriptions.push(pasteDisposable);
			});
		});

		var pasteOverride = () => {
			vscode.env.clipboard.readText().then((text) => {
				this.logEdits('paste', text);
			});
			pasteDisposable.dispose();
			vscode.commands.executeCommand("editor.action.clipboardPasteAction").then(() => {
				pasteDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardPasteAction', pasteOverride);
				subscriptions.push(pasteDisposable);
			});
		};

		//setting up copy override

		var copyDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardCopyAction', async () => {
			copyDisposable.dispose();
			vscode.commands.executeCommand("editor.action.clipboardCopyAction").then(async () => {
				// let text = await vscode.env.clipboard.readText();
				vscode.env.clipboard.readText().then((text) => {
					this.logEdits('copy', text);
				});
				// console.log(text); 
				// this.logEdits('copy', text);
				copyDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardCopyAction', copyOverride);
				subscriptions.push(copyDisposable);
			});
		});

		var copyOverride = async () => {
			copyDisposable.dispose();
			vscode.commands.executeCommand("editor.action.clipboardCopyAction").then(async () => {
				// let text = await vscode.env.clipboard.readText();
				vscode.env.clipboard.readText().then((text) => {
					this.logEdits('copy', text);
				});
				// console.log(text);
				// this.logEdits('copy', text);
				copyDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardCopyAction', copyOverride);
				subscriptions.push(copyDisposable);
			});
		};

		//setting up input override
		//TODO: fix bug where you can select some text and then type a letter, which deletes the previous letters but this deletion isnt logged.
		var typeDisposable = vscode.commands.registerCommand('type', (args) => {
			this.logEdits('input', args.text);
			vscode.commands.executeCommand('default:' + 'type', args);
		});

		//setting up delete override

		var deleteDisposable = vscode.commands.registerCommand('deleteRight', () => {
			let editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			let selection = editor.selection;
			let text = editor.document.getText(selection);
			this.logEdits('delete', text);
			deleteDisposable.dispose();
			vscode.commands.executeCommand("deleteRight").then(() => {
				deleteDisposable = vscode.commands.registerCommand('deleteRight', deleteOverride);
				subscriptions.push(deleteDisposable);
			});
		});

		var deleteOverride = () => {
			let editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			let selection = editor.selection;
			let text = editor.document.getText(selection);
			this.logEdits('delete', text);
			deleteDisposable.dispose();
			vscode.commands.executeCommand("deleteRight").then(() => {
				deleteDisposable = vscode.commands.registerCommand('deleteRight', deleteOverride);
				subscriptions.push(deleteDisposable);
			});
		};

		//setting up backspace override

		var backspaceDisposable = vscode.commands.registerCommand('deleteLeft', () => {
			let editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			let position = editor.selection.start;

			let text;
			if (position.character === 0) {
				// If at the beginning of a line, prepare to delete the line
				if (position.line === 0) {
					// If at the beginning of the first line, nothing to delete
					return;
				}
				let line = editor.document.lineAt(position.line);
				text = line.text + '\n'; // Include the newline character in the deletion
			} else {
				// Calculate the position just before the cursor
				let positionBefore = position.translate(0, -1);
		
				// Get the text at the new position
				let range = new vscode.Range(positionBefore, position);
				text = editor.document.getText(range);
			}


			this.logEdits('backspace', text);
			backspaceDisposable.dispose();
			vscode.commands.executeCommand("deleteLeft").then(() => {
				backspaceDisposable = vscode.commands.registerCommand('deleteLeft', backspaceOverride);
				subscriptions.push(backspaceDisposable);
			});
		});

		var backspaceOverride = () => {
			let editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			let position = editor.selection.start;

			let text;
			if (position.character === 0) {
				// If at the beginning of a line, prepare to delete the line
				if (position.line === 0) {
					// If at the beginning of the first line, nothing to delete
					return;
				}
				let line = editor.document.lineAt(position.line);
				text = line.text + '\n'; // Include the newline character in the deletion
			} else {
				// Calculate the position just before the cursor
				let positionBefore = position.translate(0, -1);
		
				// Get the text at the new position
				let range = new vscode.Range(positionBefore, position);
				text = editor.document.getText(range);
			}

			this.logEdits('backspace', text);
			backspaceDisposable.dispose();
			vscode.commands.executeCommand("deleteLeft").then(() => {
				backspaceDisposable = vscode.commands.registerCommand('deleteLeft', backspaceOverride);
				subscriptions.push(backspaceDisposable);
			});
		};
		// TODO: record compile error when saving. 
		// TODO: get stdio
		//setting up undo override

		var undoDisposable = vscode.commands.registerCommand('undo', () => {
			this.logEdits('undo', null);
			vscode.commands.executeCommand('default:' + 'undo');
		});

		//setting up redo override

		var redoDisposable = vscode.commands.registerCommand('redo', () => {
			this.logEdits('redo', null);
			vscode.commands.executeCommand('default:' + 'redo');
		});

		//see api here: https://code.visualstudio.com/api/references/vscode-api#debug
		/*basically this attaches a listener to the debugger called a debugadaptertracker, which receives all the messages that are sent between the debugger and vscode. 
		I'm just listening in on the messages that are being passed and logging the ones that are part of the stderr, stdin, and stdout streams. There are other streams
		that can be listened to as well, but not 100% sure what they do.*/


		vscode.debug.onDidChangeBreakpoints((event) => {
			if(event.added.length !== 0){
				var lineNumber = event.added[0]["location"]["range"]["end"]["line"];
				let lineContent = vscode.window.activeTextEditor.document.lineAt(lineNumber)["b"];
				let args = {
					'lineNumber': lineNumber,
					'contents': lineContent
				};
				this.logEdits('addBreakpoint', JSON.stringify(args));
			}else if(event.removed.length !== 0){
				var lineNumber = event.removed[0]["location"]["range"]["end"]["line"];
				let lineContent = vscode.window.activeTextEditor.document.lineAt(lineNumber)["b"];
				let args = {
					'lineNumber': lineNumber,
					'contents': lineContent
				};
				this.logEdits('removeBreakpoint', JSON.stringify(args));
			}
		}, this, subscriptions);

		vscode.window.onDidOpenTerminal(async (event) => {
			var workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
			var terminalPid = await event.processId;
			var fileName = terminalPid + ".txt";
			var filePath = path.join(workspaceFolder, "VSCODE-config", "IO-Log", fileName);
			fs.writeFileSync(filePath, '');
			fs.chmodSync(filePath, '777');
			terminalSessions.push(filePath);
			this.detactTerminalExceptions();
			var curTerminal = vscode.window.terminals[vscode.window.terminals.length - 1];
			curTerminal.sendText("script -q -F -t 0 " + filePath);
			let args = {
				'pid': terminalPid
			};
			this.logEdits("openTerminal", JSON.stringify(args));

		},this,subscriptions);

		vscode.window.onDidCloseTerminal(async (event) => {
			var workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
			var curTerminal = vscode.window.terminals[vscode.window.terminals.length - 1];
			var terminalPid = await event.processId;
			var fileName = terminalPid + ".txt";
			var filePath = path.join(workspaceFolder, "VSCODE-config", "IO-Log", fileName);
			var data;
			let index = terminalSessions.indexOf(filePath);
			if(index > -1){
				terminalSessions.splice(index, 1);
			}
			this.detactTerminalExceptions();
			try{
				data = fs.readFileSync(filePath, "utf-8");
			}catch(e){
				fs.writeFile(filePath, "Unable to record terminal log.", (err)=>{
					console.log(err);
				});
				data = fs.readFileSync(filePath, "utf-8");
			}
			// console.log(data);
			this.logEdits("closeTerminal", data);
			// fs.rm(filePath, (error) => {
			// 	if(error){
			// 		console.log(error);
			// 	}
			// });
		}, this, subscriptions);
		// vscode.debug.onDidChangeActiveDebugSession((event) => {
		// 	console.log(event);
		// 	console.log("a change");
		// }, this, subscriptions);

		// vscode.debug.onDidTerminateDebugSession((event) =>{
		// 	console.log(vscode.window.terminals[0]);
		// }, this, subscriptions);

		// var debugConsoleDisposable = vscode.debug.registerDebugAdapterTrackerFactory('*', {
		// 	createDebugAdapterTracker:(session: vscode.DebugSession) => {
		// 		return {
		// 			onDidSendMessage:m => {
		// 				if (m.type === 'event' && m.event === 'output' && m.body.output) {
		// 					if (m.body.category === 'stderr' || m.body.category === 'stdin' || m.body.category === 'stdout') {
		// 						console.log(m);
		// 						this.logEdits('debugConsole', m);
		// 					}
		// 				}else if (m.event === 'exception'){
		// 					console.log("exception happened");
		// 				}
		// 			}
		// 		};
		// 	}
		// });
		// vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
		// 	if (event.event === 'runtimeException') {
		// 	  const exceptionDetails = event.body as DebugProtocol.ExceptionDetails;
		// 	  console.error('Runtime Exception:', exceptionDetails);
		// 	  // Handle the runtime exception here (e.g., display a notification, log it, etc.)
		// 	}
		//   });

		subscriptions.push(pasteDisposable);
		subscriptions.push(copyDisposable);
		subscriptions.push(typeDisposable);
		subscriptions.push(deleteDisposable);
		subscriptions.push(backspaceDisposable);
		// subscriptions.push(refactorDisposable);
		subscriptions.push(undoDisposable);
		subscriptions.push(redoDisposable);
		// subscriptions.push(debugConsoleDisposable);
		this.disposable = vscode.Disposable.from(...subscriptions);
	}

	private logEdits(type: String, args: any, path: String | void, position: boolean | void): void {
		let editor = vscode.window.activeTextEditor;
		if (editor) {
			let doc = editor.document;
			if (doc) {
				let text = editor.document.getText();
				let selection = editor.selection;
				if (selection) {
					let start = selection.start;
					if (start) {
						let pos = start.line + ',' + start.character;
						let uri = doc.uri;
						if (uri) {
							let path = uri.path;
							let json = {
								'command': type,
								'path': path,
								'time': new Date(Date.now()).toLocaleString(),
								'position': pos,
								'arguments': args
							};

							// For JSON output:
							//   const addHeaders = new Headers()
							//   addHeaders.append("Content-Type", "application/json");
							//   fetch('https://eo339ttlrnh0yvi.m.pipedream.net', {
							// 	method: 'POST',
							// 	headers: addHeaders,
							// 	body: JSON.stringify(json),
							//   });

							const data = JSON.stringify(json);

							// const options = {
							// 	hostname: "eo339ttlrnh0yvi.m.pipedream.net",
							// 	port: 443,
							// 	path: "/",
							// 	method: "POST",
							// 	headers: {
							// 	  "Content-Type": "application/json",
							// 	  "Content-Length": data.length,
							// 	},
							//   };

							//   const req = https.request(options);
							//   req.write(data);
							//   req.end();

							this.editLogFile.write(JSON.stringify(json) + ",");

							// For human-readable output: 
							//   this.editLogFile.write(
							// 	'###########\r\n'
							// 	+ 'path: ' + json.path + '\r\n'
							// 	+ 'time: ' + json.time + '\r\n'
							// 	+ 'position: ' + json.position + '\r\n'
							// 	+ 'command: ' + json.command + '\r\n'
							// 	+ 'arguments: ' + json.arguments + '\r\n'
							// 	+ '###########\r\n\n'
							//   );

							// this.editLogFile.write('!@#$!@#$!@#$\r\n' + path + '\r\n' + Date.now() + '\r\n'
							//   + pos + '\r\n' + text + '$#@!$#@!$#@!\r\n');
						}
					}
				}
			}
		}
	}

	public replayActions(/* TODO: possibly pass in the time that we want to recreate up to here.
		possibly pass in the index of the action that needs to be done up to this point, so that we can traverse through in steps */): void {
		//types of actions
		// rename, save, close, open
		// paste, copy, input, delete, backspace, undo, redo
		let readLogFile = fs.createReadStream(this.editLogPath, { flags: 'a+' });
		let parseJSONStream = JSONStream.parse();
		let replayMap = new Map();
		let replayDir = __dirname;

		parseJSONStream.on('data', (data) => {
			let mapFile;
			if (!replayMap.has(data.path)) {
				fs.writeFile(path.join(__dirname, 'replay', data.path), '', function (err) {
					if (err) {
						console.log(err);
					}
					console.log("The file was saved!");
				});
				mapFile = vscode.Uri.parse('untitled:' + path.join(__dirname, 'replay', data.path));
				replayMap.set(data.path, mapFile);
			} else {
				mapFile = replayMap.get(mapFile);
			}
			if (data.command === 'input') {
				vscode.workspace.openTextDocument(mapFile).then(document => {
					let edit = new vscode.WorkspaceEdit;
					edit.insert(mapFile, new vscode.Position(data.position.split(',')[0], data.position.split(',')[1]), data.arguments);
					vscode.workspace.applyEdit(edit);
				});
			} else if (data.command === 'copy') {

			} else if (data.command === 'paste') {

			} else if (data.command === 'delete') {

			} else if (data.command === 'backspace') {

			} else if (data.command === 'undo') {

			} else if (data.command === 'redo') {

			} else if (data.command === 'rename') {

			} else if (data.command === 'save') {

			} else if (data.command === 'close') {

			} else if (data.command === 'open') {

			}
		});
		readLogFile.pipe(parseJSONStream);
	}
}



// this method is called when your extension is deactivated
export function deactivate() { }
