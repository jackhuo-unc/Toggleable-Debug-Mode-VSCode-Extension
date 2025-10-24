// This will own your metadata files:

// Char ledger (IDs for every char, plus flags like debug/non-debug, deleted).
// Mode delta map (how to go from Debug Off ↔ Debug On).
// Complete change log (edit history, mode toggles, etc.).

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CharRecord {
	id: string;
	ch: string;
	isDeleted: boolean;
	isDebug: boolean;
}

export interface FileCharLedger {
	filePath: string;          // absolute or workspace-relative
	chars: CharRecord[];       // includes tombstoned chars
}

export interface ModeDeltaOp {
	op: 'insert' | 'delete';   // can expand later. The assumption in debug code is that you never delete any non-debug code, only insert new debugging code.
	targetBefore: string;      // e.g. insert after this char ID, or delete range start ID
	payload?: any;             // flexible; maybe list of char IDs or text
}

export interface ModeDeltaFile {
	filePath: string;
	opsDebugOnToOff: ModeDeltaOp[];
	opsOffToDebugOn: ModeDeltaOp[];
}

export interface ChangeLogEntry {
	timestamp: number;          // not as needed
	action: string;
	data: Record<string, unknown>;
}

export class MetadataManager {
    private readonly context: vscode.ExtensionContext;
	private readonly storageDir: string;

	// in-memory caches
	private charLedgers: Map<string, FileCharLedger> = new Map();
	private modeDeltas: Map<string, ModeDeltaFile> = new Map();
	private changeLog: ChangeLogEntry[] = [];

    constructor(context: vscode.ExtensionContext) {
		this.context = context;

		// We'll put metadata next to the workspace in a hidden folder for now.
		// You can tune this (or wire to LogNameManager if it already sets up dirs).
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const rootFsPath = workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath;
		this.storageDir = path.join(rootFsPath, '.hidden-code');

		// console.log('[hidden-overlay][MetadataManager] constructed, storageDir =', this.storageDir);
	}

	public async init(): Promise<void> {
		console.log('[hidden-overlay][MetadataManager] init()');
		await this.ensureStorageDir();

		// TODO: load existing ledgers, deltas, and changelog from disk if present.
		// this.charLedgers = ...
		// this.modeDeltas = ...
		// this.changeLog = ...
	}

    private async ensureStorageDir(): Promise<void> {
		await fs.promises.mkdir(this.storageDir, { recursive: true });
	}

    public getCharLedgerForFile(filePath: string): FileCharLedger | undefined {
		return this.charLedgers.get(filePath);
	}

    public setCharLedgerForFile(ledger: FileCharLedger): void {
		// console.log('[hidden-overlay][MetadataManager] setCharLedgerForFile', ledger.file
        // Path);
		this.charLedgers.set(ledger.filePath, ledger);
		// TODO: persist to disk
	}

    public getModeDeltaForFile(filePath: string): ModeDeltaFile | undefined {
		return this.modeDeltas.get(filePath);
	}

    public setModeDeltaForFile(delta: ModeDeltaFile): void {
		// console.log('[hidden-overlay][MetadataManager] setModeDeltaForFile', delta.filePath);
		this.modeDeltas.set(delta.filePath, delta);
		// TODO: persist to disk
	}

    public appendChangeLog(entry: ChangeLogEntry): void {
		console.log('[hidden-overlay][MetadataManager] appendChangeLog', entry);
		this.changeLog.push(entry);
		// TODO: persist incrementally
	}

    public getChangeLog(): ChangeLogEntry[] {
		return this.changeLog;
	}

	public dispose(): void {
		console.log('[hidden-overlay][MetadataManager] dispose()');
		// optional: flush caches to disk on deactivate
	}
}
