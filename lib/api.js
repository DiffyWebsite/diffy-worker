const request = require('request');
const fs = require('fs-extra');
const axios = require('axios');
const FormData = require('form-data');

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
      this.logger.info('Login', body)
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
      this.logger.info('Get project', project)
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

  async uploadScreenshots(snapshotName, results) {
    const createUrl = `${this.diffyUrl}/projects/${this.projectId}/create-custom-snapshot?Xlogger_SESSION_START=PHPSTORM`;
    const CHUNK_SIZE = 5;

    const totalChunks = Math.ceil(results.length / CHUNK_SIZE);
    let snapshotId = null;

    for (let i = 0; i < results.length; i += CHUNK_SIZE) {
      const chunk = results.slice(i, i + CHUNK_SIZE);
      const formData = new FormData;

      chunk.forEach((item, originalIndex) => {
        try {
          formData.append(`urls[${originalIndex}]`, item.uri);
          formData.append(`breakpoints[${originalIndex}]`, item.breakpoint);

          formData.append(`files[${originalIndex}]`, fs.createReadStream(item.filename));
          formData.append(`htmlFiles[${originalIndex}]`, fs.createReadStream(item.htmlFilename));
          formData.append(`jsConsoleFiles[${originalIndex}]`, fs.createReadStream(item.jsConsoleFilename));
        } catch (err) {
          console.warn(`Error processing file at index ${originalIndex}:`, err.message);
        }
      });

      formData.append('snapshotName', snapshotName);
      if (snapshotId) {
        formData.append('snapshotId', snapshotId);
      }

      console.log(`Uploading chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${totalChunks}`);
      await new Promise(resolve => setTimeout(resolve, 3000));

      snapshotId = await this._makePostRequest(
          createUrl,
          formData,
          true,
          true,
          this.uploadScreenshotTimeout
      );
    }

    return snapshotId;
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
  async _makePostRequest(url, postBody, useAuth = false, multipartFormData = false, timeout = this.defaultRequestTimeout) {
    if (multipartFormData && typeof postBody.getHeaders === 'function') {
      return new Promise((resolve, reject) => {
        postBody.getLength((err, length) => {
          const headers = postBody.getHeaders(
              typeof length === 'number' ? { 'Content-Length': length } : {}
          );

          if (useAuth) {
            headers['Authorization'] = `Bearer ${this.token}`;
          }

          const req = request.post({ url, headers, timeout }, (err, res, body) => {
            if (err) return reject(err);
            try {
              return resolve(JSON.parse(body));
            } catch {
              return resolve(body);
            }
          });

          postBody.pipe(req);
        });
      });
    }

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (useAuth) headers['Authorization'] = `Bearer ${this.token}`;

      const response = await axios.post(url, postBody, { headers, timeout });
      return response.data;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = { Api }
