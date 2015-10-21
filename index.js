//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

exports.core = require(__dirname + '/core');
exports.lib = require(__dirname + '/lib');
exports.logger = require(__dirname + '/logger');
exports.ipc = require(__dirname + '/ipc');
exports.aws = require(__dirname + '/aws');
exports.db = require(__dirname + '/db');
exports.msg = require(__dirname + '/msg');
exports.server = require(__dirname + '/server');
exports.api = require(__dirname + '/api');
exports.jobs = require(__dirname + '/jobs');
exports.metrics = require(__dirname + '/metrics');
exports.app = require(__dirname + '/app');
exports.run = function(callback) { this.core.run(callback); }

exports.core.addModule('logger', exports.logger,
                       'lib', exports.lib,
                       'aws', exports.aws,
                       'ipc', exports.ipc,
                       'db', exports.db,
                       'api', exports.api,
                       'msg', exports.msg,
                       'jobs', exports.jobs,
                       'server', exports.server,
                       'metrics', exports.metrics,
                       'app', exports.app);

// Load all submodules after we have all singletons ready
exports.lib.findFileSync(__dirname + "/lib", { include: new RegExp(/\.js$/) }).forEach(function(file) { require(file); });
