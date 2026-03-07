import { TextSegment, FileLedger, DebugSegment } from '../types';

/**
 * Pure segment logic — ported directly from src/metadata/SegmentManager.ts
 * with all vscode references removed.
 */
export class SegmentManager {

    // ─────────────────────────────────────────────────────────────────────────
    // Text Building
    // ─────────────────────────────────────────────────────────────────────────

    public buildFullText(segments: TextSegment[]): string {
        return segments.map(s => s.text).join('');
    }

    public buildTextForMode(segments: TextSegment[], includeDebug: boolean): string {
        if (includeDebug) {
            return segments.map(s => s.text).join('');
        }
        return segments.filter(s => !s.isDebug).map(s => s.text).join('');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Normalization
    // ─────────────────────────────────────────────────────────────────────────

    public normalizeSegments(segments: TextSegment[]): TextSegment[] {
        const result: TextSegment[] = [];

        for (const seg of segments) {
            if (seg.text.length === 0) continue;

            const last = result[result.length - 1];
            if (last && last.isDebug === seg.isDebug) {
                last.text += seg.text;
            } else {
                result.push({ text: seg.text, isDebug: seg.isDebug });
            }
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Offset Mapping
    // Ported from your SegmentManager.findSegmentAtOffset
    // ─────────────────────────────────────────────────────────────────────────

    public findSegmentAtOffset(
        segments: TextSegment[],
        visibleOffset: number,
        isDebugMode: boolean
    ): { segmentIndex: number; offsetInSegment: number; globalLedgerOffset: number } {
        let visibleCount = 0;
        let globalOffset = 0;

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];

            // In debugOff mode, skip debug segments for counting
            if (!isDebugMode && seg.isDebug) {
                globalOffset += seg.text.length;
                continue;
            }

            if (visibleCount + seg.text.length >= visibleOffset) {
                const offsetInSegment = visibleOffset - visibleCount;
                return {
                    segmentIndex: i,
                    offsetInSegment,
                    globalLedgerOffset: globalOffset + offsetInSegment
                };
            }

            visibleCount += seg.text.length;
            globalOffset += seg.text.length;
        }

        // Past the end
        return {
            segmentIndex: segments.length,
            offsetInSegment: 0,
            globalLedgerOffset: globalOffset
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Change Application
    // Ported from your SegmentManager.applyChange + spliceSegments
    // ─────────────────────────────────────────────────────────────────────────

    public applyChange(
        ledger: FileLedger,
        rangeOffset: number,
        rangeLength: number,
        text: string,
        isDebugMode: boolean,
        isDebugInsert: boolean
    ): void {
        const startPos = this.findSegmentAtOffset(ledger.segments, rangeOffset, isDebugMode);
        const endPos = rangeLength > 0
            ? this.findSegmentAtOffset(ledger.segments, rangeOffset + rangeLength, isDebugMode)
            : startPos;

        this.spliceSegments(ledger.segments, startPos, endPos, text, isDebugInsert, isDebugMode);
    }

    private spliceSegments(
        segments: TextSegment[],
        startPos: { segmentIndex: number; offsetInSegment: number },
        endPos: { segmentIndex: number; offsetInSegment: number },
        insertText: string,
        isDebugInsert: boolean,
        isDebugMode: boolean
    ): void {
        // Handle edge case: empty segments
        if (segments.length === 0) {
            if (insertText.length > 0) {
                segments.push({ text: insertText, isDebug: isDebugInsert });
            }
            return;
        }

        // Clamp indices
        const startIdx = Math.min(startPos.segmentIndex, segments.length - 1);
        const endIdx = Math.min(endPos.segmentIndex, segments.length - 1);

        if (startIdx === endIdx && startIdx < segments.length) {
            // Change is within a single segment
            const seg = segments[startIdx];

            // In debugOff mode, skip debug segments
            if (!isDebugMode && seg.isDebug) {
                if (insertText.length > 0) {
                    segments.splice(startIdx + 1, 0, { text: insertText, isDebug: isDebugInsert });
                }
                return;
            }

            const before = seg.text.slice(0, startPos.offsetInSegment);
            const after = seg.text.slice(endPos.offsetInSegment);

            if (seg.isDebug === isDebugInsert) {
                // Same type — modify in place
                seg.text = before + insertText + after;
            } else {
                // Different type — split into up to 3 segments
                const newSegments: TextSegment[] = [];
                if (before.length > 0) {
                    newSegments.push({ text: before, isDebug: seg.isDebug });
                }
                if (insertText.length > 0) {
                    newSegments.push({ text: insertText, isDebug: isDebugInsert });
                }
                if (after.length > 0) {
                    newSegments.push({ text: after, isDebug: seg.isDebug });
                }
                segments.splice(startIdx, 1, ...newSegments);
            }
        } else {
            // Change spans multiple segments
            const newSegments: TextSegment[] = [];

            // Keep the part before the change in the start segment
            if (startIdx < segments.length) {
                const startSeg = segments[startIdx];
                const before = startSeg.text.slice(0, startPos.offsetInSegment);
                if (before.length > 0) {
                    newSegments.push({ text: before, isDebug: startSeg.isDebug });
                }
            }

            // Add the inserted text
            if (insertText.length > 0) {
                newSegments.push({ text: insertText, isDebug: isDebugInsert });
            }

            // Keep the part after the change in the end segment
            if (endIdx < segments.length) {
                const endSeg = segments[endIdx];
                const after = endSeg.text.slice(endPos.offsetInSegment);
                if (after.length > 0) {
                    newSegments.push({ text: after, isDebug: endSeg.isDebug });
                }
            }

            // Replace the affected segments
            const deleteCount = endIdx - startIdx + 1;
            segments.splice(startIdx, deleteCount, ...newSegments);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Debug Segment Ranges (for highlighting)
    // Ported from your SegmentManager.getDebugSegmentsForDocument
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns debug segment offsets within the FULL text (debugOn view).
     * When debugMode is off, there's nothing to highlight so returns [].
     */
    public getDebugSegments(segments: TextSegment[], isDebugMode: boolean): DebugSegment[] {
        if (!isDebugMode) return [];

        const result: DebugSegment[] = [];
        let offset = 0;

        for (const seg of segments) {
            if (seg.isDebug) {
                result.push({
                    start: offset,
                    end: offset + seg.text.length
                });
            }
            offset += seg.text.length;
        }

        return result;
    }

    /**
     * Deep copy segments
     */
    public deepCopySegments(segments: TextSegment[]): TextSegment[] {
        return segments.map(s => ({ text: s.text, isDebug: s.isDebug }));
    }
}