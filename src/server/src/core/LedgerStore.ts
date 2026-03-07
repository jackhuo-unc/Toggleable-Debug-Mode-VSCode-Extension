import * as fs from 'fs';
import * as path from 'path';
import { FileLedger, TextSegment } from '../types';
import { PathUtils } from './PathUtils';

/**
 * Ported from src/metadata/LedgerStore.ts
 * Scans server/metadata-storage/ instead of __debuggable__/ folders
 * in the project directory.
 */
export class LedgerStore {
    private ledgers: Map<string, FileLedger> = new Map();
    private saveQueue: Set<string> = new Set();
    private saveTimeout: NodeJS.Timeout | null = null;

    constructor(private pathUtils: PathUtils) {}

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

    public getTrackedFilePaths(): string[] {
        return Array.from(this.ledgers.keys());
    }

    public entries(): IterableIterator<[string, FileLedger]> {
        return this.ledgers.entries();
    }

    public size(): number {
        return this.ledgers.size;
    }

    /**
     * Create a new ledger from text content
     */
    public createFromText(absolutePath: string, text: string, isDebugMode: boolean): FileLedger {
        const relativePath = this.pathUtils.toRelativePath(absolutePath);
        if (!relativePath) {
            throw new Error(`Cannot create ledger: unable to compute relative path for ${absolutePath}`);
        }

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
            console.error('[LedgerStore] Failed to load ledger:', metaPath, err);
            return null;
        }
    }

    /**
     * Queue a ledger for async saving
     */
    public queueSave(filePath: string): void {
        this.saveQueue.add(filePath);

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.flushSaves();
        }, 500);
    }

    /**
     * Flush all pending saves to disk
     */
    public flushSaves(): void {
        const toSave = [...this.saveQueue];
        this.saveQueue.clear();

        for (const filePath of toSave) {
            this.saveToDisk(filePath);
        }
    }

    private saveToDisk(filePath: string): void {
        const ledger = this.ledgers.get(filePath);
        if (!ledger) return;

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
     * Scan the server's metadata-storage directory for existing ledgers.
     * 
     * CHANGED: Instead of walking the project tree looking for __debuggable__/ folders,
     * we walk server/metadata-storage/<workspace-hash>/ for .json files.
     */
    public scanWorkspace(): void {
        const storageRoot = this.pathUtils.getMetadataStorageRoot();
        if (!fs.existsSync(storageRoot)) return;

        this.walkMetadataStorage(storageRoot);

        console.log(`[LedgerStore] Scanned metadata storage, tracking ${this.ledgers.size} files`);
    }

    private walkMetadataStorage(dir: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                this.walkMetadataStorage(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
                // Skip the manifest file
                if (entry.name === '_manifest.json') continue;

                const sourceFilePath = this.pathUtils.getSourceFilePathFromMetadata(fullPath);
                if (!sourceFilePath) continue;
                if (this.ledgers.has(sourceFilePath)) continue;

                const ledger = this.loadFromDisk(sourceFilePath, fullPath);
                if (ledger) {
                    console.log('[LedgerStore] Loaded metadata for:', sourceFilePath);
                }
            }
        }
    }

    /**
     * Delete a ledger from memory and disk
     */
    public deleteFromDisk(filePath: string): void {
        const metaPath = this.pathUtils.getMetadataPath(filePath);
        if (metaPath && fs.existsSync(metaPath)) {
            try {
                fs.unlinkSync(metaPath);
                console.log('[LedgerStore] Deleted metadata:', metaPath);
            } catch (err) {
                console.error('[LedgerStore] Failed to delete metadata:', err);
            }
        }
        this.ledgers.delete(filePath);
    }

    public dispose(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.flushSaves();
    }
}