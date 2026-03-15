import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
    TextSegment,
    FileLedger,
    DebugMode,
    InsertMode,
    EditSnapshot,
    ContentChange,
    FileUpdate,
    UndoRedoResponse,
} from '../types';
import { SegmentManager } from './SegmentManager';
import { LedgerStore } from './LedgerStore';
import { PathUtils } from './PathUtils';
import { GitManager } from './GitManager';

// ─────────────────────────────────────────────────────────────────────────────
// Per-file undo/redo history (ported from UndoRedoManager)
// ─────────────────────────────────────────────────────────────────────────────

interface FileHistory {
    undoStack: EditSnapshot[];
    redoStack: EditSnapshot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Session — replaces vscode.ExtensionContext.workspaceState + all manager state
// ─────────────────────────────────────────────────────────────────────────────

export interface Session {
    sessionId: string;
    clientId: string;
    workspaceRoot: string;
    debugMode: DebugMode;
    insertMode: InsertMode;
    pathUtils: PathUtils;
    ledgerStore: LedgerStore;
    segmentManager: SegmentManager;
    gitManager: GitManager;
    fileHistories: Map<string, FileHistory>;
    // Debounce state for undo grouping
    pendingSnapshots: Map<string, {
        snapshot: EditSnapshot;
        timeout: NodeJS.Timeout;
    }>;
}

const MAX_HISTORY_SIZE = 100;
const SNAPSHOT_DEBOUNCE_MS = 500;

export class SessionManager {
    private sessions: Map<string, Session> = new Map();

    // ─────────────────────────────────────────────────────────────────────────
    // Session Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    public createSession(clientId: string, workspaceRoot: string): Session {
        const sessionId = "SAMPLE-ID"; /*uuidv4();*/ //eventually will use uuid, but for now hard code it.
        const pathUtils = new PathUtils(workspaceRoot);
        const ledgerStore = new LedgerStore(pathUtils);
        const segmentManager = new SegmentManager();
        const gitManager = new GitManager(ledgerStore, segmentManager, pathUtils.getMetadataStorageRoot());
        const session: Session = {
            sessionId,
            clientId,
            workspaceRoot,
            debugMode: 'debugOff',
            insertMode: 'insertNormal',
            pathUtils,
            ledgerStore,
            segmentManager,
            gitManager,
            fileHistories: new Map(),
            pendingSnapshots: new Map(),
        };

        // Scan for existing metadata on disk
        ledgerStore.scanWorkspace();

        gitManager.ensureRepo();

        this.sessions.set(sessionId, session);
        console.log(`[SessionManager] Created session ${sessionId} for client "${clientId}", tracking ${ledgerStore.size()} files`);
        return session;
    }

    public getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId);
    }

    public closeSession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        // Flush all pending undo snapshots
        for (const filePath of session.pendingSnapshots.keys()) {
            this.flushPendingSnapshot(session, filePath);
        }

        // Flush all pending ledger saves
        session.ledgerStore.dispose();

        this.sessions.delete(sessionId);
        console.log(`[SessionManager] Closed session ${sessionId}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Document Open
    // Ported from MetadataManager.ensureLedgerForDoc
    // ─────────────────────────────────────────────────────────────────────────

    public openDocument(
        session: Session,
        filePath: string,
        content: string
    ): {
        segments: TextSegment[];
    } {
        const { ledgerStore, segmentManager, pathUtils } = session;
        const isDebugMode = session.debugMode === 'debugOn';

        if (!pathUtils.shouldTrackFile(filePath)) {
            // Not a trackable file — just return content as-is
            return { segments: [{ text: content, isDebug: false }] };
        }

        let ledger = ledgerStore.get(filePath);

        if (!ledger) {
            // Try loading from disk
            const metaPath = pathUtils.getMetadataPath(filePath);
            if (metaPath && fs.existsSync(metaPath)) {
                ledger = ledgerStore.loadFromDisk(filePath, metaPath) ?? undefined;
                console.log('[SessionManager] Loaded ledger from disk:', filePath);
            }
        }

        if (!ledger) {
            // Brand new file — create ledger from content
            ledger = ledgerStore.createFromText(filePath, content, isDebugMode);
            console.log('[SessionManager] Created new ledger for:', filePath);
        }

        // const displayContent = segmentManager.buildTextForMode(ledger.segments, isDebugMode);
        // const debugSegments = segmentManager.getDebugSegments(ledger.segments, isDebugMode);

        return { segments: segmentManager.deepCopySegments(ledger.segments) };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Document Change
    // Ported from MetadataManager.handleTextDocumentChange
    // ─────────────────────────────────────────────────────────────────────────

    public applyChanges(
        session: Session,
        filePath: string,
        changes: ContentChange[]
    ): {
        segments: TextSegment[];
    } {
        const { ledgerStore, segmentManager } = session;
        const ledger = ledgerStore.get(filePath);
        if (!ledger) {
            throw new Error(`No ledger for file: ${filePath}`);
        }

        const isDebugMode = session.debugMode === 'debugOn';
        const isDebugInsert = session.debugMode === 'debugOn' && session.insertMode === 'insertDebug';

        // Record state before edit for undo
        this.recordBeforeEdit(session, filePath, changes[0]?.rangeOffset ?? 0);

        // Process changes in reverse offset order (same as your extension)
        const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);

        for (const change of sorted) {
            segmentManager.applyChange(
                ledger,
                change.rangeOffset,
                change.rangeLength,
                change.text,
                isDebugMode,
                isDebugInsert
            );
        }

        ledger.segments = segmentManager.normalizeSegments(ledger.segments);
        ledger.savedInDebugMode = isDebugMode;

        // Queue save
        ledgerStore.queueSave(filePath);

        // const displayContent = segmentManager.buildTextForMode(ledger.segments, isDebugMode);
        // const debugSegments = segmentManager.getDebugSegments(ledger.segments, isDebugMode);

        console.log(`[SessionManager] Applied ${changes.length} changes to ${path.basename(filePath)}, ${ledger.segments.length} segments`);

        return { segments: segmentManager.deepCopySegments(ledger.segments) };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mode Toggling
    // Ported from HiddenCodeOverlay.toggleDebugMode / toggleInsertMode
    // ─────────────────────────────────────────────────────────────────────────

    public toggleDebugMode(session: Session): {
        debugMode: DebugMode;
        insertMode: InsertMode;
        fileUpdates: Record<string, FileUpdate>;
    } {
        const { segmentManager, ledgerStore } = session;

        // Record mode toggle for undo on all tracked files
        for (const filePath of ledgerStore.getTrackedFilePaths()) {
            this.recordModeToggle(session, filePath);
        }

        // Toggle
        session.debugMode = session.debugMode === 'debugOn' ? 'debugOff' : 'debugOn';

        // When switching to debugOff, force insert mode to normal
        if (session.debugMode === 'debugOff') {
            session.insertMode = 'insertNormal';
        }

        const isDebugMode = session.debugMode === 'debugOn';
        const fileUpdates: Record<string, FileUpdate> = {};

        // Rebuild display content for all tracked files
        for (const [filePath, ledger] of ledgerStore.entries()) {
            // const displayContent = segmentManager.buildTextForMode(ledger.segments, isDebugMode);
            // const debugSegments = segmentManager.getDebugSegments(ledger.segments, isDebugMode);

            // Update saved mode state
            ledger.savedInDebugMode = isDebugMode;

            // const displayContent = segmentManager.buildTextForMode(ledger.segments, isDebugMode);

            // Also write the rebuilt source file to disk
            // (mirrors HiddenCodeOverlay.applyDebugViewToAllFiles -> rebuildAndSaveFile)
            // this.writeSourceFile(filePath, displayContent);

            ledgerStore.queueSave(filePath);

            fileUpdates[filePath] = {
                segments: segmentManager.deepCopySegments(ledger.segments),
            };
        }

        console.log(`[SessionManager] Toggled debug mode -> ${session.debugMode}, updated ${Object.keys(fileUpdates).length} files`);

        return {
            debugMode: session.debugMode,
            insertMode: session.insertMode,
            fileUpdates,
        };
    }

    public toggleInsertMode(session: Session): {
        insertMode: InsertMode;
        debugMode: DebugMode;
    } {
        if (session.debugMode === 'debugOff') {
            // Can't toggle insert mode when debug is off
            return {
                insertMode: session.insertMode,
                debugMode: session.debugMode,
            };
        }

        // Record for undo
        for (const filePath of session.ledgerStore.getTrackedFilePaths()) {
            this.recordInsertModeToggle(session, filePath);
        }

        session.insertMode = session.insertMode === 'insertDebug' ? 'insertNormal' : 'insertDebug';

        console.log(`[SessionManager] Toggled insert mode -> ${session.insertMode}`);

        return {
            insertMode: session.insertMode,
            debugMode: session.debugMode,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Source file writing
    // (replaces MetadataManager.rebuildAndSaveFile for the toggle case)
    // ─────────────────────────────────────────────────────────────────────────

    // private writeSourceFile(filePath: string, content: string): void {
    //     try {
    //         const dir = path.dirname(filePath);
    //         if (!fs.existsSync(dir)) {
    //             fs.mkdirSync(dir, { recursive: true });
    //         }
    //         fs.writeFileSync(filePath, content, 'utf-8');
    //     } catch (err) {
    //         console.error('[SessionManager] Failed to write source file:', filePath, err);
    //     }
    // }

    // ─────────────────────────────────────────────────────────────────────────
    // Document Close
    // ─────────────────────────────────────────────────────────────────────────

    public closeDocument(session: Session, filePath: string): void {
        // Flush any pending undo snapshot
        this.flushPendingSnapshot(session, filePath);

        // Clear undo history
        session.fileHistories.delete(filePath);

        // Flush ledger save
        session.ledgerStore.flushSaves();

        console.log(`[SessionManager] Closed document: ${filePath}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Query helpers
    // ─────────────────────────────────────────────────────────────────────────

    public getTrackedFiles(session: Session): string[] {
        return session.ledgerStore.getTrackedFilePaths().map(
            p => session.pathUtils.toRelativePath(p) ?? p
        );
    }

    public getLedger(session: Session, filePath: string): FileLedger | undefined {
        return session.ledgerStore.get(filePath);
    }

    public getDocumentState(session: Session, filePath: string): {
        segments: TextSegment[];
        // displayContent: string;
        debugMode: DebugMode;
        insertMode: InsertMode;
    } | null {
        const ledger = session.ledgerStore.get(filePath);
        if (!ledger) return null;

        const isDebugMode = session.debugMode === 'debugOn';
        return {
            segments: ledger.segments,
            // debugSegments: session.segmentManager.getDebugSegments(ledger.segments, isDebugMode),
            // displayContent: session.segmentManager.buildTextForMode(ledger.segments, isDebugMode),
            debugMode: session.debugMode,
            insertMode: session.insertMode,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Undo / Redo
    // Ported from UndoRedoManager — now server-side, no vscode editor
    // ─────────────────────────────────────────────────────────────────────────

    private getOrCreateHistory(session: Session, filePath: string): FileHistory {
        let history = session.fileHistories.get(filePath);
        if (!history) {
            history = { undoStack: [], redoStack: [] };
            session.fileHistories.set(filePath, history);
        }
        return history;
    }

    private recordBeforeEdit(session: Session, filePath: string, cursorOffset: number): void {
        const ledger = session.ledgerStore.get(filePath);
        if (!ledger) return;

        const pending = session.pendingSnapshots.get(filePath);
        if (pending) {
            // Extend debounce timer
            clearTimeout(pending.timeout);
            pending.timeout = setTimeout(() => {
                this.commitPendingSnapshot(session, filePath);
            }, SNAPSHOT_DEBOUNCE_MS);
            return;
        }

        // First edit in sequence — capture BEFORE state
        const snapshot: EditSnapshot = {
            segments: session.segmentManager.deepCopySegments(ledger.segments),
            debugMode: session.debugMode,
            insertMode: session.insertMode,
            cursorOffset,
            timestamp: Date.now(),
        };

        const timeout = setTimeout(() => {
            this.commitPendingSnapshot(session, filePath);
        }, SNAPSHOT_DEBOUNCE_MS);

        session.pendingSnapshots.set(filePath, { snapshot, timeout });
    }

    private commitPendingSnapshot(session: Session, filePath: string): void {
        const pending = session.pendingSnapshots.get(filePath);
        if (!pending) return;

        session.pendingSnapshots.delete(filePath);

        const history = this.getOrCreateHistory(session, filePath);
        history.undoStack.push(pending.snapshot);
        history.redoStack = [];

        if (history.undoStack.length > MAX_HISTORY_SIZE) {
            history.undoStack.shift();
        }

        console.log(`[SessionManager] Committed undo snapshot for ${path.basename(filePath)}, stack: ${history.undoStack.length}`);
    }

    private flushPendingSnapshot(session: Session, filePath: string): void {
        const pending = session.pendingSnapshots.get(filePath);
        if (pending) {
            clearTimeout(pending.timeout);
            this.commitPendingSnapshot(session, filePath);
        }
    }

    private recordModeToggle(session: Session, filePath: string): void {
        this.flushPendingSnapshot(session, filePath);

        const ledger = session.ledgerStore.get(filePath);
        if (!ledger) return;

        const history = this.getOrCreateHistory(session, filePath);
        history.undoStack.push({
            segments: session.segmentManager.deepCopySegments(ledger.segments),
            debugMode: session.debugMode,
            insertMode: session.insertMode,
            cursorOffset: 0,
            timestamp: Date.now(),
        });
        history.redoStack = [];

        if (history.undoStack.length > MAX_HISTORY_SIZE) {
            history.undoStack.shift();
        }
    }

    private recordInsertModeToggle(session: Session, filePath: string): void {
        const ledger = session.ledgerStore.get(filePath);
        if (!ledger) return;

        const history = this.getOrCreateHistory(session, filePath);
        history.undoStack.push({
            segments: session.segmentManager.deepCopySegments(ledger.segments),
            debugMode: session.debugMode,
            insertMode: session.insertMode,
            cursorOffset: 0,
            timestamp: Date.now(),
        });
        history.redoStack = [];

        if (history.undoStack.length > MAX_HISTORY_SIZE) {
            history.undoStack.shift();
        }
    }

    public undo(
        session: Session,
        filePath: string,
        currentCursorOffset: number
    ): UndoRedoResponse {
        this.flushPendingSnapshot(session, filePath);

        const history = session.fileHistories.get(filePath);
        const ledger = session.ledgerStore.get(filePath);

        if (!history || history.undoStack.length === 0 || !ledger) {
            const isDebugMode = session.debugMode === 'debugOn';
            return {
                success: false,
                segments: ledger
                    ? session.segmentManager.deepCopySegments(ledger.segments)
                    : [],
                // debugSegments: ledger
                //     ? session.segmentManager.getDebugSegments(ledger.segments, isDebugMode)
                //     : [],
                debugMode: session.debugMode,
                insertMode: session.insertMode,
                cursorOffset: currentCursorOffset,
            };
        }

        // Save current state to redo stack
        history.redoStack.push({
            segments: session.segmentManager.deepCopySegments(ledger.segments),
            debugMode: session.debugMode,
            insertMode: session.insertMode,
            cursorOffset: currentCursorOffset,
            timestamp: Date.now(),
        });

        // Pop previous state
        const snapshot = history.undoStack.pop()!;

        // Restore
        return this.restoreSnapshot(session, filePath, ledger, snapshot);
    }

    public redo(
        session: Session,
        filePath: string,
        currentCursorOffset: number
    ): UndoRedoResponse {
        this.flushPendingSnapshot(session, filePath);

        const history = session.fileHistories.get(filePath);
        const ledger = session.ledgerStore.get(filePath);

        if (!history || history.redoStack.length === 0 || !ledger) {
            const isDebugMode = session.debugMode === 'debugOn';
            return {
                success: false,
                segments: ledger
                    ? session.segmentManager.deepCopySegments(ledger.segments)
                    : [],
                // debugSegments: ledger
                //     ? session.segmentManager.getDebugSegments(ledger.segments, isDebugMode)
                //     : [],
                debugMode: session.debugMode,
                insertMode: session.insertMode,
                cursorOffset: currentCursorOffset,
            };
        }

        // Save current state to undo stack
        history.undoStack.push({
            segments: session.segmentManager.deepCopySegments(ledger.segments),
            debugMode: session.debugMode,
            insertMode: session.insertMode,
            cursorOffset: currentCursorOffset,
            timestamp: Date.now(),
        });

        // Pop redo state
        const snapshot = history.redoStack.pop()!;

        return this.restoreSnapshot(session, filePath, ledger, snapshot);
    }

    private restoreSnapshot(
        session: Session,
        filePath: string,
        ledger: FileLedger,
        snapshot: EditSnapshot
    ): UndoRedoResponse {
        // Restore segments
        ledger.segments = session.segmentManager.deepCopySegments(snapshot.segments);

        // Restore mode state
        session.debugMode = snapshot.debugMode;
        session.insertMode = snapshot.insertMode;

        if (session.debugMode === 'debugOff') {
            session.insertMode = 'insertNormal';
        }

        const isDebugMode = session.debugMode === 'debugOn';
        const displayContent = session.segmentManager.buildTextForMode(ledger.segments, isDebugMode);
        // const debugSegments = session.segmentManager.getDebugSegments(ledger.segments, isDebugMode);

        // Write source file to disk
        // this.writeSourceFile(filePath, displayContent);

        // Save ledger
        session.ledgerStore.queueSave(filePath);

        const cursorOffset = Math.min(snapshot.cursorOffset, displayContent.length);

        console.log(`[SessionManager] Restored snapshot for ${path.basename(filePath)}, mode=${session.debugMode}`);

        return {
            success: true,
            // displayContent,
            // debugSegments,
            segments: session.segmentManager.deepCopySegments(ledger.segments),
            debugMode: session.debugMode,
            insertMode: session.insertMode,
            cursorOffset,
        };
    }
}