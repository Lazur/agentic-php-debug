import { EventEmitter } from 'node:events';

/**
 * Frame a DAP message object with Content-Length header.
 * Format: `Content-Length: N\r\n\r\n{json}`
 */
export function frameMessage(message: object): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, 'utf-8');
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

/**
 * Parses Content-Length framed DAP messages from a readable stream.
 * Emits 'message' events with parsed objects.
 */
export class DAPStreamParser extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private contentLength = -1;

  constructor(stream: NodeJS.ReadableStream) {
    super();
    stream.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.on('end', () => this.emit('close'));
    stream.on('error', (err) => this.emit('error', err));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parse();
  }

  private parse(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.contentLength === -1) {
        // Look for the header separator
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.emit('error', new Error(`Invalid DAP header: ${header}`));
          return;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return;

      const body = this.buffer.subarray(0, this.contentLength).toString('utf-8');
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(body);
        this.emit('message', message);
      } catch (err) {
        this.emit('error', new Error(`Failed to parse DAP message body: ${body}`));
      }
    }
  }
}
