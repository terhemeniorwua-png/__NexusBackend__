type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const sensitiveKeyPattern =
  /password|passwd|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|pin|credential/i;

const connectionCredentialPattern = /\b((?:postgres(?:ql)?|rediss?):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi;

function sanitizeString(value: string): string {
  return value.replace(connectionCredentialPattern, '$1***$3');
}

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: sanitizeString(error.message),
    stack: error.stack ? sanitizeString(error.stack) : undefined,
  };
}

function serializeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? '[REDACTED]' : serializeValue(item, seen),
      ]),
    );
  }

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  return value;
}

export class Logger {
  private level: LogLevel;
  private readonly bindings: Record<string, unknown>;

  constructor(
    level: LogLevel = 'info',
    bindings: Record<string, unknown> = {},
    private readonly sink?: (line: string, level: LogLevel) => void,
  ) {
    this.level = level;
    this.bindings = bindings;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.bindings, ...bindings }, this.sink);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (levelWeights[level] < levelWeights[this.level]) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.bindings,
      ...(context ? (serializeValue(context) as Record<string, unknown>) : {}),
    };

    const line = JSON.stringify(entry);

    if (this.sink) {
      this.sink(line, level);
      return;
    }

    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}

export const logger = new Logger((process.env.LOG_LEVEL as LogLevel) || 'info', {
  service: 'nexus-backend',
});
