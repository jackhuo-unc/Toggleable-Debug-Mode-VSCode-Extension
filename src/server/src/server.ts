import {Request, Response } from 'express';
import express from 'express';
import { SessionManager } from './core/SessionManager';
import {
    InitSessionRequest,
    InitSessionResponse,
    SessionCloseRequest,
    DocumentOpenRequest,
    DocumentOpenResponse,
    DocumentChangeRequest,
    DocumentChangeResponse,
    DocumentCloseRequest,
    ToggleModeRequest,
    ToggleModeResponse,
    ToggleInsertModeRequest,
    ToggleInsertModeResponse,
    GetSegmentsResponse,
    UndoRequest,
    RedoRequest,
    UndoRedoResponse,
} from './types';

const app = express();
app.use(express.json({ limit: '50mb' }));

const sessionManager = new SessionManager();

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: validate sessionId for routes that need it
// ─────────────────────────────────────────────────────────────────────────────

function requireSession(req: express.Request, res: express.Response): ReturnType<typeof sessionManager.getSession> {
    const sessionId = req.body?.sessionId ?? req.query?.sessionId;
    if (!sessionId) {
        res.status(400).json({ error: 'Missing sessionId' });
        return undefined;
    }
    const session = sessionManager.getSession(sessionId as string);
    if (!session) {
        res.status(404).json({ error: `Session not found: ${sessionId}` });
        return undefined;
    }
    return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.post('/session/init', (req: Request, res: Response) => {
    const body = req.body as InitSessionRequest;

    if (!body.clientId || !body.workspaceRoot) {
        res.status(400).json({ error: 'Missing clientId or workspaceRoot' });
        return;
    }

    const session = sessionManager.createSession(body.clientId, body.workspaceRoot);
    const trackedFiles = sessionManager.getTrackedFiles(session);

    const response: InitSessionResponse = {
        sessionId: session.sessionId,
        trackedFiles,
        debugMode: session.debugMode,
        insertMode: session.insertMode,
    };

    console.log(`[Server] POST /session/init -> session ${session.sessionId}`);
    res.json(response);
});

app.post('/session/close', (req: Request, res: Response) => {
    const body = req.body as SessionCloseRequest;
    sessionManager.closeSession(body.sessionId);
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Document endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.post('/document/open', (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;

    const body = req.body as DocumentOpenRequest;

    if (!body.filePath) {
        res.status(400).json({ error: 'Missing filePath' });
        return;
    }

    const result = sessionManager.openDocument(session, body.filePath, body.content ?? '');

    const response: DocumentOpenResponse = {
        debugSegments: result.debugSegments,
        displayContent: result.displayContent,
        debugMode: session.debugMode,
        insertMode: session.insertMode,
    };

    console.log(`[Server] POST /document/open -> ${body.filePath}, ${result.debugSegments.length} debug segments`);
    res.json(response);
});

app.post('/document/change', (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;

    const body = req.body as DocumentChangeRequest;

    if (!body.filePath || !body.changes) {
        res.status(400).json({ error: 'Missing filePath or changes' });
        return;
    }

    try {
        const result = sessionManager.applyChanges(session, body.filePath, body.changes);

        const response: DocumentChangeResponse = {
            debugSegments: result.debugSegments,
            displayContent: result.displayContent,
        };

        res.json(response);
    } catch (err: any) {
        console.error('[Server] Error applying changes:', err.message);
        res.status(400).json({ error: err.message });
    }
});

app.post('/document/close', (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;

    const body = req.body as DocumentCloseRequest;
    sessionManager.closeDocument(session, body.filePath);
    res.json({ success: true });
});

app.get('/document/segments', (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;

    const filePath = req.query.filePath as string;
    if (!filePath) {
        res.status(400).json({ error: 'Missing filePath query parameter' });
        return;
    }

    const state = sessionManager.getDocumentState(session, filePath);
    if (!state) {
        res.status(404).json({ error: 'No ledger for file' });
        return;
    }

    const response: GetSegmentsResponse = state;
    res.json(response);
});

// ─────────────────────────────────────────────────────────────────────────────
// Mode endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.post('/mode/toggle', (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;

    const result = sessionManager.toggleDebugMode(session);

    const response: ToggleModeResponse = {
        debugMode: result.debugMode,
        insertMode: result.insertMode,
        fileUpdates: result.fileUpdates,
    };

    console.log(`[Server] POST /mode/toggle -> debugMode=${result.debugMode}, ${Object.keys(result.fileUpdates).length} files updated`);
    res.json(response);
});

app.post('/mode/insert-toggle', (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;

    const result = sessionManager.toggleInsertMode(session);

    const response: ToggleInsertModeResponse = {
        insertMode: result.insertMode,
        debugMode: result.debugMode,
    };

    console.log(`[Server] POST /mode/insert-toggle -> insertMode=${result.insertMode}`);
    res.json(response);
});

// ─────────────────────────────────────────────────────────────────────────────
// Undo / Redo endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.post('/undo', (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;

    const body = req.body as UndoRequest;
    const result = sessionManager.undo(session, body.filePath, body.cursorOffset ?? 0);

    console.log(`[Server] POST /undo -> success=${result.success}`);
    res.json(result);
});

app.post('/redo', (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;

    const body = req.body as RedoRequest;
    const result = sessionManager.redo(session, body.filePath, body.cursorOffset ?? 0);

    console.log(`[Server] POST /redo -> success=${result.success}`);
    res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// Health / Status
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        sessions: Array.from((sessionManager as any).sessions?.keys?.() ?? []).length,
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.DEBUG_TOGGLE_PORT ?? '7654', 10);

app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Debug Toggle Server running on http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('  Endpoints:');
    console.log('  ─────────────────────────────────────────────────────────');
    console.log('  POST /session/init          Initialize a session');
    console.log('  POST /session/close         Close a session');
    console.log('  POST /document/open         Open/register a document');
    console.log('  POST /document/change       Apply text changes');
    console.log('  POST /document/close        Close a document');
    console.log('  GET  /document/segments     Query document state');
    console.log('  POST /mode/toggle           Toggle debug mode');
    console.log('  POST /mode/insert-toggle    Toggle insert mode');
    console.log('  POST /undo                  Undo');
    console.log('  POST /redo                  Redo');
    console.log('  GET  /health                Health check');
    console.log('');
});

export default app;