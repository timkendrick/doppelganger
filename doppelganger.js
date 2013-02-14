var fs = require('fs');
var jsdom = require('jsdom');
var requirejs = require('requirejs');

/**
 * Doppelganger App main class
 * @param {String} html App index page HTML template
 * @param {String} configPath Location of the Require.js config file, relative to the server root
 * @param {String} [context] Require.js context, for running more than one Doppelganger app simultaneously
 * @constructor
 */
var Doppelganger = function Doppelganger(html, configPath, context) {
	this._html = html;
	this._configPath = configPath;
	this._context = context || null;
};

/**
 * App index page HTML template
 * @type {String}
 * @private
 */
Doppelganger.prototype._html = null;

/**
 * Location of the Require.js config file, relative to the server root
 * @type {String}
 * @private
 */
Doppelganger.prototype._configPath = null;

/**
 * Require.js context, for running more than one Doppelganger app simultaneously
 * @type {String}
 * @private
 */
Doppelganger.prototype._context = null;

/**
 * JSDOM Document DOM element
 * @type {Document}
 * @private
 */
Doppelganger.prototype._document = null;

/**
 * Version of Backbone.js that has been loaded into the app
 * @type {Backbone}
 * @private
 */
Doppelganger.prototype._backbone = null;

/**
 * Initialise the app
 * @param {Function} callback Callback to invoke when the app is up and running
 */
Doppelganger.prototype.init = function(callback) {
	// Get the base URL of the Require.js script directory
	var requirejsPath = this._configPath.substr(0, this._configPath.lastIndexOf('/') + 1);
	
	// Use JSDOM to create a document element
	this._document = this._createDOM(this._html);
	
	// Initialise the app through Require.js
	this._initRequireJS(requirejs, requirejsPath, this._configPath, this._document, callback);
};

/**
 * Check whether the specified path is a valid route within the app
 * @param {String} path The path to test
 * @return {RegExp|Boolean} The regular expression describing a matching route, or false if the path is invalid
 */
Doppelganger.prototype.routeExists = function(path) {
	return this._backbone && ((!path && (this._backbone.history.handlers.length === 0)) || _(this._backbone.history.handlers).find(function(handler) { return handler.route.test(path); })) || false;
};

/**
 * Navigate to a different page within the app
 * @param {String} path The path to navigate to
 */
Doppelganger.prototype.navigate = function(path) {
	if (this.routeExists(path) && (this._backbone.history.handlers.length !== 0)) { this._backbone.history.navigate(path, true) }
};

/**
 * Get the generated HTML of the app's current DOM state
 * @return {String} HTML reflecting the app's current state
 */
Doppelganger.prototype.getHTML = function() {
	return this._document && this._document.innerHTML || "";
};

/**
 * Create a JSDOM document
 * @param {String} html HTML from which to generate the document
 * @return {Document} The newly-created document's DOM element
 * @private
 */
Doppelganger.prototype._createDOM = function(html) {
	return jsdom.jsdom(html, null, { features: { FetchExternalResources: false, ProcessExternalResources: false } });
};

/**
 * Initialise the app through Require.js
 * @param {requirejs} requirejs Require.js instance to use to initialise the app
 * @param {String} baseURL Base URL within which to look for Require.js modules
 * @param {String} configPath Location of the Require.js config file, relative to the server root 
 * @param {Document} document JSDOM Document's DOM element
 * @param {function} callback Callback invoked when the app is up and running
 * @private
 */
Doppelganger.prototype._initRequireJS = function(requirejs, baseURL, configPath, document, callback) {
	// Some of the scripts will need a reference to a window object
	var window = document.createWindow();
	
	// Retain a reference to the current Doppelganger instance for use in nested functions
	var self = this;
	
	// Load the Require.js config file as text, so that we can manipulate it without having to call it first
	fs.readFile(configPath, 'utf8', function(error, data) {
		if (error) { throw error; }
		
		// Parse the config file for a require.config(...) call, making note of the section between the parentheses
		var configSearch = /require\s*\.\s*config\s*\(([^]+)\)/.exec(data);
		
		// Convert the config string to a JS object (hacky...)
		var config = configSearch && new Function('return ' + configSearch[1] + ';')();
		if (!config) { throw new Error('Invalid Require.js config file specified'); }
		
		// Add additional config parameters for server-side use
		config.baseUrl = configPath.substr(0, configPath.lastIndexOf('/') + 1);
		config.nodeRequire = require;
		
		// Set the Require.js context, if there is one specified
		if (self._context) { config.context = self._context; }
		
		// We'll need to perform some initialisation on jQuery and Backbone before loading in custom modules,
		// so temporarily remove the core dependencies to prevent them loading in before this has been carried out
		var rootDependencies = config.deps || null;
		delete config.deps;
		
		// We're now ready to make the require.config call on the Require.js instance
		requirejs = requirejs.config(config);
		
		// jQuery relies on the global window variable, so expose that temporarily before we load jQuery
		_setGlobal('window', window);
		
		// Load in jQuery using the app's require.config
		requirejs(['jquery'], function($) {
			// Now that jQuery has initialised, we can unset the global window variable
			_unsetGlobal('window');
			
			// Load in backbone using the app's require.config
			requirejs(['backbone'], function(Backbone) {
				
				// Perform various hacks to get Backbone working server-side
				_initBackbone(Backbone, $);
				
				// Retain a reference to the app's Backbone instance
				self._backbone = Backbone;
				
				// Now we've fixed up Backbone and jQuery, we're ready to load in the app's main dependencies (if there are any)
				if (rootDependencies) {
					
					requirejs(rootDependencies, function() {
						// The app is now up and running, so invoke the callback
						if (callback) { callback(); }
					});
					
				} else {
					
					// There weren't any root dependencies to load, so invoke the callback
					if (callback) { callback(); }
					
				}
				
				
				/**
				 * Perform various hacks to get Backbone working server-side
				 * @param {Backbone} Backbone Backbone instance loaded by Require.js
				 * @param {jQuery} $ jQuery instance loaded by Require.js
				 * @private
				 */
				function _initBackbone(Backbone, $) {
					// The $ object was not made globally available to Backbone, so set it manually 
					Backbone.$ = $;
					
					// The backbone history module relies on the location and history objects being set
					Backbone.history.location = window.location;
					Backbone.history.history = window.history;
					
					// Some of the backbone history methods rely on the top-level browser variables to function correctly.
					// We need to override these with proxy methods that temporarily set these global variables while the function executes
					Backbone.history.start = _setGlobals(Backbone.history.start, { window: window, navigator: window.navigator, document: document });
					Backbone.history.stop = _setGlobals(Backbone.history.stop, { window: window });
					Backbone.history.navigate = _setGlobals(Backbone.history.navigate, { document: document });
					
					
					/**
					 * Create a modified version of a function that temporarily exposes certain specified global variables
					 * @param {function} method The method to be modified
					 * @param {object} globals Key-value hash of the required global variables and their values
					 * @return {function} Modified version of the function that has access to the specified global variables
					 */
					function _setGlobals(method, globals) {
						return function() {
							// Apply the global properties
							for (var property in globals) { _setGlobal(property, globals[property]); }
							
							// Call the overridden method
							method.apply(this, arguments);
							
							// Unset the global properties 
							for (var property in globals) { _unsetGlobal(property); }
						}
					}
				}
			});	
		});
	});
};

var globals = {};

function _setGlobal(property,value) {
	if (property in globals) {
		globals[property]++;
	} else {
		global[property] = value;
		globals[property] = 1;
	}
}

function _unsetGlobal(property) {
	if (!(property in globals)) { return; }
	if (--globals[property] === 0) {
		delete global[property];
		delete globals[property];
	}
}

module.exports = Doppelganger;