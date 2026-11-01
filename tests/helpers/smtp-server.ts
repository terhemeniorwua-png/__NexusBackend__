import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

/**
 * Minimal SMTP server used by the Phase 4 integration tests.
 *
 * It speaks enough SMTP for nodemailer to complete a real delivery, so the
 * tests exercise the production transport instead of a stub. The captured
 * message is the raw MIME body, which lets the tests assert on the rendered
 * content and on the headers that the application adds.
 */

export interface CapturedMessage {
  from: string;
  to: string[];
  raw: string;
  headers: Record<string, string>;
  body: string;
}

export interface TestSmtpServer {
  host: string;
  port: number;
  messages: CapturedMessage[];
  /** Makes the next `count` deliveries fail with a temporary SMTP error. */
  failNext(count: number): void;
  /** Makes the next `count` deliveries fail with a permanent SMTP error. */
  rejectNext(count: number): void;
  reset(): void;
  close(): Promise<void>;
}

function extractAddress(line: string): string {
  const angle = /<([^>]*)>/.exec(line);

  if (angle?.[1]) {
    return angle[1].trim();
  }

  const parts = line.split(':');

  return (parts[1] ?? '').trim().split(/\s+/)[0] ?? '';
}

function parseHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const separator = raw.indexOf('\r\n\r\n');
  const headerBlock = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? '' : raw.slice(separator + 4);
  const headers: Record<string, string> = {};

  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':');

    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }

  return { headers, body };
}

export async function startSmtpServer(): Promise<TestSmtpServer> {
  const messages: CapturedMessage[] = [];
  const sockets = new Set<Socket>();
  let temporaryFailures = 0;
  let permanentFailures = 0;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');

    let buffer = '';
    let inData = false;
    let dataBuffer = '';
    let from = '';
    let recipients: string[] = [];

    const write = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    write('220 nexus-test ESMTP ready');

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      let index = buffer.indexOf('\r\n');

      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;

            if (permanentFailures > 0) {
              permanentFailures -= 1;
              from = '';
              recipients = [];
              dataBuffer = '';
              write('550 5.1.1 Mailbox unavailable');
              continue;
            }

            if (temporaryFailures > 0) {
              temporaryFailures -= 1;
              from = '';
              recipients = [];
              dataBuffer = '';
              write('451 4.3.0 Temporary failure, please try again later');
              continue;
            }

            const { headers, body } = parseHeaders(dataBuffer);

            messages.push({
              from,
              to: [...recipients],
              raw: dataBuffer,
              headers,
              body,
            });

            // A pooled connection carries on with the next message, so the
            // envelope of this message must not leak into the next one.
            from = '';
            recipients = [];

            write('250 2.0.0 Ok: queued as TEST123');
          } else {
            dataBuffer += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }

          index = buffer.indexOf('\r\n');
          continue;
        }

        const command = line.toUpperCase();

        if (command.startsWith('EHLO')) {
          write('250-nexus-test greets you');
          write('250-SIZE 10485760');
          write('250 8BITMIME');
        } else if (command.startsWith('HELO')) {
          write('250 nexus-test');
        } else if (command.startsWith('MAIL FROM')) {
          from = extractAddress(line);
          write('250 2.1.0 Ok');
        } else if (command.startsWith('RCPT TO')) {
          recipients.push(extractAddress(line));
          write('250 2.1.5 Ok');
        } else if (command.startsWith('DATA')) {
          inData = true;
          dataBuffer = '';
          write('354 End data with <CR><LF>.<CR><LF>');
        } else if (command.startsWith('RSET')) {
          from = '';
          recipients = [];
          inData = false;
          dataBuffer = '';
          write('250 2.0.0 Ok');
        } else if (command.startsWith('NOOP')) {
          write('250 2.0.0 Ok');
        } else if (command.startsWith('QUIT')) {
          write('221 2.0.0 Bye');
          socket.end();
        } else {
          write('250 2.0.0 Ok');
        }

        index = buffer.indexOf('\r\n');
      }
    });

    socket.on('error', () => {
      socket.destroy();
    });

    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    host: '127.0.0.1',
    port: address.port,
    messages,
    failNext(count: number): void {
      temporaryFailures += count;
    },
    rejectNext(count: number): void {
      permanentFailures += count;
    },
    reset(): void {
      messages.length = 0;
      temporaryFailures = 0;
      permanentFailures = 0;
    },
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }

      sockets.clear();

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
