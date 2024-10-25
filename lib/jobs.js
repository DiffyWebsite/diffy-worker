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
    this.logger.log(`Screenshot ${screenshotUris.length} URLs`)

    // Screenshot breakpoints.
    breakpoints = breakpoints.map(breakpoint => {
      return parseInt(breakpoint)
    })
    this.logger.log('Breakpoints', breakpoints)

    // Screenshot args.
    const args = this._buildArgs(project, screenshotBaseUrl)

    this.logger.log('Args', args)

    // Create jobs list.
    for (const screenshotUri of screenshotUris) {
      for (const breakpoint of breakpoints) {
        const jobParams = {
          url: screenshotBaseUrl + screenshotUri,
          uri: (!screenshotUri.length) ? '/' : screenshotUri,
          base_url: screenshotBaseUrl, // We need base url for creating diff jobs.'base_url': screenshotBaseUrl, // We need base url for creating diff jobs.
          breakpoint,
          args
        }

        jobs.push({ params: jobParams })
      }
    }

    this.logger.log(`Prepared ${jobs.length} jobs`)

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
    if (!Object.hasOwn(project, 'authenticate') || !Object.hasOwn(project.authenticate, 'enabled') || !project.authenticate.enabled) {
      return authArgs
    }

    const auth = project.authenticate
    const authType = (Object.hasOwn(auth, 'type')) ? auth.type : null

    authArgs.url = screenshotBaseUrl + '/' + this._lTrim(auth.loginURL)
    authArgs.usernameSelector = auth.usernameSelector
    authArgs.passwordSelector = auth.passwordSelector
    authArgs.submitSelector = auth.submitSelector
    authArgs.username = auth.username
    authArgs.password = auth.password

    if (Object.hasOwn(auth, 'clickElement') && Object.hasOwn(auth, 'clickElementSelector') && auth.clickElement) {
      authArgs.before_login_css = auth.clickElementSelector
    }

    switch (authType) {
      case 'auth0':
        authArgs.auth0 = true
        if (Object.hasOwn(auth, 'afterloginSelector') && auth.afterloginSelector.length) {
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

    if (!Object.hasOwn(project, 'advanced') || !project.advanced) {
      return advancedArgs
    }

    const advanced = project.advanced

    // Delay before screenshot is taken.
    if (Object.hasOwn(advanced, 'psScreenshotDelay') && Object.hasOwn(advanced, 'psScreenshotDelaySec') &&
      advanced.psScreenshotDelay && advanced.psScreenshotDelaySec) {
      advancedArgs.delay_before_screenshot = advanced.psScreenshotDelaySec
    }

    // Add stabilization
    if (advanced.hasOwnProperty('psHeightStabilization') && advanced.psHeightStabilization) {
      advancedArgs.stabilization = true;
      advancedArgs.stabilization_code = advanced.stabilization_code;
    }

    // Scroll page.
    if (Object.hasOwn(advanced, 'psScreenshotScroll') && advanced.psScreenshotScroll) {
      advancedArgs.scroll_step = 40
      advancedArgs.scroll_step_delay = 200
    }

    // Add custom headers.
    if (Object.hasOwn(advanced, 'psScreenshotHeaders') && advanced.psScreenshotHeaders &&
      Object.hasOwn(advanced, 'psScreenshotHeadersList') && advanced.psScreenshotHeadersList.length) {
      advancedArgs.headers = advanced.psScreenshotHeadersList
    }

    // Add cookies.
    if (Object.hasOwn(advanced, 'psScreenshotCookies') && advanced.psScreenshotCookies &&
      Object.hasOwn(advanced, 'psScreenshotCookiesString') && advanced.psScreenshotCookiesString.trim().length) {
      advancedArgs.cookies = advanced.psScreenshotCookiesString.trim()
    }

    // Add javascript code.
    if (Object.hasOwn(advanced, 'psScreenshotJs') && advanced.psScreenshotJs &&
      Object.hasOwn(advanced, 'psScreenshotJsCode') && advanced.psScreenshotJsCode.trim().length) {
      advancedArgs.js_code = advanced.psScreenshotJsCode.trim()
    }

    // Add css code.
    if (Object.hasOwn(advanced, 'psScreenshotCss') && advanced.psScreenshotCss &&
      Object.hasOwn(advanced, 'psScreenshotCssCode') && advanced.psScreenshotCssCode.trim().length) {
      advancedArgs.css_code = advanced.psScreenshotCssCode.trim()
    }

    // Add Content fixtures.
    if (Object.hasOwn(advanced, 'psScreenshotFixtures') && advanced.psScreenshotFixtures &&
      Object.hasOwn(advanced, 'psScreenshotFixturesList') && advanced.psScreenshotFixturesList.length) {
      let type
      let selector
      let content
      for (const fixture of advanced.psScreenshotFixturesList) {
        type = (Object.hasOwn(fixture, 'type') && fixture.type.trim().length) ? fixture.type : null
        selector = (Object.hasOwn(fixture, 'selector') && fixture.selector.trim().length) ? fixture.selector : null

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

    if (!Object.hasOwn(project, 'modify') || !project.modify) {
      return modifyArgs
    }

    const modify = project.modify

    // Crop.
    if (Object.hasOwn(modify, 'psScreenshotCrop') && modify.psScreenshotCrop.trim().length) {
      modifyArgs.crop = modify.psScreenshotCrop.trim()
    }

    // Exclude.
    if (Object.hasOwn(modify, 'psScreenshotExclude') && modify.psScreenshotExclude.trim().length) {
      excludeElements = striptags(modify.psScreenshotExclude)
      excludeElements = excludeElements.split('\n')
      excludeElements = excludeElements.map(e => e.trim())
      modifyArgs.elements = excludeElements
    }

    // Cut.
    if (Object.hasOwn(modify, 'psScreenshotCut') && modify.psScreenshotCut.trim().length) {
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
