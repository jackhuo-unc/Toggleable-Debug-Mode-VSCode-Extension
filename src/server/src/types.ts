// ─────────────────────────────────────────────────────────────────────────────
// Core data types — mirrored from metadata/Types.ts
// but without any vscode dependency
// ─────────────────────────────────────────────────────────────────────────────

export interface TextSegment {
    text: string;
    isDebug: boolean;
}

export interface FileLedger {
    relativePath: string;
    segments: TextSegment[];
    savedInDebugMode: boolean;
    version: number;
}

// export interface DebugSegment {
//     start: number;  // inclusive offset in displayed text
//     end: number;    // exclusive offset in displayed text
// }

export type DebugMode = 'debugOn' | 'debugOff';
export type InsertMode = 'insertDebug' | 'insertNormal';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP API Request / Response types
// ─────────────────────────────────────────────────────────────────────────────

/** POST /session/init */
export interface InitSessionRequest {
    clientId: string;
    workspaceRoot: string;
}

export interface InitSessionResponse {
    sessionId: string;
    trackedFiles: string[];
    debugMode: DebugMode;
    insertMode: InsertMode;
}

/** POST /session/close */
export interface SessionCloseRequest {
    sessionId: string;
}

/** POST /document/open */
export interface DocumentOpenRequest {
    sessionId: string;
    filePath: string;       // absolute path
    content: string;        // full file text as the client sees it
}

export interface DocumentOpenResponse {
    segments: TextSegment[];
    // displayContent: string;
    debugMode: DebugMode;
    insertMode: InsertMode;
}

/** POST /document/change */
export interface DocumentChangeRequest {
    sessionId: string;
    filePath: string;
    changes: ContentChange[];
}

export interface ContentChange {
    rangeOffset: number;
    rangeLength: number;
    text: string;
}

export interface DocumentChangeResponse {
    segments: TextSegment[];
    // displayContent: string;
}

/** POST /mode/toggle */
export interface ToggleModeRequest {
    sessionId: string;
}

export interface ToggleModeResponse {
    debugMode: DebugMode;
    insertMode: InsertMode;
    fileUpdates: Record<string, FileUpdate>;
}

export interface FileUpdate {
    // displayContent: string;
    segments: TextSegment[];
}

/** POST /mode/insert-toggle */
export interface ToggleInsertModeRequest {
    sessionId: string;
}

export interface ToggleInsertModeResponse {
    insertMode: InsertMode;
    debugMode: DebugMode;
}

/** GET /document/segments?sessionId=X&filePath=Y */
export interface GetSegmentsResponse {
    segments: TextSegment[];
    // debugSegments: DebugSegment[];
    debugMode: DebugMode;
    insertMode: InsertMode;
    // displayContent: string;
}

/** POST /document/save — client saved a file */
export interface DocumentSaveRequest {
    sessionId: string;
    filePath: string;
}

/** POST /document/close — client closed a file */
export interface DocumentCloseRequest {
    sessionId: string;
    filePath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Undo/Redo types — server-side history
// ─────────────────────────────────────────────────────────────────────────────

export interface EditSnapshot {
    segments: TextSegment[];
    debugMode: DebugMode;
    insertMode: InsertMode;
    cursorOffset: number;
    timestamp: number;
}

/** POST /undo */
export interface UndoRequest {
    sessionId: string;
    filePath: string;
    cursorOffset: number;   // client sends current cursor position
}

/** POST /redo */
export interface RedoRequest {
    sessionId: string;
    filePath: string;
    cursorOffset: number;
}

export interface UndoRedoResponse {
    success: boolean;
    // displayContent: string;
    segments: TextSegment[];
    debugMode: DebugMode;
    insertMode: InsertMode;
    cursorOffset: number;       // where the client should place the cursor
}


// ─────────────────────────────────────────────────────────────────────────────
// Git sync types — mirror client git state into server metadata repo
// ─────────────────────────────────────────────────────────────────────────────

/** POST /git/sync — client detected a git operation */
export interface GitSyncRequest {
    sessionId: string;
    /** The branch name the client just switched to */
    branch: string;
    /** The commit hash (HEAD) on the client side */
    headCommit: string;
}

export interface GitSyncResponse {
    /** Whether the server successfully mirrored the branch */
    synced: boolean;
    /** Current branch on the server metadata repo */
    serverBranch: string;
    /** Files whose ledgers changed after the branch switch */
    fileUpdates: Record<string, FileUpdate>;
    /** Debug mode detected from the (possibly different) ledgers on this branch */
    detectedDebugMode: DebugMode;
}

/** POST /git/init — ensure the server metadata repo is initialized */
export interface GitInitRequest {
    sessionId: string;
}

export interface GitInitResponse {
    initialized: boolean;
    metadataRepoPath: string;
    currentBranch: string;
}

/** GET /git/status — check server metadata repo state */
export interface GitStatusResponse {
    initialized: boolean;
    currentBranch: string;
    headCommit: string;
    trackedLedgerCount: number;
}