const fs = require('fs-extra')
const path = require('path')

// Local-runner Diffy API client. Used only by diffy-screenshots.js (the local worker); the
// production SQS path uses SQS/S3, not this file. Uses Node's built-in fetch/FormData/Blob
// (Node 18+), so it has no third-party HTTP dependency.
class Api {
  constructor (diffyUrl, apiKey, projectId, logger) {
    this.logger = logger
    this.diffyUrl = diffyUrl
    this.apiKey = apiKey
    this.projectId = projectId
    this.token = ''
    this.uploadScreenshotTimeout = (process.env.UPLOAD_SCREENSHOT_TIMEOUT && process.env.UPLOAD_SCREENSHOT_TIMEOUT.length) ? parseInt(process.env.UPLOAD_SCREENSHOT_TIMEOUT, 10) : 600000
    this.defaultRequestTimeout = (process.env.DEFAULT_REQUEST_TIMEOUT && process.env.DEFAULT_REQUEST_TIMEOUT.length) ? parseInt(process.env.DEFAULT_REQUEST_TIMEOUT, 10) : 30000
  }

  /**
   * Api login action.
   *
   * @returns {Promise<*>}
   */
  async login () {
    const url = `${this.diffyUrl}/auth/key`
    const body = await this._request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: this.apiKey })
    }, this.defaultRequestTimeout)

    this.logger.debug('Login', { body })

    if (body && Object.hasOwn(body, 'token')) {
      this.token = body.token
      return body.token
    }
    throw new Error('Can\'t login')
  }

  /**
   * Api get project settings action.
   *
   * @returns {Promise<{name}|*>}
   */
  async getProject () {
    const url = `${this.diffyUrl}/projects/${this.projectId}`
    const project = await this._request(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }
    }, this.defaultRequestTimeout)

    this.logger.debug('Get project', { project })

    if (project && Object.hasOwn(project, 'name')) {
      return project
    }
    throw new Error('Can\'t get project')
  }

  async uploadScreenshots (snapshotName, results) {
    const url = `${this.diffyUrl}/projects/${this.projectId}/create-custom-snapshot`

    const form = new FormData()
    form.set('snapshotName', snapshotName)

    for (let i = 0; i < results.length; i++) {
      const item = results[i]
      form.set(`urls[${i}]`, item.uri)
      form.set(`breakpoints[${i}]`, String(item.breakpoint))
      form.set(`files[${i}]`, new Blob([await fs.readFile(item.filename)]), path.basename(item.filename))
      form.set(`htmlFiles[${i}]`, new Blob([await fs.readFile(item.htmlFilename)]), path.basename(item.htmlFilename))
      form.set(`jsConsoleFiles[${i}]`, new Blob([await fs.readFile(item.jsConsoleFilename)]), path.basename(item.jsConsoleFilename))
    }

    this.logger.debug(`Files: ${results.length} - Sending screenshot to Diffy`)

    // Do NOT set Content-Type: fetch adds the multipart boundary automatically for a FormData body.
    const screenshotId = await this._request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form
    }, this.uploadScreenshotTimeout)

    this.logger.debug(`Saved screenshot id: ${screenshotId}`)

    return screenshotId
  }

  /**
   * Make an HTTP request and return the parsed JSON body, with a timeout.
   *
   * @param {string} url
   * @param {object} options fetch options
   * @param {number} timeout milliseconds
   * @returns {Promise<*>}
   * @private
   */
  async _request (url, options, timeout = this.defaultRequestTimeout) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(timeout) || this.defaultRequestTimeout)

    let res
    try {
      res = await fetch(url, { ...options, signal: controller.signal })
    } catch (e) {
      clearTimeout(timer)
      if (e.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeout}ms: ${url}`)
      }
      throw new Error(e.message || String(e))
    }
    clearTimeout(timer)

    const text = await res.text()

    if (!res.ok) {
      let message = `${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      try {
        const parsed = JSON.parse(text)
        if (parsed && Object.hasOwn(parsed, 'message')) {
          message = parsed.message
        } else if (parsed && Object.hasOwn(parsed, 'errors')) {
          message = JSON.stringify(parsed.errors)
        }
      } catch (e) {
        // Response body was not JSON — keep the generic status message.
      }
      throw new Error(message)
    }

    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error(text)
    }
  }
}

module.exports = { Api }
