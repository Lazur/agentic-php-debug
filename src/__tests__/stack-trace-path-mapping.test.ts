import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { handleDebugStackTrace } from '../tools/debug-stack-trace.js';
import { PathMapper, type PathMapping } from '../path-mapper.js';
import { SessionState } from '../session.js';
import type { SessionManager } from '../session.js';

/**
 * Property 16: Stack trace path mapping
 *
 * For any stack frame returned by debug_stack_trace that contains a source path
 * matching a configured remote mapping prefix, the returned path shall be the
 * corresponding local path (i.e., toLocal applied to the DAP response path).
 *
 * Validates: Requirements 7.3
 */

const arbPathSegment = fc.stringMatching(/^[a-z0-9_-]{1,10}$/);

const arbDirPath = fc
  .array(arbPathSegment, { minLength: 1, maxLength: 4 })
  .map((segments) => '/' + segments.join('/'));

const arbPathMapping: fc.Arbitrary<PathMapping> = fc
  .tuple(arbDirPath, arbDirPath)
  .filter(([a, b]) => a !== b)
  .map(([local, remote]) => ({ local, remote }));

const arbMappings = fc
  .array(arbPathMapping, { minLength: 1, maxLength: 5 })
  .filter((mappings) => {
    const locals = mappings.map((m) => m.local);
    const remotes = mappings.map((m) => m.remote);
    return new Set(locals).size === locals.length && new Set(remotes).size === remotes.length;
  });

/** Generate a remote path that starts with one of the remote mapping prefixes. */
function arbRemotePath(mappings: PathMapping[]): fc.Arbitrary<string> {
  return fc.nat({ max: mappings.length - 1 }).chain((idx) => {
    const mapping = mappings[idx];
    return fc
      .array(arbPathSegment, { minLength: 1, maxLength: 3 })
      .map((extra) => mapping.remote + '/' + extra.join('/'));
  });
}

/** Generate a DAP stack frame with a source path from the remote mapping space. */
function arbStackFrames(mappings: PathMapping[]) {
  return fc.array(
    fc.tuple(fc.nat({ max: 999 }), fc.string({ minLength: 1, maxLength: 20 }), arbRemotePath(mappings), fc.nat({ max: 500 }), fc.nat({ max: 200 }))
      .map(([id, name, path, line, col]) => ({
        id,
        name,
        source: { name: name + '.php', path },
        line: line + 1,
        column: col + 1,
      })),
    { minLength: 1, maxLength: 10 },
  );
}

describe('Stack trace path mapping property tests', () => {
  /**
   * Property 16: Stack trace path mapping
   * Validates: Requirements 7.3
   */
  it('all source paths in stack frames are mapped from remote to local', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMappings.chain((mappings) =>
          arbStackFrames(mappings).map((frames) => ({ mappings, frames })),
        ),
        async ({ mappings, frames }) => {
          const pathMapper = new PathMapper(mappings);

          // Build a mock session with the real PathMapper and a mock DAP client
          const mockSession = {
            assertState: vi.fn(),
            pathMapper,
            dapClient: {
              sendRequest: vi.fn().mockResolvedValue({
                body: {
                  stackFrames: frames,
                  totalFrames: frames.length,
                },
              }),
            },
            state: SessionState.Paused,
            // Reference tracking: handing out frame ids is recorded so a reuse
            // after a resume can be rejected. Irrelevant to path mapping, but
            // this is a partial SessionManager mock, so it must be present.
            noteIssuedFrameIds: vi.fn(),
          } as unknown as SessionManager;

          const result = await handleDebugStackTrace(mockSession, { threadId: 1 });

          expect(result.success).toBe(true);
          const data = result.data as { stackFrames: Array<{ source?: { path?: string } }> };

          for (let i = 0; i < frames.length; i++) {
            const inputPath = frames[i].source.path;
            const outputPath = data.stackFrames[i].source?.path;
            const expectedLocal = pathMapper.toLocal(inputPath);
            expect(outputPath).toBe(expectedLocal);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
