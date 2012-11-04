/*
* Copyright (c) 2011 Eran Hammer-Lahav. All rights reserved. Copyrights licensed under the New BSD License.
* See LICENSE file included with this code project for license terms.
*/

// Load modules

var Hapi = require('hapi');
var Crypto = require('crypto');
var Db = require('./db');
var User = require('./user');
var Email = require('./email');
var Vault = require('./vault');


// Declare internals

var internals = {};


// Get client information endpoint

exports.client = {
    auth: {
        scope: 'login',
        entity: 'app'
    },
    handler: function (request) {

        exports.loadClient(request.params.id, function (err, client) {

            if (err) {
                return request.reply(err);
            }

            if (!client) {
                return request.reply(Hapi.Error.notFound());
            }

            Hapi.Utils.removeKeys(client, ['secret', 'scope']);
            return request.reply(client);
        });
    }
};


// Get client

exports.loadClient = function (id, callback) {

    Db.queryUnique('client', { name: id }, function (client, err) {

        if (err || !client) {
            return callback(err);
        }

        var result = {
            id: client.name,
            secret: client.secret,
            scope: client.scope
        };

        return callback(null, result);
    });
};


// Get user authentication information

exports.loadUser = function (id, callback) {

    User.load(id, function (user, err) {

        if (err || !user) {
            return callback(err);
        }

        var result = {
            id: user._id,
            tos: user.tos
        };

        return callback(null, user);
    });
};


// Check client authorization grant

exports.checkAuthorization = function (userId, clientId, callback) {

    Db.query('grant', { user: userId, client: clientId }, function (items, err) {

        if (err) {
            return callback(Hapi.Session.error('server_error', 'Failed retrieving authorization'));
        }

        if (!items ||
            items.length <= 0) {

            return callback(Hapi.Session.error('invalid_grant', 'Client is not authorized'));
        }

        items.sort(function (a, b) {

            if (a.expiration < b.expiration) {
                return -1;
            }

            if (a.expiration > b.expiration) {
                return 1;
            }

            return 0;
        });

        var isAuthorized = false;
        var now = Date.now();

        var expired = [];
        for (var i = 0, il = items.length; i < il; ++i) {
            if ((items[i].expiration || 0) <= now) {
                expired.push(items[i]._id);
            }
            else {
                isAuthorized = true;
            }
        }

        if (expired.length > 0) {
            Db.removeMany('grant', expired, function (err) { });         // Ignore callback
        }

        if (!isAuthorized) {
            return callback(Hapi.Session.error('invalid_grant', 'Client authorization expired'));
        }

        return callback(null);
    });
};


// Extension OAuth grant types

exports.extensionGrant = function (request, client, callback) {

    // Verify grant type prefix

    if (request.payload.grant_type.search('http://ns.postmile.net/') !== 0) {
        // Unsupported grant type namespace
        return callback(Hapi.Session.error('unsupported_grant_type', 'Unknown or unsupported grant type namespace'));
    }

    // Check if client has 'login' scope

    if ((!client.scope || client.scope.indexOf('login' === -1)) &&
        (!request.session || !request.session.scope || request.session.scope.indexOf('login') === -1)) {

        // No client scope for local account access
        return callback(Hapi.Session.error('unauthorized_client', 'Client missing \'login\' scope'));
    }

    // Switch on grant type

    var grantType = request.payload.grant_type.replace('http://ns.postmile.net/', '');
    if (grantType === 'id') {

        // Get user

        User.load(request.payload.x_user_id, function (user, err) {

            if (!user) {
                // Unknown local account
                return callback(Hapi.Session.error('invalid_grant', 'Unknown local account'));
            }

            return callback(null, user);
        });
    }
    else if (grantType === 'twitter' ||
             grantType === 'facebook' ||
             grantType === 'yahoo') {

        // Check network identifier

        User.validate(request.payload.x_user_id, grantType, function (user, err) {

            if (!user) {
                // Unregistered network account
                return callback(Hapi.Session.error('invalid_grant', 'Unknown ' + grantType.charAt(0).toUpperCase() + grantType.slice(1) + ' account: ' + request.payload.x_user_id));
            }

            return callback(null, user);
        });
    }
    else if (grantType === 'email') {

        // Check email identifier

        Email.loadTicket(request.payload.x_email_token, function (ticket, user, err) {

            if (!ticket) {
                // Invalid email token
                return callback(Hapi.Session.error('invalid_grant', err.message));
            }

            return callback(null, user, { 'x_action': ticket.action });
        });
    }
    else {
        // Unsupported grant type
        return callback(Hapi.Session.error('unsupported_grant_type', 'Unknown or unsupported grant type: ' + grantType));
    }
};


// Validate message

exports.validate = function (message, token, mac, callback) {

    Hapi.Session.loadToken(Vault.oauthToken.aes256Key, token, function (session) {

        if (session &&
            session.algorithm &&
            session.key &&
            session.user) {

            // Lookup hash function

            var hashMethod = null;
            switch (session.algorithm) {
                case 'hmac-sha-1': hashMethod = 'sha1'; break;
                case 'hmac-sha-256': hashMethod = 'sha256'; break;
            }

            if (hashMethod) {

                // Sign message

                var hmac = Crypto.createHmac(hashMethod, session.key).update(message);
                var digest = hmac.digest('base64');

                if (digest === mac) {
                    callback(session.user, null);
                }
                else {
                    // Invalid signature
                    callback(null, Hapi.Error.unauthorized('Invalid mac'));
                }
            }
            else {
                // Invalid algorithm
                callback(null, Hapi.Error.internal('Unknown algorithm'));
            }
        }
        else {
            // Invalid token
            callback(null, Hapi.Error.notFound('Invalid token'));
        }
    });
};


// Remove all user grants

exports.delUser = function (userId, callback) {

    callback(null);
};



