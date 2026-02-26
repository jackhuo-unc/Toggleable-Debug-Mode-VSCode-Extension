import * as vscode from 'vscode';
import { TextSegment, FileLedger, MetadataManager } from './MetadataManager';
import { DebugMode, InsertMode, HiddenCodeOverlay } from './HiddenCodeOverlay';

export interface EditSnapshot {
    segments: TextSegment[];       // Deep copy of the char array at this point in time
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

    // Debounce: group rapid edits into one undo unit
    private pendingSnapshots: Map<string, {
        snapshot: EditSnapshot;
        timeout: NodeJS.Timeout;
    }> = new Map();
    private readonly SNAPSHOT_DEBOUNCE_MS = 500; // Group edits within 500ms

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
        let history = this.fileHistories.get(filePath);
        if (!history) {
            history = {
                filePath,
                undoStack: [],
                redoStack: [],
                maxSize: this.maxHistorySize
            };
            this.fileHistories.set(filePath, history);
        }
        return this.fileHistories.get(filePath)!;
    }

    /**
     * Record current state before an edit is made.
     * Debounces rapid edits so they become one undo unit.
     */
    public recordBeforeEdit(filePath: string, cursorOffset: number): void {
        if (this.isUndoingOrRedoing) return;

        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return;

        const pending = this.pendingSnapshots.get(filePath);
        if (pending) {
            // Already have a pending snapshot - just extend the debounce timer
            clearTimeout(pending.timeout);
            pending.timeout = setTimeout(() => {
                this.commitPendingSnapshot(filePath);
            }, this.SNAPSHOT_DEBOUNCE_MS);
            return;
        }

        // First edit in a sequence - capture the BEFORE state
        const snapshot: EditSnapshot = {
            segments: this.deepCopySegments(ledger.segments),
            debugMode: this.overlayManager.getMode(),
            insertMode: this.overlayManager.getInsertMode(),
            cursorOffset,
            timestamp: Date.now()
        };

        const timeout = setTimeout(() => {
            this.commitPendingSnapshot(filePath);
        }, this.SNAPSHOT_DEBOUNCE_MS);

        this.pendingSnapshots.set(filePath, { snapshot, timeout });
    }

    private commitPendingSnapshot(filePath: string): void {
        const pending = this.pendingSnapshots.get(filePath);
        if (!pending) return;

        this.pendingSnapshots.delete(filePath);

        const history = this.getOrCreateHistory(filePath);
        history.undoStack.push(pending.snapshot);
        history.redoStack = []; // Clear redo on new edit

        // Trim if too large
        if (history.undoStack.length > history.maxSize) {
            history.undoStack.shift();
        }

        console.log(`[UndoRedoManager] Committed snapshot for ${filePath}, stack size: ${history.undoStack.length}`);
    }

    /**
     * Force commit any pending snapshot (call before undo/redo)
     */
    private flushPendingSnapshot(filePath: string): void {
        const pending = this.pendingSnapshots.get(filePath);
        if (pending) {
            clearTimeout(pending.timeout);
            this.commitPendingSnapshot(filePath);
        }
    }

    /**
     * Record a mode toggle as an undoable action.
     * This is NOT debounced - mode toggles are always immediate snapshots.
     */
    public recordModeToggle(filePath: string): void {
        // First, flush any pending edit snapshot
        this.flushPendingSnapshot(filePath);

        if (this.isUndoingOrRedoing) return;

        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return;

        const history = this.getOrCreateHistory(filePath);

        const snapshot: EditSnapshot = {
            segments: this.deepCopySegments(ledger.segments),
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
        console.log(`[UndoRedoManager] Recorded mode toggle for ${filePath}`);
    }

    /**
     * Record an insert mode toggle as a separate undoable action.
     * Call this BEFORE the toggle happens.
     */
    public recordInsertModeToggle(filePath: string): void {
        if (this.isUndoingOrRedoing) return;

        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return;

        const history = this.getOrCreateHistory(filePath);

        const snapshot: EditSnapshot = {
            segments: this.deepCopySegments(ledger.segments),
            debugMode: this.overlayManager.getMode(),
            insertMode: this.overlayManager.getInsertMode(),
            cursorOffset: 0,
            timestamp: Date.now()
        };

        history.undoStack.push(snapshot);
        history.redoStack = [];

        if (history.undoStack.length > history.maxSize) {
            history.undoStack.shift();
        }

        console.log(`[UndoRedoManager] Recorded insert mode toggle for ${filePath}, undo stack: ${history.undoStack.length}`);
    }

    /**
     * Perform undo for a specific file
     */
    public async undo(filePath: string): Promise<boolean> {
        this.flushPendingSnapshot(filePath);
        const history = this.fileHistories.get(filePath);

        if (!history || history.undoStack.length === 0) {
            console.log('[UndoRedoManager] Nothing to undo for:', filePath);
            return false;
        }

        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return false;

        this.isUndoingOrRedoing = true;

        // Save current state to redo stack
        const editor = vscode.window.activeTextEditor;
        const currentCursorOffset = editor 
            ? editor.document.offsetAt(editor.selection.active)
            : 0;

        try {
            // Save current state to redo stack
            const currentSnapshot: EditSnapshot = {
                segments: this.deepCopySegments(ledger.segments),
                debugMode: this.overlayManager.getMode(),
                insertMode: this.overlayManager.getInsertMode(),
                cursorOffset: currentCursorOffset,
                timestamp: Date.now()
            };
            history.redoStack.push(currentSnapshot);

            // Pop and apply the previous state
            const previousSnapshot = history.undoStack.pop()!;

            await this.restoreSnapshot(editor, filePath, previousSnapshot);

            console.log(`[UndoRedoManager] Undo applied, undo stack: ${history.undoStack.length}, redo stack: ${history.redoStack.length}`);
            return true;
        } finally {
            this.isUndoingOrRedoing = false;
        }
    }

    /**
     * Perform redo for a specific file
     */
    public async redo(filePath: string): Promise<boolean> {
        this.flushPendingSnapshot(filePath);
        const history = this.fileHistories.get(filePath);

        if (!history || history.redoStack.length === 0) {
            console.log('[UndoRedoManager] Nothing to redo for:', filePath);
            return false;
        }

        const ledger = this.metadataManager.getLedgerForFile(filePath);
        if (!ledger) return false;

        this.isUndoingOrRedoing = true;

        // Save current state to undo stack
        const editor = vscode.window.activeTextEditor;
        const currentCursorOffset = editor 
            ? editor.document.offsetAt(editor.selection.active)
            : 0;
        
        try {
            const currentSnapshot: EditSnapshot = {
                segments: this.deepCopySegments(ledger.segments),
                debugMode: this.overlayManager.getMode(),
                insertMode: this.overlayManager.getInsertMode(),
                cursorOffset: currentCursorOffset,
                timestamp: Date.now()
            };
            history.undoStack.push(currentSnapshot);

            // Pop and apply the redo state
            const redoSnapshot = history.redoStack.pop()!;
            await this.restoreSnapshot(editor, filePath, redoSnapshot);

            console.log(`[UndoRedoManager] Redo applied, undo stack: ${history.undoStack.length}, redo stack: ${history.redoStack.length}`);
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
        filePath: string,
        snapshot: EditSnapshot
    ): Promise<void> {
         // Update the ledger segments through MetadataManager
        // This ensures the MetadataManager's internal state is updated
        this.metadataManager.restoreSegments(filePath, this.deepCopySegments(snapshot.segments));

        // Check if we need to switch debug mode
        const currentDebugMode = this.overlayManager.getMode();
        const snapshotDebugMode = snapshot.debugMode;

        // Build text based on the snapshot's debug mode
        const showDebug = snapshotDebugMode === 'debugOn';
        const newText = this.buildTextFromSegments(snapshot.segments, showDebug);

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
        this.metadataManager.queueSavePublic(filePath);
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
        // Clear pending timeouts
        for (const pending of this.pendingSnapshots.values()) {
            clearTimeout(pending.timeout);
        }
        this.pendingSnapshots.clear();
        this.fileHistories.clear();
    }
}
// import * as vscode from 'vscode';
// import { TextSegment, MetadataManager } from './MetadataManager';
// import { DebugMode, InsertMode, HiddenCodeOverlay } from './HiddenCodeOverlay';

// export interface EditSnapshot {
//     segments: TextSegment[];
//     debugMode: DebugMode;
//     insertMode: InsertMode;
//     cursorOffset: number;
//     timestamp: number;
// }

// export interface FileHistory {
//     filePath: string;
//     undoStack: EditSnapshot[];
//     redoStack: EditSnapshot[];
//     maxSize: number;
// }

// export class UndoRedoManager {
//     private readonly context: vscode.ExtensionContext;
//     private readonly metadataManager: MetadataManager;
//     private readonly overlayManager: HiddenCodeOverlay;
    
//     private fileHistories: Map<string, FileHistory> = new Map();
//     private readonly maxHistorySize = 100;
    
//     private isUndoingOrRedoing: boolean = false;

//     // Debounce tracking
//     private pendingSnapshots: Map<string, {
//         snapshot: EditSnapshot;
//         timeout: NodeJS.Timeout;
//     }> = new Map();
//     private readonly SNAPSHOT_DEBOUNCE_MS = 500;

//     // Track the last snapshot's debug mode to detect mode changes
//     private lastRecordedMode: Map<string, DebugMode> = new Map();

//     constructor(
//         context: vscode.ExtensionContext,
//         metadataManager: MetadataManager,
//         overlayManager: HiddenCodeOverlay
//     ) {
//         this.context = context;
//         this.metadataManager = metadataManager;
//         this.overlayManager = overlayManager;
//         console.log('[UndoRedoManager] constructed');
//     }

//     public async init(): Promise<void> {
//         console.log('[UndoRedoManager] init()');
//     }

//     public isPerformingUndoRedo(): boolean {
//         return this.isUndoingOrRedoing;
//     }

//     private getOrCreateHistory(filePath: string): FileHistory {
//         if (!this.fileHistories.has(filePath)) {
//             this.fileHistories.set(filePath, {
//                 filePath,
//                 undoStack: [],
//                 redoStack: [],
//                 maxSize: this.maxHistorySize
//             });
//         }
//         return this.fileHistories.get(filePath)!;
//     }

//     private deepCopySegments(segments: TextSegment[]): TextSegment[] {
//         return segments.map(s => ({ text: s.text, isDebug: s.isDebug }));
//     }

//     /**
//      * Record current state before an edit is made.
//      * Debounces rapid edits so they become one undo unit.
//      */
//     public recordBeforeEdit(filePath: string, cursorOffset: number): void {
//         if (this.isUndoingOrRedoing) return;

//         const ledger = this.metadataManager.getLedgerForFile(filePath);
//         if (!ledger) return;

//         const currentMode = this.overlayManager.getMode();
//         const lastMode = this.lastRecordedMode.get(filePath);

//         // If mode changed since last recording, flush pending and start fresh
//         // This ensures mode toggles create separate undo entries
//         if (lastMode !== undefined && lastMode !== currentMode) {
//             this.flushPendingSnapshot(filePath);
//         }

//         const pending = this.pendingSnapshots.get(filePath);
        
//         if (pending) {
//             // Already have a pending snapshot - just extend the debounce timer
//             clearTimeout(pending.timeout);
//             pending.timeout = setTimeout(() => {
//                 this.commitPendingSnapshot(filePath);
//             }, this.SNAPSHOT_DEBOUNCE_MS);
//             return;
//         }

//         // First edit in a sequence - capture the BEFORE state
//         const snapshot: EditSnapshot = {
//             segments: this.deepCopySegments(ledger.segments),
//             debugMode: currentMode,
//             insertMode: this.overlayManager.getInsertMode(),
//             cursorOffset,
//             timestamp: Date.now()
//         };

//         this.lastRecordedMode.set(filePath, currentMode);

//         const timeout = setTimeout(() => {
//             this.commitPendingSnapshot(filePath);
//         }, this.SNAPSHOT_DEBOUNCE_MS);

//         this.pendingSnapshots.set(filePath, { snapshot, timeout });
//     }

//     private commitPendingSnapshot(filePath: string): void {
//         const pending = this.pendingSnapshots.get(filePath);
//         if (!pending) return;

//         this.pendingSnapshots.delete(filePath);

//         const history = this.getOrCreateHistory(filePath);
//         history.undoStack.push(pending.snapshot);
//         history.redoStack = [];

//         if (history.undoStack.length > history.maxSize) {
//             history.undoStack.shift();
//         }

//         console.log(`[UndoRedoManager] Committed snapshot for ${filePath}, stack size: ${history.undoStack.length}`);
//     }

//     /**
//      * Flush any pending snapshot immediately (called before undo/redo)
//      */
//     public flushPendingSnapshot(filePath: string): void {
//         const pending = this.pendingSnapshots.get(filePath);
//         if (pending) {
//             clearTimeout(pending.timeout);
//             this.commitPendingSnapshot(filePath);
//         }
//     }

//     /**
//      * Flush all pending snapshots for all files
//      */
//     public flushAllPendingSnapshots(): void {
//         for (const filePath of this.pendingSnapshots.keys()) {
//             this.flushPendingSnapshot(filePath);
//         }
//     }

//     /**
//      * Perform undo for a specific file
//      */
//     public async undo(editor: vscode.TextEditor): Promise<boolean> {
//         const filePath = editor.document.uri.fsPath;
        
//         // Flush any pending edits first
//         this.flushPendingSnapshot(filePath);

//         const history = this.fileHistories.get(filePath);

//         if (!history || history.undoStack.length === 0) {
//             console.log('[UndoRedoManager] Nothing to undo for:', filePath);
//             return false;
//         }

//         const ledger = this.metadataManager.getLedgerForFile(filePath);
//         if (!ledger) return false;

//         this.isUndoingOrRedoing = true;

//         try {
//             // Save current state to redo stack
//             const currentSnapshot: EditSnapshot = {
//                 segments: this.deepCopySegments(ledger.segments),
//                 debugMode: this.overlayManager.getMode(),
//                 insertMode: this.overlayManager.getInsertMode(),
//                 cursorOffset: editor.document.offsetAt(editor.selection.active),
//                 timestamp: Date.now()
//             };
//             history.redoStack.push(currentSnapshot);

//             // Pop the previous state from undo stack
//             const previousSnapshot = history.undoStack.pop()!;

//             // Restore the ledger
//             await this.restoreSnapshot(editor, filePath, previousSnapshot);

//             // Update last recorded mode to match restored state
//             this.lastRecordedMode.set(filePath, previousSnapshot.debugMode);

//             console.log(`[UndoRedoManager] Undo completed for ${filePath}, undo: ${history.undoStack.length}, redo: ${history.redoStack.length}`);
//             return true;
//         } finally {
//             this.isUndoingOrRedoing = false;
//         }
//     }

//     /**
//      * Perform redo for a specific file
//      */
//     public async redo(editor: vscode.TextEditor): Promise<boolean> {
//         const filePath = editor.document.uri.fsPath;

//         // Flush any pending edits first
//         this.flushPendingSnapshot(filePath);

//         const history = this.fileHistories.get(filePath);

//         if (!history || history.redoStack.length === 0) {
//             console.log('[UndoRedoManager] Nothing to redo for:', filePath);
//             return false;
//         }

//         const ledger = this.metadataManager.getLedgerForFile(filePath);
//         if (!ledger) return false;

//         this.isUndoingOrRedoing = true;

//         try {
//             // Save current state to undo stack
//             const currentSnapshot: EditSnapshot = {
//                 segments: this.deepCopySegments(ledger.segments),
//                 debugMode: this.overlayManager.getMode(),
//                 insertMode: this.overlayManager.getInsertMode(),
//                 cursorOffset: editor.document.offsetAt(editor.selection.active),
//                 timestamp: Date.now()
//             };
//             history.undoStack.push(currentSnapshot);

//             // Pop the next state from redo stack
//             const nextSnapshot = history.redoStack.pop()!;

//             // Restore the ledger
//             await this.restoreSnapshot(editor, filePath, nextSnapshot);

//             // Update last recorded mode to match restored state
//             this.lastRecordedMode.set(filePath, nextSnapshot.debugMode);

//             console.log(`[UndoRedoManager] Redo completed for ${filePath}, undo: ${history.undoStack.length}, redo: ${history.redoStack.length}`);
//             return true;
//         } finally {
//             this.isUndoingOrRedoing = false;
//         }
//     }

//     /**
//      * Restore a snapshot to the ledger and editor
//      */
//     private async restoreSnapshot(
//         editor: vscode.TextEditor,
//         filePath: string,
//         snapshot: EditSnapshot
//     ): Promise<void> {
//         // Update the ledger segments through MetadataManager
//         this.metadataManager.restoreSegments(filePath, this.deepCopySegments(snapshot.segments));

//         // Check if we need to switch debug mode
//         const currentDebugMode = this.overlayManager.getMode();
//         const snapshotDebugMode = snapshot.debugMode;

//         // Build text based on the snapshot's debug mode
//         const showDebug = snapshotDebugMode === 'debugOn';
//         const newText = this.buildTextFromSegments(snapshot.segments, showDebug);

//         // Apply to editor
//         const fullRange = new vscode.Range(
//             editor.document.positionAt(0),
//             editor.document.positionAt(editor.document.getText().length)
//         );

//         await this.metadataManager.applyEditWithoutTracking(
//             editor.document.uri,
//             fullRange,
//             newText
//         );

//         // If debug mode changed, update the overlay state
//         if (currentDebugMode !== snapshotDebugMode) {
//             await this.overlayManager.setModeWithoutToggle(snapshotDebugMode, snapshot.insertMode);
//         }

//         // Restore cursor position
//         const cursorPos = editor.document.positionAt(
//             Math.min(snapshot.cursorOffset, newText.length)
//         );
//         editor.selection = new vscode.Selection(cursorPos, cursorPos);

//         // Update highlights
//         this.overlayManager.updateHighlightsForEditor(editor);

//         // Save ledger to disk
//         this.metadataManager.queueSavePublic(filePath);
//     }

//     private buildTextFromSegments(segments: TextSegment[], includeDebug: boolean): string {
//         if (includeDebug) {
//             return segments.map(s => s.text).join('');
//         }
//         return segments.filter(s => !s.isDebug).map(s => s.text).join('');
//     }

//     public clearHistory(filePath: string): void {
//         this.fileHistories.delete(filePath);
//         this.pendingSnapshots.delete(filePath);
//         this.lastRecordedMode.delete(filePath);
//     }

//     public dispose(): void {
//         console.log('[UndoRedoManager] dispose()');
//         for (const pending of this.pendingSnapshots.values()) {
//             clearTimeout(pending.timeout);
//         }
//         this.pendingSnapshots.clear();
//         this.lastRecordedMode.clear();
//         this.fileHistories.clear();
//     }
// }