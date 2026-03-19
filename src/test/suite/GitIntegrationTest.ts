import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PerformanceTestFramework } from '../PerformanceTestFramework';
import { MetadataManager } from '../../local/MetadataManager';
import { HiddenCodeOverlay } from '../../local/HiddenCodeOverlay';
import { saveAndCloseActiveEditor, saveAndCloseAllEditors } from '../SaveAndClose';

export class GitIntegrationTest {
    private framework: PerformanceTestFramework;
    private metadataManager: MetadataManager;
    private overlayManager: HiddenCodeOverlay;

    constructor(
        framework: PerformanceTestFramework,
        metadataManager: MetadataManager,
        overlayManager: HiddenCodeOverlay
    ) {
        this.framework = framework;
        this.metadataManager = metadataManager;
        this.overlayManager = overlayManager;
    }

    /**
     * Check if git is available and the directory is a git repo
     */
    private isGitAvailable(dir: string): boolean {
        try {
            execSync('git --version', { stdio: 'ignore' });
            execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Initialize a test git repository
     */
    private initTestRepo(testDir: string): boolean {
        try {
            if (!fs.existsSync(path.join(testDir, '.git'))) {
                execSync('git init', { cwd: testDir, stdio: 'ignore' });
                execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'ignore' });
                execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'ignore' });
            }
            return true;
        } catch (err) {
            console.error('[GitIntegrationTest] Failed to init repo:', err);
            return false;
        }
    }

    /**
     * Run git status test (baseline vs with metadata files)
     */
    public async runGitStatusTest(testDir: string, iterations: number = 10): Promise<void> {
        if (!this.isGitAvailable(testDir)) {
            console.log('[GitIntegrationTest] Git not available, skipping git tests');
            return;
        }

        if (!this.initTestRepo(testDir)) {
            console.log('[GitIntegrationTest] Could not init test repo');
            return;
        }

        // Baseline: git status without metadata files
        for (let iter = 0; iter < iterations; iter++) {
            await this.framework.measure(
                'git_status_baseline',
                async () => {
                    execSync('git status --porcelain', { cwd: testDir, stdio: 'pipe' });
                },
                { iteration: iter }
            );
        }

        // Create some tracked files with metadata
        const testFile = path.join(testDir, 'git_test.ts');
        fs.writeFileSync(testFile, 'const x = 1;\n');
        
        const doc = await vscode.workspace.openTextDocument(testFile);
        await vscode.window.showTextDocument(doc);
        await this.metadataManager.ensureLedgerForDoc(doc);
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait for metadata save

        // With metadata files
        for (let iter = 0; iter < iterations; iter++) {
            await this.framework.measure(
                'git_status_with_metadata',
                async () => {
                    execSync('git status --porcelain', { cwd: testDir, stdio: 'pipe' });
                },
                { iteration: iter }
            );
        }

        await saveAndCloseActiveEditor();
    }

    /**
     * Run git add test
     */
    public async runGitAddTest(testDir: string, iterations: number = 10): Promise<void> {
        if (!this.isGitAvailable(testDir)) {
            console.log('[GitIntegrationTest] Git not available, skipping git tests');
            return;
        }

        const testFile = path.join(testDir, 'git_add_test.ts');

        for (let iter = 0; iter < iterations; iter++) {
            // Create fresh file
            fs.writeFileSync(testFile, `const iteration = ${iter};\n`);

            // Create corresponding metadata
            const doc = await vscode.workspace.openTextDocument(testFile);
            await vscode.window.showTextDocument(doc);
            await this.metadataManager.ensureLedgerForDoc(doc);
            await new Promise(resolve => setTimeout(resolve, 200));

            // Measure git add (should NOT include __debuggable__ if .gitignore is set up)
            await this.framework.measure(
                'git_add_tracked_file',
                async () => {
                    execSync(`git add "${testFile}"`, { cwd: testDir, stdio: 'pipe' });
                },
                { iteration: iter }
            );

            // Reset
            try {
                execSync(`git reset HEAD "${testFile}"`, { cwd: testDir, stdio: 'ignore' });
            } catch {
                // Ignore if file wasn't staged
            }

            await saveAndCloseActiveEditor();
        }
    }

    /**
     * Run git diff test
     */
    public async runGitDiffTest(testDir: string, iterations: number = 10): Promise<void> {
        if (!this.isGitAvailable(testDir)) {
            console.log('[GitIntegrationTest] Git not available, skipping git tests');
            return;
        }

        const testFile = path.join(testDir, 'git_diff_test.ts');
        
        // Create and commit initial file
        fs.writeFileSync(testFile, 'const original = 1;\n');
        try {
            execSync(`git add "${testFile}"`, { cwd: testDir, stdio: 'ignore' });
            execSync('git commit -m "initial"', { cwd: testDir, stdio: 'ignore' });
        } catch {
            // May already be committed
        }

        // Open and track
        const doc = await vscode.workspace.openTextDocument(testFile);
        const editor = await vscode.window.showTextDocument(doc);
        await this.metadataManager.ensureLedgerForDoc(doc);

        for (let iter = 0; iter < iterations; iter++) {
            // Make a change
            await editor.edit(editBuilder => {
                editBuilder.insert(new vscode.Position(1, 0), `const change${iter} = ${iter};\n`);
            });
            await new Promise(resolve => setTimeout(resolve, 100));

            // Measure git diff
            await this.framework.measure(
                'git_diff_with_changes',
                async () => {
                    execSync('git diff --stat', { cwd: testDir, stdio: 'pipe' });
                },
                { iteration: iter }
            );

            // Undo the change
            await vscode.commands.executeCommand('undo');
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        await saveAndCloseActiveEditor();
    }

    /**
     * Test that .gitignore properly includes __debuggable__
     */
    public async runGitIgnoreTest(testDir: string): Promise<{ passed: boolean; message: string }> {
        if (!this.isGitAvailable(testDir)) {
            return { passed: false, message: 'Git not available' };
        }

        // Ensure .gitignore exists with __debuggable__
        const gitignorePath = path.join(testDir, '.gitignore');
        let gitignoreContent = '';
        if (fs.existsSync(gitignorePath)) {
            gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        }
        
        if (!gitignoreContent.includes('__debuggable__')) {
            gitignoreContent += '\n__debuggable__/\n';
            fs.writeFileSync(gitignorePath, gitignoreContent);
        }

        // Create a test file and metadata
        const testFile = path.join(testDir, 'gitignore_test.ts');
        fs.writeFileSync(testFile, 'const test = 1;\n');
        
        const doc = await vscode.workspace.openTextDocument(testFile);
        await vscode.window.showTextDocument(doc);
        await this.metadataManager.ensureLedgerForDoc(doc);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check git status
        const status = execSync('git status --porcelain', { cwd: testDir, encoding: 'utf-8' });
        
        await saveAndCloseActiveEditor();

        // Verify __debuggable__ is in the status
        if (status.includes('__debuggable__')) {
            return { 
                passed: true, 
                message: '__debuggable__ folder is being tracked by git as expected' 
            };
        }

        return { 
            passed: false, 
            message: '__debuggable__ folder is not being tracked by git! Check .gitignore' 
        };
    }

    /**
     * Run comprehensive git integration tests
     */
    public async runAllGitTests(testDir: string): Promise<void> {
        console.log('[GitIntegrationTest] Starting git integration tests...');

        // Check .gitignore setup
        console.log('[GitIntegrationTest] Testing .gitignore...');
        const gitignoreResult = await this.runGitIgnoreTest(testDir);
        console.log(`[GitIntegrationTest] .gitignore test: ${gitignoreResult.passed ? '✅' : '❌'} ${gitignoreResult.message}`);
        
        await this.framework.measure(
            'git_ignore_test',
            async () => {
                // Just record the result
            },
            { passed: gitignoreResult.passed, message: gitignoreResult.message }
        );

        // Git status tests
        console.log('[GitIntegrationTest] Testing git status...');
        await this.runGitStatusTest(testDir, 10);

        // Git add tests
        console.log('[GitIntegrationTest] Testing git add...');
        await this.runGitAddTest(testDir, 10);

        // Git diff tests
        console.log('[GitIntegrationTest] Testing git diff...');
        await this.runGitDiffTest(testDir, 10);

        console.log('[GitIntegrationTest] Git integration tests complete');
    }
}