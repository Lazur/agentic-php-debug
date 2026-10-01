import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { PathMapper, type PathMapping } from '../path-mapper.js';

/**
 * Arbitrary for a single path mapping with distinct local/remote prefixes.
 * Uses directory-style paths (starting with /) to match real usage.
 */
const arbPathSegment = fc.stringMatching(/^[a-z0-9_-]{1,10}$/);

const arbDirPath = fc
  .array(arbPathSegment, { minLength: 1, maxLength: 4 })
  .map((segments) => '/' + segments.join('/'));

const arbPathMapping: fc.Arbitrary<PathMapping> = fc
  .tuple(arbDirPath, arbDirPath)
  .filter(([a, b]) => a !== b)
  .map(([local, remote]) => ({ local, remote }));

/**
 * Arbitrary for a non-empty list of path mappings with unique local and remote prefixes.
 */
const arbMappings = fc
  .array(arbPathMapping, { minLength: 1, maxLength: 5 })
  .filter((mappings) => {
    const locals = mappings.map((m) => m.local);
    const remotes = mappings.map((m) => m.remote);
    return new Set(locals).size === locals.length && new Set(remotes).size === remotes.length;
  });

/**
 * Given mappings, generate a local path that starts with one of the local prefixes.
 */
function arbMappedLocalPath(mappings: PathMapping[]): fc.Arbitrary<{ path: string; mapping: PathMapping }> {
  return fc.nat({ max: mappings.length - 1 }).chain((idx) => {
    const mapping = mappings[idx];
    return fc
      .array(arbPathSegment, { minLength: 0, maxLength: 3 })
      .map((extra) => ({
        path: mapping.local + (extra.length > 0 ? '/' + extra.join('/') : ''),
        mapping,
      }));
  });
}

/**
 * Generate a path that does NOT start with any of the given prefixes.
 */
function arbUnmappedPath(prefixes: string[]): fc.Arbitrary<string> {
  return arbDirPath.filter((p) => !prefixes.some((prefix) => p.startsWith(prefix)));
}

describe('PathMapper property tests', () => {
  /**
   * Property 9: Path mapping round-trip
   * For any local path starting with a configured local mapping prefix,
   * toRemote then toLocal produces the original local path.
   * Validates: Requirements 8.1, 8.2, 8.5
   */
  it('round-trip: toRemote then toLocal returns original local path', () => {
    fc.assert(
      fc.property(
        arbMappings.chain((mappings) =>
          arbMappedLocalPath(mappings).map((result) => ({ mappings, ...result })),
        ),
        ({ mappings, path }) => {
          const mapper = new PathMapper(mappings);
          const remote = mapper.toRemote(path);
          const backToLocal = mapper.toLocal(remote);
          expect(backToLocal).toBe(path);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10: Path mapping longest prefix wins
   * When multiple mappings match, the one with the longest prefix is used.
   * Validates: Requirements 8.3
   */
  it('longest prefix wins when multiple mappings match', () => {
    fc.assert(
      fc.property(
        fc.tuple(arbPathSegment, arbPathSegment, arbPathSegment, arbPathSegment, arbPathSegment).chain(
          ([a, b, c, localBase, remoteBase]) => {
            // Create two overlapping mappings: short prefix and long prefix
            const shortLocal = `/${a}/${b}`;
            const longLocal = `/${a}/${b}/${c}`;
            const shortRemote = `/${localBase}`;
            const longRemote = `/${remoteBase}`;

            // Ensure remote prefixes are distinct
            if (shortRemote === longRemote) return fc.constant(null);

            const mappings: PathMapping[] = [
              { local: shortLocal, remote: shortRemote },
              { local: longLocal, remote: longRemote },
            ];

            // Generate a path that matches the longer prefix
            return fc
              .array(arbPathSegment, { minLength: 0, maxLength: 3 })
              .map((extra) => ({
                mappings,
                testPath: longLocal + (extra.length > 0 ? '/' + extra.join('/') : ''),
                longRemote,
                longLocal,
                extra,
              }));
          },
        ),
        (result) => {
          if (result === null) return; // skip degenerate case
          const { mappings, testPath, longRemote, longLocal, extra } = result;
          const mapper = new PathMapper(mappings);
          const remotePath = mapper.toRemote(testPath);
          const expectedRemote = longRemote + testPath.slice(longLocal.length);
          expect(remotePath).toBe(expectedRemote);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 11: Path mapping identity for unmapped paths
   * For any path that doesn't match any configured mapping prefix,
   * both toRemote and toLocal return the original path unchanged.
   * Validates: Requirements 8.4
   */
  it('unmapped paths are returned unchanged by both toRemote and toLocal', () => {
    fc.assert(
      fc.property(
        arbMappings.chain((mappings) => {
          const allPrefixes = [
            ...mappings.map((m) => m.local),
            ...mappings.map((m) => m.remote),
          ];
          return arbUnmappedPath(allPrefixes).map((path) => ({ mappings, path }));
        }),
        ({ mappings, path }) => {
          const mapper = new PathMapper(mappings);
          expect(mapper.toRemote(path)).toBe(path);
          expect(mapper.toLocal(path)).toBe(path);
        },
      ),
      { numRuns: 100 },
    );
  });
});
