const winston = require("winston");

const format = winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, identificationKey, ...meta }) => {
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
        let logMessage = `[${level.toUpperCase()}] ${timestamp} [${identificationKey}] ${message} ${metaStr}`;
        return logMessage.trim();
    })
);

class Logger {
    debug = false;
    logger = new winston.Logger();

    constructor(debug = false) {
        this.debug = debug;

        this.logger = winston.createLogger({
            level: "info",
            format,
            transports: [new winston.transports.Console()],
        });
    }

    log(level, identificationKey, message, meta = {}) {
        this.logger.log({ level, identificationKey, message, ...meta });
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
}

module.exports = { Logger };
