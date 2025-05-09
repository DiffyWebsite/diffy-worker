const request = require('request')
const fs = require('fs-extra')

class Api {
  constructor (diffyUrl, apiKey, projectId, logger) {
    this.logger = logger
    this.diffyUrl = diffyUrl
    this.apiKey = apiKey
    this.projectId = projectId
    this.token = ''
    this.uploadScreenshotTimeout = (process.env.UPLOAD_SCREENSHOT_TIMEOUT && process.env.UPLOAD_SCREENSHOT_TIMEOUT.length) ? process.env.UPLOAD_SCREENSHOT_TIMEOUT : 600000
    this.defaultRequestTimeout = (process.env.DEFAULT_REQUEST_TIMEOUT && process.env.DEFAULT_REQUEST_TIMEOUT.length) ? process.env.DEFAULT_REQUEST_TIMEOUT : 30000
  }

  /**
   * Api login action.
   *
   * @returns {Promise<*>}
   */
  async login () {
    const url = `${this.diffyUrl}/auth/key`
    let body
    try {
      body = await this._makePostRequest(url, { key: this.apiKey })

      this.logger.debug('Login', { body })

      if (body && Object.hasOwn(body,'token')) {
        this.token = body.token
        return body.token
      } else {
        throw new Error('Can\'t login')
      }
    } catch (e) {
      if (!Object.hasOwn(e,'message')) {
        throw new Error(JSON.stringify(e))
      } else {
        throw new Error(e.message)
      }
    }
  }

  /**
   * Api get project settings action.
   *
   * @returns {Promise<{name}|*>}
   */
  async getProject () {
    const url = `${this.diffyUrl}/projects/${this.projectId}`
    let project
    try {
      project = await this._makeGetRequest(url)

      this.logger.debug('Get project', { project })

      if (project && Object.hasOwn(project, 'name')) {
        return project
      } else {
        throw new Error('Can\'t get project')
      }
    } catch (e) {
      if (!Object.hasOwn(e, 'message')) {
        throw new Error(JSON.stringify(e))
      } else {
        throw new Error(e.message)
      }
    }
  }

  async uploadScreenshots (snapshotName, results) {
    const url = `${this.diffyUrl}/projects/${this.projectId}/create-custom-snapshot?Xlogger_SESSION_START=PHPSTORM`
    const formData = {
      snapshotName
    }

    results.forEach((item, i) => {
      formData['urls[' + i + ']'] = item.uri
      formData['breakpoints[' + i + ']'] = item.breakpoint
      formData['files[' + i + ']'] = fs.createReadStream(item.filename)
      formData['htmlFiles[' + i + ']'] = fs.createReadStream(item.htmlFilename)
      formData['jsConsoleFiles[' + i + ']'] = fs.createReadStream(item.jsConsoleFilename)
    })

    this.logger.debug(`Files: ${results.length} - Sending screenshot to Diffy`)

    const screenshotId = await this._makePostRequest(url, formData, true, true, this.uploadScreenshotTimeout)

    this.logger.debug(`Saved screenshot id: ${screenshotId}`)

    return screenshotId
  }

  /**
   * Make GET request.
   *
   * @param url
   * @returns {Promise<unknown>}
   * @private
   */
  async _makeGetRequest (url, timeout = this.defaultRequestTimeout) {
    const options = {
      url,
      timeout,
      headers: {
        'Content-Type': 'application/json'
      },
      auth: {
        bearer: this.token
      }
    }

    return new Promise((resolve, reject) => {
      request.get(options, function (err, res, body) {
        if (err) {
          return reject(err)
        }

        if (!res || !Object.hasOwn(res, 'statusCode')) {
          return reject(new Error('Can\'t resolve GET request'))
        }

        if (res.statusCode !== 200) {
          try {
            const result = JSON.parse(body)
            if (Object.hasOwn(result, 'message') && Object.hasOwn(result, 'code')) {
              return reject(result)
            }
            if (Object.hasOwn(result, 'errors')) {
              return reject(result.errors)
            } else {
              return reject(res.statusMessage)
            }
          } catch (e) {
            return reject(res.statusMessage)
          }
        }

        try {
          const result = JSON.parse(body)
          return resolve(result)
        } catch (e) {
          return reject(body)
        }
      })
    })
  }

  /**
   * Make POST request.
   *
   * @param url
   * @param postBody
   * @returns {Promise<unknown>}
   * @private
   */
  async _makePostRequest (url, postBody, useAuth = false, multipartFormData = false, timeout = this.defaultRequestTimeout) {
    const options = {
      url,
      timeout,
      headers: {
        'Content-Type': (multipartFormData) ? 'multipart/form-data' : 'application/json'
      }
    }

    if (multipartFormData) {
      options.formData = postBody
    } else {
      options.body = JSON.stringify(postBody)
    }

    if (useAuth) {
      options.auth = {
        bearer: this.token
      }
    }

    return new Promise((resolve, reject) => {
      request.post(options, function (err, res, body) {
        if (err) {
          return reject(err)
        }

        if (!res || !Object.hasOwn(res, 'statusCode')) {
          return reject(new Error('Can\'t resolve POST request'))
        }

        if (res.statusCode !== 200) {
          try {
            const result = JSON.parse(body)
            if (Object.hasOwn(result, 'message') && Object.hasOwn(result, 'code')) {
              return reject(new Error(result.message))
            } else {
              return reject(new Error(body))
            }
          } catch (e) {
            return reject(new Error(res.statusMessage + ' => ' + e.message))
          }
        }

        try {
          const result = JSON.parse(body)
          return resolve(result)
        } catch (e) {
          return reject(new Error(body))
        }
      })
    })
  }
}

module.exports = { Api }
