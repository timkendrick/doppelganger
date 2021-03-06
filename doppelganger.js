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
 * Version of Require.js that has been loaded into the app
 * @type {Function}
 * @private
 */
Doppelganger.prototype._requirejs = null;

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
	// Due to some dependencies (e.g. jQuery) relying on global variables, only one app can be initialised at once.
	// If another app instance is currently initialising, add this one to the queue and bail out
	if (initialising) {
		initQueue.push({ app: this, callback: callback });
		return;
	} else {
		initialising = true;
	}
	
	// Get the base URL of the Require.js script directory
	var requirejsPath = this._configPath.substr(0, this._configPath.lastIndexOf('/') + 1);
	
	// Use JSDOM to create a document element
	this._document = this._createDOM(this._html);
	
	// Retain a reference to this instance for use in nested functions
	var self = this;
	
	// Initialise the app through Require.js
	this._initRequireJS(requirejs, requirejsPath, this._configPath, this._document, _handleAppInitialised);
	
	
	function _handleAppInitialised() {
		initialising = false;
		if (initQueue.length > 0) {
			var queueItem = initQueue.shift();
			queueItem.app.init(queueItem.callback);
		}
		if (callback) { callback(self); }
	}
};

/**
 * Require dependencies from within the app instance using its version of Require.js.
 * Arguments are passed through unmodified to the Require.js `require()` function.
 * See the Require.js documentation for the possible syntax variations when calling the `require()` function.
 * @param {...} arguments Arguments to pass to Require.js
 * @return * Value returned from Require.js
 */
Doppelganger.prototype.require = function() {
	if (!this._requirejs) { throw new Error("Doppelganger app has not yet been initialised"); }
	return this._requirejs.apply(null, arguments);
};

/**
 * Check whether the specified path is a valid route within the app
 * @param {String} path The path to test
 * @return {RegExp|Boolean} The regular expression describing a matching route, or false if the path is invalid
 */
Doppelganger.prototype.routeExists = function(path) {
	if (!this._backbone) { return false; }
	if (this._backbone.history.handlers.length === 0 && !path) { return true; }
	return _(this._backbone.history.handlers).find(function(handler) { return handler.route.test(path); }) || false;
};

/**
 * Navigate to a different page within the app
 * @param {String} path The path to navigate to
 */
Doppelganger.prototype.navigate = function(path) {
	if (this.routeExists(path) && (this._backbone.history.handlers.length !== 0)) {
		this._backbone.history.navigate(path, true)
	}
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
	
	// Some dependencies (e.g. jQuery) rely on certain globals (e.g. window) being present when they are loaded
	// Create a dictionary to keep track of which ones have been set temporarily during app initialisation
	var globals = {};
	
	// Load the Require.js config file as text, so that we can manipulate it without having to call it first
	fs.readFile(configPath, 'utf8', function(error, data) {
		if (error) { throw error; }
		
		// Parse the config file and return an updated config object
		var config = _getConfigObject(data, configPath, self._context);
		
		// We'll need to perform some initialisation on jQuery and Backbone before loading in custom modules,
		// so temporarily remove the core dependencies to prevent them loading in before this has been carried out
		var rootDependencies = config.deps || null;
		delete config.deps;
		
		// We're now ready to make the require.config call on the Require.js instance
		requirejs = requirejs.config(config);
		
		// Now we've got the modified `require()` function specific to this configuration, retain it for future use
		self._requirejs = requirejs;
		
		// jQuery relies on the global window variable, so expose that temporarily before we load jQuery
		_setGlobal('window', window);
		
		// Load in jQuery using the app's require.config
		requirejs(['jquery'], function($) {
			
			// Now that jQuery has initialised, we can unset the global window variable
			_unsetGlobal('window');
			
			// Load in backbone using the app's require.config
			requirejs(['backbone'], function(Backbone) {
				
				// Perform various hacks to get Backbone working server-side
				_initBackbone(Backbone, $, window, document);
				
				// Retain a reference to the app's Backbone instance
				self._backbone = Backbone;
				
				// Now we've fixed up Backbone and jQuery, we're ready to load in the app's main dependencies
				if (rootDependencies) {
					
					requirejs(rootDependencies, function() {
						// The app is now up and running, so invoke the callback
						if (callback) { callback(); }
					});
					
				} else {
					
					// There weren't any root dependencies to load, so invoke the callback
					if (callback) { callback(); }
					
				}
			});	
		});
		
		
		function _getConfigObject(configFileData, configFilePath, context) {
			// Parse the config file for a require.config(...) call, taking note of the section between the parentheses
			var configSearch = /require\s*\.\s*config\s*\(([^]+)\)/.exec(configFileData);
			
			// Convert the config string to a JS object (hacky...)
			var config = configSearch && new Function('return ' + configSearch[1] + ';')();
			if (!config) { throw new Error('Invalid Require.js config file specified'); }
			
			// Add additional config parameters for server-side use
			config.baseUrl = configFilePath.substr(0, configFilePath.lastIndexOf('/') + 1);
			config.nodeRequire = require;
			
			// Set the Require.js context, if there is one specified
			if (context) { config.context = context; }
			
			return config;
		}
	});
	
	
	/**
	 * Perform various hacks to get Backbone working server-side
	 * @param {Backbone} Backbone Backbone instance loaded by Require.js
	 * @param {jQuery} $ jQuery instance loaded by Require.js
	 * @param {Window} window DOM window object
	 * @param {Document} document DOM document object
	 * @private
	 */
	function _initBackbone(Backbone, $, window, document) {
		// The $ object was not made globally available to Backbone, so set it manually 
		Backbone.$ = $;
		
		// The backbone history module relies on the location and history objects being set
		Backbone.history.location = window.location;
		Backbone.history.history = window.history;
		
		// Some of the backbone history methods rely on the top-level browser variables to function correctly.
		// We need to override these with proxy methods that temporarily set these globals while the function executes
		Backbone.history.start = _exposeGlobals(Backbone.history.start,
			{
				window: window,
				navigator: window.navigator,
				document: document
			}
		);
		Backbone.history.stop = _exposeGlobals(Backbone.history.stop, { window: window });
		Backbone.history.navigate = _exposeGlobals(Backbone.history.navigate, { document: document });
	}
	
	/**
	 * Set the value of a global variable.
	 * Variables that have already been assigned a value using this function will not have their values updated.
	 * @param {String} property Name of the global variable 
	 * @param {*} value Value to assign to the global variable
	 * @return {*} The updated value assigned to the global variable
	 * @private
	 */
	function _setGlobal(property, value) {
		if (property in globals) {
			globals[property]++;
		} else {
			global[property] = value;
			globals[property] = 1;
		}
		return global[property];
	}
	
	/**
	 * Unset a global variable that was previously assigned using the `_setGlobal()` function.
	 * If the `_setGlobal()` function has been called more than once for this global variable name, the global variable 
	 * will not be unset until this function has been called as many times as the `_setGlobal()` function was called.
	 * @param {String} property Name of the global variable
	 * @return {Boolean} `true` if the variable was deleted from the global names
	 * @private
	 */
	function _unsetGlobal(property) {
		if (!(property in globals)) { return false; }
		if (--globals[property] === 0) {
			delete global[property];
			delete globals[property];
			return true;
		}
		return false;
	}
	
	/**
	 * Create a modified version of a function that temporarily exposes certain specified global variables
	 * @param {function} method The method to be modified
	 * @param {object} globals Key-value hash of the required global variables and their values
	 * @return {function} Modified version of the function that has access to the specified global variables
	 */
	function _exposeGlobals(method, globals) {
		return function() {
			// Apply the global properties
			for (var property in globals) { _setGlobal(property, globals[property]); }
			
			// Call the overridden method
			method.apply(this, arguments);
			
			// Unset the global properties 
			for (var property in globals) { _unsetGlobal(property); }
		}
	}
};

// Variables used to ensure that only one app instance is initialised at once
var initialising = false;
var initQueue = [];

module.exports = Doppelganger;