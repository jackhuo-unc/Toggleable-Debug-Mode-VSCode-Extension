import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    TextSegment,
    FileLedger,
    DebugSegment,
    DebugModeChangeCallback,
    PathUtils,
    SegmentManager,
    LedgerStore,
    GitWatcher
} from './metadata/index';

export { TextSegment, FileLedger, DebugSegment };

export class MetadataManager {
	private readonly context: vscode.ExtensionContext;

    private readonly pathUtils: PathUtils;
    private readonly segmentManager: SegmentManager;
    private readonly ledgerStore: LedgerStore;
    private readonly gitWatcher: GitWatcher;

    // Flag to prevent infinite loops when we programmatically edit files
    private isApplyingEdit: boolean = false;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
        this.pathUtils = new PathUtils();
        this.segmentManager = new SegmentManager();
        this.ledgerStore = new LedgerStore(context, this.pathUtils, this.segmentManager);
        this.gitWatcher = new GitWatcher(
            context,
            this.pathUtils,
            this.ledgerStore,
            this.segmentManager,
            async (filePath, ledger, includeDebug) => {
                await this.rebuildSourceFileFromLedger(filePath, ledger, includeDebug);
            }
        );
        console.log('[MetadataManager] constructed');
	}

    public setDebugModeChangeCallback(callback: DebugModeChangeCallback): void {
        this.gitWatcher.setDebugModeChangeCallback(callback);
    }

	public async init(): Promise<void> {
		console.log('[MetadataManager] init()');
        await this.pathUtils.init();
        await this.gitWatcher.init();
	}

    // ─────────────────────────────────────────────────────────────────────────────
    // Public Path Helpers
    // ─────────────────────────────────────────────────────────────────────────────

    public getRelativePathPublic(absolutePath: string): string | null {
        return this.pathUtils.toRelativePath(absolutePath);
    }

    public getAbsolutePathPublic(relativePath: string): string | null {
        return this.pathUtils.toAbsolutePath(relativePath);
    }

    public getMetadataPathPublic(absolutePath: string): string | null {
        return this.pathUtils.getMetadataPath(absolutePath);
    }

    public getSourceFilePathFromMetadata(metadataPath: string): string | null {
        return this.pathUtils.getSourceFilePathFromMetadata(metadataPath);
    }

    public getTrackedFilePaths(): string[] {
        return this.ledgerStore.getTrackedFilePaths();
    }

    public getLedgerForFile(filePath: string): FileLedger | undefined {
        return this.ledgerStore.get(filePath);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Public Segment/Text Helpers
    // ─────────────────────────────────────────────────────────────────────────────

    public buildTextForMode(filePath: string, includeDebug: boolean): string | null {
        const ledger = this.ledgerStore.get(filePath);
        if (!ledger) return null;
        return this.segmentManager.buildTextForMode(ledger.segments, includeDebug);
    }

    public getDebugSegmentsForDocument(doc: vscode.TextDocument): DebugSegment[] {
        const ledger = this.ledgerStore.get(doc.uri.fsPath);
        if (!ledger) return [];
        return this.segmentManager.getDebugSegmentsForDocument(ledger.segments);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Document Change Handling
    // ─────────────────────────────────────────────────────────────────────────────

    public shouldSkipProcessing(filePath: string): boolean {
        return this.gitWatcher.shouldSkipProcessing(filePath);
    }

	/**
     * Handle VS Code document changes and update the ledger accordingly
     */
    public handleTextDocumentChange(
        doc: vscode.TextDocument,
        changes: readonly vscode.TextDocumentContentChangeEvent[],
        isDebugInsert: boolean
    ): void {
        // Skip if this is our own edit
        if (this.isApplyingEdit) return;
        if (doc.uri.scheme !== 'file') return;

        const filePath = doc.uri.fsPath;

        // Skip during git operations
        if (this.shouldSkipProcessing(filePath)) {
            console.log('[MetadataManager] Skipping change processing during git operation:', filePath);
            return;
        }

        if (!this.pathUtils.shouldTrackFile(filePath)) {
            return;
        }

        const ledger = this.ledgerStore.get(filePath);
        if (!ledger) {
            console.warn('[MetadataManager] No ledger for changed doc:', filePath);
            return;
        }

        const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
        const isDebugMode = currentMode === 'debugOn';

        // Process changes in reverse order to maintain correct offsets
        const sortedChanges = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);

        for (const change of sortedChanges) {
            this.segmentManager.applyChange(
                ledger, 
                change.rangeOffset, 
                change.rangeLength,
                change.text,
                isDebugMode, 
                isDebugInsert
            );
        }

        ledger.segments = this.segmentManager.normalizeSegments(ledger.segments);

        ledger.savedInDebugMode = isDebugMode;

        // Queue async save
        this.ledgerStore.queueSave(filePath);

        console.log(`[MetadataManager] Updated ledger for ${path.basename(filePath)}, now ${ledger.segments.length} segments`);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Ledger Management
    // ─────────────────────────────────────────────────────────────────────────────

    public async ensureLedgerForDoc(doc: vscode.TextDocument): Promise<FileLedger | null> {
        if (doc.uri.scheme !== 'file') return null;

        const filePath = doc.uri.fsPath;
        if (!this.pathUtils.shouldTrackFile(filePath)) return null;

        if (this.shouldSkipProcessing(filePath)) {
            return this.ledgerStore.get(filePath) ?? null;
        }

        if (this.ledgerStore.has(filePath)) {
            console.log('[MetadataManager] Ledger already exists, returning cached'); // ADD
            return this.ledgerStore.get(filePath)!;
        }

        // ADD THIS
        console.log('[MetadataManager] ensureLedgerForDoc called:', filePath);

        const metaPath = this.pathUtils.getMetadataPath(filePath);
        if (!metaPath) {
            console.warn('[MetadataManager] Could not determine metadata path for:', filePath);
            return null;
        }

        console.log('[MetadataManager] !!! LOADING FROM DISK !!!', filePath);

        if (fs.existsSync(metaPath)) {
            console.log('[MetadataManager] Loading ledger from disk:', metaPath);
            return await this.loadLedgerFromDisk(filePath, metaPath);
        } else {
            console.log('[MetadataManager] Creating new ledger for:', filePath);
            return this.ledgerStore.createFromText(filePath, doc.getText());
        }
    }

    private async loadLedgerFromDisk(absolutePath: string, metaPath: string): Promise<FileLedger | null> {
        const data = this.ledgerStore.loadFromDisk(absolutePath, metaPath);
        if (!data) return null;
        const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
        const includeDebug = currentMode === 'debugOn';
        const rebuiltText = this.segmentManager.buildTextForMode(data.segments, includeDebug);

        if (rebuiltText !== null) {
            const currentText = fs.existsSync(absolutePath) 
                ? fs.readFileSync(absolutePath, 'utf-8')
                : '';
            if (currentText !== rebuiltText) {
                this.isApplyingEdit = true;
                try {
                    fs.writeFileSync(absolutePath, rebuiltText, 'utf-8');
                    console.log('[MetadataManager] Overwrote source file from metadata:', absolutePath);
                    await this.refreshEditorForFile(absolutePath, rebuiltText);
                } finally {
                    this.isApplyingEdit = false;
                }
            }
        }

        return data;
    }

    private async refreshEditorForFile(filePath: string, newText: string): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);

        if (openDoc) {
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
     * Rebuild a source file from its ledger
     */
    private async rebuildSourceFileFromLedger(
        filePath: string,
        ledger: FileLedger,
        includeDebug: boolean
    ): Promise<void> {
        const newText = this.segmentManager.buildTextForModeFromSegments(ledger.segments, includeDebug);

        // Check if file exists and is different
        if (fs.existsSync(filePath)) {
            const currentText = fs.readFileSync(filePath, 'utf-8');
            if (currentText === newText) {
                console.log('[MetadataManager] File unchanged:', filePath);
                return;
            }
        }

        this.isApplyingEdit = true;
        try {
            fs.writeFileSync(filePath, newText, 'utf-8');
            console.log('[MetadataManager] Rebuilt source file from metadata:', filePath);

            // Refresh editor if open
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
            if (openDoc) {
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                    openDoc.positionAt(0),
                    openDoc.positionAt(openDoc.getText().length)
                );
                edit.replace(openDoc.uri, fullRange, newText);
                await vscode.workspace.applyEdit(edit);
            }
        } finally {
            this.isApplyingEdit = false;
        }
    }



    public async rebuildAndSaveFile(filePath: string, includeDebug: boolean): Promise<void> {
        const ledger = this.ledgerStore.get(filePath);
        if (!ledger) {
            console.warn('[MetadataManager] No ledger for:', filePath);
            return;
        }

        const newText = this.segmentManager.buildTextForModeFromSegments(ledger.segments, includeDebug);

        // Update saved mode state
        ledger.savedInDebugMode = includeDebug;

        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);

        if (openDoc) {
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
            fs.writeFileSync(filePath, newText, 'utf-8');
            console.log('[MetadataManager] Wrote closed file to disk:', filePath);
        }

        // Save the updated ledger
        this.ledgerStore.queueSave(filePath);
    }

    public async scanWorkspaceForFiles(): Promise<void> {
        await this.ledgerStore.scanWorkspace();
    }

    /**
     * Restore segments for a file (used by UndoRedoManager).
     * This directly replaces the segments in the ledger.
     */
    public restoreSegments(filePath: string, segments: TextSegment[]): void {
        const ledger = this.ledgerStore.get(filePath);
        if (!ledger) {
            console.warn('[MetadataManager] Cannot restore segments, no ledger for:', filePath);
            return;
        }

        ledger.segments = segments;
        console.log(`[MetadataManager] Restored ${segments.length} segments for ${filePath}`);
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

    public queueSavePublic(filePath: string): void {
        this.ledgerStore.queueSave(filePath);
    }

    public dispose(): void {
        console.log('[MetadataManager] dispose()');
        this.gitWatcher.dispose();
        this.ledgerStore.dispose();
    }

}
