'use strict';
// import {EyesBase, ContextBasedScaleProviderFactory, FixedScaleProviderFactory, ScaleProviderIdentityFactory} from 'eyes.sdk';

const EyesSDK = require('eyes.sdk');
const EyesUtils = require('eyes.utils');
const EyesBase = EyesSDK.EyesBase;
const NullScaleProvider = EyesSDK.NullScaleProvider;
const ContextBasedScaleProviderFactory = EyesSDK.ContextBasedScaleProviderFactory;
const FixedScaleProviderFactory = EyesSDK.FixedScaleProviderFactory;
const ScaleProviderIdentityFactory = EyesSDK.ScaleProviderIdentityFactory;
const RegionProvider = EyesSDK.RegionProvider;
const Region = EyesSDK.Region;
const NullRegionProvider = EyesSDK.NullRegionProvider;
const SimplePropertyHandler = EyesUtils.SimplePropertyHandler;
const PromiseFactory = EyesSDK.PromiseFactory;
const CheckSettings = EyesSDK.CheckSettings;
const RectangleSize = EyesSDK.RectangleSize;
const CoordinatesType = EyesSDK.CoordinatesType;
const ArgumentGuard = EyesUtils.ArgumentGuard;
const CssTranslatePositionProvider = require('./CssTranslatePositionProvider');
const EyesWDIOUtils = require('./EyesWDIOUtils');
const EyesWDIOScreenshot = require('./EyesWDIOScreenshot');
const EyesWebDriver = require('./EyesWebDriver');
const EyesWebElement = require('./EyesWebElement');
const ElementFinderWrapper = require('./ElementFinderWrappers').ElementFinderWrapper;
const ScrollPositionProvider = require('./ScrollPositionProvider');
const EyesRegionProvider = require('./EyesRegionProvider');
const Target = require('./Target');
const GeometryUtils = EyesUtils.GeometryUtils;

const VERSION = require('../package.json').version;


class Eyes extends EyesBase {

  static get UNKNOWN_DEVICE_PIXEL_RATIO() {
    return 0;
  }

  static get DEFAULT_DEVICE_PIXEL_RATIO() {
    return 1;
  }

  constructor(serverUrl) {
    let promiseFactory = new PromiseFactory((asyncAction) => {
      return new Promise(asyncAction);
    }, null);

    super(promiseFactory, serverUrl || EyesBase.DEFAULT_EYES_SERVER);

    this._forceFullPage = false;
    this._imageRotationDegrees = 0;
    this._automaticRotation = true;
    this._isLandscape = false;
    this._hideScrollbars = null;
    this._checkFrameOrElement = false;

    // this._promiseFactory = promiseFactory;
  }


  _init(driver) {
    this._promiseFactory.setFactoryMethods(function (asyncAction) {
      return driver.call(function () {
        return new Promise(asyncAction);
      });
    }, null);
  }


  async open(driver, appName, testName, viewportSize) {
    this._init(driver);


    this._isProtractorLoaded = false;
    this._logger.verbose("Running using Webdriverio module");

    this._devicePixelRatio = Eyes.UNKNOWN_DEVICE_PIXEL_RATIO;
    // that._driver = driver;
    this._driver = new EyesWebDriver(driver, this, this._logger, this._promiseFactory);
    this.setStitchMode(this._stitchMode);

    if (this._isDisabled) {
      return driver.execute(function () {
        return driver;
      });
    }

    if (driver.isMobile) {
      let status = await driver.status();
      const platformVersion = status.value.os.version;

      let majorVersion;
      if (!platformVersion || platformVersion.length < 1) {
        return;
      }
      majorVersion = platformVersion.split('.', 2)[0];
      let isAndroid = driver.isAndroid;
      let isIOS = driver.isIOS;
      if (isAndroid) {
        if (!this.getHostOS()) {
          this.setHostOS('Android ' + majorVersion);
        }
      } else if (isIOS) {
        if (!this.getHostOS()) {
          this.setHostOS('iOS ' + majorVersion);
        }
      }

      const orientation = driver.getOrientation();
      if (orientation && orientation.toUpperCase() === 'LANDSCAPE') {
        this._isLandscape = true;
      }
    }

    return this.openBase(appName, testName, viewportSize, null);
  }


  end(throwEx=true) {
    let that = this;

    return that._driver.call(function () {
      return this.close.call(that, throwEx)
        .then(function (results) {
          return results;
        }, function (err) {
          throw err;
        });
    });
  }


  checkWindow(tag, matchTimeout) {
    return this.check(tag, Target.window().timeout(matchTimeout));
  };


  checkElement(element, matchTimeout, tag) {
    return this.check(tag, Target.region(element).timeout(matchTimeout));
  };


  async check(name, target) {
    ArgumentGuard.notNullOrEmpty(name, "Name");
    ArgumentGuard.notNull(target, "Target");

    const that = this;

    let promise = that._promiseFactory.makePromise(function (resolve) {
      resolve();
    });

    if (that._isDisabled) {
      that._logger.verbose("match ignored - ", name);
      return promise;
    }

    // todo
    if (target.getIgnoreObjects().length) {
      target.getIgnoreObjects().forEach(function (obj) {
        promise = promise.then(function () {
          return this.findElementByLocator(obj.element);
        }).then(function (element) {
          if (!isElementObject(element)) {
            throw new Error("Unsupported ignore region type: " + typeof element);
          }

          return getRegionFromWebElement(element);
        }).then(function (region) {
          target.ignore(region);
        });
      });
    }

    // todo
    if (target.getFloatingObjects().length) {
      target.getFloatingObjects().forEach(function (obj) {
        promise = promise.then(function () {
          return this.findElementByLocator(obj.element);
        }).then(function (element) {
          if (!isElementObject(element)) {
            throw new Error("Unsupported floating region type: " + typeof element);
          }

          return getRegionFromWebElement(element);
        }).then(function (region) {
          region.maxLeftOffset = obj.maxLeftOffset;
          region.maxRightOffset = obj.maxRightOffset;
          region.maxUpOffset = obj.maxUpOffset;
          region.maxDownOffset = obj.maxDownOffset;
          target.floating(region);
        });
      });
    }

    that._logger.verbose("match starting with params", name, target.getStitchContent(), target.getTimeout());
    let regionObject,
      regionProvider,
      isFrameSwitched = false, // if we will switch frame then we need to restore parent
      originalForceFullPage, originalOverflow, originalPositionProvider, originalHideScrollBars;

    if (target.getStitchContent()) {
      originalForceFullPage = that._forceFullPage;
      that._forceFullPage = true;
    }

    // todo
    // If frame specified
    if (target.isUsingFrame()) {
      promise = promise.then(function () {
        return this.findElementByLocator(target.getFrame());
      }).then(function (frame) {
        that._logger.verbose("Switching to frame...");
        return that._driver.switchTo().frame(frame);
      }).then(function () {
        isFrameSwitched = true;
        that._logger.verbose("Done!");

        // if we need to check entire frame, we need to update region provider
        if (!target.isUsingRegion()) {
          that._checkFrameOrElement = true;
          originalHideScrollBars = that._hideScrollbars;
          that._hideScrollbars = true;
          return getRegionProviderForCurrentFrame(that).then(function (regionProvider) {
            that._regionToCheck = regionProvider;
          });
        }
      });
    }

    // todo
    // if region specified
    if (target.isUsingRegion()) {

      regionObject = await this.findElementByLocator(target.getRegion());

      if (Eyes.isElementObject(regionObject)) {
        let regionPromise, region;
        if (target.getStitchContent()) { // todo
          that._checkFrameOrElement = true;

          originalPositionProvider = that.getPositionProvider();
          that.setPositionProvider(new ElementPositionProvider(that._logger, that._driver, regionObject, that._promiseFactory));

          // Set overflow to "hidden".
          regionPromise = regionObject.getOverflow().then(function (value) {
            originalOverflow = value;
            return regionObject.setOverflow("hidden");
          }).then(function () {
            return getRegionProviderForElement(that, regionObject);
          }).then(function (regionProvider) {
            that._regionToCheck = regionProvider;
          });
        } else {
          region = await Eyes.getRegionFromWebElement(regionObject);
        }

        regionProvider = new EyesRegionProvider(that._logger, that._driver, region, CoordinatesType.CONTEXT_RELATIVE, that._promiseFactory);

      } else if (GeometryUtils.isRegion(regionObject)) {
        // if regionObject is simple region
        regionProvider = new EyesRegionProvider(that._logger, that._driver, regionObject, CoordinatesType.CONTEXT_AS_IS);
      } else {
        throw new Error("Unsupported region type: " + typeof regionObject);
      }

    } else {
      regionProvider = new NullRegionProvider(that._promiseFactory);
    }

    that._logger.verbose("Call to checkWindowBase...");

    let result = await super.checkWindowBase(regionProvider, name, target.getIgnoreMismatch(), new CheckSettings(target.getTimeout()));

    that._logger.verbose("Processing results...");
    if (result.asExpected || !that._failureReportOverridden) {
      // return result;
    } else {
      throw EyesBase.buildTestError(result, that._sessionStartInfo.scenarioIdOrName, that._sessionStartInfo.appIdOrName);
    }

    that._logger.verbose("Done!");
    that._logger.verbose("Restoring temporal variables...");

    if (that._regionToCheck) {
      that._regionToCheck = null;
    }

    if (that._checkFrameOrElement) {
      that._checkFrameOrElement = false;
    }

    // restore initial values
    if (originalForceFullPage !== undefined) {
      that._forceFullPage = originalForceFullPage;
    }

    if (originalHideScrollBars !== undefined) {
      that._hideScrollbars = originalHideScrollBars;
    }

    if (originalPositionProvider !== undefined) {
      that.setPositionProvider(originalPositionProvider);
    }

    if (originalOverflow !== undefined) {
      return regionObject.setOverflow(originalOverflow);
    }

    that._logger.verbose("Done!");

    // restore parent frame, if another frame was selected
    // todo
    if (isFrameSwitched) {
      that._logger.verbose("Switching back to parent frame...");
      return that._driver.switchTo().parentFrame().then(function () {
        that._logger.verbose("Done!");
      });
    }
  }


  findElementByLocator(elementObject) {
    return this._driver.findElement(elementObject);
  };

  static isElementObject(o) {
    return o instanceof EyesWebElement;
  };

  static isLocatorObject(o) {
    return o instanceof webdriver.By || o.findElementsOverride !== undefined || (o.using !== undefined && o.value !== undefined);
  };


  getViewportSize() {
    return EyesWDIOUtils.getViewportSizeOrDisplaySize(this._logger, this._driver, this._promiseFactory);
  };


  static async getRegionFromWebElement(element) {
    let elementSize = await element.getSize();
    let point = await element.getLocation();

    return new Region(point.x, point.y, elementSize.width, elementSize.height);
  };


  setStitchMode(mode) {
    this._stitchMode = mode;
    if (this._driver) {
      switch (mode) {
        case Eyes.StitchMode.CSS:
          this.setPositionProvider(new CssTranslatePositionProvider(this._logger, this._driver, this._promiseFactory));
          break;
        default:
          this.setPositionProvider(new ScrollPositionProvider(this._logger, this._driver, this._promiseFactory));
      }
    }
  };

  /**
   * Get the stitch mode.
   * @return {StitchMode} The currently set StitchMode.
   */
  getStitchMode() {
    return this._stitchMode;
  };


  async getScreenshot() {
    const scaleProviderFactory = await this.updateScalingParams();
    const screenshot = await EyesWDIOUtils.getScreenshot(
      this._driver,
      this._promiseFactory,
      this._viewportSize,
      this._positionProvider,
      scaleProviderFactory,
      this._cutProviderHandler.get(),
      this._forceFullPage,
      this._hideScrollbars,
      this._stitchMode === Eyes.StitchMode.CSS,
      this._imageRotationDegrees,
      this._automaticRotation,
      this._os === 'Android' ? 90 : 270,
      this._isLandscape,
      this._waitBeforeScreenshots,
      this._checkFrameOrElement,
      this._regionToCheck,
      this._saveDebugScreenshots,
      this._debugScreenshotsPath
    );

    return new EyesWDIOScreenshot(screenshot);
  };

  static get StitchMode() {
    return {
      // Uses scrolling to get to the different parts of the page.
      Scroll: 'Scroll',

      // Uses CSS transitions to get to the different parts of the page.
      CSS: 'CSS'
    };
  }


  updateScalingParams() {
    const that = this;
    return that._promiseFactory.makePromise(function (resolve) {
      if (that._devicePixelRatio === Eyes.UNKNOWN_DEVICE_PIXEL_RATIO && that._scaleProviderHandler.get() instanceof NullScaleProvider) {
        let factory, enSize, vpSize;
        that._logger.verbose("Trying to extract device pixel ratio...");

        return EyesWDIOUtils.getDevicePixelRatio(that._driver, that._promiseFactory).then(function (ratio) {
          that._devicePixelRatio = ratio;
        }, function (err) {
          that._logger.verbose("Failed to extract device pixel ratio! Using default.", err);
          that._devicePixelRatio = Eyes.DEFAULT_DEVICE_PIXEL_RATIO;
        }).then(function () {
          that._logger.verbose("Device pixel ratio: " + that._devicePixelRatio);
          that._logger.verbose("Setting scale provider..");
          return that._positionProvider.getEntireSize();
        }).then(function (entireSize) {
          enSize = new RectangleSize(entireSize.width, entireSize.height);
          return that.getViewportSize();
        }).then(function (viewportSize) {
          vpSize = new RectangleSize(viewportSize.width, viewportSize.height);
          factory = new ContextBasedScaleProviderFactory(that._logger, enSize, vpSize, that._devicePixelRatio, that._driver.getRemoteWebDriver().isMobile, that._scaleProviderHandler);
        }, function (err) {
          // This can happen in Appium for example.
          that._logger.verbose("Failed to set ContextBasedScaleProvider.", err);
          that._logger.verbose("Using FixedScaleProvider instead...");
          factory = new FixedScaleProviderFactory(1 / that._devicePixelRatio, that._scaleProviderHandler);
        }).then(function () {
          that._logger.verbose("Done!");
          resolve(factory);
        });
      }

      // If we already have a scale provider set, we'll just use it, and pass a mock as provider handler.
      resolve(new ScaleProviderIdentityFactory(that._scaleProviderHandler.get(), new SimplePropertyHandler()));
    });
  };


  setViewportSize(size) {
    this._viewportSize = new RectangleSize(size.width, size.height);
    return EyesWDIOUtils.setViewportSize(this._logger, this._driver, size, this._promiseFactory);
  };


  getInferredEnvironment() {
    let res = 'useragent:';
    return this._driver.execute('return navigator.userAgent').then(function (userAgent) {
      return res + userAgent;
    }, function () {
      return res;
    });
  };


  getBaseAgentId() {
    return `eyes.webdriverio/${VERSION}`;
  };


  setFailureReport(mode) {
    if (mode === EyesBase.FailureReport.Immediate) {
      this._failureReportOverridden = true;
      mode = EyesBase.FailureReport.OnClose;
    }

    EyesBase.prototype.setFailureReport.call(this, mode);
  };


  getAUTSessionId() {
    if (!this._driver) {
      return undefined;
    }

    return Promise.resolve(this._driver.getRemoteWebDriver().requestHandler.sessionID);
  };


  _waitTimeout(ms) {
    return this._driver.timeouts(ms);
  };


  getTitle() {
    return this._driver.getTitle();
  };


}

module.exports = Eyes;
