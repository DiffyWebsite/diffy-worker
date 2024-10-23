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
        winston.format.printf(({ level, message, ...meta }) => {
          const formatMeta = (meta) => {
            return Object.keys(meta).length
              ? JSON.stringify(meta, (key, value) => {
                  if (value instanceof Error) {
                    return {
                      message: value.message,
                      stack: value.stack,
                      name: value.name,
                    };
                  }
                  return value;
                })
              : "";
          };

          const metaStr = formatMeta(meta);
          let logMessage = `[${level.toUpperCase()}] ${message} ${metaStr}`;
          logMessage = logMessage
            .replaceAll(/(\r\n|\n|\r)/gm, " ")
            .replaceAll("\\n", "");
          return logMessage;
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
