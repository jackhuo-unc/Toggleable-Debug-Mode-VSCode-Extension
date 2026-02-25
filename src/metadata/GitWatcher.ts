import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FileLedger, DebugModeChangeCallback } from './Types';
import { PathUtils } from './PathUtils';
import { LedgerStore } from './LedgerStore';
import { SegmentManager } from './SegmentManager';

export class GitWatcher {
    private isGitOperation: boolean = false;
    private gitOperationTimeout: NodeJS.Timeout | null = null;

    //Files to skip processing (during git operations)
    private skipProcessing: Set<string> = new Set();

    // Callback to notify when debug mode should change
    private onDebugModeChange: DebugModeChangeCallback | null = null;

    // Track the last git HEAD to detect ACTUAL git operations
    private lastGitHead: string | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly pathUtils: PathUtils,
        private readonly ledgerStore: LedgerStore,
        private readonly segmentManager: SegmentManager,
        private readonly onRebuildFile: (filePath: string, ledger: FileLedger, includeDebug: boolean) => Promise<void>
    ) {}

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
        if (!rootDir) return;

        const gitDir = path.join(rootDir, '.git');
        if (!fs.existsSync(gitDir)) return;

        // Read initial HEAD
        this.lastGitHead = this.readGitHead(gitDir);
        console.log('[GitWatcher] Initial HEAD:', this.lastGitHead?.substring(0, 8));

        // Use file system watcher for git files
        const gitWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'HEAD')
        );

        this.context.subscriptions.push(
            gitWatcher.onDidChange(() => this.onGitOperationDetected()),
            // gitWatcher.onDidCreate(() => this.onGitOperationDetected()),
            gitWatcher
        );

         console.log('[GitWatcher] Initialized - watching HEAD only');
    }

    private readGitHead(gitDir: string): string | null {
        try {
            const headPath = path.join(gitDir, 'HEAD');
            const headContent = fs.readFileSync(headPath, 'utf-8').trim();
            
            // HEAD can be a ref (ref: refs/heads/main) or a commit hash
            if (headContent.startsWith('ref: ')) {
                const refPath = path.join(gitDir, headContent.slice(5));
                if (fs.existsSync(refPath)) {
                    return fs.readFileSync(refPath, 'utf-8').trim();
                }
            }
            return headContent;
        } catch {
            return null;
        }
    }

    private onGitFileChanged(gitDir: string): void {
        const newHead = this.readGitHead(gitDir);
        
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
        }, 500);
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
    }
}