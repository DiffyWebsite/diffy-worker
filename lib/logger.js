const winston = require("winston");

class Logger {
  debug = false;
  logger = new winston.Logger();

  constructor(debug = false) {
    this.debug = debug;
    this.logger = winston.createLogger({
      level: "error",
      format: winston.format.combine(
        winston.format.errors({ stack: true }),
        winston.format.printf(({ message, stack }) => {
          return stack ? stack.replace(/\n/g, " ") : message;
        })
      ),
      transports: [new winston.transports.Console()],
    });
  }

  log(...params) {
    if (this.debug) {
      console.log(params);
    }
  }

  error(...params) {
    this.logger.error(...params);
  }
}

module.exports = { Logger };
