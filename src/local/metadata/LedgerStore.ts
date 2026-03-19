import * as vscode from 'vscode';
import * as fs from 'fs';
import { FileLedger, TextSegment } from './Types';
import { PathUtils } from './PathUtils';
import { SegmentManager } from './SegmentManager';

export class LedgerStore {
    private ledgers: Map<string, FileLedger> = new Map();
    private saveQueue: Set<string> = new Set();
    private saveTimeout: NodeJS.Timeout | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private pathUtils: PathUtils,
        private segmentManager: SegmentManager
    ) {}

    public has(filePath: string): boolean {
        return this.ledgers.has(filePath);
    }

    public get(filePath: string): FileLedger | undefined {
        return this.ledgers.get(filePath);
    }

    public set(filePath: string, ledger: FileLedger): void {
        this.ledgers.set(filePath, ledger);
    }

    public delete(filePath: string): void {
        this.ledgers.delete(filePath);
    }

    public keys(): IterableIterator<string> {
        return this.ledgers.keys();
    }

    public entries(): IterableIterator<[string, FileLedger]> {
        return this.ledgers.entries();
    }

    public values(): IterableIterator<FileLedger> {
        return this.ledgers.values();
    }

    public size(): number {
        return this.ledgers.size;
    }

    // Reference to check git blocked state
    private isBlockedFn: (() => boolean) | null = null;

    /**
     * Set a function that returns whether saves are blocked
     */
    public setBlockedCheck(fn: () => boolean): void {
        this.isBlockedFn = fn;
    }

    /**
     * Get all file paths that have ledgers loaded
     */
    public getTrackedFilePaths(): string[] {
        return Array.from(this.ledgers.keys());
    }

    /**
     * Create a new ledger from text
     */
    public createFromText(absolutePath: string, text: string): FileLedger {
        const relativePath = this.pathUtils.toRelativePath(absolutePath);
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

    /**
     * Load a ledger from disk
     */
    public loadFromDisk(absolutePath: string, metaPath: string): FileLedger | null {
        try {
            const raw = fs.readFileSync(metaPath, 'utf-8');
            const data = JSON.parse(raw) as FileLedger;

            if (data.version === undefined) {
                data.version = 1;
                data.savedInDebugMode = false;
            }

            this.ledgers.set(absolutePath, data);
            return data;
        } catch (err) {
            console.error('[LedgerStore] Failed to load ledger:', err);
            return null;
        }
    }

    /**
     * Queue a ledger for saving
     */
    public queueSave(filePath: string): void {
        if (this.isBlockedFn && this.isBlockedFn()) {
            console.log('[LedgerStore] BLOCKED - not queuing save during git operation:', filePath);
            return;
        }
        this.saveQueue.add(filePath);

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.flushSaves();
        }, 500);
    }

    /**
     * Flush all pending saves
     */
    public async flushSaves(): Promise<void> {
        const toSave = [...this.saveQueue];
        this.saveQueue.clear();

        for (const filePath of toSave) {
            await this.saveToDisk(filePath);
        }
    }

    /**
     * Save a ledger to disk
     */
    private async saveToDisk(filePath: string): Promise<void> {
        const ledger = this.ledgers.get(filePath);
        if (!ledger) return;
        // BLOCK during git operations
        if (this.isBlockedFn && this.isBlockedFn()) {
            console.log('[LedgerStore] BLOCKED - not saving during git operation:', filePath);
            return;
        }

        const metaDir = this.pathUtils.getMetadataDir(filePath);
        const metaPath = this.pathUtils.getMetadataPath(filePath);

        if (!metaDir || !metaPath) {
            console.error('[LedgerStore] Invalid paths for saving:', filePath);
            return;
        }

        try {
            if (!fs.existsSync(metaDir)) {
                fs.mkdirSync(metaDir, { recursive: true });
            }

            const json = JSON.stringify(ledger, null, 2);
            fs.writeFileSync(metaPath, json, 'utf-8');

            console.log('[LedgerStore] Saved ledger:', metaPath);
        } catch (err) {
            console.error('[LedgerStore] Failed to save ledger:', err);
        }
    }

    /**
     * Scan workspace for existing metadata files
     */
    public async scanWorkspace(): Promise<void> {
        const rootDir = this.pathUtils.getRootDir();
        if (!rootDir) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for (const folder of workspaceFolders) {
            const pattern = new vscode.RelativePattern(folder, '**/__debuggable__/*.json');
            const metadataFiles = await vscode.workspace.findFiles(pattern);

            for (const metaUri of metadataFiles) {
                const metaPath = metaUri.fsPath;
                const sourceFilePath = this.pathUtils.getSourceFilePathFromMetadata(metaPath);
                
                if (!sourceFilePath) continue;
                if (this.ledgers.has(sourceFilePath)) continue;

                const ledger = this.loadFromDisk(sourceFilePath, metaPath);
                if (ledger) {
                    console.log('[LedgerStore] Loaded metadata for:', sourceFilePath);
                }
            }
        }

        console.log(`[LedgerStore] Scanned workspace, tracking ${this.ledgers.size} files`);
    }

    public dispose(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.flushSaves();
    }



}
