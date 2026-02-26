import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class PathUtils {
    private rootDir: string | null = null;

    public async init(): Promise<void> {
        this.rootDir = await this.findRootDir();
        console.log('[PathUtils] rootDir =', this.rootDir);
    }

    public getRootDir(): string | null {
        return this.rootDir;
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

    // ─────────────────────────────────────────────────────────────────────────────
    // Path Helpers
    // ─────────────────────────────────────────────────────────────────────────────


    /**
     * Convert absolute path to relative path from root
     */
    public toRelativePath(absolutePath: string): string | null {
        if (!this.rootDir) return null;
        return path.relative(this.rootDir, absolutePath);
    }

    /**
     * Convert relative path to absolute path
     */
    public toAbsolutePath(relativePath: string): string | null {
        if (!this.rootDir) return null;
        return path.join(this.rootDir, relativePath);
    }

    // Get the __debuggable__ folder path for a given file (using relative structure)
    public getMetadataDir(absolutePath: string): string | null {
        const relativePath = this.toRelativePath(absolutePath);
        if (!relativePath || !this.rootDir) return null;

        const relativeDir = path.dirname(relativePath);
        return path.join(this.rootDir, relativeDir, '__debuggable__');
    }

    // Get the metadata JSON file path for a given source file
    public getMetadataPath(absolutePath: string): string | null {
        const metaDir = this.getMetadataDir(absolutePath);
        if (!metaDir) return null;

        const baseName = path.basename(absolutePath);
        return path.join(metaDir, `${baseName}.json`);
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
    public shouldTrackFile(filePath: string): boolean {
        if (!filePath || filePath.length === 0) return false;
        if (!path.isAbsolute(filePath)) return false;
        if (filePath.includes('baseline_')) return false; // Exclude baseline testing files
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

    

}