export interface TextSegment {
    text: string;
    isDebug: boolean;
}

export interface FileLedger {
    relativePath: string;
    segments: TextSegment[];
    savedInDebugMode: boolean;
    version: number;
}

export interface DebugSegment {
    start: number; // inclusive offset in current document text
    end: number;   // exclusive offset in current document text
}

// Callback type for notifying mode changes
export type DebugModeChangeCallback = (newMode: 'debugOn' | 'debugOff') => Promise<void>;