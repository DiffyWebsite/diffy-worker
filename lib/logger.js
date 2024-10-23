const winston = require("winston");

const singleLineFormat = winston.format.printf(
  ({ level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
    let logMessage = `[${level.toUpperCase()}] ${message} ${metaStr}`;
    logMessage = logMessage.replace(/(\r\n|\n|\r)/gm, " ");
    return logMessage;
  }
);

class Logger {
  debug = false;
  logger = new winston.Logger();

  constructor(debug = false) {
    this.debug = debug;
    this.logger = winston.createLogger({
      level: "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        singleLineFormat
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
