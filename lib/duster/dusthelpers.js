var path = require('path');
var fs = require('fs');
var http = require('http');
var util = require("util");

var mkdirp = require('mkdirp');

var Gitana = require('gitana');

exports = module.exports = function(dust)
{
    var isDefined = function(thing)
    {
        return (typeof(thing) != "undefined");
    };

    /**
     * Helper function that sets the dust cursor to flushable.
     * This is to get around an apparent bug with dust:
     *
     *    https://github.com/linkedin/dustjs/issues/303
     *
     * @param chunk
     * @param callback
     * @returns {*}
     */
    var map = function(chunk, callback)
    {
        var cursor = chunk.map(function(branch) {
            callback(branch);
        });
        cursor.flushable = true;

        return cursor;
    };

    /**
     * Helper function to end the chunk.  This is in place because it's unclear exactly what is needed to counter
     * the issue mentioned in:
     *
     *    https://github.com/linkedin/dustjs/issues/303
     *
     * At one point, it seemed that some throttling of the end() call was required.  It may still be at some point.
     * So for now, we use this helper method to end() since it lets us inject our own behaviors if needed.
     *
     * @param chunk
     * @param context
     */
    var end = function(chunk, context)
    {
        chunk.end();
    };

    /**
     * Handles behavior for @query and @queryOne.
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     * @param keepOne
     * @returns {*}
     * @private
     */
    var _handleQuery = function(chunk, context, bodies, params, keepOne)
    {
        params = params || {};

        // type
        var type = dust.helpers.tap(params.type, chunk, context);

        // pagination
        var sort = dust.helpers.tap(params.sort, chunk, context);
        var limit = dust.helpers.tap(params.limit, chunk, context);
        var skip = dust.helpers.tap(params.skip, chunk, context);

        // scope
        var scope = dust.helpers.tap(params.scope, chunk, context);

        // as
        var as = dust.helpers.tap(params.as, chunk, context);

        // ensure limit and skip are numerical
        if (isDefined(limit))
        {
            limit = parseInt(limit);
        }
        if (isDefined(skip))
        {
            limit = parseInt(skip);
        }

        return map(chunk, function(chunk) {
            setTimeout(function() {

                var gitana = context.get("gitana");

                var errHandler = function(err) {
                    console.log("ERROR: " + err);
                    end(chunk, context);
                };

                var query = {};
                if (isDefined(type))
                {
                    query._type = type;
                }

                var pagination = {};
                if (!isDefined(limit)) {
                    limit = -1;
                }
                pagination.limit = limit;
                if (isDefined(sort))
                {
                    pagination.sort = {};
                    pagination.sort[sort] = 1;
                }
                if (isDefined(skip))
                {
                    pagination.skip = skip;
                }

                Chain(gitana.datastore("content")).trap(errHandler).readBranch("master").then(function() {

                    var branch = this;

                    var doQuery = function(branch, query, pagination)
                    {
                        if (keepOne)
                        {
                            Chain(branch).queryNodes(query, pagination).then(function() {

                                var newContext = null;
                                if (this.totalRows() > 0)
                                {
                                    var result = this.asArray()[0];

                                    var resultObject = null;
                                    if (as)
                                    {
                                        resultObject = {};
                                        resultObject[as] = JSON.parse(JSON.stringify(result));
                                    }
                                    else
                                    {
                                        resultObject = JSON.parse(JSON.stringify(result));
                                    }

                                    newContext = context.push(resultObject);
                                }
                                else
                                {
                                    newContext = context.push({});
                                }

                                chunk.render(bodies.block, newContext);
                                end(chunk, context);
                            });
                        }
                        else
                        {
                            Chain(branch).queryNodes(query, pagination).then(function() {

                                var resultObject = null;
                                if (as)
                                {
                                    resultObject = {};
                                    resultObject[as] = {
                                        "rows": this.asArray(),
                                        "offset": this.offset(),
                                        "total": this.totalRows()
                                    };
                                }
                                else
                                {
                                    resultObject = {
                                        "rows": this.asArray(),
                                        "offset": this.offset(),
                                        "total": this.totalRows()
                                    };
                                }

                                var newContext = context.push(resultObject);

                                chunk.render(bodies.block, newContext);
                                end(chunk, context);
                            });
                        }
                    };

                    if (isDefined(scope))
                    {
                        var page = context.get("helpers")["page"];

                        var processPageItems = function()
                        {
                            var docFields = [];
                            for (var i = 0; i < page.items.length; i++)
                            {
                                docFields.push(page.items[i]._doc);
                            }
                            query["_doc"] = {"$in": docFields};
                            doQuery(branch, query, pagination);
                        };

                        if (!page.items)
                        {
                            page.items = [];
                            Chain(page).trap(function(err) {
                                console.log("ERR: " + JSON.stringify(err));
                            }).listRelatives({
                                "type": "wcm:page_has_content"
                            }, {
                                "limit": 99999
                            }).each(function() {
                                page.items.push(this);
                            }).then(function() {
                                processPageItems();
                            });
                        }
                        else
                        {
                            processPageItems();
                        }
                    }
                    else
                    {
                        doQuery(branch, query, pagination);
                    }

                });

            });
        });
    };

    /**
     * QUERY
     *
     * Queries for content from the content repository and renders.
     *
     * Syntax:
     *
     *    {@query sort="title" scope="page" type="custom:type" limit="" skip="" as=""}
     *       {+templateIdentifier/}
     *    {/query}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    dust.helpers.query = function(chunk, context, bodies, params)
    {
        return _handleQuery(chunk, context, bodies, params, false);
    };

    /**
     * QUERY AND KEEP ONE
     *
     * Queries for content from the content repository and renders.
     *
     * Syntax:
     *
     *    {@queryOne sort="title" scope="page" type="custom:type" limit="" skip="" as=""}
     *       {+templateIdentifier/}
     *    {/query}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    dust.helpers.queryOne = function(chunk, context, bodies, params)
    {
        return _handleQuery(chunk, context, bodies, params, true);
    };

    /**
     * SEARCH
     *
     * Searches for content and renders.
     *
     * Syntax:
     *
     *    {@search sort="title" scope="page" text="something" limit="" skip="" as=""}
     *       {+templateIdentifier/}
     *    {/search}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    dust.helpers.search = function(chunk, context, bodies, params)
    {
        params = params || {};

        // pagination
        var sort = dust.helpers.tap(params.sort, chunk, context);
        var limit = dust.helpers.tap(params.limit, chunk, context);
        var skip = dust.helpers.tap(params.skip, chunk, context);

        // scope
        var scope = dust.helpers.tap(params.scope, chunk, context);

        // text
        var text = dust.helpers.tap(params.text, chunk, context);

        // as
        var as = dust.helpers.tap(params.as, chunk, context);

        // ensure limit and skip are numerical
        if (isDefined(limit))
        {
            limit = parseInt(limit);
        }
        if (isDefined(skip))
        {
            limit = parseInt(skip);
        }

        return map(chunk, function(chunk) {
            setTimeout(function() {

                var gitana = context.get("gitana");

                var errHandler = function(err) {
                    console.log("ERROR: " + err);
                    end(chunk, context);
                };

                Chain(gitana.datastore("content")).trap(errHandler).readBranch("master").then(function() {

                    // TODO: use a "find" to limit to a range of nodes (for page scope)?

                    var pagination = {};
                    if (!isDefined(limit)) {
                        limit = -1;
                    }
                    pagination.limit = limit;
                    if (sort)
                    {
                        pagination.sort = {};
                        pagination.sort[sort] = 1;
                    }
                    if (skip)
                    {
                        pagination.skip = skip;
                    }

                    this.searchNodes(text, pagination).then(function() {

                        var resultObject = null;
                        if (as)
                        {
                            resultObject = {};
                            resultObject[as] = {
                                "rows": this.asArray(),
                                "offset": this.offset(),
                                "total": this.totalRows()
                            };
                        }
                        else
                        {
                            resultObject = {
                                "rows": this.asArray(),
                                "offset": this.offset(),
                                "total": this.totalRows()
                            };
                        }

                        var newContext = context.push(resultObject);

                        chunk.render(bodies.block, newContext);
                        end(chunk, context);
                    });
                });

            });
        });
    };

    /**
     * CONTENT
     *
     * Selects a single content item.
     *
     * Syntax:
     *
     *    {@content id="GUID" path="/a/b/c" as=""}
     *       {+templateIdentifier/}
     *    {/content}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    dust.helpers.content = function(chunk, context, bodies, params)
    {
        params = params || {};

        var id = dust.helpers.tap(params.id, chunk, context);
        var contentPath = dust.helpers.tap(params.path, chunk, context);

        // as
        var as = dust.helpers.tap(params.as, chunk, context);

        return map(chunk, function(chunk) {
            setTimeout(function() {

                var gitana = context.get("gitana");

                var errHandler = function(err) {

                    console.log("ERROR: " + err);
                    end(chunk, context);
                };

                var f = function(node)
                {
                    var newContextObject = null;
                    if (as)
                    {
                        newContextObject = {};
                        newContextObject[as] = {
                            "content": JSON.parse(JSON.stringify(node))
                        };
                    }
                    else
                    {
                        newContextObject["content"] = JSON.parse(JSON.stringify(node));
                    }

                    var newContext = context.push(newContextObject);

                    // add in attachments info
                    var attachments = {};
                    node.listAttachments().each(function() {
                        var id = this["_doc"];
                        attachments[id] = JSON.parse(JSON.stringify(this));
                        attachments[id]["url"] = "/static/node/" + node.getId() + "/attachments/" + id;
                        attachments[id]["preview32"] = "/static/node/" + node.getId() + "/preview/?attachment=" + id + "&size=32";
                        attachments[id]["preview64"] = "/static/node/" + node.getId() + "/preview/?attachment=" + id + "&size=64";
                        attachments[id]["preview128"] = "/static/node/" + node.getId() + "/preview/?attachment=" + id + "&size=128";
                        attachments[id]["preview256/"] = "/static/node/" + node.getId() + "/preview/?attachment=" + id + "&size=256";
                    }).then(function() {

                        newContext.content.attachments = attachments;

                        chunk.render(bodies.block, newContext);
                        end(chunk, context);
                    });
                };

                Chain(gitana.datastore("content")).trap(errHandler).readBranch("master").then(function() {

                    // select by ID or select by Path
                    if (id)
                    {
                        this.readNode(id).then(function() {
                            f(this);
                        });
                    }
                    else if (contentPath)
                    {
                        this.readNode("root", contentPath).then(function() {
                            f(this);
                        });
                    }
                    else
                    {
                        // missing both ID and Path?
                        console.log("Missing ID and PATH!");
                    }
                });

            });
        });
    };

    /**
     * FORM
     *
     * Renders a form.
     *
     * Syntax:
     *
     *    {@form definition="custom:type" form="formKey" list="listKeyOrId" successUrl="" errorUrl=""}
     *       {+templateIdentifier/}
     *    {/form}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    dust.helpers.form = function(chunk, context, bodies, params)
    {
        params = params || {};

        var definition = dust.helpers.tap(params.definition, chunk, context);
        var form = dust.helpers.tap(params.form, chunk, context);
        var list = dust.helpers.tap(params.list, chunk, context);
        var successUrl = dust.helpers.tap(params.success, chunk, context);
        var errorUrl = dust.helpers.tap(params.error, chunk, context);

        return map(chunk, function(chunk) {
            setTimeout(function() {

                var gitana = context.get("gitana");

                var errHandler = function(err) {

                    console.log("ERROR: " + err);
                    end(chunk, context);
                };

                Chain(gitana.datastore("content")).trap(errHandler).readBranch("master").then(function() {

                    // read the definition
                    this.readDefinition(definition).then(function() {
                        var schema = this;

                        // if a form is specified, read the form
                        var options = null;
                        this.readForm(form).then(function() {
                            options = this;
                        });

                        this.then(function() {

                            if (!options)
                            {
                                options = {};
                            }

                            var config = {
                                "schema": schema,
                                "options": options
                            };
                            if (list)
                            {
                                var action = "/form/" + list + "?a=1";
                                if (successUrl)
                                {
                                    action += "&successUrl=" + successUrl;
                                }
                                if (errorUrl)
                                {
                                    action += "&errorUrl=" + errorUrl;
                                }
                                options.renderForm = true;
                                options.form = {
                                    "attributes": {
                                        "method": "POST",
                                            "action": action,
                                            "enctype": "multipart/form-data",
                                            "data-ajax": "false"
                                    },
                                    "buttons": {
                                        "submit": {
                                            "value": "Submit"
                                        }
                                    }
                                };
                            }

                            var divId = "form" + new Date().getTime();

                            chunk.write("<div id='" + divId + "'></div>");
                            chunk.write("<script>\r\n$('#" + divId + "').alpaca(" + JSON.stringify(config) + ");</script>\r\n");
                            end(chunk, context);
                        });
                    });
                });

            });
        });
    };

    /**
     * Handles include behavior for @include and @module
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     * @param targetPath
     * @returns {*}
     * @private
     */
    var _handleInclude = function(chunk, context, bodies, params, targetPath)
    {
        return map(chunk, function(chunk) {
            setTimeout(function() {

                //console.log("");
                //console.log("Target Path: " + targetPath);

                var matchingFilePath = null;

                // the stack of executing template file paths
                var currentTemplateFilePaths = context.get("templateFilePaths").reverse();
                //console.log("Current Template File Paths: " + currentTemplateFilePaths);

                if (targetPath.indexOf("/") === 0)
                {
                    currentTemplateFilePaths = currentTemplateFilePaths.reverse();

                    // absolute path, always relative to the first element in the template file paths list
                    var filePath = path.resolve(currentTemplateFilePaths[0], "..", "." + targetPath);

                    // if the file path does not end with ".html", we append
                    if (filePath.indexOf(".html") == -1)
                    {
                        filePath += ".html";
                    }

                    if (fs.existsSync(filePath))
                    {
                        matchingFilePath = filePath;
                    }
                }
                else
                {
                    // relative path, walk the template file paths list backwards
                    for (var a = 0; a < currentTemplateFilePaths.length; a++)
                    {
                        // target template path
                        var filePath = path.resolve(currentTemplateFilePaths[a], "..", targetPath);

                        // if the file path does not end with ".html", we append
                        if (filePath.indexOf(".html") == -1)
                        {
                            filePath += ".html";
                        }

                        //console.log("Candidate file path: " + filePath);

                        if (fs.existsSync(filePath))
                        {
                            matchingFilePath = filePath;
                            break;
                        }
                    }
                }

                // if no match...
                if (!matchingFilePath)
                {
                    console.log("Unable to find included file for path: " + targetPath);
                    end(chunk, context);
                    return;
                }

                var filePath = matchingFilePath;

                var templatePath = filePath.split(path.sep).join("/");
                //console.log("Template Path: " + templatePath);

                // load the contents of the file
                // make sure this is text
                var compiled = false;
                if (!dust.cache[templatePath])
                {
                    var html = "" + fs.readFileSync(filePath);

                    try
                    {
                        // compile
                        var compiledTemplate = dust.compile(html, templatePath);
                        dust.loadSource(compiledTemplate);

                        compiled = true;
                    }
                    catch (e)
                    {
                        // compilation failed
                        console.log("Compilation failed for: " + filePath);
                        console.log(e);
                    }
                }
                else
                {
                    compiled = true;
                }

                // now run the template
                if (compiled)
                {
                    var includeContextObject = {};
                    for (var k in params) {
                        var value = dust.helpers.tap(params[k], chunk, context);
                        if (value)
                        {
                            includeContextObject[k] = value;
                        }
                    }
                    // push down new file path
                    var templateFilePaths = context.get("templateFilePaths");
                    var newTemplateFilePaths = [];
                    for (var r = 0; r < templateFilePaths.length; r++)
                    {
                        newTemplateFilePaths.push(templateFilePaths[r]);
                    }
                    newTemplateFilePaths.push(filePath);
                    includeContextObject["templateFilePaths"] = newTemplateFilePaths;
                    var subContext = context.push(includeContextObject);

                    //chunk.render(bodies.block, newContext);
                    //chunk.partial(templatePath, subContext, {});
                    //dust.render(templatePath, subContext, function(err, out) {

                    //var x = chunk.partial.call(chunk, templatePath, subContext, {});

                    //console.log("a2: " + x);
                    //chunk.write(out);
                    //chunk.write("ABC");
                    //chunk.end("");

                    //chunk.render.call(chunk, bodies.block, subContext);

                    //chunk.render(dust.cache[templatePath], subContext);
                    //chunk.end("");

                    //});

                    dust.render(templatePath, subContext, function(err, out) {

                        chunk.write(out);

                        end(chunk, context);
                    });
                }
                else
                {
                    end(chunk, context);
                }

            });
        });
    };

    /**
     * INCLUDE TEMPLATE
     *
     * Includes another dust template into this one and passes any context forward.
     *
     * Syntax:
     *
     *    {@include path="../template.html" ...args/}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    dust.helpers.include = function(chunk, context, bodies, params)
    {
        params = params || {};

        var targetPath = dust.helpers.tap(params.path, chunk, context);

        return _handleInclude(chunk, context, bodies, params, targetPath);
    };

    /**
     * INCLUDE BLOCK
     *
     * Includes a block dust template into this one and passes any context forward.
     *
     * Syntax:
     *
     *    {@block path="path" ...args/}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    dust.helpers.block = function(chunk, context, bodies, params)
    {
        params = params || {};

        var targetPath = dust.helpers.tap(params.path, chunk, context);

        if (targetPath.indexOf("/blocks") === 0)
        {
            // we're ok
        }
        else
        {
            targetPath = "/" + path.join("blocks", targetPath);
        }

        return _handleInclude(chunk, context, bodies, params, targetPath);
    };

    /**
     * INCLUDE LAYOUT
     *
     * Includes a layout dust template into this one and passes any context forward.
     *
     * Syntax:
     *
     *    {@layout path="path" ...args/}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    dust.helpers.layout = function(chunk, context, bodies, params)
    {
        params = params || {};

        var targetPath = dust.helpers.tap(params.path, chunk, context);

        if (targetPath.indexOf("/layouts") === 0)
        {
            // we're ok
        }
        else
        {
            targetPath = "/" + path.join("layouts", targetPath);
        }

        return _handleInclude(chunk, context, bodies, params, targetPath);
    };

    /**
     * BLOCK
     *
     * Declares a block.
     *
     * Syntax:
     *
     *    {@block name="abc"}
     *       ...default markup
     *    {/@block}
     *
     * @param chunk
     * @param context
     * @param bodies
     * @param params
     */
    /*
    dust.helpers.block = function(chunk, context, bodies, params)
    {
        params = params || {};

        var name = dust.helpers.tap(params.name, chunk, context);

        return chunk.capture(bodies.block, context, function(text, chunk) {

            var f = dust.load(name, chunk, context);
            var markup = "{+" + name + "}" + text + "{/" + name + "}";
            chunk.render(f, context)

            end(chunk, context);
        });
    };
    */

};