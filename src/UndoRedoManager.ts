import * as vscode from 'vscode';
import { TextSegment, FileLedger, MetadataManager } from './MetadataManager';
import { DebugMode, InsertMode, HiddenCodeOverlay } from './HiddenCodeOverlay';

export interface EditSnapshot {
    chars: TextSegment[];       // Deep copy of the char array at this point in time
    debugMode: DebugMode;       // Mode state when this edit was made
    insertMode: InsertMode;     // Insert mode state when this edit was made
    cursorOffset: number;       // Cursor position for restoring
    timestamp: number;          // Timestamp for debugging
}

export interface FileHistory {
    filePath: string;
    undoStack: EditSnapshot[];
    redoStack: EditSnapshot[];
    maxSize: number;            // Maximum history size to prevent memory bloat
}

export class UndoRedoManager {
    private readonly context: vscode.ExtensionContext;
    private readonly metadataManager: MetadataManager;
    private readonly overlayManager: HiddenCodeOverlay;
    
    private fileHistories: Map<string, FileHistory> = new Map();
    private readonly maxHistorySize = 100;
    
    // Flag to prevent recording edits during undo/redo
    private isUndoingOrRedoing: boolean = false;

    constructor(
        context: vscode.ExtensionContext,
        metadataManager: MetadataManager,
        overlayManager: HiddenCodeOverlay
    ) {
        this.context = context;
        this.metadataManager = metadataManager;
        this.overlayManager = overlayManager;
        console.log('[UndoRedoManager] constructed');
    }

    public async init(): Promise<void> {
        console.log('[UndoRedoManager] init()');
        // History is built as edits happen, nothing needed in init
    }

    /**
     * Check if we're currently performing an undo/redo operation
     */
    public isPerformingUndoRedo(): boolean {
        return this.isUndoingOrRedoing;
    }

    /**
     * Get or create history for a file
     */
    private getOrCreateHistory(filePath: string): FileHistory {
        if (!this.fileHistories.has(filePath)) {
            this.fileHistories.set(filePath, {
                filePath,
                undoStack: [],
                redoStack: [],
                maxSize: this.maxHistorySize
            });
        }
        return this.fileHistories.get(filePath)!;
    }

    /**
     * Record current state before an edit is made.
     * Call this BEFORE the edit is applied to the ledger.
     */
    public recordBeforeEdit(filePath: string, cursorOffset: number): void {
        if (this.isUndoingOrRedoing) return;

        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return;

        const history = this.getOrCreateHistory(filePath);

        // Create snapshot of current state
        const snapshot: EditSnapshot = {
            chars: this.deepCopySegments(ledger.segments),
            debugMode: this.overlayManager.getMode(),
            insertMode: this.overlayManager.getInsertMode(),
            cursorOffset,
            timestamp: Date.now()
        };

        history.undoStack.push(snapshot);   // Push to undo stack
        history.redoStack = [];             // Clear redo stack (new edit invalidates redo history)

        // Trim if too large
        if (history.undoStack.length > history.maxSize) {
            history.undoStack.shift();
        }

        console.log(`[UndoRedoManager] Recorded snapshot for ${filePath}, undo stack size: ${history.undoStack.length}`);
    }

    /**
     * Record a mode toggle as an undoable action
     */
    public recordModeToggle(filePath: string): void {
        // When mode toggles, we want to capture the state of ALL tracked files
        // so that undo can restore them all
        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return;

        const history = this.getOrCreateHistory(filePath);

        const snapshot: EditSnapshot = {
            chars: this.deepCopySegments(ledger.segments),
            debugMode: this.overlayManager.getMode(),
            insertMode: this.overlayManager.getInsertMode(),
            cursorOffset: 0, // Mode toggle doesn't have a specific cursor position
            timestamp: Date.now()
        };

        history.undoStack.push(snapshot);
        history.redoStack = [];

        if (history.undoStack.length > history.maxSize) {
            history.undoStack.shift();
        }
    }

    /**
     * Perform undo for a specific file
     */
    public async undo(editor: vscode.TextEditor): Promise<boolean> {
        const filePath = editor.document.uri.fsPath;
        const history = this.fileHistories.get(filePath);

        if (!history || history.undoStack.length === 0) {
            console.log('[UndoRedoManager] Nothing to undo for:', filePath);
            return false;
        }

        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return false;

        this.isUndoingOrRedoing = true;

        try {
            // Save current state to redo stack
            const currentSnapshot: EditSnapshot = {
                chars: this.deepCopySegments(ledger.segments),
                debugMode: this.overlayManager.getMode(),
                insertMode: this.overlayManager.getInsertMode(),
                cursorOffset: editor.document.offsetAt(editor.selection.active),
                timestamp: Date.now()
            };
            history.redoStack.push(currentSnapshot);

            // Pop the previous state from undo stack
            const previousSnapshot = history.undoStack.pop()!;

            // Restore the ledger
            await this.restoreSnapshot(editor, ledger, previousSnapshot);

            console.log(`[UndoRedoManager] Undo completed for ${filePath}`);
            return true;
        } finally {
            this.isUndoingOrRedoing = false;
        }
    }

    /**
     * Perform redo for a specific file
     */
    public async redo(editor: vscode.TextEditor): Promise<boolean> {
        const filePath = editor.document.uri.fsPath;
        const history = this.fileHistories.get(filePath);

        if (!history || history.redoStack.length === 0) {
            console.log('[UndoRedoManager] Nothing to redo for:', filePath);
            return false;
        }

        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return false;

        this.isUndoingOrRedoing = true;

        try {
            // Save current state to undo stack
            const currentSnapshot: EditSnapshot = {
                chars: this.deepCopySegments(ledger.segments),
                debugMode: this.overlayManager.getMode(),
                insertMode: this.overlayManager.getInsertMode(),
                cursorOffset: editor.document.offsetAt(editor.selection.active),
                timestamp: Date.now()
            };
            history.undoStack.push(currentSnapshot);

            // Pop the next state from redo stack
            const nextSnapshot = history.redoStack.pop()!;

            // Restore the ledger
            await this.restoreSnapshot(editor, ledger, nextSnapshot);

            console.log(`[UndoRedoManager] Redo completed for ${filePath}`);
            return true;
        } finally {
            this.isUndoingOrRedoing = false;
        }
    }

    /**
     * Restore a snapshot to the ledger and editor
     */
    private async restoreSnapshot(
        editor: vscode.TextEditor,
        ledger: FileLedger,
        snapshot: EditSnapshot
    ): Promise<void> {
        // Restore ledger segments
        ledger.segments = this.deepCopySegments(snapshot.chars);

        // Check if we need to switch debug mode
        const currentDebugMode = this.overlayManager.getMode();
        const snapshotDebugMode = snapshot.debugMode;

        // Build text based on the snapshot's debug mode
        const showDebug = snapshotDebugMode === 'debugOn';
        const newText = this.buildTextFromSegments(snapshot.chars, showDebug);

        // Apply to editor
        const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
        );

        await this.metadataManager.applyEditWithoutTracking(
            editor.document.uri,
            fullRange,
            newText
        );

        // If debug mode changed, update the overlay state
        if (currentDebugMode !== snapshotDebugMode) {
            await this.overlayManager.setModeWithoutToggle(snapshotDebugMode, snapshot.insertMode);
        }

        // Restore cursor position (adjusted for current view)
        const cursorPos = editor.document.positionAt(
            Math.min(snapshot.cursorOffset, newText.length)
        );
        editor.selection = new vscode.Selection(cursorPos, cursorPos);

        // Update highlights
        this.overlayManager.updateHighlightsForEditor(editor);

        // Save ledger to disk
        this.metadataManager.queueSavePublic(ledger.relativePath);
    }

    /**
     * Build text from segments array
     */
    private buildTextFromSegments(segments: TextSegment[], includeDebug: boolean): string {
        if (includeDebug) {
            return segments.map(s => s.text).join('');
        }
        return segments.filter(s => !s.isDebug).map(s => s.text).join('');
    }

    /**
     * Deep copy segments array to avoid reference issues
     */
    private deepCopySegments(segments: TextSegment[]): TextSegment[] {
        return segments.map(s => ({
            text: s.text,
            isDebug: s.isDebug
        }));
    }

    /**
     * Clear history for a file (e.g., when file is closed)
     */
    public clearHistory(filePath: string): void {
        this.fileHistories.delete(filePath);
    }

    public dispose(): void {
        console.log('[UndoRedoManager] dispose()');
        this.fileHistories.clear();
    }
}