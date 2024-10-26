const winston = require("winston");
const util = require("util");

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
          /////////////// Solution 1. To prettify console dump in a single line
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

          /////////////// Solution 2. To avoid circular reference error
          // const formatMeta = (meta) => {
          //   return Object.keys(meta).length
          //     ? util.inspect(meta, { depth: null, compact: true, breakLength: Infinity })
          //     : "";
          // };

          const metaStr = formatMeta(meta);
          let logMessage = `[${level.toUpperCase()}] ${timestamp} ${message} ${metaStr}`;
          logMessage = logMessage
            .replace(/(\r\n|\n|\r)/gm, " ")
            .replace(/\\n/g, " ");
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
