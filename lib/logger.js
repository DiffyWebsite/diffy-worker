const { createLogger, format, transports } = require('winston')
const { combine, timestamp, json } = format
require('winston-daily-rotate-file')

const logger = createLogger({
  format: combine(
      timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
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
