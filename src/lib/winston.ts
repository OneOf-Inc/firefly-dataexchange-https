import * as winston from 'winston';
import * as path from 'path';

enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
}

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
  verbose: 5,
}

function enumKeys<O extends object, K extends keyof O = keyof O>(obj: O): K[] {
  return Object.keys(obj).filter(k => !Number.isNaN(k)) as K[]
}

export class Logger {
  private logger: winston.Logger;

  constructor(private loggername?: string) {
    this.logger = winston.createLogger({
      levels,
      format: this.getFormat(),
      transports: this.getTransports(),
    })
  }

  getFormat() {
    return winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
      winston.format.printf(
        (info) => `[${info.timestamp}] [${info.level.toUpperCase()}]: ${info.message}`.trimEnd() + ` ${this.loggername}`,
      ),
    )
  }

  getTransports() {
    return [
      new winston.transports.File({
        filename: path.join(__dirname, 'access.log'),
        level: this.getLogLevel(),
      }),
      new winston.transports.Console({
        level: this.getLogLevel(),
      }),
    ]
  }

  getLogLevel(level?: string) {
    let logLevel = LogLevel.ERROR;
    if (!level) level = process.env.LOG_LEVEL || 'info';
    for (const key of enumKeys(LogLevel)) {
      if (LogLevel[key] === level) {
        logLevel = LogLevel[key];
        break;
      }
    }
    return logLevel;
  }

  error(...args: any[]) { this.logger.error(args); }
  warn(...args: any[])  { this.logger.warn(args); }
  info(...args: any[])  { this.logger.info(args); }
  debug(...args: any[]) { this.logger.debug(args); }
  trace(...args: any[]) { this.logger.verbose(args); }
}
