const { createLogger, format, transports } = require('winston')
const { combine, timestamp, json, errors } = format
require('winston-daily-rotate-file')

const MAX_DEPTH = 4

// An Error's message and stack are non-enumerable, so JSON.stringify reduces `{error: err}`
// metadata to `{"name":"Error"}`. Replace Error values with plain objects before json() runs.
const normalize = (value, depth) => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined ? { cause: String(value.cause) } : {})
    }
  }

  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') {
    return value
  }

  // Copy only when something below actually changed, so caller objects are left untouched.
  let changed = false
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value)
  const out = Array.isArray(value) ? [] : {}

  for (const [key, item] of entries) {
    const normalized = normalize(item, depth + 1)
    if (normalized !== item) changed = true
    out[key] = normalized
  }

  return changed ? out : value
}

const serializeErrors = format((info) => {
  for (const key of Object.keys(info)) {
    info[key] = normalize(info[key], 0)
  }
  return info
})

const logger = createLogger({
  format: combine(
      timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      errors({ stack: true }),
      serializeErrors(),
      json()
  ),
  defaultMeta: { service: 'screenshot_worker' },
  transports: [
    new transports.Console({
      level: 'info'
    }),
    new transports.DailyRotateFile({
      level: 'debug',
      dirname: 'log',
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '10d'
    })
  ],
  exceptionHandlers: [
    new transports.Console()
  ]
})

module.exports = logger
