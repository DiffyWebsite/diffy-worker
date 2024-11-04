const winston = require("winston");

const format = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const formatMeta = (meta) => {
      return Object.keys(meta).length
        ? JSON.stringify(meta, (key, value) =>
            value instanceof Error
              ? { message: value.message, stack: value.stack, name: value.name }
              : value
          )
            .replaceAll(/(\r\n|\n|\r)/gm, " ")
            .replaceAll(/\s+/g, " ")
            .replaceAll(/\\n/g, "")
        : "";
    };

    const metaStr = formatMeta(meta);
    let logMessage = `[${level.toUpperCase()}] ${timestamp} ${message} ${metaStr}`;
    return logMessage.trim();
  })
);

class Logger {
  debug = false;
  infoLogger = new winston.Logger();
  warnLogger = new winston.Logger();
  errorLogger = new winston.Logger();

  constructor(debug = false) {
    this.debug = debug;

    this.infoLogger = winston.createLogger({
      level: "info",
      format,
      transports: [new winston.transports.Console()],
    });
    this.warnLogger = winston.createLogger({
      level: "warn",
      format,
      transports: [new winston.transports.Console()],
    });
    this.errorLogger = winston.createLogger({
      level: "error",
      format,
      transports: [new winston.transports.Console()],
    });
  }

  log(...params) {
    if (this.debug) {
      console.log(...params);
    }
  }

  info(message, ...meta) {
    this.infoLogger.info(message, { meta });
  }

  warn(message, ...meta) {
    this.warnLogger.warn(message, { meta });
  }

  error(message, ...meta) {
    this.errorLogger.error(message, { meta });
  }
}

module.exports = { Logger };
