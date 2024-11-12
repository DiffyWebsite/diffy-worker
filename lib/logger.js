const winston = require("winston");

const format = winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, identificationKey, ...meta }) => {
        const formatMeta = (meta) => {
            return meta && Object.keys(meta).length
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
        let logMessage = `[${level.toUpperCase()}] ${timestamp} [${identificationKey || 'N/A'}] ${message} ${metaStr}`;
        return logMessage.trim();
    })
);

class Logger {
  debug = false;
  timers = {};

  constructor(debug = false) {
    this.debug = debug;
  }

  log(level, identificationKey, message, meta = {}) {
    const logData = {
      log_status: level.toUpperCase(),
      message: identificationKey + ' - ' + message,
      timestamp: new Date().toISOString(),
      ...meta,
    };

    console.log(JSON.stringify(logData));
  }

  info(identificationKey, message, meta = {}) {
    this.log("info", identificationKey, message, meta);
  }

  warn(identificationKey, message, meta = {}) {
    this.log("warn", identificationKey, message, meta);
  }

  error(identificationKey, message, meta = {}) {
    this.log("error", identificationKey, message, meta);
  }

  startTimer(label, identificationKey) {
    if (!this.timers[identificationKey]) {
      this.timers[identificationKey] = {};
    }
    this.timers[identificationKey][label] = Date.now();
    this.info(identificationKey, `Timer started: ${label}`);
  }

  endTimer(label, identificationKey, meta = {}) {
    if (this.timers[identificationKey] && this.timers[identificationKey][label]) {
      const duration = Date.now() - this.timers[identificationKey][label];
      this.info(identificationKey, `Timer ended: ${label} - Duration: ${duration} ms`, meta);
      delete this.timers[identificationKey][label];
    } else {
      this.warn(identificationKey, `Timer with label "${label}" was not found`, meta);
    }
  }
}

module.exports = { Logger };
