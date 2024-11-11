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
  logGroups = {};
  timers = {};

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

  groupLog(url, level, message, meta) {
    if (!this.logGroups[url]) {
      this.logGroups[url] = [];
    }
    this.logGroups[url].push({ level, message, meta, timestamp: new Date().toISOString() });
  }

  flushLogs(url) {
    if (this.logGroups[url] && this.logGroups[url].length > 0) {
      this.logGroups[url].forEach(log => {
        const { level, message, meta, timestamp } = log;

        switch (level) {
          case "info":
            this.infoLogger.info({ message, meta, timestamp });
            break;
          case "warn":
            this.warnLogger.warn({ message, meta, timestamp });
            break;
          case "error":
            this.errorLogger.error({ message, meta, timestamp });
            break;
        }
      });

      // Clear the group
      delete this.logGroups[url];
    }
  }

  startTimer(label, url) {
    if (!this.timers[url]) {
      this.timers[url] = {};
    }
    this.timers[url][label] = Date.now();
    this.groupLog(url, "info", `Timer started: ${label}`, {});
  }

  endTimer(label, url, ...meta) {
    if (this.timers[url] && this.timers[url][label]) {
      const duration = Date.now() - this.timers[url][label];
      this.groupLog(url, "info", `Timer ended: ${label} - Duration: ${duration} ms`, meta);
      delete this.timers[url][label];
    } else {
      this.groupLog(url, "warn", `Timer with label "${label}" was not found`, meta);
    }
  }

  info(url, message, ...meta) {
    this.groupLog(url, "info", message, meta);
  }

  warn(url, message, ...meta) {
    this.groupLog(url, "warn", message, meta);
  }

  error(url, message, ...meta) {
    this.groupLog(url, "error", message, meta);
  }

  flushAllLogs() {
    for (const url in this.logGroups) {
      this.flushLogs(url);
    }
  }
}

module.exports = { Logger };
