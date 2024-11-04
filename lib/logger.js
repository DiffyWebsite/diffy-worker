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
  logTimers = {};

  constructor(debug = false) {
    this.debug = debug;

    // Create different loggers for different levels
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

  groupLog(url, level, message, meta) {
    if (!this.logGroups[url]) {
      this.logGroups[url] = [];
    }
    this.logGroups[url].push({ level, message, meta, timestamp: new Date().toISOString() });

    if (!this.logTimers[url]) {
      this.logTimers[url] = setTimeout(() => {
        this.flushLogs(url);
      }, 10000); // Send aggregated logs every 10 seconds
    }
  }

  flushLogs(url) {
    if (this.logGroups[url] && this.logGroups[url].length > 0) {
      // Aggregate all log messages for the URL in a single log object
      const aggregatedLog = {
        url: url,
        group_id: url,
        logs: this.logGroups[url].map(log => ({
          level: log.level.toUpperCase(),
          timestamp: log.timestamp,
          message: log.message,
          meta: log.meta,
        })),
      };

      // Send the single aggregated log object
      console.log(JSON.stringify(aggregatedLog));

      // Clear the group
      delete this.logGroups[url];
      clearTimeout(this.logTimers[url]);
      delete this.logTimers[url];
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

  getGroupedLogs(url) {
    return this.logGroups[url] || [];
  }

  flushAllLogs() {
    // Flush all logs that are currently grouped
    for (const url in this.logGroups) {
      this.flushLogs(url);
    }
  }
}

module.exports = { Logger };
