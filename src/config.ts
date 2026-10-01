import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { bundledAdapterPath } from './adapter-path.js';

// Sub-schemas for nested config objects

const XdebugSettingsSchema = z.object({
  max_children: z.number().int().optional(),
  max_data: z.number().int().optional(),
  max_depth: z.number().int().optional(),
  show_hidden: z.union([z.literal(0), z.literal(1)]).optional(),
  breakpoint_include_return_value: z.union([z.literal(0), z.literal(1)]).optional(),
}).strict().optional();

const ProxySettingsSchema = z.object({
  enable: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().default(9001),
  key: z.string().optional(),
  allowMultipleSessions: z.boolean().default(true),
  timeout: z.number().int().default(3000),
}).strict().optional();

const StreamSettingsSchema = z.object({
  stdout: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
}).strict().optional();

export const ConfigSchema = z.object({
  // Lazy default: evaluated only when a config omits adapterPath.
  adapterPath: z.string().default(bundledAdapterPath),
  port: z.number().int().default(9003),
  hostname: z.string().default('127.0.0.1'),
  stopOnEntry: z.boolean().default(false),
  pathMappings: z.record(z.string(), z.string()).default({}),
  program: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  runtimeExecutable: z.string().default('php'),
  runtimeArgs: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  envFile: z.string().optional(),
  xdebugSettings: XdebugSettingsSchema,
  maxConnections: z.number().int().default(0),
  skipFiles: z.array(z.string()).optional(),
  skipEntryPaths: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  ignoreExceptions: z.array(z.string()).optional(),
  stream: StreamSettingsSchema,
  proxy: ProxySettingsSchema,
  xdebugCloudToken: z.string().optional(),
  log: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load and validate a JSON configuration file.
 * @throws Error if the file is missing, unreadable, or contains invalid config.
 */
export function loadConfig(filePath: string): Config {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config file "${filePath}": ${message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse config file "${filePath}": invalid JSON`);
  }

  return ConfigSchema.parse(json);
}

/**
 * Serialize a validated Config object to a JSON string.
 */
export function serializeConfig(config: Config): string {
  return JSON.stringify(config);
}
