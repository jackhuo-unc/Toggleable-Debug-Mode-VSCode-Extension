// This will own your metadata files:

// Char ledger (IDs for every char, plus flags like debug/non-debug, deleted).
// Mode delta map (how to go from Debug Off ↔ Debug On).
// Complete change log (edit history, mode toggles, etc.).

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuid } from 'uuid';

export interface CharRecord {
	id: string;
	ch: string;
	isDebug: boolean;
}

export interface FileCharLedger {
    filePath: string;
    chars: CharRecord[]; 
}

export interface DebugSegment {
    start: number; // inclusive offset in current document text
    end: number;   // exclusive offset in current document text
}

// export interface KeystrokeEvent {
//     kind: 'type' | 'deleteLeft' | 'deleteRight' | 'paste' | 'cut';
//     text: string;
//     uri: string;
//     selections: Array<{ start: vscode.Position; end: vscode.Position }>;
//     isDebug: boolean;
//     timestamp: number;
// }

// export interface FileCharLedger {
// 	filePath: string;          // absolute or workspace-relative
// 	chars: CharRecord[];       // includes tombstoned chars
// }

export class MetadataManager {
	private readonly context: vscode.ExtensionContext;
    private charLedgers: Map<string, FileCharLedger> = new Map();
    private saveQueue: Set<string> = new Set();
    private saveTimeout: NodeJS.Timeout | null = null;

    // Flag to prevent infinite loops when we programmatically edit files
    private isApplyingEdit: boolean = false;

	private readonly storageDir: string;

	// in-memory caches
	// private charLedgers: Map<string, FileCharLedger> = new Map();
	// private modeDeltas: Map<string, ModeDeltaFile> = new Map();
	// private changeLog: ChangeLogEntry[] = [];

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
        console.log('[MetadataManager] constructed');

		// We'll put metadata next to the workspace in a hidden folder for now.
		// You can tune this (or wire to LogNameManager if it already sets up dirs).
		// const workspaceFolders = vscode.workspace.workspaceFolders;
		// const rootFsPath = workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath;
		// this.storageDir = path.join(rootFsPath, '.hidden-code');

		// console.log('[hidden-overlay][MetadataManager] constructed, storageDir =', this.storageDir);
	}

	public async init(): Promise<void> {
		console.log('[MetadataManager] init()');
		// await this.ensureStorageDir();

		// TODO: load existing ledgers, deltas, and changelog from disk if present.
		// this.charLedgers = ...
		// this.modeDeltas = ...
		// this.changeLog = ...
	}

    //Get the __debuggable__ folder path for a given file
    private getMetadataDir(filePath: string): string {
        const dir = path.dirname(filePath);
        return path.join(dir, '__debuggable__');
    }

    //Get the metadata JSON file path for a given source file
    private getMetadataPath(filePath: string): string {
        const metaDir = this.getMetadataDir(filePath);
        const baseName = path.basename(filePath);
        return path.join(metaDir, `${baseName}.json`);
    }

    //Check if a file should be tracked (exclude metadata files, config, etc.)
    private shouldTrackFile(filePath: string): boolean {
        if (filePath.includes('__debuggable__')) return false;
        if (filePath.includes('VSCODE-config')) return false;
        if (filePath.includes('node_modules')) return false;
        if (filePath.endsWith('.git')) return false;
        if (filePath.includes(path.sep + 'log' + path.sep)) return false;
        return true;
    }

    /**
     * Get all file paths that have ledgers loaded
     */
    public getTrackedFilePaths(): string[] {
        return Array.from(this.charLedgers.keys());
    }

    /**
     * Ensure a ledger exists for this document.
     * - If metadata file exists on disk, load it and overwrite the source file
     * - If not, create ledger from current file content (all chars are debug=false)
     */
    public async ensureLedgerForDoc(doc: vscode.TextDocument): Promise<FileCharLedger | null> {
        const filePath = doc.uri.fsPath;

        if (!this.shouldTrackFile(filePath)) {
            return null;
        }

        // Already in memory?
        if (this.charLedgers.has(filePath)) {
            return this.charLedgers.get(filePath)!;
        }

        const metaPath = this.getMetadataPath(filePath);

        if (fs.existsSync(metaPath)) {
            // Load from metadata file (source of truth)
            console.log('[MetadataManager] Loading ledger from disk:', metaPath);
            return await this.loadLedgerFromDisk(filePath, metaPath);
        } else {
            // Create new ledger from current file content
            console.log('[MetadataManager] Creating new ledger for:', filePath);
            return this.createLedgerFromText(filePath, doc.getText());
        }
    }

       /**
     * Load ledger from disk and sync to source file
     */
    private async loadLedgerFromDisk(filePath: string, metaPath: string): Promise<FileCharLedger | null> {
        try {
            const raw = fs.readFileSync(metaPath, 'utf-8');
            const data = JSON.parse(raw) as FileCharLedger;

            this.charLedgers.set(filePath, data);

            // Metadata is canon—rebuild and overwrite source file
            // We do NOT do this immediately to avoid conflicts during init
            // Instead, the HiddenCodeOverlay will handle rebuilding on toggle

            const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
            const includeDebug = currentMode === 'debugOn';
            const rebuiltText = this.buildTextFromLedgerData(data, includeDebug);

            if (rebuiltText !== null) {
                fs.writeFileSync(filePath, rebuiltText, 'utf-8');
                console.log('[MetadataManager] Overwrote source file from metadata:', filePath);

                await this.refreshEditorForFile(filePath, rebuiltText);
            }

            return data;
        } catch (err) {
            console.error('[MetadataManager] Failed to load ledger:', err);
            return null;
        }
    }

    private async refreshEditorForFile(filePath: string, newText: string): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        
        // Find if this document is already open
        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        
        if (openDoc) {
            // Apply edit to replace entire content
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                openDoc.positionAt(0),
                openDoc.positionAt(openDoc.getText().length)
            );
            edit.replace(uri, fullRange, newText);

            this.isApplyingEdit = true;
            try {
                await vscode.workspace.applyEdit(edit);
                console.log('[MetadataManager] Refreshed editor for:', filePath);
            } finally {
                this.isApplyingEdit = false;
            }
        }
    }

    /**
     * Rebuild a file from its ledger and save to disk.
     * Used when toggling debug mode for files that may not be open.
     */
    public async rebuildAndSaveFile(filePath: string, includeDebug: boolean): Promise<void> {
        const ledger = this.charLedgers.get(filePath);
        if (!ledger) {
            console.warn('[MetadataManager] No ledger for:', filePath);
            return;
        }

        const newText = this.buildTextFromLedger(filePath, includeDebug);
        if (newText === null) {
            console.warn('[MetadataManager] Failed to build text for:', filePath);
            return;
        }

        // Check if file is open in an editor
        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);

        if (openDoc) {
            // File is open - use applyEditWithoutTracking to update editor
            const fullRange = new vscode.Range(
                openDoc.positionAt(0),
                openDoc.positionAt(openDoc.getText().length)
            );
            
            this.isApplyingEdit = true;
            try {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(openDoc.uri, fullRange, newText);
                await vscode.workspace.applyEdit(edit);
                await openDoc.save();
                console.log('[MetadataManager] Updated and saved open file:', filePath);
            } finally {
                this.isApplyingEdit = false;
            }
        } else {
            // File is not open - write directly to disk
            const fs = await import('fs');
            fs.writeFileSync(filePath, newText, 'utf-8');
            console.log('[MetadataManager] Wrote closed file to disk:', filePath);
        }
    }

    /**
     * Scan workspace for all files and ensure ledgers exist.
     * Call this on startup or when toggling to ensure all files are tracked.
     */
    public async scanWorkspaceForFiles(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for (const folder of workspaceFolders) {
            // Find all files, excluding common non-source directories
            const pattern = new vscode.RelativePattern(folder, '**/*');
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');

            for (const fileUri of files) {
                const filePath = fileUri.fsPath;
                
                if (!this.shouldTrackFile(filePath)) continue;
                
                // Skip directories and non-text files
                const fs = await import('fs');
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) continue;

                // Skip if already loaded
                if (this.charLedgers.has(filePath)) continue;

                // Check if metadata exists
                const metaPath = this.getMetadataPath(filePath);
                if (fs.existsSync(metaPath)) {
                    // Load existing ledger
                    await this.loadLedgerFromDisk(filePath, metaPath);
                }
                // Note: We don't create new ledgers here - only for files that already have metadata
            }
        }

        console.log(`[MetadataManager] Scanned workspace, tracking ${this.charLedgers.size} files`);
    }

    /**
     * Build text from ledger data (helper that takes ledger directly)
     */
    private buildTextFromLedgerData(ledger: FileCharLedger, includeDebug: boolean): string {
        const parts: string[] = [];
        for (const c of ledger.chars) {
            if (!includeDebug && c.isDebug) continue;
            parts.push(c.ch);
        }
        return parts.join('');
    }

    /**
     * Create a new ledger from text content
     */
    private createLedgerFromText(filePath: string, text: string): FileCharLedger {
        const chars: CharRecord[] = [];

        for (const ch of text) {
            chars.push({
                id: uuid(),
                ch,
                isDebug: false
            });
        }

        const ledger: FileCharLedger = { filePath, chars };
        this.charLedgers.set(filePath, ledger);

        // Save to disk
        this.queueSave(filePath);

        return ledger;
    }

	/**
     * Get ledger for a file (if loaded)
     */
    public getCharLedgerForFile(filePath: string): FileCharLedger | undefined {
        return this.charLedgers.get(filePath);
    }

    /**
     * Convert a visible offset to a ledger index.
     * In debugOff mode, we skip debug chars when counting.
     * 
     * @param filePath - The file path
     * @param visibleOffset - The offset in the visible text (what VS Code reports)
     * @param isDebugMode - Whether we're in debugOn mode
     * @returns The corresponding index in the ledger array
     */
    private visibleOffsetToLedgerIndex(
        filePath: string,
        visibleOffset: number,
        isDebugMode: boolean
    ): number {
        const ledger = this.charLedgers.get(filePath);
        if (!ledger) return visibleOffset;

        // In debugOn mode, all chars are visible, so offset === index
        if (isDebugMode) {
            return visibleOffset;
        }

        // In debugOff mode, we need to skip debug chars
        let visibleCount = 0;
        let ledgerIndex = 0;

        while (ledgerIndex < ledger.chars.length && visibleCount < visibleOffset) {
            if (!ledger.chars[ledgerIndex].isDebug) {
                visibleCount++;
            }
            ledgerIndex++;
        }

        return ledgerIndex;
    }

    /**
     * Count how many ledger entries correspond to a given visible length.
     * In debugOff mode, we skip debug chars.
     * 
     * @param filePath - The file path
     * @param startIndex - Starting index in the ledger
     * @param visibleLength - Number of visible chars to count
     * @param isDebugMode - Whether we're in debugOn mode
     * @returns Number of ledger entries that span this visible length
     */
    private countLedgerCharsForVisibleLength(
        filePath: string,
        startIndex: number,
        visibleLength: number,
        isDebugMode: boolean
    ): number {
        const ledger = this.charLedgers.get(filePath);
        if (!ledger) return visibleLength;

        // In debugOn mode, all chars are visible
        if (isDebugMode) {
            return visibleLength;
        }

        // In debugOff mode, count ledger entries until we've covered visibleLength visible chars
        let visibleCount = 0;
        let ledgerCount = 0;
        let index = startIndex;

        while (index < ledger.chars.length && visibleCount < visibleLength) {
            if (!ledger.chars[index].isDebug) {
                visibleCount++;
            }
            ledgerCount++;
            index++;
        }

        return ledgerCount;
    }

	/**
     * Handle VS Code document changes and update the ledger accordingly
     */
    public handleTextDocumentChange(
        doc: vscode.TextDocument,
        changes: readonly vscode.TextDocumentContentChangeEvent[],
        isDebug: boolean
    ): void {
        // Skip if this is our own edit
        if (this.isApplyingEdit) return;

        const filePath = doc.uri.fsPath;

        if (!this.shouldTrackFile(filePath)) {
            return;
        }

        const ledger = this.charLedgers.get(filePath);
        if (!ledger) {
            console.warn('[MetadataManager] No ledger for changed doc:', filePath);
            return;
        }

        const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
        const isDebugMode = currentMode === 'debugOn';

        // Process changes in reverse order to maintain correct offsets
        const sortedChanges = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);

        for (const change of sortedChanges) {
            const { rangeOffset, rangeLength, text } = change;

            // Convert visible offset to ledger index
            const ledgerStartIndex = this.visibleOffsetToLedgerIndex(filePath, rangeOffset, isDebugMode);

            // For deletion, we need to figure out how many ledger entries to remove
            // This is tricky: rangeLength is in visible chars, but we need to count ledger entries
            let deleteCount = 0;
            if (rangeLength > 0) {
                deleteCount = this.countLedgerCharsForVisibleLength(
                    filePath,
                    ledgerStartIndex,
                    rangeLength,
                    isDebugMode
                );
            }

            // Delete the old chars
            if (deleteCount > 0) {
                ledger.chars.splice(ledgerStartIndex, deleteCount);
            }

            // Insert new chars
            if (text.length > 0) {
                const newChars: CharRecord[] = [];
                for (const ch of text) {
                    newChars.push({
                        id: uuid(),
                        ch,
                        isDebug
                    });
                }
                ledger.chars.splice(ledgerStartIndex, 0, ...newChars);
            }
        }

        // Queue async save
        this.queueSave(filePath);

        console.log(`[MetadataManager] Updated ledger for ${path.basename(filePath)}, now ${ledger.chars.length} chars`);
    }

    /**
     * Build text from ledger, optionally filtering by debug mode
     */
    public buildTextFromLedger(filePath: string, includeDebug: boolean): string | null {
        const ledger = this.charLedgers.get(filePath);
        if (!ledger) return null;

        const parts: string[] = [];
        for (const c of ledger.chars) {
            if (!includeDebug && c.isDebug) continue;
            parts.push(c.ch);
        }
        return parts.join('');
    }

    public async applyEditWithoutTracking(
        uri: vscode.Uri,
        range: vscode.Range,
        newText: string
    ): Promise<void> {
        this.isApplyingEdit = true;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, range, newText);
            await vscode.workspace.applyEdit(edit);
        } finally {
            this.isApplyingEdit = false;
        }
    }

	// public rebuildTextFromLedger(filePath: string): string | null {
	// 	const ledger = this.charLedgers.get(filePath);
	// 	if (!ledger) return null;
	// 	return ledger.chars.filter(c => !c.isDeleted).sort((a, b) => a.offset - b.offset).map(c => c.ch).join('');
	// }

	// public buildLedgerFromText(filePath: string): void {
	// 	//Get the text from the file with the filePath
	// 	const fileUri = vscode.Uri.file(filePath);
	// 	vscode.workspace.fs.readFile(fileUri).then((data) => {
	// 		const text = data.toString();
	// 		const chars: CharRecord[] = [];
	// 		for (let i = 0; i < text.length; i++) {
	// 			const ch = text.charAt(i);
	// 			const id = uuid();
	// 			chars.push({ id, ch, offset: i, isDeleted: false, isDebug: false });
	// 		}
	// 		const ledger: FileCharLedger = { filePath, chars };
	// 		this.charLedgers.set(filePath, ledger);
	// 	});
	// }

    /**
     * Get debug segments (ranges of debug-only code) for highlighting.
     * Returns offsets in the VISIBLE text (for use with VS Code ranges).
     */
    public getDebugSegmentsForDocument(doc: vscode.TextDocument): DebugSegment[] {
        const filePath = doc.uri.fsPath;
        const ledger = this.charLedgers.get(filePath);
        if (!ledger) return [];

        // Debug segments are only visible/meaningful in debugOn mode
        // In that mode, all chars are visible, so we can count directly
        const segments: DebugSegment[] = [];
        let offset = 0;
        let segStart: number | null = null;

        for (const c of ledger.chars) {
            if (c.isDebug) {
                if (segStart === null) segStart = offset;
            } else {
                if (segStart !== null) {
                    segments.push({ start: segStart, end: offset });
                    segStart = null;
                }
            }
            offset += c.ch.length;
        }

        // Close final segment if needed
        if (segStart !== null) {
            segments.push({ start: segStart, end: offset });
        }

        return segments;
    }

    /**
     * Queue a save operation (debounced to avoid excessive disk writes)
     */
    private queueSave(filePath: string): void {
        this.saveQueue.add(filePath);

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.flushSaves();
        }, 500); // Save after 500ms of inactivity
    }

    /**
     * Flush all pending saves to disk
     */
    private async flushSaves(): Promise<void> {
        const toSave = [...this.saveQueue];
        this.saveQueue.clear();

        for (const filePath of toSave) {
            await this.saveLedgerToDisk(filePath);
        }
    }

    /**
     * Save a single ledger to disk
     */
    private async saveLedgerToDisk(filePath: string): Promise<void> {
        const ledger = this.charLedgers.get(filePath);
        if (!ledger) return;

        const metaDir = this.getMetadataDir(filePath);
        const metaPath = this.getMetadataPath(filePath);

        try {
            // Ensure directory exists
            if (!fs.existsSync(metaDir)) {
                fs.mkdirSync(metaDir, { recursive: true });
            }

            // Write JSON
            const json = JSON.stringify(ledger, null, 2);
            fs.writeFileSync(metaPath, json, 'utf-8');

            console.log('[MetadataManager] Saved ledger:', metaPath);
        } catch (err) {
            console.error('[MetadataManager] Failed to save ledger:', err);
        }
    }


	public dispose(): void {
		console.log('[MetadataManager] dispose()');
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        // Final flush
        this.flushSaves();
	}

    /**
     * For demo purposes—seed a fake ledger with some debug chars
     */
    public seedLedgerForFile(filePath: string): void {
        const ledger = this.charLedgers.get(filePath);
        if (!ledger) return;

        // Mark some chars as debug (e.g., chars 10-20)
        for (let i = 10; i < Math.min(20, ledger.chars.length); i++) {
            ledger.chars[i].isDebug = true;
        }

        this.queueSave(filePath);
        console.log('[MetadataManager] Seeded debug chars in:', filePath);
    }

	// // Temporary sample ledger generator (for demo purposes)
	// public seedLedgerForFile(filePath: string): void {
	// 	console.log('[hidden-overlay][MetadataManager] seeding fake ledger for', filePath);

	// 	// You can replace this with a real parse later.
	// 	const fakeChars = [
	// 		{ id: uuid(), ch: 'c', offset: 0, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'o', offset: 1, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'n', offset: 2, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 's', offset: 3, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'o', offset: 4, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'l', offset: 5, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'e', offset: 6, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: '.', offset: 7, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'l', offset: 8, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'o', offset: 9, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'g', offset: 10, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: '(', offset: 11, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: '"', offset: 12, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: 'd', offset: 13, isDeleted: false, isDebug: true }, // ← debug-only chars
	// 		{ id: uuid(), ch: 'e', offset: 14, isDeleted: false, isDebug: true },
	// 		{ id: uuid(), ch: 'b', offset: 15, isDeleted: false, isDebug: true },
	// 		{ id: uuid(), ch: 'u', offset: 16, isDeleted: false, isDebug: true },
	// 		{ id: uuid(), ch: 'g', offset: 17, isDeleted: false, isDebug: true },
	// 		{ id: uuid(), ch: '"', offset: 18, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: ')', offset: 19, isDeleted: false, isDebug: false },
	// 		{ id: uuid(), ch: ';', offset: 20, isDeleted: false, isDebug: false }
	// 	];

	// 	const ledger = {
	// 		filePath,
	// 		chars: fakeChars
	// 	};
	// 	this.charLedgers.set(filePath, ledger);
	// }

}
