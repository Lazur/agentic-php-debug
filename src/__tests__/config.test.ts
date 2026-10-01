import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { ZodError } from 'zod';
import { ConfigSchema, serializeConfig, type Config } from '../config.js';

/**
 * Arbitrary for generating valid Config objects matching the Zod ConfigSchema.
 */

const arbZeroOrOne = fc.constantFrom(0 as const, 1 as const);

const arbXdebugSettings = fc.option(
  fc.record({
    max_children: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
    max_data: fc.option(fc.integer({ min: 0, max: 100000 }), { nil: undefined }),
    max_depth: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
    show_hidden: fc.option(arbZeroOrOne, { nil: undefined }),
    breakpoint_include_return_value: fc.option(arbZeroOrOne, { nil: undefined }),
  }),
  { nil: undefined },
);

const arbProxySettings = fc.option(
  fc.record({
    enable: fc.boolean(),
    host: fc.string({ minLength: 1, maxLength: 50 }),
    port: fc.integer({ min: 1, max: 65535 }),
    key: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
    allowMultipleSessions: fc.boolean(),
    timeout: fc.integer({ min: 0, max: 60000 }),
  }),
  { nil: undefined },
);

const arbStreamSettings = fc.option(
  fc.record({
    stdout: fc.constantFrom(0 as const, 1 as const, 2 as const),
  }),
  { nil: undefined },
);

const arbStringRecord = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.string({ minLength: 0, maxLength: 50 }),
  { minKeys: 0, maxKeys: 3 },
);

const arbStringArray = fc.array(fc.string({ minLength: 0, maxLength: 30 }), { minLength: 0, maxLength: 5 });

const arbConfig: fc.Arbitrary<Config> = fc.record({
  adapterPath: fc.string({ minLength: 1, maxLength: 100 }),
  port: fc.integer({ min: 1, max: 65535 }),
  hostname: fc.string({ minLength: 1, maxLength: 50 }),
  stopOnEntry: fc.boolean(),
  pathMappings: fc.dictionary(fc.string({ minLength: 1, maxLength: 30 }), fc.string({ minLength: 1, maxLength: 30 }), {
    minKeys: 0,
    maxKeys: 3,
  }),
  program: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  args: fc.option(arbStringArray, { nil: undefined }),
  cwd: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  runtimeExecutable: fc.string({ minLength: 1, maxLength: 50 }),
  runtimeArgs: fc.option(arbStringArray, { nil: undefined }),
  env: fc.option(arbStringRecord, { nil: undefined }),
  envFile: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  xdebugSettings: arbXdebugSettings,
  maxConnections: fc.integer({ min: 0, max: 100 }),
  skipFiles: fc.option(arbStringArray, { nil: undefined }),
  skipEntryPaths: fc.option(arbStringArray, { nil: undefined }),
  ignore: fc.option(arbStringArray, { nil: undefined }),
  ignoreExceptions: fc.option(arbStringArray, { nil: undefined }),
  stream: arbStreamSettings,
  proxy: arbProxySettings,
  xdebugCloudToken: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  log: fc.boolean(),
});

describe('Config property tests', () => {
  /**
   * Property 1: Configuration serialization round-trip
   * For any valid Config object, serializing to JSON and re-parsing/validating
   * produces a deeply equal Config.
   * Validates: Requirements 1.7, 1.8
   */
  it('round-trip: serialize then parse produces equivalent config', () => {
    fc.assert(
      fc.property(arbConfig, (config) => {
        const serialized = serializeConfig(config);
        const roundTripped = ConfigSchema.parse(JSON.parse(serialized));
        expect(roundTripped).toEqual(config);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 2: Valid configuration acceptance
   * For any JSON object whose fields conform to the ConfigSchema types and constraints,
   * ConfigSchema.parse shall succeed and return a Config object without throwing.
   * Validates: Requirements 1.2
   */
  it('valid configurations are accepted without throwing', () => {
    fc.assert(
      fc.property(arbConfig, (config) => {
        // Serialize to plain JSON and re-parse to simulate real input
        const json = JSON.parse(JSON.stringify(config));
        const result = ConfigSchema.parse(json);
        expect(result).toBeDefined();
        expect(result.adapterPath).toBe(config.adapterPath);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 3: Invalid configuration rejection
   * For any JSON object that contains at least one field with an incorrect type
   * (e.g., port as a string, stopOnEntry as a number), ConfigSchema.parse shall
   * throw a ZodError listing the invalid field.
   * Validates: Requirements 1.4
   */
  it('invalid configurations are rejected with ZodError', () => {
    // Arbitrary that produces an object with exactly one field corrupted to a wrong type
    const arbInvalidConfig = arbConfig.chain((config) => {
      const corruptions: fc.Arbitrary<Record<string, unknown>>[] = [
        // port should be number, corrupt to string
        fc.constant({ ...config, port: 'not-a-number' }),
        // stopOnEntry should be boolean, corrupt to number
        fc.constant({ ...config, stopOnEntry: 42 }),
        // adapterPath should be string, corrupt to number
        fc.constant({ ...config, adapterPath: 123 }),
        // hostname should be string, corrupt to boolean
        fc.constant({ ...config, hostname: true }),
        // pathMappings should be record of strings, corrupt to array
        fc.constant({ ...config, pathMappings: ['bad'] }),
        // log should be boolean, corrupt to string
        fc.constant({ ...config, log: 'yes' }),
        // maxConnections should be number, corrupt to boolean
        fc.constant({ ...config, maxConnections: false }),
      ];
      return fc.oneof(...corruptions);
    });

    fc.assert(
      fc.property(arbInvalidConfig, (invalidObj) => {
        expect(() => ConfigSchema.parse(invalidObj)).toThrow(ZodError);
      }),
      { numRuns: 100 },
    );
  });
});

import { loadConfig } from '../config.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Config unit tests - edge cases', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Requirement 1.3: Missing or unreadable config file returns descriptive error
   */
  it('throws descriptive error for missing config file', () => {
    const missingPath = '/nonexistent/path/config.json';
    expect(() => loadConfig(missingPath)).toThrow(/Failed to read config file/);
    expect(() => loadConfig(missingPath)).toThrow(missingPath);
  });

  /**
   * Requirement 1.6: Default values applied when optional fields omitted
   */
  it('applies default values for port, stopOnEntry, and hostname', () => {
    const configPath = join(tempDir, 'minimal.json');
    writeFileSync(configPath, JSON.stringify({ adapterPath: '/usr/bin/php-debug' }));

    const config = loadConfig(configPath);
    expect(config.port).toBe(9003);
    expect(config.stopOnEntry).toBe(false);
    expect(config.hostname).toBe('127.0.0.1');
  });

  /**
   * Requirement 1.5: pathMappings normalization from record to bidirectional structure
   */
  it('normalizes pathMappings record preserving remote-to-local pairs', () => {
    const configPath = join(tempDir, 'mappings.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        adapterPath: '/usr/bin/php-debug',
        pathMappings: {
          '/var/www/html': '/home/user/project',
          '/app/src': '/local/src',
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.pathMappings).toEqual({
      '/var/www/html': '/home/user/project',
      '/app/src': '/local/src',
    });
  });

  it('defaults adapterPath to the bundled dist/adapter/phpDebug.js', () => {
    const configPath = join(tempDir, 'no-adapter.json');
    writeFileSync(configPath, JSON.stringify({ port: 9003 }));

    const config = loadConfig(configPath);
    expect(config.adapterPath).toMatch(/[\\/]adapter[\\/]phpDebug\.js$/);
  });

  it('defaults pathMappings to empty record when omitted', () => {
    const configPath = join(tempDir, 'no-mappings.json');
    writeFileSync(configPath, JSON.stringify({ adapterPath: '/usr/bin/php-debug' }));

    const config = loadConfig(configPath);
    expect(config.pathMappings).toEqual({});
  });
});
