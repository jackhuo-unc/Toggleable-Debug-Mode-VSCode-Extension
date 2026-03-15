import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LedgerStore } from './LedgerStore';
import { SegmentManager } from './SegmentManager';
import { FileLedger, DebugMode, FileUpdate } from '../types';

/**
 * Manages a git repository inside the server's metadata-storage/<hash>/ directory.
 * Mirrors branch switches from the client so that ledger files are versioned
 * per-branch, just like source code is on the client side.
 */
export class GitManager {
    private metadataRepoPath: string;
    private initialized: boolean = false;

    constructor(
        private ledgerStore: LedgerStore,
        private segmentManager: SegmentManager,
        metadataStorageRoot: string
    ) {
        this.metadataRepoPath = metadataStorageRoot;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialization
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Ensure a git repo exists in the metadata storage directory.
     * Called on session init or explicitly via POST /git/init.
     */
    public ensureRepo(): { initialized: boolean; currentBranch: string } {
        const gitDir = path.join(this.metadataRepoPath, '.git');

        if (!fs.existsSync(this.metadataRepoPath)) {
            fs.mkdirSync(this.metadataRepoPath, { recursive: true });
        }

        if (!fs.existsSync(gitDir)) {
            this.exec('git init');
            this.exec('git config user.email "debug-toggle-server@local"');
            this.exec('git config user.name "Debug Toggle Server"');

            // Create an initial commit so branches work
            const readmePath = path.join(this.metadataRepoPath, '.gitkeep');
            fs.writeFileSync(readmePath, '');
            this.exec('git add .');
            this.exec('git commit -m "Initialize metadata repository"');

            console.log('[GitManager] Initialized new metadata repo:', this.metadataRepoPath);
        }

        this.initialized = true;
        return {
            initialized: true,
            currentBranch: this.getCurrentBranch(),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Branch Sync
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Mirror a client branch switch into the metadata repo.
     *
     * 1. Auto-commit any dirty ledger files on the current branch
     * 2. Switch to (or create) the target branch
     * 3. Reload ledgers from disk
     * 4. Return the updated file states
     */
    public syncBranch(
        targetBranch: string,
        clientHeadCommit: string,
        debugMode: DebugMode
    ): {
        synced: boolean;
        serverBranch: string;
        fileUpdates: Record<string, FileUpdate>;
        detectedDebugMode: DebugMode;
    } {
        if (!this.initialized) {
            this.ensureRepo();
        }

        const currentBranch = this.getCurrentBranch();
        console.log(`[GitManager] Syncing: ${currentBranch} -> ${targetBranch}`);

        // Step 1: auto-commit any uncommitted ledger changes on current branch
        this.autoCommitLedgers(`Auto-save ledgers before switching to ${targetBranch}`);

        // Step 2: switch to target branch (create if it doesn't exist)
        if (targetBranch !== currentBranch) {
            if (this.branchExists(targetBranch)) {
                this.exec(`git checkout "${targetBranch}"`);
            } else {
                this.exec(`git checkout -b "${targetBranch}"`);
                console.log(`[GitManager] Created new metadata branch: ${targetBranch}`);
            }
        }

        // Step 3: reload ledgers from disk (files may have changed with the branch)
        this.ledgerStore.scanWorkspace();

        // Step 4: detect what debug mode these ledgers were saved in
        const detectedMode = this.detectSavedDebugMode();

        // Step 5: build file updates for the client
        const fileUpdates: Record<string, FileUpdate> = {};
        const includeDebug = detectedMode === 'debugOn';

        for (const filePath of this.ledgerStore.getTrackedFilePaths()) {
            const ledger = this.ledgerStore.get(filePath);
            if (!ledger) continue;

            fileUpdates[filePath] = {
                segments: this.segmentManager.deepCopySegments(ledger.segments),
                // debugSegments: this.segmentManager.getDebugSegments(ledger.segments, includeDebug),
            };
        }

        return {
            synced: true,
            serverBranch: this.getCurrentBranch(),
            fileUpdates,
            detectedDebugMode: detectedMode,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Commit Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Auto-commit all ledger .json files in the metadata repo.
     * This is called before branch switches so no work is lost.
     */
    public autoCommitLedgers(message: string): boolean {
        try {
            // Stage all json files (ledgers)
            this.exec('git add *.json **/*.json');

            // Check if there's anything to commit
            const status = this.exec('git status --porcelain').trim();
            if (!status) {
                console.log('[GitManager] Nothing to commit');
                return false;
            }

            this.exec(`git commit -m "${message}"`);
            console.log('[GitManager] Auto-committed ledgers:', message);
            return true;
        } catch (err) {
            console.error('[GitManager] Auto-commit failed:', err);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Query Helpers
    // ─────────────────────────────────────────────────────────────────────────

    public getCurrentBranch(): string {
        try {
            return this.exec('git rev-parse --abbrev-ref HEAD').trim();
        } catch {
            return 'main';
        }
    }

    public getHeadCommit(): string {
        try {
            return this.exec('git rev-parse HEAD').trim();
        } catch {
            return '';
        }
    }

    public branchExists(branch: string): boolean {
        try {
            this.exec(`git rev-parse --verify "${branch}"`);
            return true;
        } catch {
            return false;
        }
    }

    public isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Detect what debug mode the majority of ledgers were saved in.
     * Same logic as GitWatcher.detectSavedDebugMode() in the VSCode extension.
     */
    private detectSavedDebugMode(): DebugMode {
        let debugOnCount = 0;
        let debugOffCount = 0;

        for (const filePath of this.ledgerStore.getTrackedFilePaths()) {
            const ledger = this.ledgerStore.get(filePath);
            if (!ledger) continue;
            if (ledger.savedInDebugMode) {
                debugOnCount++;
            } else {
                debugOffCount++;
            }
        }

        return debugOnCount >= debugOffCount ? 'debugOn' : 'debugOff';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    private exec(cmd: string): string {
        return execSync(cmd, {
            cwd: this.metadataRepoPath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
}