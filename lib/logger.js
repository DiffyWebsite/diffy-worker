const winston = require("winston");

class Logger {
  debug = false;
  logger = new winston.Logger();

  constructor(debug = false) {
    this.debug = debug;
    this.logger = winston.createLogger({
      level: "info",
      format: winston.format.combine(
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
      ),
      transports: [new winston.transports.Console()],
    });
  }

  log(...params) {
    if (this.debug) {
      console.log(...params);
    }
  }

  info(message, ...meta) {
    this.logger.info(message, { meta });
  }

  warn(message, ...meta) {
    this.logger.warn(message, { meta });
  }

  error(message, ...meta) {
    this.logger.error(message, { meta });
  }
}

module.exports = { Logger };
