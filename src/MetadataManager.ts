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
	offset: number;
	isDeleted: boolean;
	isDebug: boolean;
}

export interface DebugSegment {
    start: number; // inclusive offset in current document text
    end: number;   // exclusive offset in current document text
}

export interface KeystrokeEvent {
    kind: 'type' | 'deleteLeft' | 'deleteRight' | 'paste' | 'cut';
    text: string;
    uri: string;
    selections: Array<{ start: vscode.Position; end: vscode.Position }>;
    isDebug: boolean;
    timestamp: number;
}

export interface FileCharLedger {
	filePath: string;          // absolute or workspace-relative
	chars: CharRecord[];       // includes tombstoned chars
}

// export interface ModeDeltaOp {
// 	op: 'insert' | 'delete';   // can expand later. The assumption in debug code is that you never delete any non-debug code, only insert new debugging code.
// 	targetBefore: string;      // e.g. insert after this char ID, or delete range start ID
// 	payload?: any;             // flexible; maybe list of char IDs or text
// }

// export interface ModeDeltaFile {
// 	filePath: string;
// 	opsDebugOnToOff: ModeDeltaOp[];
// 	opsOffToDebugOn: ModeDeltaOp[];
// }

// export interface ChangeLogEntry {
// 	timestamp: number;          // not as needed
// 	action: string;
// 	data: Record<string, unknown>;
// }

export class MetadataManager {
	private readonly context: vscode.ExtensionContext;
	private readonly storageDir: string;

	// in-memory caches
	private charLedgers: Map<string, FileCharLedger> = new Map();
	// private modeDeltas: Map<string, ModeDeltaFile> = new Map();
	// private changeLog: ChangeLogEntry[] = [];

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

	// public getModeDeltaForFile(filePath: string): ModeDeltaFile | undefined {
	// 	return this.modeDeltas.get(filePath);
	// }

	// public setModeDeltaForFile(delta: ModeDeltaFile): void {
	// 	// console.log('[hidden-overlay][MetadataManager] setModeDeltaForFile', delta.filePath);
	// 	this.modeDeltas.set(delta.filePath, delta);
	// 	// TODO: persist to disk
	// }

	// public appendChangeLog(entry: ChangeLogEntry): void {
	// 	console.log('[hidden-overlay][MetadataManager] appendChangeLog', entry);
	// 	this.changeLog.push(entry);
	// 	// TODO: persist incrementally
	// }

	// public getChangeLog(): ChangeLogEntry[] {
	// 	return this.changeLog;
	// }

	public insertChar(filePath: string, newChar: string, at: number, isDebug: boolean): void {
		const ledger = this.charLedgers.get(filePath);
		if (!ledger) return;

		const id = uuid();

		const newRecord = { id, ch: newChar, offset: at, isDeleted: false, isDebug };
		ledger.chars.splice(at, 0, newRecord);

		for (let i = at + 1; i < ledger.chars.length; i++) {
			ledger.chars[i].offset += 1;
		}
	}

	public deleteChar(filePath: string, at: number): void {
		const ledger = this.charLedgers.get(filePath);
		if (!ledger) return;

		const record = ledger.chars.find(c => c.offset === at && !c.isDeleted);
		if (record) {
			record.isDeleted = true;

			for (let i = at + 1; i < ledger.chars.length; i++) {
				ledger.chars[i].offset -= 1;
			}
		}
	}

	public rebuildTextFromLedger(filePath: string): string | null {
		const ledger = this.charLedgers.get(filePath);
		if (!ledger) return null;
		return ledger.chars.filter(c => !c.isDeleted).sort((a, b) => a.offset - b.offset).map(c => c.ch).join('');
	}

	public buildLedgerFromText(filePath: string): void {
		//Get the text from the file with the filePath
		const fileUri = vscode.Uri.file(filePath);
		vscode.workspace.fs.readFile(fileUri).then((data) => {
			const text = data.toString();
			const chars: CharRecord[] = [];
			for (let i = 0; i < text.length; i++) {
				const ch = text.charAt(i);
				const id = uuid();
				chars.push({ id, ch, offset: i, isDeleted: false, isDebug: false });
			}
			const ledger: FileCharLedger = { filePath, chars };
			this.charLedgers.set(filePath, ledger);
		});
	}

	// Ensure a ledger exists for this doc, seeded from current buffer
    public ensureLedgerForDoc(doc: vscode.TextDocument): FileCharLedger {
        const filePath = doc.uri.fsPath;
        let ledger = this.charLedgers.get(filePath);
        if (!ledger) {
            const text = doc.getText();
            const chars: CharRecord[] = [];
            for (let i = 0; i < text.length; i++) {
                chars.push({
                    id: uuid(),
                    ch: text[i],           // includes '\n'
                    offset: i,             // continuous offsets
                    isDeleted: false,
                    isDebug: false
                });
            }
            ledger = { filePath, chars };
            this.charLedgers.set(filePath, ledger);
        }
        return ledger;
    }

    // Find array index in ledger.chars corresponding to current "visible" offset among non-deleted chars
    private mapOffsetToArrayIndex(ledger: FileCharLedger, visibleOffset: number): number {
        if (visibleOffset <= 0) return 0;
        let count = 0;
        for (let i = 0; i < ledger.chars.length; i++) {
            const c = ledger.chars[i];
            if (!c.isDeleted) {
                if (count === visibleOffset) return i;
                count++;
            }
        }
        // append at end
        return ledger.chars.length;
    }

    // Recalculate offsets for all chars from a given array index onward (non-deleted only)
    private recalcOffsetsFrom(ledger: FileCharLedger, startArrayIndex: number = 0): void {
        let offset = 0;
        for (let i = 0; i < ledger.chars.length; i++) {
            const c = ledger.chars[i];
            if (!c.isDeleted) {
                c.offset = offset++;
            }
        }
    }

    // Insert a block of text at a given visible offset, tagging new chars
    private insertText(filePath: string, atVisibleOffset: number, text: string, isDebug: boolean): void {
        const ledger = this.charLedgers.get(filePath);
        if (!ledger || text.length === 0) return;

        const insertIdx = this.mapOffsetToArrayIndex(ledger, atVisibleOffset);
        const newRecords: CharRecord[] = [];
        for (let i = 0; i < text.length; i++) {
            newRecords.push({
                id: uuid(),
                ch: text[i],
                offset: -1, // will recalc next
                isDeleted: false,
                isDebug
            });
        }
        ledger.chars.splice(insertIdx, 0, ...newRecords);
        this.recalcOffsetsFrom(ledger, insertIdx);
    }

    // Delete a visible range [start,end)
    private deleteRange(filePath: string, startVisibleOffset: number, endVisibleOffset: number): void {
        const ledger = this.charLedgers.get(filePath);
        if (!ledger) return;
        if (endVisibleOffset <= startVisibleOffset) return;

        const startIdx = this.mapOffsetToArrayIndex(ledger, startVisibleOffset);
        const endIdx = this.mapOffsetToArrayIndex(ledger, endVisibleOffset);

        for (let i = startIdx; i < endIdx; i++) {
            const c = ledger.chars[i];
            if (c && !c.isDeleted) c.isDeleted = true;
        }
        this.recalcOffsetsFrom(ledger, startIdx);
    }

    // Replace visible range [start,end) with text
    private replaceRange(filePath: string, startVisibleOffset: number, endVisibleOffset: number, text: string, isDebug: boolean): void {
        this.deleteRange(filePath, startVisibleOffset, endVisibleOffset);
        if (text && text.length > 0) {
            this.insertText(filePath, startVisibleOffset, text, isDebug);
        }
    }

    /**
     * Track keystrokes (pre-change). Keep it separate from ledger mutation.
     */
    public recordKeystroke(evt: KeystrokeEvent): void {
        try {
            const logDir = this.storageDir;
            const line = JSON.stringify(evt) + '\n';
            fs.appendFileSync(path.join(logDir, 'keystrokes.jsonl'), line, 'utf8');
        } catch { /* best-effort logging */ }
    }

    /**
     * Apply VS Code buffer changes to the per-character ledger.
     * Use numeric offsets (rangeOffset/rangeLength) with a running shift.
     */
    public handleTextDocumentChange(
        doc: vscode.TextDocument,
        changes: readonly vscode.TextDocumentContentChangeEvent[],
        markDebug: boolean
    ): void {
        const ledger = this.ensureLedgerForDoc(doc);
        // Apply in ascending order with running shift to map pre-change offsets to current ledger
        const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
        let shift = 0;

        for (const chg of sorted) {
            const oldLen = (chg as any).rangeLength ?? chg.rangeLength ?? doc.getText(chg.range).length;
            const newLen = chg.text.length;

            const start = chg.rangeOffset + shift;
            const end = start + oldLen;

            if (oldLen === 0 && newLen > 0) {
                // insert
                this.insertText(doc.uri.fsPath, start, chg.text, markDebug);
            } else if (oldLen > 0 && newLen === 0) {
                // delete
                this.deleteRange(doc.uri.fsPath, start, end);
            } else if (oldLen > 0 && newLen > 0) {
                // replace
                this.replaceRange(doc.uri.fsPath, start, end, chg.text, markDebug);
            }
            shift += (newLen - oldLen);
        }

        // Optional: persist ledger
        // fs.writeFileSync(path.join(this.storageDir, 'ledgers.json'), JSON.stringify([...this.charLedgers.values()]));
    }

    /**
     * Build debug highlight segments from the current ledger (continuous offsets).
     */
    public getDebugSegmentsForDocument(doc: vscode.TextDocument): DebugSegment[] {
        const ledger = this.charLedgers.get(doc.uri.fsPath);
        if (!ledger) return [];

        const segments: DebugSegment[] = [];
        let inSeg = false;
        let segStart = 0;

        // chars are not guaranteed to be sorted by array index, so iterate by offset order
        const visible = ledger.chars.filter(c => !c.isDeleted).sort((a, b) => a.offset - b.offset);
        for (const c of visible) {
            if (c.isDebug) {
                if (!inSeg) {
                    inSeg = true;
                    segStart = c.offset;
                }
            } else {
                if (inSeg) {
                    segments.push({ start: segStart, end: c.offset });
                    inSeg = false;
                }
            }
        }
        if (inSeg) {
            const last = visible[visible.length - 1];
            segments.push({ start: segStart, end: (last?.offset ?? 0) + 1 });
        }
        return segments;
    }


	public dispose(): void {
		console.log('[hidden-overlay][MetadataManager] dispose()');
		// optional: flush caches to disk on deactivate
	}

	// Temporary sample ledger generator (for demo purposes)
	public seedLedgerForFile(filePath: string): void {
		console.log('[hidden-overlay][MetadataManager] seeding fake ledger for', filePath);

		// You can replace this with a real parse later.
		const fakeChars = [
			{ id: uuid(), ch: 'c', offset: 0, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'o', offset: 1, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'n', offset: 2, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 's', offset: 3, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'o', offset: 4, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'l', offset: 5, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'e', offset: 6, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: '.', offset: 7, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'l', offset: 8, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'o', offset: 9, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'g', offset: 10, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: '(', offset: 11, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: '"', offset: 12, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: 'd', offset: 13, isDeleted: false, isDebug: true }, // ← debug-only chars
			{ id: uuid(), ch: 'e', offset: 14, isDeleted: false, isDebug: true },
			{ id: uuid(), ch: 'b', offset: 15, isDeleted: false, isDebug: true },
			{ id: uuid(), ch: 'u', offset: 16, isDeleted: false, isDebug: true },
			{ id: uuid(), ch: 'g', offset: 17, isDeleted: false, isDebug: true },
			{ id: uuid(), ch: '"', offset: 18, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: ')', offset: 19, isDeleted: false, isDebug: false },
			{ id: uuid(), ch: ';', offset: 20, isDeleted: false, isDebug: false }
		];

		const ledger = {
			filePath,
			chars: fakeChars
		};
		this.charLedgers.set(filePath, ledger);
	}

}
