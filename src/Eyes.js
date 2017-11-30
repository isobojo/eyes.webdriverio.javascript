'use strict';

const {
  ContextBasedScaleProviderFactory,
  CoordinatesType,
  DiffsFoundError,
  EyesBase,
  FailureReports,
  FixedScaleProviderFactory,
  NewTestError,
  Location,
  NullCutProvider,
  NullScaleProvider,
  NullRegionProvider,
  ScaleProviderIdentityFactory,
  RectangleSize,
  Region,
  RegionProvider,
  TestFailedError,
  TestResultsStatus,
  UserAgent
} = require('eyes.sdk');
const {
  ArgumentGuard,
  SimplePropertyHandler
} = require('eyes.utils');

const ImageProviderFactory = require('./capture/ImageProviderFactory');
const CssTranslatePositionProvider = require('./positioning/CssTranslatePositionProvider');
const ScrollPositionProvider = require('./positioning/ScrollPositionProvider');
const RegionPositionCompensationFactory = require('./positioning/RegionPositionCompensationFactory');
const EyesWebDriver = require('./wrappers/EyesWebDriver');
const EyesWebElement = require('./wrappers/EyesWebElement');
const EyesWDIOScreenshot = require('./capture/EyesWDIOScreenshot');
const Frame = require('./frames/Frame');
const FrameChain = require('./frames/FrameChain');
const FullPageCaptureAlgorithm = require('./capture/FullPageCaptureAlgorithm');
const EyesWDIOScreenshotFactory = require('./capture/EyesWDIOScreenshotFactory');
const EyesWDIOUtils = require('./EyesWDIOUtils');
const ElementPositionProvider = require('./positioning/ElementPositionProvider');
const StitchMode = require('./StitchMode');
const Target = require('./fluent/Target');
const WDIOJSExecutor = require('./WDIOJSExecutor');

const VERSION = require('../package.json').version;


const DEFAULT_STITCHING_OVERLAP = 50; // px
const DEFAULT_WAIT_BEFORE_SCREENSHOTS = 100; // Milliseconds
const DEFAULT_WAIT_SCROLL_STABILIZATION = 200; // Milliseconds


class Eyes extends EyesBase {

  static get UNKNOWN_DEVICE_PIXEL_RATIO() {
    return 0;
  }

  static get DEFAULT_DEVICE_PIXEL_RATIO() {
    return 1;
  }


  /**
   * Creates a new (possibly disabled) Eyes instance that interacts with the Eyes Server at the specified url.
   *
   * @param {String} [serverUrl=EyesBase.DEFAULT_EYES_SERVER] The Eyes server URL.
   * @param {Boolean} [isDisabled=false] Set to true to disable Applitools Eyes and use the webdriver directly.
   * @param {PromiseFactory} [promiseFactory] If not specified will be created using `Promise` object
   **/
  constructor(serverUrl = EyesBase.DEFAULT_EYES_SERVER, isDisabled = false, promiseFactory) {
    super(serverUrl, isDisabled, promiseFactory);

    /** @type {EyesWebDriver} */
    this._driver = undefined;
    /** @type {boolean} */
    this._forceFullPageScreenshot = false;
    this._imageRotationDegrees = 0;
    this._automaticRotation = true;
    /** @type {boolean} */
    this._isLandscape = false;
    this._hideScrollbars = null;
    /** @type {boolean} */
    this._checkFrameOrElement = false;
    /** @type {EyesJsExecutor} */
    this._jsExecutor = undefined;
    this._rotation = undefined;
    /** @type {StitchMode} */
    this._stitchMode = StitchMode.SCROLL;
    /** @type {ImageProvider} */
    this._imageProvider = undefined;
    /** @type {RegionPositionCompensation} */
    this._regionPositionCompensation = undefined;
    /** @type {number} */
    this._devicePixelRatio = Eyes.UNKNOWN_DEVICE_PIXEL_RATIO;
    /** @type {Region} */
    this._regionToCheck = null;
    /** @type {EyesWebElement} */
    this._targetElement = null;
    /** @type {ElementPositionProvider} */
    this._elementPositionProvider = undefined;
    /** @type {int} */
    this._waitBeforeScreenshots = DEFAULT_WAIT_BEFORE_SCREENSHOTS;
    /** @type {int} */
    this._stitchingOverlap = DEFAULT_STITCHING_OVERLAP;
  }


  // noinspection JSUnusedGlobalSymbols
  /**
   *
   * @param {Object} driver
   * @param {String} appName
   * @param {String} testName
   * @param {RectangleSize|{width: number, height: number}} viewportSize
   * @returns {Promise.<*>}
   */
  async open(driver, appName, testName, viewportSize = null, sessionType = null) {
    ArgumentGuard.notNull(driver, 'driver');

    this.getPromiseFactory().setFactoryMethod(asyncAction => {
      return driver.call(() => {
        return new Promise(asyncAction);
      });
    }, null);

    this._logger.verbose('Running using Webdriverio module');

    if (this._isDisabled) {
      this._logger.verbose('Ignored');
      return this.getPromiseFactory().resolve(driver);
    }

    this._driver = new EyesWebDriver(driver, this, this._logger);

    const userAgentString = await this._driver.getUserAgent();
    if (userAgentString) {
      this._userAgent = UserAgent.parseUserAgentString(userAgentString, true);
    }

    this._imageProvider = ImageProviderFactory.getImageProvider(this._userAgent, this, this._logger, this._driver);
    this._regionPositionCompensation = RegionPositionCompensationFactory.getRegionPositionCompensation(this._userAgent, this, this._logger);

    this._jsExecutor = new WDIOJSExecutor(this._driver);

    await this.openBase(appName, testName, viewportSize, sessionType);

    this._devicePixelRatio = Eyes.UNKNOWN_DEVICE_PIXEL_RATIO;

    this._initPositionProvider();

    this._driver.rotation = this._rotation;

    return this._driver;
  }


  async close(throwEx = true) {
    try {
      const results = await super.close.call(this, false);
      const status = results.getStatus();
      if (throwEx && status !== TestResultsStatus.Passed) {
        const status = results.getStatus();
        const sessionResultsUrl = results.getUrl();
        if (status === TestResultsStatus.Unresolved) {
          if (results.getIsNew()) {
            const instructions = 'Please approve the new baseline at ' + sessionResultsUrl;
            const message = `'${this._sessionStartInfo.getScenarioIdOrName()}' of '${this._sessionStartInfo.getAppIdOrName()}'. ${instructions}`;
            return Promise.reject(new NewTestError(results, message));
          } else {
            const instructions = `See details at ${sessionResultsUrl}`;
            const message = `Test '${this._sessionStartInfo.getScenarioIdOrName()}' of '${this._sessionStartInfo.getAppIdOrName()} detected differences!'. ${instructions}`;
            return Promise.reject(new DiffsFoundError(results, message));
          }
        } else if (status === TestResultsStatus.Failed) {
          const instructions = `See details at ${sessionResultsUrl}`;
          const message = `'${this._sessionStartInfo.getScenarioIdOrName()}' of '${this._sessionStartInfo.getAppIdOrName()}'. ${instructions}`;
          return Promise.reject(new TestFailedError(results, message));
        }
      } else {
        return Promise.resolve(results);
      }
    } catch (e) {
      console.error(e);
    }
  }


  checkWindow(tag, matchTimeout) {
    return this.check(tag, Target.window().timeout(matchTimeout));
  }


  /**
   *
   * @param {By} selector
   * @param matchTimeout
   * @param tag
   * @returns {Promise.<*>}
   */
  checkElementBySelector(selector, matchTimeout, tag) {
    return this.check(tag, Target.region(selector).timeout(matchTimeout).fully());
  }

  /**
   *
   * @param name
   * @param {WebdriverioCheckSettings} checkSettings
   * @returns {Promise.<*>}
   */
  async check(name, checkSettings) {
    ArgumentGuard.notNull(checkSettings, 'checkSettings');

    let result;

    let switchedToFrameCount;
    try {
      this._logger.verbose(`check("${name}", checkSettings) - begin`);
      this._stitchContent = checkSettings.getStitchContent();
      const targetRegion = checkSettings.getTargetRegion();


      switchedToFrameCount = await this._switchToFrame(checkSettings);
      this._regionToCheck = null;

      if (targetRegion) {
        result = await super.checkWindowBase(new RegionProvider(targetRegion, this.getPromiseFactory()), name, false, checkSettings);
      }

      if (checkSettings) {
        const targetSelector = checkSettings.targetSelector;
        let targetElement = checkSettings.targetElement;
        if (!targetElement && targetSelector) {
          targetElement = await this._driver.findElement(targetSelector);
        }

        if (targetElement) {
          this._targetElement = targetElement instanceof EyesWebElement ? targetElement : new EyesWebElement(this._logger, this._driver, targetElement);
          if (this._stitchContent) {
            result = await this._checkElement(name, checkSettings);
          } else {
            result = await this._checkRegion(name, checkSettings);
          }
        } else if (checkSettings.frameChain.length > 0) {
          if (this._stitchContent) {
            result = await this._checkFullFrameOrElement(name, checkSettings);
          } else {
            result = await this._checkFrameFluent(name, checkSettings);
          }
        } else {
          result = await super.checkWindowBase(new NullRegionProvider(this.getPromiseFactory()), name, false, checkSettings);
        }
      }

      return result;
      /*
            if (targetRegion) {
              return super.checkWindowBase(new RegionProvider(targetRegion, this.getPromiseFactory()), name, false, checkSettings);
            }
            if (checkSettings) {
              const targetSelector = checkSettings.targetSelector;
              let targetElement = checkSettings.targetElement;
              if (!targetElement && targetSelector) {
                targetElement = await this._driver.findElement(targetSelector);
              }

              if (targetElement) {
                this._targetElement = targetElement instanceof EyesWebElement ? targetElement : new EyesWebElement(this._logger, this._driver, targetElement);
                if (this._stitchContent) {
                  return this._checkElement(name, checkSettings);
                } else {
                  return this._checkRegion(name, checkSettings);
                }
              } else if (checkSettings.frameChain.length > 0) {
                if (this._stitchContent) {
                  return this._checkFullFrameOrElement(name, checkSettings);
                } else {
                  return this._checkFrameFluent(name, checkSettings);
                }
              } else {
                return super.checkWindowBase(new NullRegionProvider(this.getPromiseFactory()), name, false, checkSettings);
              }

            }
      */
    } finally {
      this._targetElement = null;
      await this._switchToParentFrame(switchedToFrameCount);
      this._stitchContent = false;
      this._logger.verbose('check - done!');
    }
  }


  /**
   * @private
   * @return {Promise}
   */
  async _checkRegion(name, checkSettings) {
    const that = this;

    const RegionProviderImpl = class RegionProviderImpl extends RegionProvider {
      // noinspection JSUnusedGlobalSymbols
      /** @override */
      async getRegion() {
        const p = await that._targetElement.getLocation();
        const d = await that._targetElement.getSize();
        return new Region(Math.ceil(p.x), Math.ceil(p.y), d.getWidth(), d.getHeight(), CoordinatesType.CONTEXT_RELATIVE);
      }
    };

    try {
      return super.checkWindowBase(new RegionProviderImpl(), name, false, checkSettings);
    } finally {
      this._logger.verbose("Done! trying to scroll back to original position..");
    }
  }


  /**
   * @private
   * @return {Promise}
   */
  async _checkElement(name, checkSettings) {
    const eyesElement = this._targetElement;
    const originalPositionProvider = this._positionProvider;
    const scrollPositionProvider = new ScrollPositionProvider(this._logger, this._jsExecutor);

    let originalScrollPosition, originalOverflow, error;
    originalScrollPosition = await scrollPositionProvider.getCurrentPosition();
    const pl = await eyesElement.getLocation();

    try {
      this._checkFrameOrElement = true;

      let elementLocation, elementSize;
      const displayStyle = await eyesElement.getComputedStyle('display');
      if (displayStyle !== 'inline') {
        this._elementPositionProvider = new ElementPositionProvider(this._logger, this._driver, eyesElement);
      }
      originalOverflow = await eyesElement.getOverflow();

      // Set overflow to "hidden".
      await eyesElement.setOverflow('hidden');

      const elementWidth = await eyesElement.getClientWidth();
      const elementHeight = await eyesElement.getClientHeight();
      elementSize = new RectangleSize(elementWidth, elementHeight);

      const borderLeftWidth = await eyesElement.getComputedStyleInteger("border-left-width");
      const borderTopWidth = await eyesElement.getComputedStyleInteger("border-top-width");
      elementLocation = new Location(pl.x + borderLeftWidth, pl.y + borderTopWidth);

      const elementRegion = new Region(elementLocation, elementSize, CoordinatesType.CONTEXT_RELATIVE);

      this._logger.verbose("Element region: " + elementRegion);

      this._logger.verbose("replacing regionToCheck");
      this._regionToCheck = elementRegion;

      await super.checkWindowBase(new NullRegionProvider(this.getPromiseFactory()), name, false, checkSettings);
    } catch (e) {
      error = e;
    } finally {


      if (originalOverflow) {
        await eyesElement.setOverflow(originalOverflow);
      }

      this._checkFrameOrElement = false;
      this._positionProvider = originalPositionProvider;
      this._regionToCheck = null;
      this._elementPositionProvider = null;

      await scrollPositionProvider.setPosition(originalScrollPosition);

      if (error) {
        // noinspection ThrowInsideFinallyBlockJS
        throw error;
      }
    }
  }


  /**
   * @private
   * @return {Promise}
   */
  _checkFullFrameOrElement(name, checkSettings) {
    this._checkFrameOrElement = true;

    const that = this;
    this._logger.verbose("checkFullFrameOrElement()");

    const RegionProviderImpl = class RegionProviderImpl extends RegionProvider {
      // noinspection JSUnusedGlobalSymbols
      /** @override */
      getRegion() {
        if (that._checkFrameOrElement) {
          return that._ensureFrameVisible().then(fc => {
            // FIXME - Scaling should be handled in a single place instead
            // noinspection JSUnresolvedFunction
            return that._updateScalingParams().then(scaleProviderFactory => {
              let screenshotImage;
              return that._imageProvider.getImage().then(screenshotImage_ => {
                screenshotImage = screenshotImage_;
                return that._debugScreenshotsProvider.save(screenshotImage_, "checkFullFrameOrElement");
              }).then(() => {
                const scaleProvider = scaleProviderFactory.getScaleProvider(screenshotImage.getWidth());
                // TODO: do we need to scale image?
                return screenshotImage.scale(scaleProvider.getScaleRatio());
              }).then(screenshotImage_ => {
                screenshotImage = screenshotImage_;
                const switchTo = that._driver.switchTo();
                return switchTo.frames(fc);
              }).then(() => {
                const screenshot = new EyesWDIOScreenshot(that._logger, that._driver, screenshotImage, that.getPromiseFactory());
                return screenshot.init();
              }).then(screenshot => {
                that._logger.verbose("replacing regionToCheck");
                that.regionToCheck = screenshot.getFrameWindow();
              });
            });
          });
        }

        return that.getPromiseFactory().resolve(Region.EMPTY);
      }
    };

    return super.checkWindowBase(new RegionProviderImpl(), name, false, checkSettings).then(() => {
      that._checkFrameOrElement = false;
    });
  }


  /**
   * @private
   * @return {Promise}
   */
  async _checkFrameFluent(name, checkSettings) {
    try {
      const frameChain = new FrameChain(this._logger, this._driver.getFrameChain());
      const targetFrame = frameChain.pop();
      this._targetElement = targetFrame.reference;

      await this._driver.switchTo().framesDoScroll(frameChain);
      return this._checkRegion(name, checkSettings);
    } finally {
      this._targetElement = null;
    }
  }


  /**
   * @private
   * @return {Promise.<int>}
   */
  async _switchToParentFrame(switchedToFrameCount) {
    if (switchedToFrameCount > 0) {
      await this._driver.switchTo().parentFrame();
      switchedToFrameCount--;
      return this._switchToParentFrame(switchedToFrameCount);
    }

    return this.getPromiseFactory().resolve();
  }

  /**
   * @private
   * @return {Promise.<int>}
   */
  async _switchToFrame(checkSettings) {
    if (!checkSettings) {
      return this.getPromiseFactory().resolve(0);
    }

    const frameChain = checkSettings.frameChain;
    let switchedToFrameCount = 0;
    frameChain.reduce(async (promise, frameLocator) => {
      await promise;
      const isSuccess = await this._switchToFrameLocator(frameLocator);
      if (isSuccess) {
        switchedToFrameCount++;
      }
      return switchedToFrameCount;
    }, this.getPromiseFactory().resolve());
  }


  /**
   * @private
   * @return {Promise.<boolean>}
   */
  _switchToFrameLocator(frameLocator) {
    const switchTo = this._driver.switchTo();

    if (frameLocator.getFrameIndex()) {
      return switchTo.frame(frameLocator.getFrameIndex()).then(() => true);
    }

    if (frameLocator.getFrameNameOrId()) {
      return switchTo.frame(frameLocator.getFrameNameOrId()).then(() => true);
    }

    if (frameLocator.getFrameSelector()) {
      const frameElement = this._driver.findElement(frameLocator.getFrameSelector());
      if (frameElement) {
        return switchTo.frame(frameElement).then(() => true);
      }
    }

    return this.getPromiseFactory().resolve(false);
  }


  /**
   *
   * @return {Promise.RectangleSize} The viewport size of the current context, or the display size if the viewport size cannot be retrieved.
   */
  getViewportSize() {
    return EyesWDIOUtils.getViewportSizeOrDisplaySize(this._logger, this.jsExecutor);
  }


  /**
   *
   * @param {By} locator
   * @returns {Region}
   */
  async getRegionByLocator(locator) {
    const element = await this._driver.findElement(locator);

    let elementSize = await element.getSize();
    let point = await element.getLocation();

    return new Region(point.x, point.y, elementSize.width, elementSize.height);
  };


  // noinspection JSUnusedGlobalSymbols
  /**
   *
   * @param {StitchMode} mode
   */
  set stitchMode(mode) {
    this._logger.verbose(`setting stitch mode to ${mode}`);
    this._stitchMode = mode;
    if (this._driver) {
      this._initPositionProvider();
    }
  };


  /** @private */
  _initPositionProvider() {
    // Setting the correct position provider.
    const stitchMode = this.stitchMode;
    this._logger.verbose(`initializing position provider. stitchMode: ${stitchMode}`);
    switch (stitchMode) {
      case StitchMode.CSS:
        this.setPositionProvider(new CssTranslatePositionProvider(this._logger, this._jsExecutor));
        break;
      default:
        this.setPositionProvider(new ScrollPositionProvider(this._logger, this._jsExecutor));
    }
  }


  /**
   * Get the stitch mode.
   * @return {StitchMode} The currently set StitchMode.
   */
  get stitchMode() {
    return this._stitchMode;
  };


  /**
   * Get jsExecutor
   * @return {EyesJsExecutor}
   */
  get jsExecutor() {
    return this._jsExecutor;
  }


  // noinspection JSUnusedGlobalSymbols
  /**
   *
   * @returns {Promise.<EyesWDIOScreenshot>}
   * @override
   */
  async getScreenshot() {
    const scaleProviderFactory = await this.updateScalingParams();


    let originalOverflow;
    if (this._hideScrollbars) {
      try {
        originalOverflow = EyesWDIOUtils.hideScrollbars(this.jsExecutor, DEFAULT_WAIT_SCROLL_STABILIZATION);
      } catch (e) {
        this._logger.verbose('WARNING: Failed to hide scrollbars! Error: ', e);
      }
    }

    let result;
    try {
      const screenshotFactory = new EyesWDIOScreenshotFactory(this._logger, this._driver, this.getPromiseFactory());

      const originalFrameChain = new FrameChain(this._logger, this._driver.frameChain);
      const algo = new FullPageCaptureAlgorithm(this._logger, this._userAgent, this.getPromiseFactory());
      const switchTo = this._driver.switchTo();

      if (this._checkFrameOrElement) {
        this._logger.verbose("Check frame/element requested");

        await switchTo.framesDoScroll(originalFrameChain);

        const entireFrameOrElement = await algo.getStitchedRegion(
          this._imageProvider, this._regionToCheck, this._positionProvider,
          this.getElementPositionProvider(), scaleProviderFactory, this._cutProviderHandler.get(),
          this.getWaitBeforeScreenshots(), this._debugScreenshotsProvider, screenshotFactory,
          this.getStitchOverlap(), this._regionPositionCompensation
        );

        this._logger.verbose("Building screenshot object...");
        let screenshot = new EyesWDIOScreenshot(this._logger, this._driver, entireFrameOrElement, this.getPromiseFactory());
        result = await screenshot.initFromFrameSize(new RectangleSize(entireFrameOrElement.getWidth(), entireFrameOrElement.getHeight()));
      } else if (this._forceFullPageScreenshot || this._stitchContent) {
        this._logger.verbose("Full page screenshot requested.");

        // Save the current frame path.
        const originalFramePosition = originalFrameChain.size() > 0 ? originalFrameChain.getDefaultContentScrollPosition() : new Location(0, 0);

        await switchTo.defaultContent();

        const fullPageImage = await algo.getStitchedRegion(
          this._imageProvider, Region.EMPTY, new ScrollPositionProvider(this._logger, this._jsExecutor),
          this._positionProvider, scaleProviderFactory, this._cutProviderHandler.get(), this.getWaitBeforeScreenshots(),
          this._debugScreenshotsProvider, screenshotFactory, this.getStitchOverlap(), this._regionPositionCompensation);

        await switchTo.frames(originalFrameChain);
        const screenshot = new EyesWDIOScreenshot(this._logger, this._driver, fullPageImage, this.getPromiseFactory());
        result = screenshot.init(null, originalFramePosition);
      } else {
        await this._ensureElementVisible(this.targetElement);

        this._logger.verbose("Screenshot requested...");
        let screenshotImage = await this._imageProvider.getImage();
        await this._debugScreenshotsProvider.save(screenshotImage, "original");

        const scaleProvider = scaleProviderFactory.getScaleProvider(screenshotImage.getWidth());
        if (scaleProvider.getScaleRatio() !== 1) {
          this._logger.verbose("scaling...");
          const screenshotImage = await screenshotImage.scale(scaleProvider.getScaleRatio());
          return this._debugScreenshotsProvider.save(screenshotImage, "scaled");
        }

        const cutProvider = this._cutProviderHandler.get();
        if (!(cutProvider instanceof NullCutProvider)) {
          this._logger.verbose("cutting...");
          const screenshotImage = await cutProvider.cut(screenshotImage);
          return this._debugScreenshotsProvider.save(screenshotImage, "cut");
        }

        this._logger.verbose("Creating screenshot object...");
        const screenshot = new EyesWDIOScreenshot(this._logger, this._driver, screenshotImage, this.getPromiseFactory());
        result = screenshot.init();
      }

      return result;
    } catch (e) {
      throw e;
    } finally {
      if (this._hideScrollbars) {
        try {
          await EyesWDIOUtils.setOverflow(this._jsExecutor, originalOverflow);
        } catch (e) {
          // Bummer, but we'll continue with the screenshot anyway :)
          this._logger.log("WARNING: Failed to revert overflow! Error: " + e);
        }
      }
      this._logger.verbose("Done!");
    }
  }


  /**
   *
   * @returns {Promise.<*>}
   */
  async updateScalingParams() {
    if (this._devicePixelRatio === Eyes.UNKNOWN_DEVICE_PIXEL_RATIO && this._scaleProviderHandler.get() instanceof NullScaleProvider) {
      let factory;
      this._logger.verbose('Trying to extract device pixel ratio...');

      try {
        this._devicePixelRatio = await EyesWDIOUtils.getDevicePixelRatio(this.jsExecutor);
      } catch (e) {
        this._logger.verbose('Failed to extract device pixel ratio! Using default.', e);
        this._devicePixelRatio = Eyes.DEFAULT_DEVICE_PIXEL_RATIO;
      }

      this._logger.verbose('Device pixel ratio: ' + this._devicePixelRatio);
      this._logger.verbose('Setting scale provider..');
      const entireSize = await this._positionProvider.getEntireSize();

      try {
        const enSize = new RectangleSize(entireSize.getWidth(), entireSize.getHeight());
        const viewportSize = await this.getViewportSize();

        const vpSize = new RectangleSize(viewportSize.getWidth(), viewportSize.getHeight());
        factory = new ContextBasedScaleProviderFactory(this._logger, enSize, vpSize, this._devicePixelRatio, this._driver.remoteWebDriver.isMobile, this._scaleProviderHandler);
      } catch (e) {
        // This can happen in Appium for example.
        this._logger.verbose('Failed to set ContextBasedScaleProvider.', e);
        this._logger.verbose('Using FixedScaleProvider instead...');
        factory = new FixedScaleProviderFactory(1 / this._devicePixelRatio, this._scaleProviderHandler);
      }

      this._logger.verbose('Done!');
      return factory;
    } else {
      // If we already have a scale provider set, we'll just use it, and pass a mock as provider handler.
      return new ScaleProviderIdentityFactory(this._scaleProviderHandler.get(), new SimplePropertyHandler());
    }
  };


  /**
   * @private
   * @param {WebElement} element
   * @return {Promise}
   */
  async _ensureElementVisible(element) {
    if (!element) {
      // No element? we must be checking the window.
      return this.getPromiseFactory().resolve();
    }

    const originalFC = new FrameChain(this._logger, this._driver.getFrameChain());
    const switchTo = this._driver.switchTo();

    let elementBounds;
    const eyesRemoteWebElement = new EyesWebElement(this._logger, this._driver, element);
    const bounds = await eyesRemoteWebElement.getBounds();
    const currentFrameOffset = originalFC.getCurrentFrameOffset();
    elementBounds = bounds.offset(currentFrameOffset.getX(), currentFrameOffset.getY());
    const viewportBounds = await this._getViewportScrollBounds();

    if (!viewportBounds.contains(elementBounds)) {
      let elementLocation;
      await this._ensureFrameVisible();
      const p = await element.getLocation();

      elementLocation = new Location(p.x, p.y);

      if (originalFC.size() > 0 && !element.equals(originalFC.peek().reference)) {
        return switchTo.frames(originalFC);
      }

      return this._positionProvider.setPosition(elementLocation);
    }
  }


  /**
   * @return {Promise.<FrameChain>}
   */
  async _ensureFrameVisible() {
    const originalFC = new FrameChain(this._logger, this._driver.getFrameChain());
    const fc = new FrameChain(this._logger, this._driver.getFrameChain());
    await ensureFrameVisibleLoop(this._positionProvider, fc, this._driver.switchTo(), this.getPromiseFactory());
    await this._driver.switchTo().frames(originalFC);
    return originalFC;
  }


  /**
   * @private
   * @return {Promise.<Region>}
   */
  async _getViewportScrollBounds() {
    const originalFrameChain = new FrameChain(this._logger, this._driver.getFrameChain());
    const switchTo = this._driver.switchTo();
    await switchTo.defaultContent();
    const spp = new ScrollPositionProvider(this._logger, this._jsExecutor);
    const location = await spp.getCurrentPosition();
    const size = await this.getViewportSize();
    const viewportBounds = new Region(location, size);
    await switchTo.frames(originalFrameChain);
    return viewportBounds;
  }


  // noinspection JSUnusedGlobalSymbols
  setViewportSize(size) {
    this._viewportSize = size;
    return EyesWDIOUtils.setViewportSize(this._logger, this._driver, size);
  };


  // noinspection JSUnusedGlobalSymbols
  async getInferredEnvironment() {
    const res = 'useragent:';
    try {
      const userAgent = await this.jsExecutor.executeScript('return navigator.userAgent');
      return res + userAgent.value;
    } catch (e) {
      return res;
    }
  };


  // noinspection JSUnusedGlobalSymbols
  /**
   * @override
   */
  getBaseAgentId() {
    return `eyes.webdriverio/${VERSION}`;
  };


  //noinspection JSUnusedGlobalSymbols
  /**
   * Set the failure report.
   * @param {FailureReports} mode Use one of the values in FailureReports.
   */
  setFailureReport(mode) {
    if (mode === FailureReports.IMMEDIATE) {
      this._failureReportOverridden = true;
      mode = FailureReports.ON_CLOSE;
    }

    super.setFailureReport(mode);
  };


  // noinspection JSUnusedGlobalSymbols
  getAUTSessionId() {
    if (!this._driver) {
      return undefined;
    }

    return Promise.resolve(this._driver.remoteWebDriver.requestHandler.sessionID);
  };


  getTitle() {
    return this._driver.getTitle();
  };


  // noinspection JSUnusedGlobalSymbols
  /**
   * Forces a full page screenshot (by scrolling and stitching) if the browser only supports viewport screenshots).
   *
   * @param {boolean} shouldForce Whether to force a full page screenshot or not.
   */
  setForceFullPageScreenshot(shouldForce) {
    this._forceFullPageScreenshot = shouldForce;
  }

  //noinspection JSUnusedGlobalSymbols
  /**
   * @return {boolean} Whether Eyes should force a full page screenshot.
   */
  getForceFullPageScreenshot() {
    return this._forceFullPageScreenshot;
  }


  /**
   *
   * @returns {Region}
   */
  get regionToCheck() {
    return this._regionToCheck;
  }


  /**
   *
   * @param {Region} regionToCheck
   */
  set regionToCheck(regionToCheck) {
    this._regionToCheck = regionToCheck;
  }

  /**
   * @return {int} The time to wait just before taking a screenshot.
   */
  getWaitBeforeScreenshots() {
    return this._waitBeforeScreenshots;
  }

  /**
   * @return {PositionProvider} The currently set position provider.
   */
  getElementPositionProvider() {
    return this._elementPositionProvider ? this._elementPositionProvider : this._positionProvider;
  }

  /**
   * @return {?EyesWebDriver}
   */
  getDriver() {
    return this._driver;
  }

  /**
   * @return {int} Returns the stitching overlap in pixels.
   */
  getStitchOverlap() {
    return this._stitchingOverlap;
  }

  /**
   * @return {number} The device pixel ratio, or {@link #UNKNOWN_DEVICE_PIXEL_RATIO} if the DPR is not known yet or if it wasn't possible to extract it.
   */
  getDevicePixelRatio() {
    return this._devicePixelRatio;
  }

  /**
   * @return {boolean}
   */
  shouldStitchContent() {
    return this._stitchContent;
  }
}

/**
 * @param positionProvider
 * @param frameChain
 * @param switchTo
 * @param promiseFactory
 * @return {Promise}
 */
function ensureFrameVisibleLoop(positionProvider, frameChain, switchTo, promiseFactory) {
  return promiseFactory.resolve().then(() => {
    if (frameChain.size() > 0) {
      return switchTo.parentFrame().then(() => {
        const frame = frameChain.pop();
        return positionProvider.setPosition(frame.getLocation());
      }).then(() => {
        return ensureFrameVisibleLoop(positionProvider, frameChain, switchTo, promiseFactory);
      });
    }
  });
}

module.exports = Eyes;
