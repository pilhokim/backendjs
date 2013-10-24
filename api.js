//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var path = require('path');
var util = require('util');
var fs = require('fs');
var http = require('http');
var url = require('url');
var crypto = require('crypto');
var async = require('async');
var express = require('express');
var domain = require('domain');
var core = require(__dirname + '/core');
var printf = require('printf');
var logger = require(__dirname + '/logger');
var backend = require(__dirname + '/backend');

// HTTP API to the server from the clients
var api = {

    // No authentication for these urls
    allow: /(^\/$|[a-zA-Z0-9\.-]+\.(gif|png|jpg|js|ico|css|html|txt|csv|json|plist)$|(^\/public\/)|(^\/image\/[a-z]+\/|^\/account\/add))/,

    // Refuse access to these urls
    deny: null,
    
    // Account management
    imagesUrl: '',
    tables: { 
        // Authentication by email and secret
        auth: [ { name: 'email', primary: 1 },
                { name: 'id', unique: 1 },
                { name: 'secret' },
                { name: 'api_deny' },
                { name: 'api_allow' },
                { name: 'account_allow' },                        // list of public columns
                { name: "expires", type: "int" },
                { name: "mtime", type: "int" } ],
                 
        // Basic account information
        account: [ { name: "id", primary: 1, pub: 1 },
                   { name: "email", unique: 1 },
                   { name: "name" },
                   { name: "alias", pub: 1 },
                   { name: "phone" },
                   { name: "website" },
                   { name: "birthday", semipub: 1 },
                   { name: "gender", pub: 1 },
                   { name: "address" },
                   { name: "city" },
                   { name: "state" },
                   { name: "zipcode" },
                   { name: "country" },
                   { name: "latitude", type: "real" },
                   { name: "longitude", type: " real" },
                   { name: "location" },
                   { name: "ltime", type: "int" },
                   { name: "ctime", type: "int" },
                   { name: "mtime", type: "int" } ],
                   
       // Locations for all accounts to support distance searches
       location: [ { name: "geohash", primary: 1 },                // geohash[0-2]
                   { name: "id", primary: 1 },                     // geohash[3-8]:account_id
                   { name: "latitude", type: "real" },
                   { name: "longitude", type: " real" },
                   { name: "mtime", type: "int" }],

       // All connections between accounts: like,dislike,friend...
       connection: [ { name: "id", primary: 1 },                    // account_id
                     { name: "type", primary: 1 },                  // type:connection_id
                     { name: "state" },
                     { name: "mtime", type: "int" }],
                   
       // References from other accounts, likes,dislikes...
       reference: [ { name: "id", primary: 1 },                    // connection_id
                    { name: "type", primary: 1 },                  // type:account_id
                    { name: "state" },
                    { name: "mtime", type: "int" }],
                     
       // Keep historic data about an account, data can be JSON depending on the type
       history: [{ name: "id", primary: 1 },
                 { name: "mtime", type: "int", primary: 1 },
                 { name: "type" } ]
    },
    
    // Upload limit, bytes
    uploadLimit: 10*1024*1024,
    
    // Config parameters
    args: ["account-pool", 
           "backend-pool",
           "images-url",
           "access-log",
           { name: "backend", type: "bool" },
           { name: "allow", type: "regexp" },
           { name: "deny", type: "regexp" },
           { name: "accesslog", type: "path" },
           { name: "upload-limit", type: "number", min: 1024*1024, max: 1024*1024*10 }],

    // Cutomization hooks/callbacks, always run within api context
    onInit: function() {},
           
    // Initialize API layer with the active HTTP server
    init: function(callback) {
        var self = this;

        // Access log via file or syslog
        if (logger.syslog) {
            this.accesslog = new stream.Stream();
            this.accesslog.writable = true;
            this.accesslog.write = function(data) { logger.printSyslog('info:local5', data); return true; }
        } else
        if (this.accessLog) {
            this.accesslog = fs.createWriteStream(path.join(core.path.log, this.accessLog), { flags: 'a' });
            this.accesslog.on('error', function(err) { logger.error('accesslog:', err); })
        } else {
            this.accesslog = logger;
        }

        this.app = express();
        // Wrap all calls in domain to catch exceptions
        this.app.use(function(req, res, next) {
            var d = domain.create();
            d.add(req);
            d.add(res);
            d.on('error', function(err) { req.next(err); });
            d.run(next);
        });
        this.app.use(express.bodyParser({ uploadDir: core.path.tmp, keepExtensions: true, limit: self.uploadLimit }));
        this.app.use(express.methodOverride());
        this.app.use(express.cookieParser());
        this.app.use(function(req, res, next) {
            res.header('Server', core.name + '/' + core.version);
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'accesskey,version,signature,expires,checksum');
            next();
        });
        this.app.use(this.accessLogger());
        this.app.use(function(req, res, next) { return self.checkRequest(req, res, next); });
        this.app.use(express.static(path.resolve(core.path.web)));
        this.app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
        this.app.listen(core.port, core.bind, function(err) {
            if (err) logger.error('startExpress:', core.port, err);
        });

        // Return current statistics
        this.app.all("/status", function(req, res) {
            res.json(db.getPool(self.accountPool).stats);
        });

        // Return images by prefix, id and possibly type, serves from local images folder, 
        // this is generic access without authentication, depends on self.allow regexp
        this.app.all(/^\/image\/([a-z]+)\/([a-z0-9-]+)\/?([a-z])?/, function(req, res) {
            self.sendFile(req, res, core.iconPath(req.params[1], req.params[0], req.params[2]));
        });

        // Managing accounts
        this.initAccount();
        
        // Provisioning access to the database
        if (this.backend) this.initBackend();

        // Post init or other application routes
        this.onInit.call(this);

        // Create account tables if dont exist
        db.initTables({ pool: self.accountPool, tables: self.tables }, callback);
    },
        
    // Perform authorization of the incoming request for access and permissions
    checkRequest: function(req, res, next) {
        var self = this;
        self.checkAccess(req, function(rc1) {
            // Status is given, return an error or proceed to the next module
            if (rc1) return (rc1.status == 200 ? next() : res.json(rc1));

            // Verify account access for signature
            self.checkSignature(req, function(rc2) {
                res.header("cache-control", "no-cache");
                res.header("pragma", "no-cache");
                // The account is verified, proceed with the request
                if (rc2.status == 200) return next();
                // Something is wrong, return an error
                res.json(rc2.status, rc2);
            });
        });
    },

    // Perform URL based access checks
    // Check access permissions, calls the callback with the following argument:
    // - nothing if checkSignature needs to be called
    // - an object with status: 200 to skip authorization and proceed with the next module
    // - an object with status other than 200 to return the status and stop request processing
    checkAccess: function(req, callback) {
        if (this.deny && req.path.match(this.deny)) return callback({ status: 401, message: "Access denied" });
        if (this.allow && req.path.match(this.allow)) return callback({ status: 200, message: "" });
        callback();
    },

    // Verify request signature from the request object, uses properties: .host, .method, .url or .originalUrl, .headers
    checkSignature: function(req, callback) {
        // Make sure we will not crash on wrong object
        if (!req || !req.headers) req = { headers: {} };
        if (!callback) callback = function(x) { return x; }

        // Extract all signatuee components from the request
        var sig = core.parseSignature(req);
        
        // Show request in the log on demand for diagnostics
        if (logger.level > 1 || req.query._debug) {
            logger.log('checkSignature:', sig, 'hdrs:', req.headers);
        }

        // Sanity checks, required headers must be present and not empty
        if (!sig.method || !sig.host || !sig.expires || !sig.id || !sig.signature) {
            return callback({ status: 401, message: "Invalid request: " + (!sig.method ? "no method" :
                                                                           !sig.host ? "no host" :
                                                                           !sig.id ? "no email" :
                                                                           !sig.expires ? "no expires" :
                                                                           !sig.signature ? "no signature" : "") });
        }

        // Make sure it is not expired, it may be milliseconds or ISO date
        if (sig.expires <= Date.now()) {
            return callback({ status: 400, message: "Expired request" });
        }

        // Verify if the access key is valid, they all are cached so a bad cache may result in rejects
        db.getCached("auth", { email: sig.id }, { pool: this.accountPool }, function(err, account) {
            if (err) return callback({ status: 500, message: String(err) });
            if (!account) return callback({ status: 404, message: "No account" });

            // Account expiration time
            if (account.expires && account.expires < Date.now()) {
                return callback({ status: 404, message: "Expired account" });
            }

            // Verify ACL regex if specified, test the whole query string as it appear in GET query line
            if (account.api_deny && sig.url.match(account.api_deny)) {
                return callback({ status: 401, message: "Access denied" });
            }
            if (account.api_allow && !sig.url.match(account.api_allow)) {
                return callback({ status: 401, message: "Not permitted" });
            }

            // Verify the signature with account secret
            if (!core.checkSignature(sig, account)) {
                return callback({ status: 401, message: "Bad signature, signed string is: " + sig.str + ", calculated signature is " + sig.hash });
            }

            // Deal with encrypted body, we have to decrypt it before checking checksum, use
            // out account secret to decrypt
            if (req.body && req.get("content-encoding") == "encrypted") {
                req.body = core.decrypt(account.secret, req.body);
            }

            // Check body checksum now
            if (sig.checksum) {
                var chk = core.hash(typeof req.body == "object" ? JSON.stringify(req.body) : String(req.body));
                if (sig.checksum != chk) {
                    return callback({ status: 401, message: "Bad checksum, calculated checksum is " + chk });
                }
            }
            // Save components of signature verification, it will be used later for profile password check as well
            req.signature = sig;
            // Save current account in the request
            req.account = account;
            return callback({ status: 200, message: "Ok" });
        });
    },

    // Account management
    initAccount: function() {
        var self = this;
        var now = core.now();
        
        this.app.all(/^\/account\/([a-z\/]+)$/, function(req, res) {
            logger.debug('account:', req.params[0], req.account, req.query);
            
            switch (req.params[0]) {
            case "get":
                db.get("account", { id: req.account.id }, { pool: self.accountPool }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    if (!rows.length) return self.sendReply(res, 404);
                    self.prepareAccount(rows[0]);
                    res.json(rows[0]);
                });
                break;

            case "list":
                if (!req.query.id) return self.sendReply(res, 400, "id is required");
                self.listAccounts(req, req.query, { select: req.query._columns }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    res.json(rows);
                });
                break;
                
            case "add":
                // Verify required fields
                if (!req.query.secret) return self.sendReply(res, 400, "secret is required");
                if (!req.query.name) return self.sendReply(res, 400, "name is required");
                if (!req.query.email) return self.sendReply(res, 400, "email is required");
                req.query.id = backend.uuid().replace(/-/g, '');
                req.query.mtime = req.query.ctime = now;
                // Add new auth record with only columns we support, no-SQL dbs can add any columns on 
                // the fly and we want to keep auth table very small
                db.add("auth", req.query, { pool: self.accountPool, columns: db.convertColumns(self.tables.auth) }, function(err) {
                    if (err) return self.sendReply(res, err);
                    db.add("account", req.query, { pool: self.accountPool }, function(err) {
                        if (err) db.del("auth", req.query, { pool: self.accountPool });
                        self.sendReply(res, err);
                    });
                });
                break;

            case "put":
                req.query.mtime = now;
                req.query.id = req.account.id;
                req.query.email = req.account.email;
                // Make sure we dont add extra properties in case of noSQL database or update columns we do not support here
                ["secret","ctime","ltime","latitude","longitude","geohash","location"].forEach(function(x) { delete req.query[x] });
                db.update("account", req.query, { pool: self.accountPool }, function(err) {
                    self.sendReply(res, err);
                });
                break;

            case "del":
                db.del("auth", { email: req.account.email } , { pool: self.accountPool }, function(err) {
                    self.sendReply(res, err);
                    core.ipcDelCache("auth:" + req.account.email);
                    if (err) return;
                    db.del("account", { id: req.account.id } , { pool: self.accountPool });
                });
                break;
                
            case "secret/put":
                if (!req.query.secret) return self.sendReply(res, 400, "secret is required");
                db.update("auth", { email: req.account.email, secret: req.query.secret }, { pool: self.accountPool }, function(err) {
                    self.sendReply(res, err);
                    core.ipcDelCache("auth:" + req.account.email);
                    if (err) return;
                    // Keep history of all changes
                    db.add("history", { id: req.account.id, type: req.params[0], mtime: now, secret: core.sign(req.account.id, req.query.secret) }, { pool: self.accountPool });
                });
                break;
                
            case "location/put":
                if (!req.query.latitude || !req.query.longitude) return self.sendReply(res, 400, "latitude/longitude are required");
                var obj = { id: req.account.id, email: req.account.email, mtime: now, ltime: now, latitude: req.query.latitude, longitude: req.query.longitude, location: req.query.location };
                db.update("account", obj, { pool: self.accountPool }, function(err) {
                    self.sendReply(res, err);
                    if (err) return;
                    // Store location for searches
                    db.get("account", { id: req.account.id }, { pool: self.accountPool, select: 'geohash,latitude,longitude' }, function(err, rows) {
                        var row = rows[0];
                        // Skip if within short range
                        var distance = backend.getDistance(row.latitude, row.longitude, req.query.latitude, req.query.longitude);
                        logger.debug(req.params[0], req.account, 'distance:', distance);
                        if (distance < 5) return;
                        // Delete current location
                        obj = { geohash: row.geohash.substr(0, 3), id: row.geohash.substr(3) + ":" + req.account.id };
                        db.del("location", obj, { pool: self.accountPool });
                        // Insert new location
                        var geohash = backend.geoHashEncode(req.query.latitude, req.query.longitude);
                        obj = { geohash: geohash.substr(0, 3), id: geohash.substr(3) + ":" + req.account.id, latitude: req.query.latitude, longitude: req.query.longitude, mtime: now };
                        db.put("location", obj, { pool: self.accountPool });
                    });
                        
                    // Keep history of all changes
                    db.add("history", { id: req.account.id, type: req.params[0], mtime: now, latitude: obj.latitude, longitude: obj.longitude }, { pool: self.accountPool });
                });
                break;
                
            case "location/list":
                if (!req.query.latitude || !req.query.longitude) return self.sendReply(res, 400, "latitude/longitude are required");
                if (!req.query.distance) return self.sendReply(res, 400, "Distance is required (km)");
                req.query.distance = core.toNumber(req.query.distance);
                var geohash = backend.geoHashEncode(req.query.latitude, req.query.longitude);
                db.select("location", { geohash: geohash.substr(0, 3), id: geohash.substr(3) }, { pool: self.accountPool, select: "id,latitude,longitude" }, function(err, rows) {
                    rows = rows.filter(function(x) { return backend.geoDistance(req.query.latitude, req.query.longitude, x.latitude, x.longitude) <= req.query.distance });
                    res.json(rows);
                });
                break;

            case "connection/set":
                if (!req.query.id || !req.query.type) return self.sendReply(res, 400, "id and type are required");
                if (req.query.id == req.account.id) return self.sendReply(res, 400, "cannot connect to itself");
                // Override primary key properties, the rest of the properties will be added as is
                var id = req.query.id, type = req.query.type;
                req.query.id = req.account.id;
                req.query.type = type + ":" + id;
                req.query.mtime = now;
                db.put("connection", req.query, { pool: self.accountPool }, function(err) {
                    if (err) return self.sendReply(res, err);
                    req.query.id = id;
                    req.query.type = type + ":"+ req.account.id;
                    db.put("reference", req.query, { pool: self.accountPool }, function(err) {
                        if (err) db.del("connection", { id: req.account.id, type: type + ":" + id }, { pool: self.accountPool });
                        self.sendReply(res, err);
                    });
                });
                break;

            case "connection/del":
                if (!req.query.id || !req.query.type) return self.sendReply(res, 400, "id and type are required");
                db.del("connection", { id: req.account.id, type: req.query.type + ":" + req.query.id }, { pool: self.accountPool }, function(err) {
                    if (err) return self.sendReply(res, err);
                    db.del("reference", { id: req.query.id, type: req.query.type + ":" + req.account.id }, { pool: self.accountPool }, function(err) {
                        self.sendReply(res, err);
                    });
                });
                break;

            case "connection/list":
                // Only one connection record to be returned if id and type specified
                if (req.query.id && req.query.type) req.query.type += ":" + req.query.id;
                db.select("connection", { id: req.account.id, type: req.query.type }, { pool: self.accountPool, select: req.query._columns }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    rows.forEach(function(row) {
                        var type = row.type.split(":");
                        row.id = type[1];
                        row.type = type[0];
                    });
                    res.json(rows);
                });
                break;

            case "reference/list":
                // Only one connection record to be returned if id and type specified
                if (req.query.id && req.query.type) req.query.type += ":" + req.query.id;
                db.select("reference", { id: req.account.id, type: req.query.type }, { pool: self.accountPool, select: req.query._columns }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    rows.forEach(function(row) {
                        var type = row.type.split(":");
                        row.id = type[1];
                        row.type = type[0];
                    });
                    res.json(rows);
                });
                break;
                
            case "connection/members":
                db.select("connection", { id: req.account.id, type: req.query.type }, { pool: self.accountPool, select: req.query._columns }, function(err, rows) {
                    if (err) return self.sendReply(res, err);
                    var list = {}, ids = [];
                    // Collect account ids
                    rows.forEach(function(row) {
                        var type = row.type.split(":");
                        row.id = type[1];
                        row.type = type[0];
                        ids.push({ id: row.id });
                        list[row.id] = row;
                    });
                    // Get all account records for the id list
                    self.listAccounts(req, ids, { select: req.query._columns }, function(err, rows) {
                        if (err) return self.sendReply(res, err);
                        // Keep all connecton properties in separate object
                        rows.forEach(function(row) {
                            row.connection = list[row.id];
                        })
                        res.json(rows);
                    });
                });
                break;
                
            case "history/add":
                self.sendReply(res);
                req.query.mtime = now();
                db.add("history", req.query, { pool: self.accountPool });
                break;
                
            case "icon/list":
                // List all possible icons, this server may not have access to the files so it is up to the client to verify which icons exist
                res.json(['a','b','c','d','e','f'].map(function(x) { return self.imagesUrl + '/image/account/' + req.account.id + '/' + x }));
                break;
                
            case "icon/put":
                // Add icon to the account, support up to 6 icons with types: a,b,c,d,e,f, primary icon type is ''
                self.putIcon(req, { id: req.account.id, prefix: 'account' , type: req.body.type || req.query.type || '' }, function(err) {
                    self.sendReply(res, err);
                });
                break;
                
            default:
                self.sendReply(res, 400, "Invalid operation");
            }
        });
    },
    
    // Prepare an account record for response, set required fields, icons
    prepareAccount: function(row) {
        if (row.birthday) row.age = (core.now() - core.toDate(row.birthday))/(86400*365);
        row.icon = this.imagesUrl + '/image/account/' + row.id;
    },
    
    // Collect accounts by id or list of ids
    listAccounts: function(req, obj, options, callback) {
        var self = this;
        var pubcols = db.publicColumns('account', { columns: self.tables.account });
        // Provided list of columns must be a subset of public columns
        var cols = obj._columns ? core.strSplit(options.select).filter(function(x) { return pubcols.indexOf(x) > -1 }) : pubcols;
        // List of account ids can be provided to retrieve all accounts at once, for DynamoDB it means we may iterate over all 
        // pages in order to get all items until we reach our limit.
        var ids = core.strSplit(obj.id);
        ids = ids.length > 1 ? ids.map(function(x) { return { id: x } }) : { id: ids[0] };
        db.select("account", ids, { pool: self.accountPool, select: cols }, function(err, rows) {
            if (err) return callback(err, []);
            rows.forEach(function(row) {
                self.prepareAccount(row);
                db.publicPrepare(rows[0], { columns: self.tables.account, allowed: req.account.account_allow });
            });
            callback(null, rows);
        });
    },
    
    // API for internal provisioning, by default supports access to all tables
    initBackend: function() {
        var self = this;
        
        // Load columns into the cache
        this.app.all(/^\/cache-columns$/, function(req, res) {
            db.cacheColumns({ pool: self.backendPool });
            res.json([]);
        });

        // Return table columns
        this.app.all(/^\/([a-z_0-9]+)\/columns$/, function(req, res) {
            res.json(db.getColumns(req.params[0], { pool: self.backendPool }));
        });

        // Return table keys
        this.app.all(/^\/([a-z_0-9]+)\/keys$/, function(req, res) {
            res.json(db.getKeys(req.params[0], { pool: self.backendPool }));
        });

        // Query on a table
        this.app.all(/^\/([a-z_0-9]+)\/get$/, function(req, res) {
            var options = { pool: self.backendPool, 
                            total: req.query._total, 
                            count: req.query._count || 25, 
                            sort: req.query._sort, 
                            select: req.query._cols };
            // Convert values into actual arrays if separated by pipes
            for (var p in req.query) {
                if (p[0] != '_' && req.query[p].indexOf("|") > 0) req.query[p] = req.query[p].split("|");
            }
            db.select(req.params[0], req.query, options, function(err, rows) {
                if (err) return res.json([]);
                res.json(rows);
            });
        });
        
        // Basic operations on a table
        this.app.all(/^\/([a-z_0-9]+)\/(add|put|del)$/, function(req, res) {
            var dbcols = db.getColumns(req.params[0], { pool: self.backendPool });
            if (!dbcols) return res.json([]);
            
            switch (req.params[1]) {
            case "add":
                db.add(req.params[0], req.query, { pool: self.backendPool }, function(err, rows) {
                    return self.sendReply(res, err);
                });
                break;
                
            case "rep":
                db.replace(req.params[0], req.query, { pool: self.backendPool }, function(err, rows) {
                    self.sendReply(res, err);
                });
                break;
                
            case "put":
                db.put(req.params[0], req.query, { pool: self.backendPool }, function(err, rows) {
                    self.sendReply(res, err);
                });
                break;
                
            case "update":
                db.update(req.params[0], req.query, { pool: self.backendPool }, function(err, rows) {
                    self.sendReply(res, err);
                });
                break;
                
            case "del":
                db.del(req.params[0], req.query, { pool: self.backendPool }, function(err, rows) {
                    self.sendReply(res, err);
                });
                break;
            }
        });
        
    },
    
    // Add columns to account tables, makes sense in case of SQL database for extending supported properties and/or adding indexes
    initTables: function(table, columns) {
        var self = this;
        if (!Array.isArray(columns)) return;
        if (!self.tables[table]) self.tables[table] = []; 
        columns.forEach(function(x) {
            if (typeof x == "object" && x.name && !self.tables[table].some(function(y) { return y.name == x.name })) {
                self.tables[table].push(x);
            } 
        });
    },

    // Send formatted reply to API clients, if status is an instance of Error then error message with status 500 is sent back
    sendReply: function(res, status, msg) {
        if (status instanceof Error) msg = status, status = 500;
        if (!status) status = 200, msg = "";
        res.json(status, { status: status, message: String(msg || "").replace(/SQLITE_CONSTRAINT:/g, '') });
        return false;
    },

    // Send file back to the client, res is Express response object
    sendFile: function(req, res, file, redirect) {
        fs.exists(file, function(yes) {
            if (req.method == 'HEAD') return res.send(yes ? 200 : 404);
            if (yes) return res.sendfile(file);
            if (redirect) return res.redirect(redirect);
            res.send(404);
        });
    },

    // Store an icon for account, .type defines icon prefix
    putIcon: function(req, options, callback) {
        // Multipart upload can provide more than one icon, file name can be accompanied by file_type property
        // to define type for each icon
        if (req.files) {
            async.forEachSeries(Object.keys(req.files), function(f, next) {
                core.putIcon(req.files[f].path, options.id, { prefix: options.prefix, type: req.body[f + '_type'] }, next);
            }, function(err) {
                callback(err);
            });
        } else 
        // JSON object submitted with .icon property
        if (typeof req.body == "object") {
            req.body = new Buffer(req.body.icon, "base64");
            core.putIcon(req.body, options.id, options, callback);
        } else {
            return callback(new Error("no icon"));
        }
    },
    
    // Custom access logger
    accessLogger: function() {
        var self = this;

        var format = function(req, res) {
            var now = new Date();
            return (req.ip || (req.socket.socket ? req.socket.socket.remoteAddress : "-")) + " - " +
                   (logger.syslog ? "-" : '[' +  now.toUTCString() + ']') + " " +
                   req.method + " " +
                   (req.originalUrl || req.url) + " " +
                   "HTTP/" + req.httpVersionMajor + '.' + req.httpVersionMinor + " " +
                   res.statusCode + " " +
                   ((res._headers || {})["content-length"] || '-') + " - " +
                   (now - req._startTime) + " ms - " +
                   (req.headers['user-agent'] || "-") + " " +
                   (req.headers['version'] || "-") + " " +
                   (req.account ? req.account.email : "-") + "\n";
        }

        return function logger(req, res, next) {
            req._startTime = new Date;
            res._end = res.end;
            res.end = function(chunk, encoding) {
                res._end(chunk, encoding);
                if (!self.accesslog || req._skipLogging) return;
                var line = format(req, res);
                if (!line) return;
                self.accesslog.write(line);
            }
            next();
        }
    },

}

module.exports = api;
core.addContext('api', api);
