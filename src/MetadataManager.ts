import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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

export interface DebugSegment {
    start: number; // inclusive offset in current document text
    end: number;   // exclusive offset in current document text
}

export class MetadataManager {
	private readonly context: vscode.ExtensionContext;
    private ledgers: Map<string, FileLedger> = new Map();
    private saveQueue: Set<string> = new Set();
    private saveTimeout: NodeJS.Timeout | null = null;

    // Flag to prevent infinite loops when we programmatically edit files
    private isApplyingEdit: boolean = false;

	private rootDir: string | null = null;

    private isGitOperation: boolean = false;
    private gitOperationTimeout: NodeJS.Timeout | null = null;

    private fileHashes: Map<string, string> = new Map();
    //Files to skip processing (during git operations)
    private skipProcessing: Set<string> = new Set();

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
        console.log('[MetadataManager] constructed');
	}

	public async init(): Promise<void> {
		console.log('[MetadataManager] init()');
        this.rootDir = await this.findRootDir();
        console.log('[MetadataManager] rootDir =', this.rootDir);

        this.watchForGitOperations();
	}

    /**
     * Find the root directory for relative paths.
     * Prefers git root, falls back to workspace root.
     */
    private async findRootDir(): Promise<string | null> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // Try to find .git directory by walking up from workspace root
        let currentDir = workspaceRoot;
        while (currentDir !== path.dirname(currentDir)) { // stop at filesystem root
            const gitDir = path.join(currentDir, '.git');
            if (fs.existsSync(gitDir)) {
                console.log('[MetadataManager] Found git root:', currentDir);
                return currentDir;
            }
            currentDir = path.dirname(currentDir);
        }

        // No git repo found, use workspace root
        console.log('[MetadataManager] No git root found, using workspace root:', workspaceRoot);
        return workspaceRoot;
    }
    /**
     * Watch for git operations by monitoring .git/HEAD and .git/index
     */
    private watchForGitOperations(): void {
        if (!this.rootDir) return;

        const gitDir = path.join(this.rootDir, '.git');
        if (!fs.existsSync(gitDir)) return;

        // Watch HEAD file for branch switches
        const headPath = path.join(gitDir, 'HEAD');
        const indexPath = path.join(gitDir, 'index');

        // Use file system watcher for git files
        const gitWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, '{HEAD,index,ORIG_HEAD,FETCH_HEAD}')
        );

        this.context.subscriptions.push(
            gitWatcher.onDidChange(() => this.onGitOperationDetected()),
            gitWatcher.onDidCreate(() => this.onGitOperationDetected()),
            gitWatcher
        );

        // Also listen for workspace file changes that might indicate git operations
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                // If many files change at once in quick succession, likely a git operation
                this.detectBulkChanges(event.document.uri.fsPath);
            })
        );
        console.log('[MetadataManager] Git watcher initialized');
    }

    private bulkChangeCount = 0;
    private bulkChangeTimer: NodeJS.Timeout | null = null;

    /**
     * Detect bulk file changes that indicate a git operation
     */
    private detectBulkChanges(filePath: string): void {
        if (this.isApplyingEdit) return;
        if (!this.shouldTrackFile(filePath)) return;

        this.bulkChangeCount++;

        if (this.bulkChangeTimer) {
            clearTimeout(this.bulkChangeTimer);
        }

        this.bulkChangeTimer = setTimeout(() => {
            if (this.bulkChangeCount > 3) {
                console.log(`[MetadataManager] Bulk changes detected (${this.bulkChangeCount} files), likely git operation`);
                this.onGitOperationDetected();
            }
            this.bulkChangeCount = 0;
        }, 100);
    }

    /**
     * Called when a git operation (branch switch, checkout, etc.) is detected
     */
    private onGitOperationDetected(): void {
        console.log('[MetadataManager] Git operation detected');
        
        this.isGitOperation = true;

        // Clear any existing timeout
        if (this.gitOperationTimeout) {
            clearTimeout(this.gitOperationTimeout);
        }

        // Mark all tracked files to skip processing temporarily
        for (const filePath of this.ledgers.keys()) {
            this.skipProcessing.add(filePath);
        }

        // After git operation settles, rebuild files from metadata
        this.gitOperationTimeout = setTimeout(async () => {
            console.log('[MetadataManager] Git operation settled, rebuilding files from metadata');
            await this.rebuildAllFilesFromMetadata();
            this.isGitOperation = false;
            this.skipProcessing.clear();
        }, 500);
    }

    /**
     * Check if we should skip processing for a file (during git operations)
     */
    public shouldSkipProcessing(filePath: string): boolean {
        return this.isGitOperation || this.skipProcessing.has(filePath);
    }

    /**
     * Rebuild all tracked files from their metadata
     */
    private async rebuildAllFilesFromMetadata(): Promise<void> {
        const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
        const includeDebug = currentMode === 'debugOn';

        // First, reload all metadata files (they may have changed due to git)
        await this.reloadAllMetadataFromDisk();

        // Then rebuild source files
        for (const [filePath, ledger] of this.ledgers.entries()) {
            await this.rebuildSourceFileFromLedger(filePath, ledger, includeDebug);
        }

        // Refresh all open editors
        for (const editor of vscode.window.visibleTextEditors) {
            const filePath = editor.document.uri.fsPath;
            if (this.ledgers.has(filePath)) {
                // Force reload the document
                await vscode.commands.executeCommand('workbench.action.files.revert');
            }
        }

        console.log('[MetadataManager] All files rebuilt from metadata');
    }

    /**
     * Reload all metadata files from disk (after git operation)
     */
    private async reloadAllMetadataFromDisk(): Promise<void> {
        const trackedFiles = [...this.ledgers.keys()];

        for (const filePath of trackedFiles) {
            const metadataPath = this.getMetadataPath(filePath);
            if (!metadataPath) continue;

            if (fs.existsSync(metadataPath)) {
                try {
                    const raw = fs.readFileSync(metadataPath, 'utf-8');
                    const data = JSON.parse(raw) as FileLedger;
                    
                    // Migrate old format if needed
                    if (data.version === undefined) {
                        data.version = 1;
                        data.savedInDebugMode = false; // Assume old files were saved in debugOff
                    }

                    this.ledgers.set(filePath, data);
                    console.log('[MetadataManager] Reloaded metadata for:', filePath);
                } catch (err) {
                    console.error('[MetadataManager] Failed to reload metadata:', err);
                }
            } else {
                // Metadata file was deleted (maybe on different branch)
                console.log('[MetadataManager] Metadata file not found after git op:', metadataPath);
                this.ledgers.delete(filePath);
            }
        }

        // Also scan for new metadata files that may have appeared
        await this.scanWorkspaceForFiles();
    }

    /**
     * Rebuild a source file from its ledger
     */
    private async rebuildSourceFileFromLedger(
        filePath: string,
        ledger: FileLedger,
        includeDebug: boolean
    ): Promise<void> {
        const newText = this.buildTextForModeFromSegments(ledger.segments, includeDebug);

        // Check if file exists and is different
        if (fs.existsSync(filePath)) {
            const currentText = fs.readFileSync(filePath, 'utf-8');
            if (currentText === newText) {
                console.log('[MetadataManager] File unchanged:', filePath);
                return;
            }
        }

        // Write to disk
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

    /**
     * Convert absolute path to relative path from root
     */
    private toRelativePath(absolutePath: string): string | null {
        if (!this.rootDir) return null;
        return path.relative(this.rootDir, absolutePath);
    }

    public getRelativePathPublic(absolutePath: string): string | null {
        return this.toRelativePath(absolutePath);
    }

    /**
     * Convert relative path to absolute path
     */
    private toAbsolutePath(relativePath: string): string | null {
        if (!this.rootDir) return null;
        return path.join(this.rootDir, relativePath);
    }

    public getAbsolutePathPublic(relativePath: string): string | null {
        return this.toAbsolutePath(relativePath);
    }

    // Get the __debuggable__ folder path for a given file (using relative structure)
    private getMetadataDir(absolutePath: string): string | null {
        const relativePath = this.toRelativePath(absolutePath);
        if (!relativePath || !this.rootDir) return null;

        const relativeDir = path.dirname(relativePath);
        return path.join(this.rootDir, relativeDir, '__debuggable__');
    }

    // Get the metadata JSON file path for a given source file
    private getMetadataPath(absolutePath: string): string | null {
        const metaDir = this.getMetadataDir(absolutePath);
        if (!metaDir) return null;

        const baseName = path.basename(absolutePath);
        return path.join(metaDir, `${baseName}.json`);
    }

    public getMetadataPathPublic(absolutePath: string): string | null {
        return this.getMetadataPath(absolutePath);
    }

    public getSourceFilePathFromMetadata(metadataPath: string): string | null {
        if (!this.rootDir) return null;

        const metadataDir = path.dirname(metadataPath);
        const fileName = path.basename(metadataPath, '.json');

        if (!metadataDir.endsWith('__debuggable__')) {
            return null;
        }

        const sourceDir = path.dirname(metadataDir);
        return path.join(sourceDir, fileName);
    }

    //Check if a file should be tracked (exclude metadata files, config, etc.)
    private shouldTrackFile(filePath: string): boolean {
        if (!filePath || filePath.length === 0) return false;
        if (!path.isAbsolute(filePath)) return false;
        if (filePath.includes('__debuggable__')) return false;
        if (filePath.includes('VSCODE-config')) return false;
        if (filePath.includes('.vscode')) return false;
        if (filePath.includes('node_modules')) return false;
        if (filePath.endsWith('.git')) return false;
        if (filePath.includes(path.sep + 'log' + path.sep)) return false;

        // Ensure file is within our root directory
        if (this.rootDir && !filePath.startsWith(this.rootDir)) return false;

        return true;
    }

    /**
     * Get all file paths that have ledgers loaded
     */
    public getTrackedFilePaths(): string[] {
        return Array.from(this.ledgers.keys());
    }

    public getLedgerForFile(filePath: string): FileLedger | undefined {
        return this.ledgers.get(filePath);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Segment Helpers
    // ─────────────────────────────────────────────────────────────────────────────

    private buildTextForModeFromSegments(segments: TextSegment[], includeDebug: boolean): string {
        if (includeDebug) {
            return segments.map(s => s.text).join('');
        }
        return segments.filter(s => !s.isDebug).map(s => s.text).join('');
    }

    /**
     * Build full text from segments
     */
    private buildFullText(segments: TextSegment[]): string {
        return segments.map(s => s.text).join('');
    }

    /**
     * Build text for a specific mode (include or exclude debug segments)
     */
    public buildTextForMode(filePath: string, includeDebug: boolean): string | null {
        const ledger = this.ledgers.get(filePath);
        if (!ledger) return null;

        if (includeDebug) {
            return this.buildFullText(ledger.segments);
        }

        return ledger.segments
            .filter(s => !s.isDebug)
            .map(s => s.text)
            .join('');
    }

    /**
     * Normalize segments: merge adjacent segments with same isDebug value,
     * remove empty segments
     */
    private normalizeSegments(segments: TextSegment[]): TextSegment[] {
        const result: TextSegment[] = [];

        for (const seg of segments) {
            if (seg.text.length === 0) continue;

            const last = result[result.length - 1];
            if (last && last.isDebug === seg.isDebug) {
                // Merge with previous
                last.text += seg.text;
            } else {
                result.push({ text: seg.text, isDebug: seg.isDebug });
            }
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Offset Mapping
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Find which segment and offset within that segment corresponds to a global offset.
     * If isDebugMode is false, we skip debug segments when counting.
     * 
     * Returns: { segmentIndex, offsetInSegment, globalLedgerOffset }
     */
    private findSegmentAtOffset(
        segments: TextSegment[],
        visibleOffset: number,
        isDebugMode: boolean
    ): { segmentIndex: number; offsetInSegment: number; globalLedgerOffset: number } {
        let visibleCount = 0;
        let globalOffset = 0;

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];

            // In debugOff mode, skip debug segments for counting
            if (!isDebugMode && seg.isDebug) {
                globalOffset += seg.text.length;
                continue;
            }

            if (visibleCount + seg.text.length >= visibleOffset) {
                // Found the segment
                const offsetInSegment = visibleOffset - visibleCount;
                return {
                    segmentIndex: i,
                    offsetInSegment,
                    globalLedgerOffset: globalOffset + offsetInSegment
                };
            }

            visibleCount += seg.text.length;
            globalOffset += seg.text.length;
        }

        // Past the end - return position at end
        return {
            segmentIndex: segments.length,
            offsetInSegment: 0,
            globalLedgerOffset: globalOffset
        };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Document Change Handling
    // ─────────────────────────────────────────────────────────────────────────────

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

        if (!this.shouldTrackFile(filePath)) {
            return;
        }

        const ledger = this.ledgers.get(filePath);
        if (!ledger) {
            console.warn('[MetadataManager] No ledger for changed doc:', filePath);
            return;
        }

        const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
        const isDebugMode = currentMode === 'debugOn';

        // Process changes in reverse order to maintain correct offsets
        const sortedChanges = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);

        for (const change of sortedChanges) {
            // const { rangeOffset, rangeLength, text } = change;
            this.applyChangeToSegments(ledger, change, isDebugMode, isDebugInsert);
        }

        ledger.segments = this.normalizeSegments(ledger.segments);

        ledger.savedInDebugMode = isDebugMode;

        // Queue async save
        this.queueSave(filePath);

        console.log(`[MetadataManager] Updated ledger for ${path.basename(filePath)}, now ${ledger.segments.length} segments`);
    }

    /**
     * Apply a single change to the segment list
     */
    private applyChangeToSegments(
        ledger: FileLedger,
        change: vscode.TextDocumentContentChangeEvent,
        isDebugMode: boolean,
        isDebugInsert: boolean
    ): void {
        const { rangeOffset, rangeLength, text } = change;

        // Find where the change starts in our segment structure
        const startPos = this.findSegmentAtOffset(ledger.segments, rangeOffset, isDebugMode);
        
        // Find where the deletion ends (if any)
        const endPos = rangeLength > 0
            ? this.findSegmentAtOffset(ledger.segments, rangeOffset + rangeLength, isDebugMode)
            : startPos;

        // Perform the splice operation on segments
        this.spliceSegments(ledger, startPos, endPos, text, isDebugInsert, isDebugMode);
    }

    /**
     * Splice text into/out of segments
     */
    private spliceSegments(
        ledger: FileLedger,
        startPos: { segmentIndex: number; offsetInSegment: number },
        endPos: { segmentIndex: number; offsetInSegment: number },
        insertText: string,
        isDebugInsert: boolean,
        isDebugMode: boolean
    ): void {
        const segments = ledger.segments;

        // Handle edge case: empty segments
        if (segments.length === 0) {
            if (insertText.length > 0) {
                segments.push({ text: insertText, isDebug: isDebugInsert });
            }
            return;
        }

        // Clamp indices
        const startIdx = Math.min(startPos.segmentIndex, segments.length - 1);
        const endIdx = Math.min(endPos.segmentIndex, segments.length - 1);

        if (startIdx === endIdx && startIdx < segments.length) {
            // Change is within a single segment
            const seg = segments[startIdx];
            
            // In debugOff mode, skip debug segments
            if (!isDebugMode && seg.isDebug) {
                // Insert after this debug segment
                if (insertText.length > 0) {
                    segments.splice(startIdx + 1, 0, { text: insertText, isDebug: isDebugInsert });
                }
                return;
            }

            const before = seg.text.slice(0, startPos.offsetInSegment);
            const after = seg.text.slice(endPos.offsetInSegment);

            if (seg.isDebug === isDebugInsert) {
                // Same type - just modify in place
                seg.text = before + insertText + after;
            } else {
                // Different type - split into up to 3 segments
                const newSegments: TextSegment[] = [];
                if (before.length > 0) {
                    newSegments.push({ text: before, isDebug: seg.isDebug });
                }
                if (insertText.length > 0) {
                    newSegments.push({ text: insertText, isDebug: isDebugInsert });
                }
                if (after.length > 0) {
                    newSegments.push({ text: after, isDebug: seg.isDebug });
                }
                segments.splice(startIdx, 1, ...newSegments);
            }
        } else {
            // Change spans multiple segments
            const newSegments: TextSegment[] = [];

            // Keep the part before the change in the start segment
            if (startIdx < segments.length) {
                const startSeg = segments[startIdx];
                const before = startSeg.text.slice(0, startPos.offsetInSegment);
                if (before.length > 0) {
                    newSegments.push({ text: before, isDebug: startSeg.isDebug });
                }
            }

            // Add the inserted text
            if (insertText.length > 0) {
                newSegments.push({ text: insertText, isDebug: isDebugInsert });
            }

            // Keep the part after the change in the end segment
            if (endIdx < segments.length) {
                const endSeg = segments[endIdx];
                const after = endSeg.text.slice(endPos.offsetInSegment);
                if (after.length > 0) {
                    newSegments.push({ text: after, isDebug: endSeg.isDebug });
                }
            }

            // Replace the affected segments
            const deleteCount = endIdx - startIdx + 1;
            segments.splice(startIdx, deleteCount, ...newSegments);
        }
    }


    // ─────────────────────────────────────────────────────────────────────────────
    // Ledger Loading/Saving
    // ─────────────────────────────────────────────────────────────────────────────

    public async ensureLedgerForDoc(doc: vscode.TextDocument): Promise<FileLedger | null> {
        if (doc.uri.scheme !== 'file') return null;

        const filePath = doc.uri.fsPath;
        if (!this.shouldTrackFile(filePath)) return null;

        if (this.shouldSkipProcessing(filePath)) {
            return this.ledgers.get(filePath) ?? null;
        }

        if (this.ledgers.has(filePath)) {
            return this.ledgers.get(filePath)!;
        }

        const metaPath = this.getMetadataPath(filePath);
        if (!metaPath) {
            console.warn('[MetadataManager] Could not determine metadata path for:', filePath);
            return null;
        }

        if (fs.existsSync(metaPath)) {
            console.log('[MetadataManager] Loading ledger from disk:', metaPath);
            return await this.loadLedgerFromDisk(filePath, metaPath);
        } else {
            console.log('[MetadataManager] Creating new ledger for:', filePath);
            return this.createLedgerFromText(filePath, doc.getText());
        }
    }

    private async loadLedgerFromDisk(absolutePath: string, metaPath: string): Promise<FileLedger | null> {
        try {
            const raw = fs.readFileSync(metaPath, 'utf-8');
            const data = JSON.parse(raw) as FileLedger;

            // Migrate old format
            if (data.version === undefined) {
                data.version = 1;
                data.savedInDebugMode = false;
            }

            this.ledgers.set(absolutePath, data);

            const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
            const includeDebug = currentMode === 'debugOn';
            const rebuiltText = this.buildTextForMode(absolutePath, includeDebug);

            if (rebuiltText !== null) {
                // Check if source file needs to be updated
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
        } catch (err) {
            console.error('[MetadataManager] Failed to load ledger:', err);
            return null;
        }
    }

    private createLedgerFromText(absolutePath: string, text: string): FileLedger {
        const relativePath = this.toRelativePath(absolutePath);
        if (!relativePath) {
            throw new Error(`Cannot create ledger: unable to compute relative path for ${absolutePath}`);
        }

        const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
        const isDebugMode = currentMode === 'debugOn';

        // Start with a single non-debug segment containing all text
        const ledger: FileLedger = {
            relativePath,
            segments: text.length > 0 ? [{ text, isDebug: false }] : [],
            savedInDebugMode: isDebugMode,
            version: 1
        };

        this.ledgers.set(absolutePath, ledger);
        this.queueSave(absolutePath);

        return ledger;
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

    public async rebuildAndSaveFile(filePath: string, includeDebug: boolean): Promise<void> {
        const ledger = this.ledgers.get(filePath);
        if (!ledger) {
            console.warn('[MetadataManager] No ledger for:', filePath);
            return;
        }

        const newText = this.buildTextForMode(filePath, includeDebug);
        if (newText === null) {
            console.warn('[MetadataManager] Failed to build text for:', filePath);
            return;
        }

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
        this.queueSave(filePath);
    }

    public async scanWorkspaceForFiles(): Promise<void> {
        if (!this.rootDir) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for (const folder of workspaceFolders) {
            const pattern = new vscode.RelativePattern(folder, '**/__debuggable__/*.json');
            const metadataFiles = await vscode.workspace.findFiles(pattern);

            for (const metaUri of metadataFiles) {
                const metaPath = metaUri.fsPath;
                const sourceFilePath = this.getSourceFilePathFromMetadata(metaPath);
                
                if (!sourceFilePath) continue;
                if (this.ledgers.has(sourceFilePath)) continue;

                try {
                    const raw = fs.readFileSync(metaPath, 'utf-8');
                    const data = JSON.parse(raw) as FileLedger;

                    // Migrate old format
                    if (data.version === undefined) {
                        data.version = 1;
                        data.savedInDebugMode = false;
                    }

                    this.ledgers.set(sourceFilePath, data);
                    console.log('[MetadataManager] Loaded metadata for:', sourceFilePath);

                    // Rebuild source file if needed
                    const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
                    const includeDebug = currentMode === 'debugOn';
                    
                    await this.rebuildSourceFileFromLedger(sourceFilePath, data, includeDebug);
                } catch (err) {
                    console.error('[MetadataManager] Failed to load metadata:', metaPath, err);
                }
            }
        }

        console.log(`[MetadataManager] Scanned workspace, tracking ${this.ledgers.size} files`);
    }

    /**
     * Restore segments for a file (used by UndoRedoManager).
     * This directly replaces the segments in the ledger.
     */
    public restoreSegments(filePath: string, segments: TextSegment[]): void {
        const ledger = this.ledgers.get(filePath);
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

    // ─────────────────────────────────────────────────────────────────────────────
    // Debug Segments for Highlighting
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get debug segments (ranges of debug-only code) for highlighting.
     * Returns offsets in the VISIBLE text (for use with VS Code ranges).
     */
    public getDebugSegmentsForDocument(doc: vscode.TextDocument): DebugSegment[] {
        const filePath = doc.uri.fsPath;
        const ledger = this.ledgers.get(filePath);
        if (!ledger) return [];

        const result: DebugSegment[] = [];
        let offset = 0;

        for (const seg of ledger.segments) {
            if (seg.isDebug) {
                result.push({
                    start: offset,
                    end: offset + seg.text.length
                });
            }
            offset += seg.text.length;
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Persistence
    // ─────────────────────────────────────────────────────────────────────────────

    private queueSave(filePath: string): void {
        this.saveQueue.add(filePath);

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.flushSaves();
        }, 500);
    }

    public queueSavePublic(filePath: string): void {
        this.queueSave(filePath);
    }

    private async flushSaves(): Promise<void> {
        const toSave = [...this.saveQueue];
        this.saveQueue.clear();

        for (const filePath of toSave) {
            await this.saveLedgerToDisk(filePath);
        }
    }

    private async saveLedgerToDisk(filePath: string): Promise<void> {
        const ledger = this.ledgers.get(filePath);
        if (!ledger) return;

        const metaDir = this.getMetadataDir(filePath);
        const metaPath = this.getMetadataPath(filePath);

        if (!metaDir || !metaPath) {
            console.error('[MetadataManager] Invalid paths for saving:', filePath);
            return;
        }

        try {
            if (!fs.existsSync(metaDir)) {
                fs.mkdirSync(metaDir, { recursive: true });
            }

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
        if (this.gitOperationTimeout) {
            clearTimeout(this.gitOperationTimeout);
        }
        if (this.bulkChangeTimer) {
            clearTimeout(this.bulkChangeTimer);
        }
        this.flushSaves();
    }

}
