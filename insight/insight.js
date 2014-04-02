var http = require("http");
var path = require("path");
var request = require("request");
var util = require("../util/util");

/**
 * Insight subsystem.
 *
 * When insight "push" requests come along, we handle them here and pass back to Cloud CMS.
 */
var exports = module.exports;

var firstConnection = true;

exports.init = function(socket)
{
    // listen for pushes from the client
    socket.on("insight-push", function(data) {

        if (data && data.rows)
        {
            handleInsightPush(socket, data, function(err) {

                if (err && firstConnection)
                {
                    socket._log("Socket initialization - will retry insight-push in 10 seconds");

                    // give it another shot in 10 seconds
                    window.setTimeout(function() {
                        handleInsightPush(socket, data, function(err) {
                            if (!err)
                            {
                                socket._log("Event: insight-push, interactions: " + data.rows.length);
                            }
                            else
                            {
                                socket._log("Error: " + JSON.stringify(err));
                            }
                        });
                        firstConnection = false;
                    }, 10000);
                }
                else if (err)
                {
                    socket._log("Error: " + JSON.stringify(err));
                }
                else
                {
                    socket._log("Event: insight-push, interactions: " + data.rows.length);
                }

            });
        }
    });
};

/**
 * Data comes in:
 *
 * @param data
 */
var handleInsightPush = function(socket, data, callback)
{
    var gitana = socket.gitana;
    if (!gitana)
    {
        callback({
            "code": "no_gitana"
        });
        return;
    }

    var warehouseId = data.warehouseId;
    if (!warehouseId)
    {
        var analytics = gitana.datastore("analytics");
        if (analytics) {
            warehouseId = analytics.getId();
        }
    }
    if (!warehouseId) {
        console.log("Could not determine warehouse id");
        return;
    }

    var ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address.address;
    var host = socket.handshake.headers['x-forwarded-host'] || socket.handshake.headers.host;

    // tag all rows with the "applicationKey"
    for (var i = 0; i < data.rows.length; i++)
    {
        data.rows[i].appKey = gitana.application().getId();

        if (!data.rows[i].source) {
            data.rows[i].source = {};
        }

        data.rows[i].source.ip = ip;
        data.rows[i].source.host = host;
    }

    var URL = process.env.GITANA_PROXY_SCHEME + "://" + process.env.GITANA_PROXY_HOST + ":" + process.env.GITANA_PROXY_PORT + "/warehouses/" + warehouseId + "/interactions/_create";
    var requestConfig = {
        "url": URL,
        "qs": {},
        "method": "POST",
        "json": data
    };

    util.retryGitanaRequest(socket._log, gitana, requestConfig, 2, function(err, response, body) {

        if (response && response.statusCode == 200 && body)
        {
            // success
            callback();
        }
        else
        {
            if (err)
            {
                // an HTTP error
                socket._log("Response error: " + JSON.stringify(err));

                callback(err);

                return;
            }

            if (body && body.error)
            {
                // some kind of operational error
                socket._log("Operational error");
                socket._log(JSON.stringify(body));

                callback({
                    "message": body.error
                });

                return;
            }
        }
    });
};
