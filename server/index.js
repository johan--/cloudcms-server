var express = require('express');
var http = require('http');
var https = require('https');
var path = require('path');
var fs = require('fs');
var clone = require('clone');
var bytes = require('bytes');
var moment = require("moment");

var async = require('../util/async');

var morgan = require("morgan");
var bodyParser = require("body-parser");
var errorHandler = require("errorhandler");
var multipart = require("connect-multiparty");
var session = require('express-session');
var cookieParser = require('cookie-parser');

var util = require("../util/util");

var launchPad = require("../launchpad/index");
var cluster = require("cluster");

var app = express();
app.disable('x-powered-by');

// cloudcms app server support
var main = require("../index");

// duster service
var duster = require("../duster/index");

var defaultHelpers = require("../duster/helpers/default");

var requestCounter = 0;

// holds configuration settings
var SETTINGS = {
    "setup": "single", // single, multiple, cluster
    "name": "Cloud CMS Application Server",
    "socketFunctions": [],
    "routeFunctions": [],
    "configureFunctions": {},
    "beforeFunctions": [],
    "afterFunctions": [],
    "reportFunctions": [],
    "dustFunctions": [],
    "viewEngine": "handlebars",
    "storeEngines": {
        "app": {
            "type": "fs",
            "config": {
                "basePath": "{appBasePath}"
            }
        },
        "tmp": {
            "type": "fs",
            "config": {
                "basePath": "{tmpdirPath}/hosts/{host}",
                "hostsPath": "{tmpdirPath}/hosts"
            }
        },
        "hosts_fs": {
            "type": "fs",
            "config": {
                "basePath": "/hosts/{host}",
                "hostsPath": "/hosts"
            }
        },
        "hosts_s3": {
            "type": "s3",
            "config": {
                "accessKey": "",
                "secretKey": "",
                "bucket": "",
                "basePath": "/hosts/{host}",
                "hostsPath": "/hosts"
            }
        },
        "hosts_s3fs": {
            "type": "s3fs",
            "config": {
                "accessKey": "",
                "secretKey": "",
                "bucket": "",
                "basePath": "/hosts/{host}",
                "hostsPath": "/hosts"
            }
        }
    },
    "storeConfigurations": {
        "default": {
            "root": "app",
            "config": "app",
            "web": "app",
            "content": "tmp",
            "templates": "app",
            "modules": "app"
        },
        "oneteam": {
            "root": "hosts_fs",
            "config": "app",
            "web": "app",
            "content": "hosts_fs",
            "templates": "app",
            "modules": "hosts_fs"
        },
        "net-development": {
            "root": "hosts_fs",
            "config": "hosts_fs",
            "web": "hosts_fs",
            "content": "hosts_fs",
            "templates": "hosts_fs",
            "modules": "hosts_fs"
        },
        "net-production": {
            "root": "hosts_s3fs",
            "config": "hosts_s3fs",
            "web": "hosts_s3fs",
            "content": "hosts_s3fs",
            "templates": "hosts_s3fs",
            "modules": "hosts_s3fs"
        },
        "net-development-s3": {
            "root": "hosts_s3",
            "config": "hosts_s3",
            "web": "hosts_s3",
            "content": "hosts_s3",
            "templates": "hosts_s3"
        },
        "net-development-s3fs": {
            "root": "hosts_s3fs",
            "config": "hosts_s3fs",
            "web": "hosts_s3fs",
            "content": "hosts_s3fs",
            "templates": "hosts_s3fs",
            "modules": "hosts_s3fs"
        }
    },
    "duster": {
        "fragments": {
            "cache": true
        }
    },
    "virtualHost": {
        "enabled": false // true
    },
    "wcm": {
        "enabled": false, // true
        "cache": false
    },
    "serverTags": {
        "enabled": false // true
    },
    "insight": {
        "enabled": false // true
    },
    "perf": {
        "enabled": true // true
    },
    "driverConfig": {
        "enabled": true
    },
    "virtualDriver": {
        "enabled": false
    },
    "virtualContent": {
        "enabled": true
    },
    "flow": {
        "enabled": false
    },
    "auth": {
        "enabled": true,
        "providers": {
            "facebook": {
                "enabled": false
            },
            "twitter": {
                "enabled": false
            },
            "linkedin": {
                "enabled": false
            }
        }
    },
    "notifications": {
        "enabled": false,
        "type": "sqs",
        "configuration": {
            "queue": "",
            "accessKey": "",
            "secretKey": "",
            "region": ""
        }
    },
    "broadcast": {
        "enabled": true
    },
    "local": {
        "enabled": true
    },
    "welcome": {
        "enabled": true,
        "file": "index.html"
    },
    "config": {
        "enabled": true
    },
    "cache": {
        "enabled": true
    },
    "templates": {
        "enabled": true
    },
    "modules": {
        "enabled": true
    }
};

// runs on 2999 by default
process.env.PORT = process.env.PORT || 2999;

// allows for specification of alternative transports
SETTINGS.socketTransports = [
    'xhr-polling',
    'jsonp-polling',
    'polling'
];

var exports = module.exports;

/**
 * Sets a configuration key/value.
 *
 * @param key
 * @param value
 */
exports.set = function (key, value) {
    SETTINGS[key] = value;
};

/**
 * Gets a configuration key/value.
 *
 * @param key
 * @return {*}
 */
exports.get = function (key) {
    return SETTINGS[key];
};

/**
 * Registers an express configuration function for a specific environment.
 *
 * @param env
 * @param fn
 */
exports.configure = function (env, fn) {
    if (!SETTINGS.configureFunctions[env]) {
        SETTINGS.configureFunctions[env] = [];
    }

    SETTINGS.configureFunctions[env].push(fn);
};

/**
 * Registers a socket configuration function.
 *
 * @param fn
 */
exports.sockets = function (fn) {
    SETTINGS.socketFunctions.push(fn);
};

/**
 * Registers a route configuration function.
 *
 * @param fn
 */
exports.routes = function (fn) {
    SETTINGS.routeFunctions.push(fn);
};

/**
 * Adds an initialization function to set up dust.
 *
 * The function must have signature fn(app, dust)
 *
 * @param helperFn
 */
var dust = exports.dust = function(fn) {
    SETTINGS.dustFunctions.push(fn);
};

/**
 * Registers a function to run before the server starts.
 *
 * @param fn
 */
var before = exports.before = function (fn) {
    SETTINGS.beforeFunctions.push(fn);
};

/**
 * Registers a function to run after the server starts.
 *
 * @param fn
 */
var after = exports.after = function (fn) {
    SETTINGS.afterFunctions.push(fn);
};

/**
 * Registers a function to run after all server instances have started
 *
 * @param fn
 */
var report = exports.report = function (fn) {
    SETTINGS.reportFunctions.push(fn);
};

/*******************************************************************************************************/
/*******************************************************************************************************/
/*******************************************************************************************************/

var runFunctions = function (functions, args, callback) {

    // skip out early if nothing to do
    if (!functions || functions.length === 0) {
        callback();
        return;
    }

    async.series(functions, args, function (err) {

        if (err) {
            console.log(err);
            throw new Error(err);
        }

        callback(err);
    });
};


/*******************************************************************************************************/
/*******************************************************************************************************/
/*******************************************************************************************************/

/**
 * Starts the Cloud CMS server.
 *
 * @param overrides optional config overrides
 * @param callback optional callback function
 */
exports.start = function(overrides, callback) {

    if (typeof(overrides) === "function") {
        callback = overrides;
        overrides = null;
    }

    if (!callback) {
        callback = function() {};
    }

    // DUST - some setup
    if (!SETTINGS.dustFunctions) {
        SETTINGS.dustFunctions = [];
    }
    // always push default tags to the front
    SETTINGS.dustFunctions.unshift(defaultHelpers);
    // if no other custom dust tags are configured, we include NYT example by default
    if (SETTINGS.dustFunctions.length === 1)
    {
        dust(require("../duster/helpers/nyt"));
    }

    // create our master config
    var config = clone(SETTINGS);
    if (overrides) {
        util.merge(overrides, config);
    }

    // assume for launchpad
    if (!config.setup) {
        config.setup = "single";
    }

    launchPad({
        "setup": config.setup,
        "factory": function(done) {
            startSlave(config, function(app, server) {
                done(server);
            });
        },
        "report": function() {
            runFunctions(config.reportFunctions, [], function(err) {
                // todo
            });
        },
        "complete": function() {
            callback();
        }
    });
};

var startSlave = function(config, afterStartFn)
{
    // set up modes
    process.env.CLOUDCMS_APPSERVER_MODE = "development";

    if (process.env.NODE_ENV == "production") {
        process.env.CLOUDCMS_APPSERVER_MODE = "production";
    }

    // set up domain hosting
    // if not otherwise specified, we assume hosting at *.cloudcms.net
    if (!process.env.CLOUDCMS_DOMAIN) {
        process.env.CLOUDCMS_DOMAIN = "cloudcms.net";
    }


    // store config on process instance
    process.configuration = config;

    // some config overrides can come in through process.configuration
    if (process.configuration) {
        if (process.configuration.virtualHost && process.configuration.virtualHost.domain) {
            if (!process.env.CLOUDCMS_DOMAIN) {
                process.env.CLOUDCMS_DOMAIN = process.configuration.virtualHost.domain;
            }
        }
    }
    if (process.env.CLOUDCMS_DOMAIN) {
        process.env.CLOUDCMS_DOMAIN = process.env.CLOUDCMS_DOMAIN.toLowerCase();
    }

    // session store
    var initializedSession = null;
    if (process.configuration.session)
    {
        if (process.configuration.session.enabled)
        {
            var sessionConfig = {
                secret: 'secret',
                resave: false,
                saveUninitialized: false
            };

            if (process.configuration.session.type === "file")
            {
                // session file store
                var SessionFileStore = require('session-file-store')(session);
                sessionConfig.store = new SessionFileStore();
            }

            initializedSession = session(sessionConfig);
        }
    }

    // global temp directory
    util.createTempDirectory(function(err, tempDirectory) {
        process.env.CLOUDCMS_TEMPDIR_PATH = tempDirectory;

        // determine the max files
        util.maxFiles(function(err, maxFiles) {

            process.env.CLOUDCMS_MAX_FILES = maxFiles;

            // global service starts
            main.init(function (err) {

                //console.log("");
                //console.log("Starting " + config.name);
                //console.log("Settings: " + JSON.stringify(config, null, "   "));

                app.enable('strict routing');

                ////////////////////////////////////////////////////////////////////////////
                //
                // VIRTUAL SUPPORT
                //
                // Configure NodeJS to load virtual driver and configure for virtual descriptors
                // ahead of anything else running.
                //
                ////////////////////////////////////////////////////////////////////////////

                // custom morgan logger
                morgan(function (tokens, req, res) {

                    var status = res.statusCode;
                    var len = parseInt(res.getHeader('Content-Length'), 10);
                    var host = req.domainHost;
                    if (!host)
                    {
                        host = req.hostname;
                    }
                    len = isNaN(len) ? '0b' : len = bytes(len);

                    var d = new Date();
                    var dateString = d.toDateString();
                    var timeString = d.toTimeString();

                    // gray color
                    var grayColor = "\x1b[90m";

                    // status color
                    var color = 32;
                    if (status >= 500) color = 31
                    else if (status >= 400) color = 33
                    else if (status >= 300) color = 36;
                    var statusColor = "\x1b[" + color + "m"

                    // final color
                    var finalColor = "\x1b[0m";

                    if (process.env.CLOUDCMS_APPSERVER_MODE == "production")
                    {
                        grayColor = "";
                        statusColor = "";
                        finalColor = "";
                    }

                    var message = '';
                    message += grayColor + '<' + req.id + '> ';
                    message += grayColor + '[' + dateString + ' ' + timeString + '] ';
                    message += grayColor + host + ' ';
                    //message += grayColor + '(' + req.ip + ') ';
                    message += statusColor + res.statusCode + ' ';
                    message += statusColor + (new Date - req._startTime) + ' ms ';
                    message += grayColor + '"' + req.method + ' ';
                    message += grayColor + req.originalUrl + '" ';
                    message += grayColor + len + ' ';
                    message += finalColor;

                    return message;
                });

                /*
                 // debug headers being set
                 app.use(function(req, res, next) {
                 var setHeader = res.setHeader;
                 res.setHeader = function(a,b) {
                 console.trace("Writing header: " + a + " = " + b);
                 setHeader.call(this, a,b);
                 };
                 next();
                 });
                 */

                // add req.id  re
                app.use(function (req, res, next) {
                    requestCounter++;
                    req.id = requestCounter;
                    next();
                });

                app.use(function (req, res, next) {
                    req.originalUrl = req.url;
                    req.originalPath = req.path;
                    next();
                });

                // add req.log function
                app.use(function (req, res, next) {

                    req.log = function (text) {

                        var host = req.domainHost;
                        if (!host)
                        {
                            host = req.hostname;
                        }

                        var timestamp = moment(new Date()).format("MM/DD/YYYY HH:mm:ss Z");
                        var grayColor = "\x1b[90m";
                        var finalColor = "\x1b[0m";

                        // in production, don't use colors
                        if (process.env.CLOUDCMS_APPSERVER_MODE === "production")
                        {
                            grayColor = "";
                            finalColor = "";
                        }

                        var message = '';
                        message += grayColor + '<' + req.id + '> ';
                        if (cluster.worker && cluster.worker.id)
                        {
                            message += grayColor + '(' + cluster.worker.id + ') ';
                        }
                        message += grayColor + '[' + timestamp + '] ';
                        message += grayColor + host + ' ';
                        message += grayColor + text + '';
                        message += finalColor;

                        console.log(message);
                    };

                    req._log = req.log;

                    next();
                });

                // some cosmetic things
                app.use(function (req, res, next) {
                    res.header("X-Powered-By", "Cloud CMS");
                    next();
                });

                // common interceptors and config
                main.common1(app);

                // initial log
                app.use(function (req, res, next) {
                    req.log(req.method + " " + req.url);
                    next();
                });

                // set up CORS allowances
                // this lets CORS requests float through the proxy
                app.use(main.ensureCORS());

                // common interceptors and config
                main.common2(app);

                // PATH BASED PERFORMANCE CACHING
                main.perf1(app);

                // proxy - anything that goes to /proxy is handled here early and nothing processes afterwards
                main.proxy(app);

                // MIMETYPE BASED PERFORMANCE CACHING
                main.perf2(app);

                // standard body parsing + a special cloud cms body parser that makes a last ditch effort for anything
                // that might be JSON (regardless of content type)
                app.use(function (req, res, next) {

                    multipart()(req, res, function (err) {
                        bodyParser.json()(req, res, function (err) {
                            bodyParser.urlencoded({
                                extended: true
                            })(req, res, function (err) {
                                main.bodyParser()(req, res, function (err) {
                                    next(err);
                                });
                            });
                        });
                    });

                });

                // welcome files
                main.welcome(app);


                ////////////////////////////////////////////////////////////////////////////
                //
                // BASE CONFIGURATION
                //
                // Configures NodeJS app server using dustjs templating engine
                // Runs on port 2999 by default
                //
                ////////////////////////////////////////////////////////////////////////////

                // all environments
                app.set('port', process.env.PORT);
                app.set('views', process.env.CLOUDCMS_APPSERVER_BASE_PATH + "/views");

                if (config.viewEngine === "dust")
                {
                    app.set('view engine', 'html');
                    var cons = require('consolidate');
                    app.engine('html', cons.dust);
                }
                else if (config.viewEngine === "jade")
                {
                    app.set('view engine', 'jade');
                }
                else if (config.viewEngine === "handlebars" || config.viewEngine === "hbs")
                {
                    app.set('view engine', 'html');
                    var hbs = require('hbs');
                    app.engine('html', hbs.__express);
                }

                //app.use(cookieParser("secret"));
                app.use(cookieParser());

                if (initializedSession)
                {
                    app.use(initializedSession);
                }

                // configure cloudcms app server command handing
                main.interceptors(app, true);

                //app.use(app.router);
                app.use(errorHandler());

                // APPLY CUSTOM ROUTES
                runFunctions(config.routeFunctions, [app], function (err) {

                    // configure cloudcms app server handlers
                    main.handlers(app, true);

                    // APPLY CUSTOM CONFIGURE FUNCTIONS
                    var allConfigureFunctions = [];
                    for (var env in config.configureFunctions)
                    {
                        var functions = config.configureFunctions[env];
                        if (functions)
                        {
                            for (var i = 0; i < functions.length; i++)
                            {
                                allConfigureFunctions.push(functions[i]);
                            }
                        }
                    }
                    runFunctions(allConfigureFunctions, [app], function (err) {

                        ////////////////////////////////////////////////////////////////////////////
                        //
                        // INITIALIZE THE SERVER
                        //
                        ////////////////////////////////////////////////////////////////////////////

                        // CORE OBJECTS
                        var server = http.Server(app);
                        server.setTimeout(30000); // 30 seconds
                        server.on("connection", function (socket) {
                            socket.setNoDelay(true);
                        });
                        var io = process.IO = require("socket.io")(server);
                        io.set('transports', config.socketTransports);
                        io.use(function (socket, next) {

                            console.log("New socket being initialized");

                            // attach _log function
                            socket._log = function (text) {

                                var host = socket.handshake.headers.host;
                                if (socket.handshake.headers["x-forwarded-host"])
                                {
                                    host = socket.handshake.headers["x-forwarded-host"];
                                }

                                var d = new Date();
                                var dateString = d.toDateString();
                                var timeString = d.toTimeString();

                                // gray color
                                var grayColor = "\x1b[90m";

                                // final color
                                var finalColor = "\x1b[0m";

                                if (process.env.CLOUDCMS_APPSERVER_MODE === "production")
                                {
                                    grayColor = "";
                                    finalColor = "";
                                }

                                var message = '';
                                message += grayColor + '<socket> ';
                                message += grayColor + '[' + dateString + ' ' + timeString + '] ';
                                message += grayColor + host + ' ';
                                message += grayColor + text + '';
                                message += finalColor;

                                console.log(message);
                            };
                            socket.on("connect", function () {
                                console.log("Socket connect()");
                            });
                            socket.on("disconnect", function () {
                                var message = "Socket disconnected";
                                if (socket && socket.host)
                                {
                                    message += ", host=" + socket.host;
                                }
                                if (socket && socket.gitana && socket.gitana.application && socket.gitana.application())
                                {
                                    message += ", application=" + socket.gitana.application().title;
                                }
                                console.log(message);
                            });

                            // APPLY CUSTOM SOCKET.IO CONFIG
                            runFunctions(config.socketFunctions, [socket], function (err) {

                                // INSIGHT SERVER
                                if (config.insight && config.insight.enabled)
                                {
                                    console.log("Init Insight to Socket");

                                    require("../insight/insight").init(socket, function () {
                                        next();
                                    });
                                }
                                else
                                {
                                    next();
                                }
                            });

                        });

                        // SET INITIAL VALUE FOR SERVER TIMESTAMP
                        process.env.CLOUDCMS_APPSERVER_TIMESTAMP = new Date().getTime();

                        // DUST
                        runFunctions(config.dustFunctions, [app, duster.getDust()], function (err) {

                            // APPLY SERVER BEFORE START FUNCTIONS
                            runFunctions(config.beforeFunctions, [app], function (err) {

                                server._listenPort = app.get("port");

                                // AFTER SERVER START
                                runFunctions(config.afterFunctions, [app], function (err) {

                                    // if we are on a worker process, then inform the master that we completed
                                    if (process.send)
                                    {
                                        process.send("server-startup");
                                    }

                                    afterStartFn(app, server);

                                });
                            });
                        });
                    });
                });
            });
        });
    });
};


////////////////////////////////////////////////////////////////////////////
//
// DEFAULT HANDLERS
//
////////////////////////////////////////////////////////////////////////////

// default before function
before(function (app, callback) {
    callback();
});

// default after function
after(function (app, callback) {
    callback();
});
