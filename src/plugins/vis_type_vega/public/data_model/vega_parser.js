/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import _ from 'lodash';
import { vega, vegaLite } from '../lib/vega';
import schemaParser from 'vega-schema-url-parser';
import versionCompare from 'compare-versions';
import { EsQueryParser } from './es_query_parser';
import hjson from 'hjson';
import { Utils } from './utils';
import { EmsFileParser } from './ems_file_parser';
import { UrlParser } from './url_parser';
import { VISUALIZATION_COLORS } from '@elastic/eui';
import { i18n } from '@kbn/i18n';

// Set default single color to match other Kibana visualizations
const defaultColor = VISUALIZATION_COLORS[0];
const locToDirMap = {
  left: 'row-reverse',
  right: 'row',
  top: 'column-reverse',
  bottom: 'column',
};
const DEFAULT_SCHEMA = 'https://vega.github.io/schema/vega/v5.json';

// If there is no "%type%" parameter, use this parser
const DEFAULT_PARSER = 'elasticsearch';

export class VegaParser {
  constructor(spec, searchAPI, timeCache, filters, serviceSettings) {
    this.spec = spec;
    this.hideWarnings = false;
    this.error = undefined;
    this.warnings = [];

    const onWarn = this._onWarning.bind(this);
    this._urlParsers = {
      elasticsearch: new EsQueryParser(timeCache, searchAPI, filters, onWarn),
      emsfile: new EmsFileParser(serviceSettings),
      url: new UrlParser(onWarn),
    };
  }

  async parseAsync() {
    try {
      await this._parseAsync();
    } catch (err) {
      // if we reject current promise, it will use the standard Kibana error handling
      this.error = Utils.formatErrorToStr(err);
    }
    return this;
  }

  async _parseAsync() {
    if (this.isVegaLite !== undefined) throw new Error();

    if (typeof this.spec === 'string') {
      this.spec = hjson.parse(this.spec, { legacyRoot: false });
    }
    if (!_.isPlainObject(this.spec)) {
      throw new Error(
        i18n.translate('visTypeVega.vegaParser.invalidVegaSpecErrorMessage', {
          defaultMessage: 'Invalid Vega specification',
        })
      );
    }
    this.isVegaLite = this._parseSchema();
    this.useHover = !this.isVegaLite;

    this._config = this._parseConfig();
    this.hideWarnings = !!this._config.hideWarnings;
    this.useMap = this._config.type === 'map';
    this.renderer = this._config.renderer === 'svg' ? 'svg' : 'canvas';
    this.tooltips = this._parseTooltips();

    this._setDefaultColors();
    this._parseControlPlacement(this._config);
    if (this.useMap) {
      this.mapConfig = this._parseMapConfig();
    } else if (this.spec.autosize === undefined) {
      // Default autosize should be fit, unless it's a map (leaflet-vega handles that)
      this.spec.autosize = { type: 'fit', contains: 'padding' };
    }

    await this._resolveDataUrls();

    if (this.isVegaLite) {
      this._compileVegaLite();
    }

    this._calcSizing();
  }

  /**
   * Convert VegaLite to Vega spec
   * @private
   */
  _compileVegaLite() {
    this.vlspec = this.spec;
    // eslint-disable-next-line import/namespace
    const logger = vega.logger(vega.Warn); // note: eslint has a false positive here
    logger.warn = this._onWarning.bind(this);
    this.spec = vegaLite.compile(this.vlspec, logger).spec;

    // When using VL with the type=map and user did not provid their own projection settings,
    // remove the default projection that was generated by VegaLite compiler.
    // This way we let leaflet-vega library inject a different default projection for tile maps.
    // Also, VL injects default padding and autosize values, but neither should be set for vega-leaflet.
    if (this.useMap) {
      const hasConfig = _.isPlainObject(this.vlspec.config);
      if (this.vlspec.config === undefined || (hasConfig && !this.vlspec.config.projection)) {
        // Assume VL generates spec.projections = an array of exactly one object named 'projection'
        if (
          !Array.isArray(this.spec.projections) ||
          this.spec.projections.length !== 1 ||
          this.spec.projections[0].name !== 'projection'
        ) {
          throw new Error(
            i18n.translate(
              'visTypeVega.vegaParser.VLCompilerShouldHaveGeneratedSingleProtectionObjectErrorMessage',
              {
                defaultMessage:
                  'Internal error: Vega-Lite compiler should have generated a single projection object',
              }
            )
          );
        }
        delete this.spec.projections;
      }

      // todo: sizing cleanup might need to be rethought and consolidated
      if (!this.vlspec.width) delete this.spec.width;
      if (!this.vlspec.height) delete this.spec.height;
      if (
        !this.vlspec.padding &&
        (this.vlspec.config === undefined || (hasConfig && !this.vlspec.config.padding))
      ) {
        delete this.spec.padding;
      }
      if (
        !this.vlspec.autosize &&
        (this.vlspec.config === undefined || (hasConfig && !this.vlspec.config.autosize))
      ) {
        delete this.spec.autosize;
      }
    }
  }

  /**
   * Process graph size and padding
   * @private
   */
  _calcSizing() {
    this.useResize = false;
    if (!this.useMap) {
      // when useResize is true, vega's canvas size will be set based on the size of the container,
      // and will be automatically updated on resize events.
      // We delete width & height if the autosize is set to "fit"
      // We also set useResize=true in case autosize=none, and width & height are not set
      const autosize = this.spec.autosize.type || this.spec.autosize;
      if (autosize === 'fit' || (autosize === 'none' && !this.spec.width && !this.spec.height)) {
        this.useResize = true;
      }
    }

    // Padding is not included in the width/height by default
    this.paddingWidth = 0;
    this.paddingHeight = 0;
    if (this.useResize && this.spec.padding && this.spec.autosize.contains !== 'padding') {
      if (typeof this.spec.padding === 'object') {
        this.paddingWidth += (+this.spec.padding.left || 0) + (+this.spec.padding.right || 0);
        this.paddingHeight += (+this.spec.padding.top || 0) + (+this.spec.padding.bottom || 0);
      } else {
        this.paddingWidth += 2 * (+this.spec.padding || 0);
        this.paddingHeight += 2 * (+this.spec.padding || 0);
      }
    }

    if (this.useResize && (this.spec.width || this.spec.height)) {
      if (this.isVegaLite) {
        delete this.spec.width;
        delete this.spec.height;
      } else {
        this._onWarning(
          i18n.translate(
            'visTypeVega.vegaParser.widthAndHeightParamsAreIgnoredWithAutosizeFitWarningMessage',
            {
              defaultMessage:
                'The {widthParam} and {heightParam} params are ignored with {autosizeParam}',
              values: {
                autosizeParam: 'autosize=fit',
                widthParam: '"width"',
                heightParam: '"height"',
              },
            }
          )
        );
      }
    }
  }

  /**
   * Calculate container-direction CSS property for binding placement
   * @private
   */
  _parseControlPlacement() {
    this.containerDir = locToDirMap[this._config.controlsLocation];
    if (this.containerDir === undefined) {
      if (this._config.controlsLocation === undefined) {
        this.containerDir = 'column';
      } else {
        throw new Error(
          i18n.translate('visTypeVega.vegaParser.unrecognizedControlsLocationValueErrorMessage', {
            defaultMessage:
              'Unrecognized {controlsLocationParam} value. Expecting one of [{locToDirMap}]',
            values: {
              locToDirMap: `"${locToDirMap.keys().join('", "')}"`,
              controlsLocationParam: 'controlsLocation',
            },
          })
        );
      }
    }
    const dir = this._config.controlsDirection;
    if (dir !== undefined && dir !== 'horizontal' && dir !== 'vertical') {
      throw new Error(
        i18n.translate('visTypeVega.vegaParser.unrecognizedDirValueErrorMessage', {
          defaultMessage: 'Unrecognized {dirParam} value. Expecting one of [{expectedValues}]',
          values: { expectedValues: '"horizontal", "vertical"', dirParam: 'dir' },
        })
      );
    }
    this.controlsDir = dir === 'horizontal' ? 'row' : 'column';
  }

  /**
   * Parse {config: kibana: {...}} portion of the Vega spec (or root-level _hostConfig for backward compat)
   * @returns {object} kibana config
   * @private
   */
  _parseConfig() {
    let result;
    if (this.spec._hostConfig !== undefined) {
      result = this.spec._hostConfig;
      delete this.spec._hostConfig;
      if (!_.isPlainObject(result)) {
        throw new Error(
          i18n.translate('visTypeVega.vegaParser.hostConfigValueTypeErrorMessage', {
            defaultMessage: 'If present, {configName} must be an object',
            values: { configName: '"_hostConfig"' },
          })
        );
      }
      this._onWarning(
        i18n.translate('visTypeVega.vegaParser.hostConfigIsDeprecatedWarningMessage', {
          defaultMessage:
            '{deprecatedConfigName} has been deprecated. Use {newConfigName} instead.',
          values: {
            deprecatedConfigName: '"_hostConfig"',
            newConfigName: 'config.kibana',
          },
        })
      );
    }
    if (_.isPlainObject(this.spec.config) && this.spec.config.kibana !== undefined) {
      result = this.spec.config.kibana;
      delete this.spec.config.kibana;
      if (!_.isPlainObject(result)) {
        throw new Error(
          i18n.translate('visTypeVega.vegaParser.kibanaConfigValueTypeErrorMessage', {
            defaultMessage: 'If present, {configName} must be an object',
            values: { configName: 'config.kibana' },
          })
        );
      }
    }
    return result || {};
  }

  _parseTooltips() {
    if (this._config.tooltips === false) {
      return false;
    }

    const result = this._config.tooltips || {};

    if (result.position === undefined) {
      result.position = 'top';
    } else if (['top', 'right', 'bottom', 'left'].indexOf(result.position) === -1) {
      throw new Error(
        i18n.translate(
          'visTypeVega.vegaParser.unexpectedValueForPositionConfigurationErrorMessage',
          {
            defaultMessage: 'Unexpected value for the {configurationName} configuration',
            values: { configurationName: 'result.position' },
          }
        )
      );
    }

    if (result.padding === undefined) {
      result.padding = 16;
    } else if (typeof result.padding !== 'number') {
      throw new Error(
        i18n.translate('visTypeVega.vegaParser.paddingConfigValueTypeErrorMessage', {
          defaultMessage: '{configName} is expected to be a number',
          values: { configName: 'config.kibana.result.padding' },
        })
      );
    }

    if (result.centerOnMark === undefined) {
      // if mark's width & height is less than this value, center on it
      result.centerOnMark = 50;
    } else if (typeof result.centerOnMark === 'boolean') {
      result.centerOnMark = result.centerOnMark ? Number.MAX_VALUE : -1;
    } else if (typeof result.centerOnMark !== 'number') {
      throw new Error(
        i18n.translate('visTypeVega.vegaParser.centerOnMarkConfigValueTypeErrorMessage', {
          defaultMessage: '{configName} is expected to be {trueValue}, {falseValue}, or a number',
          values: {
            configName: 'config.kibana.result.centerOnMark',
            trueValue: 'true',
            falseValue: 'false',
          },
        })
      );
    }

    return result;
  }

  /**
   * Parse map-specific configuration
   * @returns {{mapStyle: *|string, delayRepaint: boolean, latitude: number, longitude: number, zoom, minZoom, maxZoom, zoomControl: *|boolean, maxBounds: *}}
   * @private
   */
  _parseMapConfig() {
    const res = {
      delayRepaint: this._config.delayRepaint === undefined ? true : this._config.delayRepaint,
    };

    const validate = (name, isZoom) => {
      const val = this._config[name];
      if (val !== undefined) {
        const parsed = parseFloat(val);
        if (Number.isFinite(parsed) && (!isZoom || (parsed >= 0 && parsed <= 30))) {
          res[name] = parsed;
          return;
        }
        this._onWarning(
          i18n.translate('visTypeVega.vegaParser.someKibanaConfigurationIsNoValidWarningMessage', {
            defaultMessage: '{configName} is not valid',
            values: { configName: `config.kibana.${name}` },
          })
        );
      }
      if (!isZoom) res[name] = 0;
    };

    validate(`latitude`, false);
    validate(`longitude`, false);
    validate(`zoom`, true);
    validate(`minZoom`, true);
    validate(`maxZoom`, true);

    // `false` is a valid value
    res.mapStyle = this._config.mapStyle === undefined ? `default` : this._config.mapStyle;
    if (res.mapStyle !== `default` && res.mapStyle !== false) {
      this._onWarning(
        i18n.translate('visTypeVega.vegaParser.mapStyleValueTypeWarningMessage', {
          defaultMessage:
            '{mapStyleConfigName} may either be {mapStyleConfigFirstAllowedValue} or {mapStyleConfigSecondAllowedValue}',
          values: {
            mapStyleConfigName: 'config.kibana.mapStyle',
            mapStyleConfigFirstAllowedValue: 'false',
            mapStyleConfigSecondAllowedValue: '"default"',
          },
        })
      );
      res.mapStyle = `default`;
    }

    this._parseBool('zoomControl', res, true);
    this._parseBool('scrollWheelZoom', res, false);

    const maxBounds = this._config.maxBounds;
    if (maxBounds !== undefined) {
      if (
        !Array.isArray(maxBounds) ||
        maxBounds.length !== 4 ||
        !maxBounds.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        this._onWarning(
          i18n.translate('visTypeVega.vegaParser.maxBoundsValueTypeWarningMessage', {
            defaultMessage: '{maxBoundsConfigName} must be an array with four numbers',
            values: {
              maxBoundsConfigName: 'config.kibana.maxBounds',
            },
          })
        );
      } else {
        res.maxBounds = maxBounds;
      }
    }

    return res;
  }

  _parseBool(paramName, dstObj, dflt) {
    const val = this._config[paramName];
    if (val === undefined) {
      dstObj[paramName] = dflt;
    } else if (typeof val !== 'boolean') {
      this._onWarning(
        i18n.translate('visTypeVega.vegaParser.someKibanaParamValueTypeWarningMessage', {
          defaultMessage: '{configName} must be a boolean value',
          values: {
            configName: `config.kibana.${paramName}`,
          },
        })
      );
      dstObj[paramName] = dflt;
    } else {
      dstObj[paramName] = val;
    }
  }

  /**
   * Parse Vega schema element
   * @returns {boolean} is this a VegaLite schema?
   * @private
   */
  _parseSchema() {
    if (!this.spec.$schema) {
      this._onWarning(
        i18n.translate('visTypeVega.vegaParser.inputSpecDoesNotSpecifySchemaWarningMessage', {
          defaultMessage:
            'The input spec does not specify a {schemaParam}, defaulting to {defaultSchema}',
          values: { defaultSchema: `"${DEFAULT_SCHEMA}"`, schemaParam: '"$schema"' },
        })
      );
      this.spec.$schema = DEFAULT_SCHEMA;
    }

    const schema = schemaParser(this.spec.$schema);
    const isVegaLite = schema.library === 'vega-lite';
    const libVersion = isVegaLite ? vegaLite.version : vega.version;

    if (versionCompare(schema.version, libVersion) > 0) {
      this._onWarning(
        i18n.translate('visTypeVega.vegaParser.notValidLibraryVersionForInputSpecWarningMessage', {
          defaultMessage:
            'The input spec uses {schemaLibrary} {schemaVersion}, but current version of {schemaLibrary} is {libraryVersion}.',
          values: {
            schemaLibrary: schema.library,
            schemaVersion: schema.version,
            libraryVersion: libVersion,
          },
        })
      );
    }

    return isVegaLite;
  }

  /**
   * Replace all instances of ES requests with raw values.
   * Also handle any other type of url: {type: xxx, ...}
   * @private
   */
  async _resolveDataUrls() {
    const pending = {};

    this._findObjectDataUrls(this.spec, (obj) => {
      const url = obj.url;
      delete obj.url;
      let type = url['%type%'];
      delete url['%type%'];
      if (type === undefined) {
        type = DEFAULT_PARSER;
      }

      const parser = this._urlParsers[type];
      if (parser === undefined) {
        throw new Error(
          i18n.translate('visTypeVega.vegaParser.notSupportedUrlTypeErrorMessage', {
            defaultMessage: '{urlObject} is not supported',
            values: {
              urlObject: 'url: {"%type%": "${type}"}',
            },
          })
        );
      }

      let pendingArr = pending[type];
      if (pendingArr === undefined) {
        pending[type] = pendingArr = [];
      }

      pendingArr.push(parser.parseUrl(obj, url));
    });

    const pendingParsers = Object.keys(pending);
    if (pendingParsers.length > 0) {
      // let each parser populate its data in parallel
      await Promise.all(
        pendingParsers.map((type) => this._urlParsers[type].populateData(pending[type]))
      );
    }
  }

  /**
   * Recursively find and callback every instance of the data.url as an object
   * @param {*} obj current location in the object tree
   * @param {function({object})} onFind Call this function for all url objects
   * @param {string} [key] field name of the current object
   * @private
   */
  _findObjectDataUrls(obj, onFind, key) {
    if (Array.isArray(obj)) {
      for (const elem of obj) {
        this._findObjectDataUrls(elem, onFind, key);
      }
    } else if (_.isPlainObject(obj)) {
      if (key === 'data' && _.isPlainObject(obj.url)) {
        // Assume that any  "data": {"url": {...}}  is a request for data
        if (obj.values !== undefined || obj.source !== undefined) {
          throw new Error(
            i18n.translate(
              'visTypeVega.vegaParser.dataExceedsSomeParamsUseTimesLimitErrorMessage',
              {
                defaultMessage:
                  'Data must not have more than one of {urlParam}, {valuesParam}, and {sourceParam}',
                values: {
                  urlParam: '"url"',
                  valuesParam: '"values"',
                  sourceParam: '"source"',
                },
              }
            )
          );
        }
        onFind(obj);
      } else {
        for (const k of Object.keys(obj)) {
          this._findObjectDataUrls(obj[k], onFind, k);
        }
      }
    }
  }

  /**
   * Inject default colors into the spec.config
   * @private
   */
  _setDefaultColors() {
    // Default category coloring to the Elastic color scheme
    this._setDefaultValue({ scheme: 'elastic' }, 'config', 'range', 'category');

    if (this.isVegaLite) {
      // Vega-Lite: set default color, works for fill and strike --  config: { mark:  { color: '#54B399' }}
      this._setDefaultValue(defaultColor, 'config', 'mark', 'color');
    } else {
      // Vega - global mark has very strange behavior, must customize each mark type individually
      // https://github.com/vega/vega/issues/1083
      // Don't set defaults if spec.config.mark.color or fill are set
      if (
        !this.spec.config.mark ||
        (this.spec.config.mark.color === undefined && this.spec.config.mark.fill === undefined)
      ) {
        this._setDefaultValue(defaultColor, 'config', 'arc', 'fill');
        this._setDefaultValue(defaultColor, 'config', 'area', 'fill');
        this._setDefaultValue(defaultColor, 'config', 'line', 'stroke');
        this._setDefaultValue(defaultColor, 'config', 'path', 'stroke');
        this._setDefaultValue(defaultColor, 'config', 'rect', 'fill');
        this._setDefaultValue(defaultColor, 'config', 'rule', 'stroke');
        this._setDefaultValue(defaultColor, 'config', 'shape', 'stroke');
        this._setDefaultValue(defaultColor, 'config', 'symbol', 'fill');
        this._setDefaultValue(defaultColor, 'config', 'trail', 'fill');
      }
    }
  }

  /**
   * Set default value if it doesn't exist.
   * Given an object, and an array of fields, ensure that obj.fld1.fld2. ... .fldN is set to value if it doesn't exist.
   * @param {*} value
   * @param {string} fields
   * @private
   */
  _setDefaultValue(value, ...fields) {
    let o = this.spec;
    for (let i = 0; i < fields.length - 1; i++) {
      const field = fields[i];
      const subObj = o[field];
      if (subObj === undefined) {
        o[field] = {};
      } else if (!_.isPlainObject(subObj)) {
        return;
      }
      o = o[field];
    }
    const lastField = fields[fields.length - 1];
    if (o[lastField] === undefined) {
      o[lastField] = value;
    }
  }

  /**
   * Add a warning to the warnings array
   * @private
   */
  _onWarning() {
    if (!this.hideWarnings) {
      this.warnings.push(Utils.formatWarningToStr(...arguments));
    }
  }
}