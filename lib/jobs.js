const striptags = require('striptags')
const urlParse = require('url-parse')

class Jobs {
  constructor (logger) {
    this.logger = logger
  }

  /**
   * Create jobs list for screenshot worker.
   *
   * @param screenshotBaseUrl
   * @param project
   * @returns {[]}
   */
  prepareJobs (screenshotBaseUrl, project) {
    const urls = project.urls || []
    let projectBaseDomain = project.production || null
    const projectBaseDomainParsed = urlParse(projectBaseDomain, true)
    let breakpoints = project.breakpoints || []
    let uri
    let jobParams
    const jobs = []

    if (projectBaseDomainParsed.auth) {
      projectBaseDomain = projectBaseDomain.replace(projectBaseDomainParsed.auth + '@', '')
    }

    screenshotBaseUrl = this._rTrim(screenshotBaseUrl)
    // Screenshot urls.
    const screenshotUris = urls.map(url => {
      uri = url.replace(projectBaseDomain, '')
      uri = this._rTrim(uri)
      return uri
    })
    this.logger.log(screenshotUris.length + ' URLs', 'Screenshot')

    // Screenshot breakpoints.
    breakpoints = breakpoints.map(breakpoint => {
      return parseInt(breakpoint)
    })
    this.logger.log(breakpoints, 'Breakpoints ')

    // Screenshot args.
    const args = this._buildArgs(project, screenshotBaseUrl)

    this.logger.log(args, 'Args ')

    // Create jobs list.
    for (const screenshotUri of screenshotUris) {
      for (const breakpoint of breakpoints) {
        jobParams = {
          url: screenshotBaseUrl + screenshotUri,
          uri: (!screenshotUri.length) ? '/' : screenshotUri,
          base_url: screenshotBaseUrl, // We need base url for creating diff jobs.'base_url': screenshotBaseUrl, // We need base url for creating diff jobs.
          breakpoint,
          args
        }

        jobs.push({ params: jobParams })
      }
    }

    this.logger.log(jobs.length + ' jobs', 'Prepared')

    return jobs
  }

  /**
   * Build args for job.
   *
   * @param project
   * @param screenshotBaseUrl
   * @returns {{}}
   * @private
   */
  _buildArgs (project, screenshotBaseUrl) {
    const authArgs = this._getAuthArgs(project, screenshotBaseUrl)
    const advancedArgs = this._getAdvancedArgs(project)
    const modifyArgs = this._getModifyArgs(project)

    return { ...authArgs, ...advancedArgs, ...modifyArgs }
  }

  /**
   * Build auth args for job.
   *
   * @param project
   * @param screenshotBaseUrl
   * @private
   */
  _getAuthArgs (project, screenshotBaseUrl) {
    const authArgs = {}
    if (!project.hasOwnProperty('authenticate') || !project.authenticate.hasOwnProperty('enabled') || !project.authenticate.enabled) {
      return authArgs
    }

    const auth = project.authenticate
    const authType = (auth.hasOwnProperty('type')) ? auth.type : null

    authArgs.url = screenshotBaseUrl + '/' + this._lTrim(auth.loginURL)
    authArgs.usernameSelector = auth.usernameSelector
    authArgs.passwordSelector = auth.passwordSelector
    authArgs.submitSelector = auth.submitSelector
    authArgs.username = auth.username
    authArgs.password = auth.password

    if (auth.hasOwnProperty('clickElement') && auth.hasOwnProperty('clickElementSelector') && auth.clickElement) {
      authArgs.before_login_css = auth.clickElementSelector
    }

    switch (authType) {
      case 'auth0':
        authArgs.auth0 = true
        if (auth.hasOwnProperty('afterloginSelector') && auth.afterloginSelector.length) {
          authArgs.after_login_check_css = auth.afterloginSelector
        }
        break

      case 'drupal':
        authArgs.url = screenshotBaseUrl + '/user'
        authArgs.usernameSelector = '#edit-name'
        authArgs.passwordSelector = '#edit-pass'
        authArgs.submitSelector = '#edit-submit'
        break

      case 'wordpress':
        authArgs.url = screenshotBaseUrl + '/wp-login.php'
        authArgs.usernameSelector = '#user_login'
        authArgs.passwordSelector = '#user_pass'
        authArgs.submitSelector = '#wp-submit'
        break
    }
    return authArgs
  }

  /**
   * Build advanced args for job.
   *
   * @param project
   * @private
   */
  _getAdvancedArgs (project) {
    const advancedArgs = {}

    if (!project.hasOwnProperty('advanced') || !project.advanced) {
      return advancedArgs
    }

    const advanced = project.advanced

    // Delay before screenshot is taken.
    if (advanced.hasOwnProperty('psScreenshotDelay') && advanced.hasOwnProperty('psScreenshotDelaySec') &&
      advanced.psScreenshotDelay && advanced.psScreenshotDelaySec) {
      advancedArgs.delay_before_screenshot = advanced.psScreenshotDelaySec
    }

    // Scroll page.
    if (advanced.hasOwnProperty('psScreenshotScroll') && advanced.psScreenshotScroll) {
      advancedArgs.scroll_step = 40
      advancedArgs.scroll_step_delay = 200
    }

    // Add custom headers.
    if (advanced.hasOwnProperty('psScreenshotHeaders') && advanced.psScreenshotHeaders &&
      advanced.hasOwnProperty('psScreenshotHeadersList') && advanced.psScreenshotHeadersList.length) {
      advancedArgs.headers = advanced.psScreenshotHeadersList
    }

    // Add cookies.
    if (advanced.hasOwnProperty('psScreenshotCookies') && advanced.psScreenshotCookies &&
      advanced.hasOwnProperty('psScreenshotCookiesString') && advanced.psScreenshotCookiesString.trim().length) {
      advancedArgs.cookies = advanced.psScreenshotCookiesString.trim()
    }

    // Add javascript code.
    if (advanced.hasOwnProperty('psScreenshotJs') && advanced.psScreenshotJs &&
      advanced.hasOwnProperty('psScreenshotJsCode') && advanced.psScreenshotJsCode.trim().length) {
      advancedArgs.js_code = advanced.psScreenshotJsCode.trim()
    }

    // Add css code.
    if (advanced.hasOwnProperty('psScreenshotCss') && advanced.psScreenshotCss &&
      advanced.hasOwnProperty('psScreenshotCssCode') && advanced.psScreenshotCssCode.trim().length) {
      advancedArgs.css_code = advanced.psScreenshotCssCode.trim()
    }

    // Add Content fixtures.
    if (advanced.hasOwnProperty('psScreenshotFixtures') && advanced.psScreenshotFixtures &&
      advanced.hasOwnProperty('psScreenshotFixturesList') && advanced.psScreenshotFixturesList.length) {
      let type
      let selector
      let content
      for (const fixture of advanced.psScreenshotFixturesList) {
        type = (fixture.hasOwnProperty('type') && fixture.type.trim().length) ? fixture.type : null
        selector = (fixture.hasOwnProperty('selector') && fixture.selector.trim().length) ? fixture.selector : null

        if (type && selector) {
          switch (type) {
            case 'title':
              content = 'Nullam dapibus lobortis nunc, eu mattis orci ultrices eu.'
              break
            case 'paragraph':
              content = 'Ut tellus quam, auctor et tristique at, hendrerit ut nunc. Proin massa dolor, ullamcorper nec dolor eget, elementum iaculis dui. Aliquam erat volutpat. Pellentesque ac hendrerit neque. Nunc quis augue felis. In a nunc vel orci luctus ullamcorper.'
              break
            case 'large paragraph':
              content = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Curabitur at felis semper tortor sollicitudin pharetra. Suspendisse augue diam, porta eget nunc et, auctor vestibulum diam. Nam quis lorem at nibh cursus ultrices. Morbi in semper est. Sed condimentum libero velit, at eleifend ex dapibus sit amet. Donec vulputate diam ut rutrum venenatis. Donec sit amet nisl at nunc sodales molestie in pellentesque risus. Sed finibus, mi ac congue lacinia, ipsum felis gravida velit, sed tincidunt purus ante pellentesque neque. Mauris sollicitudin semper egestas. Donec ut tortor nibh. In semper lacus vel arcu sodales ultrices. Aenean in nisi ornare, convallis leo venenatis, finibus eros. Duis quis enim luctus, pharetra massa id, fringilla est. Cras in mi ac dui ultrices iaculis. Nulla facilisi. Phasellus et tortor mollis, accumsan nisl a, ornare elit.'
              break
            case 'image':
            default:
              content = ''
          }
          if (!advancedArgs.fixtures) {
            advancedArgs.fixtures = []
          }

          advancedArgs.fixtures.push({ type, selector, content })
        }
      }
    }

    return advancedArgs
  }

  /**
   * Build modify args for job.
   *
   * @param project
   * @private
   */
  _getModifyArgs (project) {
    const modifyArgs = {}
    let excludeElements
    let cutElements

    if (!project.hasOwnProperty('modify') || !project.modify) {
      return modifyArgs
    }

    const modify = project.modify

    // Crop.
    if (modify.hasOwnProperty('psScreenshotCrop') && modify.psScreenshotCrop.trim().length) {
      modifyArgs.crop = modify.psScreenshotCrop.trim()
    }

    // Exclude.
    if (modify.hasOwnProperty('psScreenshotExclude') && modify.psScreenshotExclude.trim().length) {
      excludeElements = striptags(modify.psScreenshotExclude)
      excludeElements = excludeElements.split('\n')
      excludeElements = excludeElements.map(e => e.trim())
      modifyArgs.elements = excludeElements
    }

    // Cut.
    if (modify.hasOwnProperty('psScreenshotCut') && modify.psScreenshotCut.trim().length) {
      cutElements = striptags(modify.psScreenshotCut)
      cutElements = cutElements.split('\n')
      cutElements = cutElements.map(e => e.trim())
      modifyArgs.cut_elements = cutElements
    }

    return modifyArgs
  }

  /**
   * Left trim slash.
   *
   * @param str
   * @returns {*}
   * @private
   */
  _lTrim (str) {
    return str.replace(/^\/*/, '')
  }

  /**
   * Right trim slash.
   *
   * @param str
   * @returns {*}
   * @private
   */
  _rTrim (str) {
    return str.replace(/\/*$/, '')
  }
}

module.exports = { Jobs }
