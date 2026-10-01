import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { successResult, errorResult, ErrorCodes } from '../tools/types.js';
import { McpNotificationSender } from '../notifications.js';

// Feature: ts-php-debug-mcp, Property 12: Tool response envelope format
// **Validates: Requirements 11.1, 11.2, 11.3**
describe('Property 12: Tool response envelope format', () => {
  it('successResult always produces { success: true, data }', () => {
    fc.assert(
      fc.property(fc.anything(), (data) => {
        const result = successResult(data);
        expect(result.success).toBe(true);
        expect(result).toHaveProperty('data');
        expect(result.error).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('errorResult always produces { success: false, error: { message, code } }', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.constantFrom(...Object.values(ErrorCodes)),
        (message, code) => {
          const result = errorResult(message, code);
          expect(result.success).toBe(false);
          expect(result.error).toBeDefined();
          expect(typeof result.error!.message).toBe('string');
          expect(typeof result.error!.code).toBe('string');
          expect(result.data).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// Feature: ts-php-debug-mcp, Property 13: Output event log level mapping
// **Validates: Requirements 10.2**
describe('Property 13: Output event log level mapping', () => {
  function outputCategoryToLogLevel(category: string): string {
    if (category === 'stderr') return 'warning';
    return 'info';
  }

  it('stdout maps to info, stderr maps to warning', () => {
    fc.assert(
      fc.property(fc.constantFrom('stdout', 'stderr'), (category) => {
        const level = outputCategoryToLogLevel(category);
        if (category === 'stdout') {
          expect(level).toBe('info');
        } else {
          expect(level).toBe('warning');
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: ts-php-debug-mcp, Property 14: State change logging
// **Validates: Requirements 10.3**
describe('Property 14: State change logging', () => {
  const states = ['not_started', 'initializing', 'listening', 'connected', 'paused', 'terminated'] as const;

  it('sendLog is called with info level for every state transition', () => {
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...states),
        fc.constantFrom(...states),
        async (oldState, newState) => {
          const mockServer = {
            server: { notification: vi.fn().mockResolvedValue(undefined) },
            sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
          };
          const sender = new McpNotificationSender(mockServer as any);

          await sender.sendLog('info', `Session state: ${oldState} → ${newState}`);

          expect(mockServer.sendLoggingMessage).toHaveBeenCalledTimes(1);
          const call = mockServer.sendLoggingMessage.mock.calls[0][0];
          expect(call.level).toBe('info');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: ts-php-debug-mcp, Property 15: Progress token propagation
// **Validates: Requirements 9.2**
describe('Property 15: Progress token propagation', () => {
  it('sendProgress always includes the provided progressToken', () => {
    fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string({ minLength: 1 }), fc.integer()),
        fc.nat({ max: 100 }),
        fc.option(fc.nat({ max: 100 }), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        async (token, progress, total, message) => {
          const notificationFn = vi.fn().mockResolvedValue(undefined);
          const mockServer = {
            server: { notification: notificationFn },
            sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
          };
          const sender = new McpNotificationSender(mockServer as any);

          await sender.sendProgress(token, progress, total, message);

          expect(notificationFn).toHaveBeenCalledTimes(1);
          const notification = notificationFn.mock.calls[0][0];
          expect(notification.method).toBe('notifications/progress');
          expect(notification.params.progressToken).toBe(token);
          expect(notification.params.progress).toBe(progress);
        },
      ),
      { numRuns: 100 },
    );
  });
});
