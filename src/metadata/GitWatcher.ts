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

    private bulkChangeCount = 0;
    private bulkChangeTimer: NodeJS.Timeout | null = null;

    //Files to skip processing (during git operations)
    private skipProcessing: Set<string> = new Set();

    // Callback to notify when debug mode should change
    private onDebugModeChange: DebugModeChangeCallback | null = null;

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
     * Watch for git operations by monitoring .git/HEAD and .git/index
     */
    public init(): void {
        const rootDir = this.pathUtils.getRootDir();
        if (!rootDir) return;

        const gitDir = path.join(rootDir, '.git');
        if (!fs.existsSync(gitDir)) return;

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
        console.log('[GitWatcher] Git watcher initialized');
    }

    /**
     * Detect bulk file changes that indicate a git operation
     */
    private detectBulkChanges(filePath: string): void {
        if (!this.pathUtils.shouldTrackFile(filePath)) return;

        this.bulkChangeCount++;

        if (this.bulkChangeTimer) {
            clearTimeout(this.bulkChangeTimer);
        }

        this.bulkChangeTimer = setTimeout(() => {
            if (this.bulkChangeCount > 3) {
                console.log(`[GitWatcher] Bulk changes detected (${this.bulkChangeCount} files), likely git operation`);
                this.onGitOperationDetected();
            }
            this.bulkChangeCount = 0;
        }, 100);
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
        console.log('[MetadataManager] Git operation detected');
        
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
        } else {
            // Mode matches, just rebuild files to ensure consistency
            await this.rebuildAllFilesFromMetadata();
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
        } else if (debugOffCount > debugOnCount) {
            return 'debugOff';
        } else {
            // Tie - prefer debugOff as it's the safer default
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
        if (this.bulkChangeTimer) {
            clearTimeout(this.bulkChangeTimer);
        }
    }
}