import * as path from 'path';
import * as fs from 'fs';

/**
 * Path utilities — ported from src/metadata/PathUtils.ts
 * All metadata is stored under server/metadata-storage/
 * instead of __debuggable__/ folders inside the project.
 * This keeps the client project clean and centralizes state on the server.
 */
export class PathUtils {
    private rootDir: string;
    private metadataStorageRoot: string;

    constructor(workspaceRoot: string) {
        // The actual project directory
        this.rootDir = this.findRootDir(workspaceRoot);

        // Metadata lives under server/metadata-storage/<hashed-workspace>/
        // This way multiple projects don't collide
        const serverDir = path.resolve(__dirname, '..', '..');
        const workspaceHash = this.hashWorkspacePath(this.rootDir);
        this.metadataStorageRoot = path.join(serverDir, 'metadata-storage', workspaceHash);

        // Ensure the directory exists
        if (!fs.existsSync(this.metadataStorageRoot)) {
            fs.mkdirSync(this.metadataStorageRoot, { recursive: true });
        }

        // Write a manifest so we can identify which project this metadata belongs to
        const manifestPath = path.join(this.metadataStorageRoot, '_manifest.json');
        if (!fs.existsSync(manifestPath)) {
            fs.writeFileSync(manifestPath, JSON.stringify({
                workspaceRoot: this.rootDir,
                createdAt: new Date().toISOString(),
            }, null, 2), 'utf-8');
        }

        console.log('[PathUtils] rootDir =', this.rootDir);
        console.log('[PathUtils] metadataStorageRoot =', this.metadataStorageRoot);
    }

    public getRootDir(): string {
        return this.rootDir;
    }

    public getMetadataStorageRoot(): string {
        return this.metadataStorageRoot;
    }

    private findRootDir(workspaceRoot: string): string {
        let currentDir = workspaceRoot;
        while (currentDir !== path.dirname(currentDir)) {
            const gitDir = path.join(currentDir, '.git');
            if (fs.existsSync(gitDir)) {
                console.log('[PathUtils] Found git root:', currentDir);
                return currentDir;
            }
            currentDir = path.dirname(currentDir);
        }

        console.log('[PathUtils] No git root found, using workspace root:', workspaceRoot);
        return workspaceRoot;
    }

    /**
     * Simple hash of workspace path to create a unique folder name.
     * e.g. "/Users/jack/myproject" -> "myproject_a1b2c3d4"
     */
    private hashWorkspacePath(workspacePath: string): string {
        const basename = path.basename(workspacePath);
        let hash = 0;
        for (let i = 0; i < workspacePath.length; i++) {
            const char = workspacePath.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit int
        }
        const hexHash = Math.abs(hash).toString(16).padStart(8, '0');
        return `${basename}_${hexHash}`;
    }

    public toRelativePath(absolutePath: string): string | null {
        const rel = path.relative(this.rootDir, absolutePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
        return rel;
    }

    public toAbsolutePath(relativePath: string): string | null {
        return path.join(this.rootDir, relativePath);
    }

    /**
     * Metadata directory for a given source file.
     * 
     * CHANGED: Instead of __debuggable__/ next to the source file,
     * metadata is stored under server/metadata-storage/<workspace-hash>/<relative-dir>/
     * 
     * e.g. Source:   /Users/jack/myproject/src/app.ts
     *      Metadata: server/metadata-storage/myproject_a1b2c3d4/src/app.ts.json
     */
    public getMetadataDir(absolutePath: string): string | null {
        const relativePath = this.toRelativePath(absolutePath);
        if (!relativePath) return null;

        const relativeDir = path.dirname(relativePath);
        return path.join(this.metadataStorageRoot, relativeDir);
    }

    public getMetadataPath(absolutePath: string): string | null {
        const relativePath = this.toRelativePath(absolutePath);
        if (!relativePath) return null;

        return path.join(this.metadataStorageRoot, `${relativePath}.json`);
    }

    public getSourceFilePathFromMetadata(metadataPath: string): string | null {
        // metadataPath: server/metadata-storage/<hash>/src/app.ts.json
        // We need to recover: /Users/jack/myproject/src/app.ts

        const relToStorage = path.relative(this.metadataStorageRoot, metadataPath);
        if (relToStorage.startsWith('..') || path.isAbsolute(relToStorage)) return null;

        // Remove the .json extension to get the original relative path
        if (!relToStorage.endsWith('.json')) return null;
        const relativePath = relToStorage.slice(0, -'.json'.length);

        // Skip manifest
        if (relativePath === '_manifest') return null;

        return path.join(this.rootDir, relativePath);
    }

    public shouldTrackFile(filePath: string): boolean {
        if (!filePath || filePath.length === 0) return false;
        if (!path.isAbsolute(filePath)) return false;
        if (filePath.includes('baseline_')) return false;
        if (filePath.includes('__debuggable__')) return false;
        if (filePath.includes('metadata-storage')) return false;  // Don't track our own metadata
        if (filePath.includes('VSCODE-config')) return false;
        if (filePath.includes('.vscode')) return false;
        if (filePath.includes('.idea')) return false;
        if (filePath.includes('.eclipse')) return false;
        if (filePath.includes('node_modules')) return false;
        if (filePath.endsWith('.git')) return false;
        if (filePath.includes(path.sep + 'log' + path.sep)) return false;

        if (!filePath.startsWith(this.rootDir)) return false;

        return true;
    }
}