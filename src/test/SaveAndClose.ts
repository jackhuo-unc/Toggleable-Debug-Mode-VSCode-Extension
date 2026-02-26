import * as vscode from 'vscode';

/**
 * Helper to save and close active editor without prompts
 */
export async function saveAndCloseActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.isDirty) {
        await editor.document.save();
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await new Promise(resolve => setTimeout(resolve, 100));
}

/**
 * Helper to save all and close all editors without prompts
 */
export async function saveAndCloseAllEditors(): Promise<void> {
    // Save all dirty files first
    await vscode.workspace.saveAll(false); // false = don't include untitled
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Now close all - no prompts since files are saved
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise(resolve => setTimeout(resolve, 100));
}