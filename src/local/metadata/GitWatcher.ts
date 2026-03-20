import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { FileLedger, DebugModeChangeCallback } from './Types';
import { PathUtils } from './PathUtils';
import { LedgerStore } from './LedgerStore';

export class GitWatcher {
    private isGitOperation: boolean = false;
    private gitOperationTimeout: NodeJS.Timeout | null = null;

    //Files to skip processing (during git operations)
    private skipProcessing: Set<string> = new Set();

    // Callback to notify when debug mode should change
    private onDebugModeChange: DebugModeChangeCallback | null = null;

    // Track the last git HEAD to detect ACTUAL git operations
    private lastGitHead: string | null = null;
    private lastIndexMtime: number = 0;

    private headWatcher: fs.FSWatcher | null = null;
    private indexWatcher: fs.FSWatcher | null = null;

     /**
     * GLOBAL flag - when true, NOTHING in the extension should write metadata.
     * Checked by MetadataManager, LedgerStore, and extension.ts event handlers.
     */
    private _blocked: boolean = false;

    private gitDir: string | null = null;
    private rootDir: string | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly pathUtils: PathUtils,
        private readonly ledgerStore: LedgerStore,
        private readonly onRebuildFile: (filePath: string, ledger: FileLedger, includeDebug: boolean) => Promise<void>
    ) {}

    /**
     * Is the extension currently blocked due to a git operation?
     * This should be checked before ANY metadata write or segment processing.
     */
    public get blocked(): boolean {
        return this._blocked;
    }

    /**
     * Register a callback to be notified when debug mode should change
     * (e.g., after a git operation detects a different saved mode)
     */
    public setDebugModeChangeCallback(callback: DebugModeChangeCallback): void {
        this.onDebugModeChange = callback;
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Git Operation Detection
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Watch for git operations by monitoring .git/HEAD
     */
    public init(): void {
        const rootDir = this.pathUtils.getRootDir();
        if (!rootDir) {
            console.log('[GitWatcher] No root dir, skipping init');
            return;
        }
        this.rootDir = rootDir;

        const gitDir = path.join(rootDir, '.git');
        if (!fs.existsSync(gitDir)) {
            console.log('[GitWatcher] No .git directory found, skipping init');
            return;
        }
        this.gitDir = gitDir;

        this.lastGitHead = this.readGitHead();
        console.log('[GitWatcher] Initial HEAD:', this.lastGitHead?.substring(0, 8));
        this.lastIndexMtime = this.getIndexMtime();


        const headPath = path.join(gitDir, 'HEAD');
        const indexPath = path.join(this.gitDir, 'index');

        try {
            if (fs.existsSync(headPath)) {
                this.headWatcher = fs.watch(headPath, () => {
                    console.log('[GitWatcher] .git/HEAD changed');
                    this.onGitFileTouched('HEAD');
                });
                console.log('[GitWatcher] Watching .git/HEAD');
            }
        } catch (err) {
            console.error('[GitWatcher] Failed to watch HEAD:', err);
        }

        // Watch .git/index — fires on: restore, reset, add, stash, checkout (files)
        try {
            if (fs.existsSync(indexPath)) {
                this.indexWatcher = fs.watch(indexPath, () => {
                    console.log('[GitWatcher] .git/index changed');
                    this.onGitFileTouched('index');
                });
                console.log('[GitWatcher] Watching .git/index');
            }
        } catch (err) {
            console.error('[GitWatcher] Failed to watch index:', err);
        }

        console.log('[GitWatcher] Initialized');
    }

    private onGitFileTouched(source: 'HEAD' | 'index'): void {
        // IMMEDIATELY block everything
        this._blocked = true;
        console.log(`[GitWatcher] BLOCKED (triggered by ${source})`);

        // Debounce — git operations often touch multiple files in sequence
        if (this.gitOperationTimeout) {
            clearTimeout(this.gitOperationTimeout);
        }

        this.gitOperationTimeout = setTimeout(async () => {
            await this.handleGitSettled();
        }, 500);
    }

    private onHeadTouched(): void {
        // IMMEDIATELY block everything
        this._blocked = true;
        console.log('[GitWatcher] BLOCKED all extension processing');

        // Debounce - git may touch HEAD multiple times
        if (this.gitOperationTimeout) {
            clearTimeout(this.gitOperationTimeout);
        }

        this.gitOperationTimeout = setTimeout(async () => {
            await this.handleGitSettled();
        }, 10); // Wait for git to fully settle
    }

    private async handleGitSettled(): Promise<void> {
        if (!this.rootDir || !this.gitDir) {
            this._blocked = false;
            return;
        }

        const newHead = this.readGitHead();
        const newIndexMtime = this.getIndexMtime();

        const headChanged = newHead !== null && newHead !== this.lastGitHead;
        const indexChanged = newIndexMtime !== this.lastIndexMtime;

        if (!headChanged && !indexChanged) {
            console.log('[GitWatcher] No actual changes detected, unblocking');
            this._blocked = false;
            return;
        }

        console.log('[GitWatcher] ════════════════════════════════════');
        if (headChanged) {
            console.log('[GitWatcher] HEAD changed:',
                this.lastGitHead?.substring(0, 8), '->', newHead?.substring(0, 8));
        }
        if (indexChanged) {
            console.log('[GitWatcher] Index mtime changed:',
                this.lastIndexMtime, '->', newIndexMtime);
        }
        console.log('[GitWatcher] ════════════════════════════════════');

        this.lastGitHead = newHead;
        this.lastIndexMtime = newIndexMtime;

        try {
            // Step 1: Undo any metadata corruption
            console.log('[GitWatcher] Running: git restore .');
            execSync('git restore .', { cwd: this.rootDir, stdio: 'pipe' });
            console.log('[GitWatcher] git restore complete');

            // Step 2: Wait for disk to settle
            await new Promise(resolve => setTimeout(resolve, 500));

            // Step 3: Reload the window
            console.log('[GitWatcher] Reloading window...');
            await vscode.commands.executeCommand('workbench.action.reloadWindow');

        } catch (err) {
            console.error('[GitWatcher] Error during git recovery:', err);
            try {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            } catch {
                this._blocked = false;
                vscode.window.showErrorMessage(
                    'Debug extension: Git recovery failed. Please reload the window manually.'
                );
            }
        }
    }

    private readGitHead(): string | null {
        if (!this.gitDir) return null;
        try {
            const headPath = path.join(this.gitDir, 'HEAD');
            const headContent = fs.readFileSync(headPath, 'utf-8').trim();

            if (headContent.startsWith('ref: ')) {
                const refPath = path.join(this.gitDir, headContent.slice(5));
                if (fs.existsSync(refPath)) {
                    return fs.readFileSync(refPath, 'utf-8').trim();
                }
                return headContent;
            }
            return headContent;
        } catch {
            return null;
        }
    }

    private getIndexMtime(): number {
        if (!this.gitDir) return 0;
        try {
            const indexPath = path.join(this.gitDir, 'index');
            const stat = fs.statSync(indexPath);
            return stat.mtimeMs;
        } catch {
            return 0;
        }
    }

    private onGitFileChanged(gitDir: string): void {
        const newHead = this.readGitHead();
        
        // Only trigger if HEAD actually changed (different commit)
        if (newHead && newHead !== this.lastGitHead) {
            console.log('[GitWatcher] HEAD changed:', this.lastGitHead?.substring(0, 8), '->', newHead.substring(0, 8));
            this.lastGitHead = newHead;
            this.onGitOperationDetected();
        } else {
            console.log('[GitWatcher] HEAD file touched but commit unchanged, ignoring');
        }
    }

     /**
     * Check if we should skip processing for a file (during git operations)
     */
    public shouldSkipProcessing(filePath: string): boolean {
        return this.isGitOperation || this.skipProcessing.has(filePath);
    }

    public isInGitOperation(): boolean {
        return this.isGitOperation;
    }

    /**
     * Called when a git operation (branch switch, checkout, etc.) is detected
     */
    private onGitOperationDetected(): void {
        console.log('[MetadataManager] Git operation detected (HEAD changed)');
        
        this.isGitOperation = true;

        // Clear any existing timeout
        if (this.gitOperationTimeout) {
            clearTimeout(this.gitOperationTimeout);
        }

        // Mark all tracked files to skip processing temporarily
        for (const filePath of this.ledgerStore.keys()) {
            this.skipProcessing.add(filePath);
        }

        // After git operation settles, rebuild files from metadata
        this.gitOperationTimeout = setTimeout(async () => {
            console.log('[MetadataManager] Git operation settled, rebuilding files from metadata');
            await this.handlePostGitOperation();
            this.isGitOperation = false;
            this.skipProcessing.clear();
        }, 10);
    }

    /**
     * Handle post-git-operation: detect saved mode and switch if needed
     */
    private async handlePostGitOperation(): Promise<void> {
        // Reload metadata from disk first
        await this.reloadAllMetadataFromDisk();

        // Determine what debug mode the metadata was saved in
        const detectedMode = this.detectSavedDebugMode();
        const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';

        console.log(`[MetadataManager] Detected saved mode: ${detectedMode}, current mode: ${currentMode}`);

        if (detectedMode !== null && detectedMode !== currentMode) {
            console.log(`[MetadataManager] Switching debug mode to match saved state: ${detectedMode}`);
            
            // Update the stored mode
            await this.context.workspaceState.update('hiddenOverlay.debugMode', detectedMode);

            // Notify the overlay manager to update UI and highlights
            if (this.onDebugModeChange) {
                await this.onDebugModeChange(detectedMode as 'debugOn' | 'debugOff');
            }

            // Show notification to user
            const modeLabel = detectedMode === 'debugOn' ? 'Debug ON' : 'Debug OFF';
            vscode.window.showInformationMessage(
                `Switched to ${modeLabel} mode to match the checked-out commit.`
            );
            await this.rebuildAllFilesFromMetadata();
        } else {
            // Mode is the same - DON'T rebuild, just refresh metadata in memory
            console.log('[GitWatcher] Mode unchanged, skipping file rebuild');
        }
    }

    /**
     * Detect what debug mode the metadata files were saved in.
     * Uses majority voting if files have different states.
     */
    private detectSavedDebugMode(): string | null {
        let debugOnCount = 0;
        let debugOffCount = 0;

        for (const ledger of this.ledgerStore.values()) {
            if (ledger.savedInDebugMode === true) {
                debugOnCount++;
            } else if (ledger.savedInDebugMode === false) {
                debugOffCount++;
            }
            // If undefined (old format), don't count
        }

        const total = debugOnCount + debugOffCount;
        if (total === 0) {
            return null; // No metadata with saved state
        }

        // Use majority voting
        if (debugOnCount > debugOffCount) {
            return 'debugOn';
        } else {
            return 'debugOff';
        }
    }

    /**
     * Reload all metadata files from disk (after git operation)
     */
   private async reloadAllMetadataFromDisk(): Promise<void> {
        const trackedFiles = [...this.ledgerStore.keys()];

        for (const filePath of trackedFiles) {
            const metadataPath = this.pathUtils.getMetadataPath(filePath);
            if (!metadataPath) continue;

            if (fs.existsSync(metadataPath)) {
                const ledger = this.ledgerStore.loadFromDisk(filePath, metadataPath);
                if (ledger) {
                    console.log('[GitWatcher] Reloaded metadata for:', filePath);
                }
            } else {
                console.log('[GitWatcher] Metadata file not found:', metadataPath);
                this.ledgerStore.delete(filePath);
            }
        }

        await this.ledgerStore.scanWorkspace();
    }

    /**
     * Rebuild all tracked files from their metadata
     */
    private async rebuildAllFilesFromMetadata(): Promise<void> {
        const currentMode = this.context.workspaceState.get<string>('hiddenOverlay.debugMode') ?? 'debugOff';
        const includeDebug = currentMode === 'debugOn';

        for (const [filePath, ledger] of this.ledgerStore.entries()) {
            await this.onRebuildFile(filePath, ledger, includeDebug);
        }

        console.log('[GitWatcher] All files rebuilt from metadata');
    }

    public dispose(): void {
        if (this.gitOperationTimeout) {
            clearTimeout(this.gitOperationTimeout);
        }
        if (this.headWatcher) {
            this.headWatcher.close();
            this.headWatcher = null;
        }
        if (this.indexWatcher) {
            this.indexWatcher.close();
            this.indexWatcher = null;
        }
    }
}