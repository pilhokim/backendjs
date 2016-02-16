//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var net = require('net');
var util = require('util');
var fs = require('fs');
var repl = require('repl');
var path = require('path');
var crypto = require('crypto');
var domain = require('domain');
var url = require('url');
var http = require('http');
var https = require('https');
var child = require('child_process');
var bkutils = require('bkjs-utils');
var cluster = require('cluster');
var os = require('os');
var dns = require('dns');
var lib = require(__dirname + '/lib');
var logger = require(__dirname + '/logger');

// The primary object containing all config options and common functions
var core = {
    // Backend process name
    name: 'bkjs',

    // Protocol version
    version: '2015.09.01',

    // Application version, read from package.json if exists
    appName: '',
    appVersion: '0',
    appDescr: "",

    // Process and config parameters
    argv: {},

    // Server role, used by API server, for provisioning must include backend
    role: '',

    // Environment mode of the process or the application
    runMode: 'development',

    // Current instance attributes gathered by other modules
    instance: { id: process.pid, pid: process.pid, type: "", index: 0, tag: '', image: '', region: '', zone: '' },
    workerId: '',

    // Home directory, current by default, must be absolute path
    home: process.env.BKJS_HOME || (process.env.HOME + '/.bkjs'),
    cwd: process.cwd(),

    // Various folders, by default relative paths are used
    path: { etc: "etc", spool: "var", images: "images", tmp: "tmp", web: "web", views: "views", files: "files", log: "log", modules: "modules", locales: "locales" },

    // Log file for debug and other output from the modules, error or info messages, default is stdout
    logFile: "log/message.log",
    errFile: "log/error.log",
    confFile: "config",

    // HTTP settings
    port: 8000,
    bind: '0.0.0.0',
    timeout: 30000,
    backlog: 511,

    // HTTPS server options, can be updated by the apps before starting the SSL server
    ssl: { port: 443, bind: '0.0.0.0' },

    // WebSockets config
    ws: { port: 0, bind: "0.0.0.0", },

    // Proxy config
    proxy: { port: 0, bind: "127.0.0.1", ssl: false },

    // Number of parallel tasks running at the same time, can be used by various modules
    concurrency: 2,

    // Local host IPs and name
    ipaddr: '',
    subnet: '',
    network: '',
    ipaddrs: [],
    hostName: '',
    domain: '',
    maxCPUs: os.cpus().length,
    ctime: Date.now(),

    // Unix user/group privileges to set after opening port 80 and if running as root, in most cases this is ec2-user on Amazon cloud,
    // for manual installations `bkjs int-server` will create a user with this id
    uid: 0,
    gid: 0,
    umask: '0002',

    // Watched source files for changes, restarts the process if any file has changed
    watchdirs: [],
    noWatch: /bk_shell.js/,
    timers: {},
    locales: [],

    // Log watcher config, define different named channels for different patterns, email notification can be global or per channel
    logwatcherMax: 1000000,
    logwatcherInterval: 60,
    logwatcherAnyRange: 5,
    logwatcherEmail: {},
    logwatcherUrl: {},
    logwatcherTable: {},
    logwatcherIgnore: {},
    logwatcherMatch: {
        error: [ ' (ERROR|ALERT|EMERG|CRIT): ', 'message":"ERROR:' ],
        warning: [ ' (WARNING|WARN): ' ],
    },
    // List of files to watch, every file is an object with the following properties:
    //   - file: absolute pth to the log file - or -
    //   - name: name of the property in the core which hold the file path
    //   - ignore: a regexp with the pattern to ignore
    //   - match: a regexp with the pattern to match and report
    //   - type: channel if match is specified, otherwise it will go to the channel 'all'
    logwatcherFile: [
        { file: "/var/log/messages" },
        { name: "logFile" },
        { name: "errFile", match: /.+/, type: "error" }
    ],

    // How long to keep temp files
    tmpWatcher: {
        tmp: 86400*3,
        log: 86400*14,
    },

    // Inter-process messages
    lruMax: 100000,

    // REPL pors
    repl: {
        bind: '127.0.0.1',
        file: '.history',
    },

    // All internal and loaded modules
    modules: {},
    // By default do not allow any modules, must be allowed in the config
    allowModules: {
        "": /^(bk_account|bk_icon)$/,
        server: /^(?!x)x$/,
        master: /^(?!x)x$/,
    },
    denyModules: {},

    // Config parameters
    args: [ { name: "help", type: "callback", callback: function() { this.showHelp() }, descr: "Print help and exit" },
            { name: "log", type: "callback", callback: function(v) { logger.setLevel(v); }, descr: "Set debugging level to any of " + Object.keys(logger.levels), pass: 1, cmdline: 1 },
            { name: "log-filter", type: "callback", callback: function(v) { logger.setDebugFilter(v); }, descr: "Enable debug filters, format is: +label,... to enable, and -label,... to disable. Only first argument is used for label in logger.debug", pass: 1 },
            { name: "log-file", type: "callback", callback: function(v) { if(v) this.logFile=v;logger.setFile(this.logFile); }, descr: "Log to a file, if not specified used default logfile, disables syslog", pass: 1 },
            { name: "syslog", type: "callback", callback: function(v) { logger.setSyslog(v ? lib.toBool(v) : true); }, descr: "Write all logging messages to syslog, connect to the local syslog server over Unix domain socket", pass: 1 },
            { name: "console", type: "callback", callback: function() { logger.setFile(null);}, descr: "All logging goes to the console resetting all previous log related settings, this is used in the development mode mostly", pass: 1 },
            { name: "home", type: "callback", callback: "setHome", descr: "Specify home directory for the server, the server will try to chdir there or exit if it is not possible, the directory must exist", pass: 1 },
            { name: "conf-file", descr: "Name of the config file to be loaded instead of the default etc/config, can be relative or absolute path", pass: 1 },
            { name: "err-file", type: "path", descr: "Path to the error log file where daemon will put app errors and crash stacks", pass: 1 },
            { name: "etc-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep config files", pass: 1 },
            { name: "web-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep web pages" },
            { name: "views-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep web template views" },
            { name: "tmp-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep temp files" },
            { name: "spool-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep modifiable files" },
            { name: "log-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep other log files, log-file and err-file are not affected by this", pass: 1 },
            { name: "files-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep uploaded files" },
            { name: "images-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep images" },
            { name: "modules-dir", type: "path", obj: "path", strip: /Dir/, descr: "Directory from where to load modules, these are the backendjs modules but in the same format and same conventions as regular node.js modules, the format of the files is NAME_{web,worker,shell}.js. The modules can load any other files or directories, this is just an entry point", pass: 1 },
            { name: "locales-dir", type: "path", obj: "path", strip: /Dir/, descr: "Path where to keep locale translations" },
            { name: "uid", type: "callback", callback: function(v) { if (!v)return;v = bkutils.getUser(v);if (v.name) this.uid = v.uid, this.gid = v.gid,this._name = "uid" }, descr: "User id or name to switch after startup if running as root, used by Web servers and job workers", pass: 1 },
            { name: "gid", type: "callback", callback: function(v) { if (!v)return;v = bkutils.getGroup(v);if (v.name) this.gid = v.gid,this._name = "gid" }, descr: "Group id or name to switch after startup if running to root", pass: 1 },
            { name: "email", descr: "Email address to be used when sending emails from the backend" },
            { name: "role", descr: "Override servers roles, this may have very strange side effects and should only be used for testing purposes" },
            { name: "force-uid", type: "callback", callback: "dropPrivileges", descr: "Drop privileges if running as root by all processes as early as possibly, this reqiures uid being set to non-root user. A convenient switch to start the backend without using any other tools like su or sudo.", pass: 1 },
            { name: "umask", descr: "Permissions mask for new files, calls system umask on startup, if not specified the current umask is used", pass: 1 },
            { name: "port", type: "number", min: 0, descr: "port to listen for the HTTP server, this is global default" },
            { name: "bind", descr: "Bind to this address only, if not specified listen on all interfaces" },
            { name: "backlog", descr: "The maximum length of the queue of pending connections, used by HTTP server in listen." },
            { name: "ws-port", type: "number", obj: 'ws', min: 0, descr: "port to listen for WebSocket server, it can be the same as HTTP/S ports to co-exist on existing web servers" },
            { name: "ws-bind", obj: 'ws', descr: "Bind to this address only for WebSocket, if not specified listen on all interfaces, only when the port is different from existing web ports" },
            { name: "ssl-port", type: "number", obj: 'ssl', min: 0, descr: "port to listen for HTTPS server, this is global default, be advised that proxy-port takes precedence" },
            { name: "ssl-bind", obj: 'ssl', descr: "Bind to this address only for HTTPS server, if not specified listen on all interfaces" },
            { name: "ssl-key", type: "file", obj: 'ssl', descr: "Path to SSL prvate key" },
            { name: "ssl-cert", type: "file", obj: 'ssl', descr: "Path to SSL certificate" },
            { name: "ssl-pfx", type: "file", obj: 'ssl', descr: "A string or Buffer containing the private key, certificate and CA certs of the server in PFX or PKCS12 format. (Mutually exclusive with the key, cert and ca options.)" },
            { name: "ssl-ca", type: "file", obj: 'ssl', array: 1, descr: "An array of strings or Buffers of trusted certificates in PEM format. If this is omitted several well known root CAs will be used, like VeriSign. These are used to authorize connections." },
            { name: "ssl-passphrase", obj: 'ssl', descr: "A string of passphrase for the private key or pfx" },
            { name: "ssl-crl", type: "file", obj: 'ssl', array: 1, descr: "Either a string or list of strings of PEM encoded CRLs (Certificate Revocation List)" },
            { name: "ssl-ciphers", obj: 'ssl', descr: "A string describing the ciphers to use or exclude. Consult http://www.openssl.org/docs/apps/ciphers.html#CIPHER_LIST_FORMAT for details on the format" },
            { name: "ssl-request-cert", type: "bool", obj: 'ssl', descr: "If true the server will request a certificate from clients that connect and attempt to verify that certificate. " },
            { name: "ssl-reject-unauthorized", type: "bool", obj: 'ssl', decr: "If true the server will reject any connection which is not authorized with the list of supplied CAs. This option only has an effect if ssl-request-cert is true" },
            { name: "concurrency", type:"number", min: 1, max: 4, descr: "How many simultaneous tasks to run at the same time inside one process, this is used by async module only to perform several tasks at once, this is not multithreading but and only makes sense for I/O related tasks" },
            { name: "timeout", type: "number", min: 0, max: 3600000, descr: "HTTP request idle timeout for servers in ms, how long to keep the connection socket open, this does not affect Long Poll requests" },
            { name: "daemon", type: "none", descr: "Daemonize the process, go to the background, can be specified only in the command line" },
            { name: "shell", type: "none", descr: "Run command line shell, load the backend into the memory and prompt for the commands, can be specified only in the command line" },
            { name: "monitor", type: "none", descr: "For production use, monitors the master and Web server processes and restarts if crashed or exited, can be specified only in the command line" },
            { name: "master", type: "none", descr: "Start the master server, can be specified only in the command line, this process handles job schedules and starts Web server, keeps track of failed processes and restarts them" },
            { name: "web", type: "none", descr: "Start Web server processes, spawn workers that listen on the same port, for use without master process which starts Web servers automatically" },
            { name: "proxy-port", type: "number", min: 0, obj: 'proxy', descr: "Start the HTTP reverse proxy server, all Web workers will listen on different ports and will be load-balanced by the proxy, the proxy server will listen on global HTTP port and all workers will listen on ports starting with the proxy-port" },
            { name: "proxy-ssl", type: "bool", obj: "proxy", descr: "Start HTTPS reverse proxy to accept incoming SSL requests, ssl-key/cert must be defined" },
            { name: "app-name", type: "callback", callback: function(v) { if (!v) return;v = v.split(/[\/-]/);this.appName=v[0].trim();if(v[1]) this.appVersion=v[1].trim();}, descr: "Set appName and version explicitely an skip reading it from package.json, it can be just a name or name-version", pass: 1 },
            { name: "instance-tag", obj: 'instance', descr: "Set instance tag explicitely, skip all meta data checks for it", pass: 1 },
            { name: "instance-region", obj: 'instance', obj: 'instance', descr: "Set instance region explicitely, skip all meta data checks for it", pass: 1 },
            { name: "instance-zone", obj: 'instance', descr: "Set instance zone explicitely, skip all meta data checks for it", pass: 1 },
            { name: "instance-job", obj: 'instance', type: "bool", descr: "Enables remote job mode, it means the backendjs is running in the cloud to execute a job or other task and can be terminated during the idle timeout" },
            { name: "run-mode", dns: 1, descr: "Running mode for the app, used to separate different running environment and configurations" },
            { name: "no-monitor", type: "none", descr: "Disable monitor process, for cases when the master will be monitored by other tool like monit..." },
            { name: "no-master", type: "none", descr: "Do not start the master process" },
            { name: "no-watch", type: "none", descr: "Disable source code watcher" },
            { name: "no-web", type: "bool", descr: "Disable Web server processes, without this flag Web servers start by default" },
            { name: "no-db", type: "bool", descr: "Do not initialize DB drivers" },
            { name: "no-dns", type: "bool", descr: "Do not use DNS configuration during the initialization" },
            { name: "no-configure", type: "bool", descr: "Do not run configure hooks during the initialization" },
            { name: "repl-port-([a-z]+)$", type: "number", obj: "repl", make: "$1Port", min: 1001, descr: "Base REPL port for process role (server, master, web, worker), if specified it initializes REPL in the processes, for workers the port is computed by adding a worker id to the base port, for example if specified `-repl-port-web 2090` then a web worker will use any available 2091,2092..." },
            { name: "repl-bind", obj: "repl", descr: "Listen only on specified address for REPL server in the master process" },
            { name: "repl-file", obj: "repl", descr: "User specified file for REPL history" },
            { name: "worker", type: "bool", descr: "Set this process as a worker even it is actually a master, this skips some initializations" },
            { name: "allow-modules-?(.+)?", obj: "allow-modules", type: "regexp", strip: "allowModules", descr: "A regexp with modules name to be loaded on startup, only matched modules will be loaded, basename of the file is matched only, no path or extension, it is per role or global if no role is provided", pass: 1 },
            { name: "deny-modules-?(.+)?", obj: "deny-modules", type: "regexp", strip: "denyModules", descr: "A regexp with modules names that will never be loaded even if allowed, this is for blacklisted modules, can be per role or global for all processes", pass: 1 },
            { name: "logwatcher-from", descr: "Email address to send logwatcher notifications from, for cases with strict mail servers accepting only from known addresses" },
            { name: "logwatcher-interval", type: "number", min: 1, descr: "How often to check for errors in the log files in minutes" },
            { name: "logwatcher-any-range", type: "number", min: 1, descr: "Number of lines for matched channel `any` to be attached to the previous matched channel, if more than this number use the channel `any` on its own" },
            { name: "logwatcher-match-[a-z]+", obj: "logwatcher-match", array: 1, descr: "Regexp patterns that match conditions for logwatcher notifications, this is in addition to default backend logger patterns, suffix defines the log channel to use, like error, warning.... Special channel `any` is reserved to send matched lines to the previously matched channel if within configured range. Example: `-logwatcher-match-error=^failed:` `-logwatcher-match-any=line:[0-9]+`" },
            { name: "logwatcher-email-[a-z]+", obj: "logwatcher-email", descr: "Email address for the logwatcher notifications, the monitor process scans system and backend log files for errors and sends them to this email address, if not specified no log watching will happen, each channel must define an email separately, one of error, warning, info, all. Example: `-logwatcher-email-error=help@error.com`" },
            { name: "logwatcher-ignore-[a-z]+", obj: "logwatcher-ignore", array: 1, descr: "Regexp with patterns that need to be ignored by the logwatcher process, it is added to the list of ignored patterns for each specified channel separately" },
            { name: "logwatcher-file(-[a-z]+)?", obj: "logwatcher-file", type: "callback", callback: function(v,k) { if (v) this.logwatcherFile.push({file:v,type:k}) }, descr: "Add a file to be watched by the logwatcher, it will use all configured match patterns" },
            { name: "logwatcher-url(-[a-z]+)?", obj: "logwatcher-url", descr: "The backend URL(s) where logwatcher reports should be sent, the log is sent in a POST request, additional info is in the headers" },
            { name: "logwatcher-table(-[a-z]+)?", obj: "logwatcher-table", descr: "The database table where logwatcher reports should be stored, the table must have the following columns: ipaddr, host, type, instance_id, instance_tag, run_mode, data, mtime" },
            { name: "logwatcher-ses", type: "bool", descr: "Send logwatcher emails via SES if running inside an EC2 instance" },
            { name: "user-agent", array: 1, descr: "Add HTTP user-agent header to be used in HTTP requests, for scrapers or other HTTP requests that need to be pretended coming from Web browsers" },
            { name: "backend-host", descr: "Host of the master backend, can be used for backend nodes communications using core.sendRequest function calls with relative URLs, also used in tests." },
            { name: "backend-login", descr: "Credentials login for the master backend access when using core.sendRequest" },
            { name: "backend-secret", descr: "Credentials secret for the master backend access when using core.sendRequest" },
            { name: "host-name", type: "callback", callback: function(v) { if(v)this.hostName=v;this.domain = lib.domainName(this.hostName);this._name = "hostName" }, descr: "Hostname/domain to use for communications, default is current domain of the host machine" },
            { name: "config-domain", descr: "Domain to query for configuration TXT records, must be specified to enable DNS configuration" },
            { name: "watch", type: "callback", callback: function(v) { this.watch = true; this.watchdirs.push(v ? v : __dirname); }, descr: "Watch sources directory for file changes to restart the server, for development only, the backend module files will be added to the watch list automatically, so only app specific directores should be added. In the production -monitor must be used." },
            { name: "no-watch", type: "regexp", descr: "Files to be ignored by the wather" },
            { name: "locales", array: 1, type: "list", descr: "A list of locales to load from the locales/ directory, only language name must be specified, example: en,es. It enables internal support for `res.__` and `req.__` methods that can be used for translations, for each request the internal language header will be honored forst, then HTTP Accept-Language" },
            { name: "no-locales", type: "bool", descr: "Do not load locales on start" },
            { name: "smtp-(.+)", obj: "smtp", make: "$1", descr: "SMTP server parameters, user, password, host, ssl, tls...see emailjs for details" },
            { name: "tmp-watcher-(.+)", obj: "tmp-watcher", type: "int", strip: "tmpWatcher", descr: "How long to keep files per subdirectory in seconds" },
    ],
}

module.exports = core;

// Main initialization, must be called prior to perform any actions.
//
// If options are given they may contain the following properties:
// - noDb - if true do not initialize database
// - noConfigure - do not run all configure methods
// - noDns - do not retrieve config from DNS
// - noWatch - do not watch and reload config files
// - noModules - do not load modules
// - noLocales - do not load locales
// - denyModules - which modules should not be loaded
// - allowModules - which modules to load
core.init = function(options, callback)
{
    var self = this;

    if (typeof options == "function") callback = options, options = {};
    if (!options) options = {};
    var db = self.modules.db;

    // Already initialized, skip the whole sequence so it is safe to run in the server the scripts which
    // can be used as standalone node programs
    if (this._initialized) {
        logger.debug("init:", this.role, "already initialized");
        return typeof callback == "function" ? callback.call(self, null, options) : true;
    }

    // Process role
    if (options.role) this.role = options.role;
    if (cluster.worker) this.workerId = cluster.worker.id;

    // Random proces id to be used as a prefix in clusters
    this.pid = crypto.randomBytes(4).toString('hex');

    // Initial args to run before the config file
    this.processArgs(this, process.argv, 1);

    // Default home as absolute path from the command line or custom config file passed
    this.setHome(this.home);

    // No restriction on the client http clients
    http.globalAgent.maxSockets = http.Agent.defaultMaxSockets = Infinity;
    https.globalAgent.maxSockets = Infinity;

    // Find our IP address
    var intf = os.networkInterfaces();
    Object.keys(intf).forEach(function(x) {
        if (x.substr(0, 2) == 'lo') return;
        intf[x].forEach(function(y) {
            if (y.family != 'IPv4' || !y.address) return;
            if (!self.ipaddr) self.ipaddr = y.address;
            self.ipaddrs.push(y.address);
        });
    });
    this.subnet = self.ipaddr.split(".").slice(0, 3).join(".");
    this.network = self.ipaddr.split(".").slice(0, 2).join(".");
    this.hostName = os.hostname().toLowerCase();
    this.domain = lib.domainName(this.hostName);
    this.location = "http://" + this.hostName + ":" + core.port;
    // Pre load config files into memory to perform 2 passes
    var config = "";

    // Serialize initialization procedure, run each function one after another
    lib.series([
        function(next) {
            // Default config files, locate in the etc if just name is given
            if (self.confFile.indexOf("/") == -1) self.confFile = path.join(self.path.etc, self.confFile);
            self.confFile = path.resolve(self.confFile);
            lib.forEachSeries([self.confFile, self.confFile + ".local"], function(file, next2) {
                logger.debug('loadConfig:', self.role, file);
                fs.readFile(file, function(err, data) {
                    if (data) config += data.toString() + "\n";
                    next2();
                });
            }, next);
        },

        // Process first pass parameters, this is important for modules to be loaded
        function(next) {
            self.parseConfig(config, 2);
            next();
        },

        // Load external modules, from the core and from the app home
        function(next) {
            if (options.noModules) return next();
            var modules = path.resolve(__dirname, "../modules");
            var opts = {
                denyModules: options.denyModules || self.denyModules[self.role] || self.denyModules[""],
                allowModules: options.allowModules || self.allowModules[self.role] || self.allowModules[""]
            };
            if (modules != path.resolve(self.path.modules)) {
                self.loadModules(modules, opts);
            }
            self.loadModules(self.path.modules, opts);
            next();
        },

        // Now re-process all other config parameters for all modules again
        function(next) {
            self.parseConfig(config);

            // Override by the command line parameters
            self.parseArgs(process.argv);
            next();
        },

        // Application version from the package.json
        function(next) {
            if (!self.appName) {
                var pkg = lib.readFileSync("package.json", { json: 1, logger: "error", missingok: 1  });
                if (!pkg.version) pkg = lib.readFileSync(self.cwd + "/package.json", { json: 1, logger: "error", missingok: 1 });
                if (!pkg.version) pkg = lib.readFileSync(self.path.etc + "/../package.json", { json: 1, logger: "error", missingok: 1 });
                if (pkg.name) self.appName = pkg.name;
                if (pkg.version) self.appVersion = pkg.version;
                if (pkg.description) self.appDescr = pkg.description;
                if (!self.appName) self.appName = self.name;
            }
            next();
        },

        // Load config params from the DNS TXT records, only the ones marked as dns
        function(next) {
            if (options.noDns || self.noDns) return next();
            self.loadDnsConfig(options, next);
        },

        // Create all directories, only master should do it once but we resolve absolute paths in any mode
        function(next) {
            try { process.umask(self.umask); } catch(e) { logger.error("umask:", self.umask, e) }

            // Create all subfolders with permissions, run it before initializing db which may create files in the spool folder
            if (!cluster.isWorker && !self.worker) {
                Object.keys(self.path).forEach(function(p) {
                    lib.mkdirSync(self.path[p]);
                    lib.chownSync(this.uid, this.gid, self.path[p]);
                });
            }
            next();
        },

        // Run all configure methods for every module
        function(next) {
            if (options.noConfigure || self.noConfigure) return next();
            self.runMethods("configure", options, next);
        },

        // Initialize all database pools
        function(next) {
            if (options.noDb || self.noDb) return next();
            db.init(options, next);
        },

        // Load all available config parameters from the config database for the specified config type
        function(next) {
            if (options.noDb || self.noDb) return next();
            db.initConfig(options, next);
        },

        // Make sure spool and db files are owned by regular user, not the root
        function(next) {
            if (!cluster.isWorker && !self.worker && process.getuid() == 0) {
                lib.findFileSync(self.path.spool).forEach(function(p) { lib.chownSync(self.uid, self.gid, p); });
            }
            next();
        },

        function(next) {
            if (options.noWatch) return next();
            // Can only watch existing files
            lib.forEach([self.confFile, self.confFile + ".local"], function(file, next2) {
                fs.exists(file, function(exists) {
                    if (exists) fs.watch(file, function (event, filename) {
                        self.setTimeout(file, function() { self.loadConfig(file); }, 5000);
                    });
                    next2();
                });
            }, next);
        },

        // Initialize all modules after core is done
        function(next) {
            if (options.noConfigure || self.noConfigure) return next();
            self.runMethods("configureModule", options, next);
        },

        function(next) {
            if (options.noLocales || self.noLocales) return next();
            self.loadLocales(options, next);
        },

        function(next) {
            // Default email address
            if (!self.email) self.email = (self.appName || self.name) + "@" + self.domain;
            next();
        },
    ], function(err) {
        logger.debug("init:", self.role, options, err || "");
        if (!err) self._initialized = true;
        if (typeof callback == "function") callback.call(self, err, options);
    });
}

// Run any backend function after environment has been initialized, this is to be used in shell scripts,
// core.init will parse all command line arguments, the simplest case to run from /data directory and it will use
// default environment or pass -home dir so the script will reuse same config and paths as the server
// context can be specified for the callback, if no then it run in the core context
// - require('backendjs').run(function() {}) is one example where this call is used as a shortcut for ad-hoc scripting
core.run = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = {};

    if (typeof callback != "function") return logger.error('run:', 'callback is required');
    this.init(options, function(err) {
        callback.call(self, err);
    });
}

// Exit the process with possible message to be displayed and status code
core.exit = function(code, msg)
{
    if (msg) console.log(msg);
    process.exit(code || 0);
}

// Switch to new home directory, exit if we cannot, this is important for relative paths to work if used,
// no need to do this in worker because we already switched to home directory in the master and all child processes
// inherit current directory
// Important note: If run with combined server or as a daemon then this MUST be an absolute path, otherwise calling
// it in the spawned web master will fail due to the fact that we already set the home and relative path will not work after that.
core.setHome = function(home)
{
    if ((home || this.home) && cluster.isMaster) {
        if (home) this.home = path.resolve(home);
        // On create set permissions
        if (lib.makePathSync(this.home)) lib.chownSync(this.uid, this.gid, this.home);
        try {
            process.chdir(this.home);
        } catch(e) {
            logger.error('setHome: cannot set home directory', this.home, e);
            process.exit(1);
        }
        logger.dev('setHome:', this.role, this.home);
    }
    this.home = process.cwd();
}

// Parse config lines for the file or other place
core.parseConfig = function(data, pass)
{
    if (!data) return;
    var argv = [], lines = String(data).split("\n");
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.match(/^([a-z0-9_-]+)/)) continue;
        line = line.split("=");
        if (line[0]) argv.push('-' + line[0].trim());
        if (line[1]) argv.push(line.slice(1).join('=').trim());
    }
    this.parseArgs(argv, pass);
}

// Parse command line arguments
core.parseArgs = function(argv, pass)
{
    if (!Array.isArray(argv) || !argv.length) return;

    // Convert spaces if passed via command line
    argv = argv.map(function(x) {
        return x.replace(/(\\n|%20|%0A)/ig, function(m) { return m == '\\n' || m == '%0a' || m == '%0A' ? '\n' : m == "%20" ? ' ' : m; });
    });
    logger.dev('parseArgs:', this.role, argv.join(' '));

   // Core parameters
    this.processArgs(this, argv, pass);

    // Run registered handlers for each module
    for (var n in this.modules) {
        this.processArgs(this.modules[n], argv, pass);
    }
}

// Config parameters defined in a module as a list of parameter names prefixed with module name, a parameters can be
// a string which defines text parameter or an object with the properties: name, type, value, decimals, min, max, separator
// type can be bool, number, list, json
core.processArgs = function(ctx, argv, pass)
{
    var self = this;
    if (!ctx || !Array.isArray(ctx.args) || !Array.isArray(argv) || !argv.length) return;

    function put(obj, key, val, x, reverse) {
        if (reverse) {
            var v = val;
            val = key;
            key = v;
        }

        if (Array.isArray(key)) {
            for (var i in key) put(obj, key[i], val, x);
        } else
        if (x.array) {
            if (val == null) {
                obj[key] = [];
            } else {
                if (!Array.isArray(obj[key]) || x.set) obj[key] = [];
                if (Array.isArray(val)) {
                    val.forEach(function(x) { if (obj[key].indexOf(x) == -1) obj[key].push(x); });
                } else {
                    if (obj[key].indexOf(val) == -1) obj[key].push(val);
                }
            }
        } else {
            if (val == null) {
                delete obj[key];
            } else {
                obj[key] = val;
            }
        }
    }

    for (var i = 0; i < argv.length; i++) {
        var key = String(argv[i]);
        if (!key || key[0] != "-") continue;
        var val = argv[i + 1] || null;
        if (val) {
            val = String(val);
            // Numbers can start with the minus and be the argument value
            if (val[0] == "-" && !/^[0-9-]+$/.test(val)) val = null; else i++;
        }

        ctx.args.forEach(function(x) {
            if (!x.name) return;
            // Process only equal to the given pass phase
            if (pass && !x.pass) return;
            if (x.cmdline && x._cmdline) return;

            var obj = ctx;
            // Module prefix and name of the key variable in the contenxt, key. property specifies alternative name for the value
            var prefix = ctx == self ? "-" : "-" + ctx.name + "-";
            // Name can be a regexp
            var d = key.match("^" + prefix + x.name + "$");
            if (!d) return;
            var name = x.key || key.substr(prefix.length), oname = "";
            // Process type restrictions
            if ((x.master && cluster.isWorker) || (x.worker && cluster.isMaster)) return;

            try {
                // Make name from the matched pieces
                if (x.make) {
                    name = x.make;
                    for (var j = 1; j < d.length; j++) {
                        name = name.replace("$" + j, d[j] || "");
                    }
                }
                // Place inside the object
                if (x.obj) {
                    oname = x.obj;
                    // Substitutions from the matched key
                    if (oname.indexOf("$") > -1) {
                        for (var j = 1; j < d.length; j++) {
                            oname = oname.replace("$" + j, d[j] || "");
                        }
                    }
                    // Compound name, no camel
                    if (oname.indexOf(".") > -1) {
                        obj = lib.objGet(ctx, oname + "." + name, { owner: 1 });
                        if (!obj) lib.objSet(ctx, oname, obj = {});
                    } else {
                        if (!x.nocamel) oname = lib.toCamel(oname, x.camel);
                        if (!ctx[oname]) ctx[oname] = {};
                        obj = ctx[oname];
                        // Strip the prefix if starts with the same name
                        name = name.replace(new RegExp("^" + x.obj + "-"), "");
                    }
                }

                if (!x.nocamel) name = lib.toCamel(name, x.camel);
                if (x.ucase) name = name.replace(x.ucase, function(v) { return v.toUpperCase(); });
                if (x.lcase) name = name.replace(x.lcase, function(v) { return v.toLowerCase(); });
                if (x.strip) name = name.replace(x.strip, "");

                // Use defaults only for the first time
                if (val == null && typeof obj[name] == "undefined") {
                    if (typeof x.novalue != "undefined") val = x.novalue;
                }
                // Explicit empty value
                if (val == "''" || val == '""') val = "";
                // Only some types allow no value case
                var type = (x.type || "").trim();
                if (val == null && type != "bool" && type != "callback" && type != "none") return false;

                // Can be set only once
                if (x.once) {
                    if (!x._once) x._once = {};
                    if (x._once[name]) return;
                    x._once[name] = 1;
                }
                if (x.cmdline) x._cmdline = 1;

                // Set the actual config variable name for further reference and easy access to the value
                if (val != null) {
                    x._name = (oname ? oname + "." : "") + name;
                    x._key = key;
                }
                // Explicit clear
                if (val == "<null>" || val == "~") val = null;
                // Autodetect type
                if (x.autotype && val) {
                    if (lib.isNumeric(val)) type = "number"; else
                    if (val == "true" || val == "false") type = "bool"; else
                    if (val.indexOf("|") > -1) type = "list"; else
                    if (val[0] == "[" && val.slice(-1) == "]") type = "json"; else
                    if (val[0] == "{" && val.slice(-1) == "}") type = "json";
                }
                logger.debug("processArgs:", type || "str", ctx.name + "." + x._name, "(" + key + ")", "=", val);
                switch (type) {
                case "none":
                    break;
                case "bool":
                    put(obj, name, !val ? true : lib.toBool(val), x, x.reverse);
                    break;
                case "int":
                case "real":
                case "number":
                    put(obj, name, lib.toNumber(val, x.decimals, x.value, x.min, x.max), x, x.reverse);
                    break;
                case "map":
                    put(obj, name, lib.strSplit(val).map(function(x) { return x.split(":") }).reduce(function(x,y) { if (!x[y[0]]) x[y[0]] = {}; x[y[0]][y[1]] = 1; return x }, {}), x, x.reverse);
                    break;
                case "intmap":
                    put(obj, name, lib.strSplit(val).map(function(x) { return x.split(":") }).reduce(function(x,y) { x[y[0]] = lib.toNumber(y[1]); return x }, {}), x, x.reverse);
                break;
                case "list":
                    put(obj, name, lib.strSplitUnique(val, x.separator), x, x.reverse);
                    break;
                case "regexp":
                    put(obj, name, val ? new RegExp(val) : val, x, x.reverse);
                    break;
                case "regexpobj":
                    if (x.reverse) {
                        obj[val] = lib.toRegexpObj(obj[val], name, x);
                    } else {
                        obj[name] = lib.toRegexpObj(obj[name], val, x);
                    }
                    break;
                case "regexpmap":
                    if (x.reverse) {
                        obj[val] = lib.toRegexpMap(obj[val], name, x);
                    } else {
                        obj[name] = lib.toRegexpMap(obj[name], val, x);
                    }
                    break;
                case "url":
                    put(obj, name, val ? url.parse(val) : val, x, x.reverse);
                    break;
                case "json":
                    put(obj, name, val ? lib.jsonParse(val, x) : val, x, x.reverse);
                    break;
                case "path":
                    // Check if it starts with local path, use the actual path not the current dir for such cases
                    for (var p in this.path) {
                        if (val && val.substr(0, p.length + 1) == p + "/") {
                            val = this.path[p] + val.substr(p.length);
                            break;
                        }
                    }
                    put(obj, name, val ? path.resolve(val) : val, x, x.reverse);
                    break;
                case "file":
                    if (!val) break;
                    try { put(obj, name, fs.readFileSync(path.resolve(val)), x); } catch(e) { logger.error('procesArgs:', name, val, e); }
                    break;
                case "callback":
                    if (!x.callback) break;
                    if (typeof x.callback == "string") {
                        ctx[x.callback](val, name, pass);
                    } else
                    if (typeof x.callback == "function") {
                        x.callback.call(ctx, val, name, pass);
                    }
                    break;
                default:
                    put(obj, name, val, x, x.reverse);
                }
                // Notify about update
                if (typeof x.trigger == "function") x.trigger.call(ctx, val, name);
            } catch(e) {
                logger.error("processArgs:", self.role, name, val, e.stack);
            }
        });
    }
}

// Add custom config parameters to be understood and processed by the config parser
// - module - name of the module to add these params to, if it is an empty string or skipped then the module where any
//    parameter goes is determined by the prefix, for example if name is 'aws-elastic-ip' then it will be added to the aws module,
//    all not matched parameters will be added to the core module.
// - args - a list of objects in the format: { name: N, type: T, descr: D, min: M, max: M, array: B }, all except name are optional.
//
// Example:
//
//      core.describeArgs("api", [ { name: "num", type: "int", descr: "int param" }, { name: "list", array: 1, descr: "list of words" } ]);
//      core.describeArgs([ { name: "api-list", array: 1, descr: "list of words" } ]);
//
core.describeArgs = function(module, args)
{
    var self = this;
    if (typeof module != "string") args = module, module = "";
    if (!Array.isArray(args)) return;
    function addArgs(ctx, args) {
        if (!ctx.args) ctx.args = [];
        ctx.args.push.apply(ctx.args, args.filter(function(x) { return x.name }));
    }
    var ctx = module == "core" ? this : this.modules[module];
    if (ctx) return addArgs(ctx, args);

    // Add arguments to the module by the prefix
    var map = {};
    args.forEach(function(x) { map[x.name] = x });
    Object.keys(this.modules).forEach(function(ctx) {
        Object.keys(map).forEach(function(x) {
            var n = x.split("-");
            if (n[0] == ctx) {
                map[x].name = n.slice(1).join("-");
                addArgs(self.modules[ctx], [map[x]]);
                delete map[x];
            }
        });
    });
    // The rest goes to the core
    addArgs(this, Object.keys(map).map(function(x) { return map[x] }));
}

// Parse the config file, configFile can point to a file or can be skipped and the default file will be loaded
core.loadConfig = function(file, callback)
{
    var self = this;
    if (typeof callback != "function") callback = lib.noop;

    logger.debug('loadConfig:', this.role, file);

    fs.readFile(file || "", function(err, data) {
        if (!err) self.parseConfig(data);
        callback(err);
    });
}

// Load configuration from the DNS TXT records
core.loadDnsConfig = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null
    if (!options) options = {};
    if (typeof callback != "function") callback = lib.noop;

    if (!self.configDomain) return callback();

    var args = [], argv = [];
    this.args.forEach(function(x) { if (x.name && x.dns) push(["", x]); });
    for (var p in this.modules) {
        if (Array.isArray(this.modules[p].args)) this.modules[p].args.forEach(function(x) { if (x.name && x.dns) push([p + "-", x]); });
    }
    lib.forEachLimit(args, options.concurrency || 5, function(x, next) {
        var cname = x[0] + x[1].name;
        dns.resolveTxt(cname + "." + self.configDomain, function(err, list) {
            if (!err && list && list.length) {
                argv.push("-" + cname, list[0]);
                logger.debug('loadDnsConfig:', self.role, cname, list[0]);
            }
            next();
        });
    }, function() {
        self.parseArgs(argv);
        callback();
    });
}

// Load configured locales
core.loadLocales = function(options, callback)
{
    var self = this;
    lib.forEach(this.locales, function(x, next) {
        lib.loadLocale(self.path.locales + "/" + x + '.json', function() {
            next();
        });
    }, function() {
        if (self._localeFiles) {
            self._localeFiles.forEach(function(x) {
                if (x.watcher) x.watcher.close();
            });
            delete self._localeFiles;
        }

        self.watchFiles(self.path.locales, /\.json$/, function(file) {
            lib.loadLocale(file.name);
        }, function(err, files) {
            self._localeFiles = files;
            if (typeof callback == "function") callback(err);
        });
    });
}

// Run a method for every module, a method must conform to the following signature: `function(options, callback)` and
// call the callback when finished. The callback second argument will be the options, so it is possible to pass anything
// in the options back to the caller. Errors from a module is never propagated and simply ignored.
//
// The following properties can be specified in the options:
//  - filterModules - a regexp of the modules names to be called only
//
core.runMethods = function(name, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};

    lib.forEachSeries(Object.keys(this.modules), function(mod, next) {
        if (util.isRegExp(options.filterModules) && !options.filterModules.test(mod)) return next();
        var ctx = self.modules[mod];
        if (typeof ctx[name] != "function") return next();
        logger.debug("runMethods:", self.role, name, mod);
        ctx[name](options, function(err) {
            if (err) logger.error('runMethods:', self.role, name, mod, err);
            next();
        });
    }, callback);
}

// Adds reference to the objects in the core for further access, specify module name, module reference pairs.
// This is used the the core itself to register all internal modules and makes it available in the shell and in the `core.modules` object.
//
// Also this is used when cresting modular backend application by separating the logic into different modules, by registering such
// modules with the core it makes the module a first class citizen in the backendjs core and exposes all the callbacks and methods.
//
// For example, the module below will register API routes and some methods
//
//       var bkjs = require("backendjs");
//       var mymod = {}
//       exports.module = mymod;
//       core.addModule("mymod", mymod);
//       mymod.configureWeb = function(options, callback) {
//          bkjs.api.app.all("/mymod", function(req, res) {
//               res.json({});
//          });
//       }
//
//
// In the main app.js just load it and the rest will be done automatically, i.e. routes will be created ...
//
//       var mymod = require("./mymod.js");
//
// Running the shell will make the object `mymod` available
//
//       ./app.sh -shell
//       > mymod
//         {}
//
core.addModule = function()
{
    for (var i = 0; i < arguments.length - 1; i+= 2) {
        this.modules[arguments[i]] = arguments[i + 1];
        if (!arguments[i + 1].name) arguments[i + 1].name = arguments[i];
    }
}

// Dynamically load services from the specified directory.
//
// The modules are loaded using `require` as a normal nodejs module but in addition if the module exports
// `init` method it is called immediately with options passed as an argument. This is a synchronous function so it is supposed to be
// called on startup, not dynamically during a request processing. Only top level .js files are loaded, not subdirectories. `core.addModule` is called
// automatically.
//
// **Caution must be taken for module naming, it is possible to override any default bkjs module which will result in unexpected behaviour**
//
// The following options properties can be specified:
//  - denyModules - a regexp with modules name(s) to be excluded from loading, the basename of a file is checked only
//  - allowModules - a regexp with modules name(s) to be loaded only
//
//  Example, to load all modules from the local relative directory
//
//       core.loadModules("modules")
//
core.loadModules = function(dir, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};
    var denyModules = util.isRegExp(options.denyModules) ? options.denyModules: null;
    var allowModules = util.isRegExp(options.allowModules) ? options.allowModules: null;

    lib.findFileSync(path.resolve(dir), { depth: 1, types: "f", include: /\.js$/ }).sort().forEach(function(file) {
        try {
            var base = path.basename(file, ".js");
            if (denyModules && denyModules.test(base)) return;
            if (allowModules && !allowModules.test(base)) return;

            var mod = require(file);
            self.addModule(mod.name || base, mod);
            // Call the initializer method for the module after it is registered
            if (typeof mod.init == "function") {
                mod.init(options);
            }
            logger.info("loadModules:", self.role, file, "loaded", "allow:", allowModules);
        } catch (e) {
            logger.error("loadModules:", self.role, file, e.stack);
        }
    });
    if (typeof callback == "function") callback();
}

// Make a HTTP request, see `httpGet` module for more details.
core.httpGet = function(uri, params, callback)
{
    this.modules.httpGet(uri, params, callback);
}

// Make a HTTP request using `httpGet` with ability to sign requests.
//
// The POST request is made, if data is an object, it is converted into string.
//
// Returns params as in `httpGet` with .json property assigned with an object from parsed JSON response.
//
// *When used with API endpoints, the `backend-host` parameter must be set in the config or command line to the base URL of the backend,
// like http://localhost:8000, this is when `uri` is relative URL. Absolute URLs do not need this parameter.*
//
// Special parameters for options:
// - url - url if options is first argument
// - login - login to use for access credentials instead of global credentials
// - secret - secret to use for access instead of global credentials
// - checksum - calculate checksum from the data
// - obj - return just the result object, not the whole params
core.sendRequest = function(options, callback)
{
    if (typeof options == "string") options = { url: options };

    // Sign request using internal backend credentials
    if (options.sign || typeof options.sign == "undefined") {
        options = lib.cloneObj(options, "signer", this.signRequest);
    }

    // Relative urls resolve against global backend host
    if (typeof options.url == "string" && options.url.indexOf("://") == -1) {
        options = lib.cloneObj(options, "url", (this.backendHost || "http://localhost:" + this.port) + options.url);
    }

    this.httpGet(options.url, options, function(err, params) {
        if (!params.obj) params.obj = {};
        if ((params.status < 200 || params.status > 299) && !err) {
            err = lib.newError({ message: "Error " + params.status + (params.data ? ": " + params.data : ""), status: params.status });
        }
        if (typeof callback == "function") callback(err, options.obj ? params.obj : params);
    });
}

core.signRequest = function()
{
    this.login = this.login || core.backendLogin || '';
    this.secret = this.secret || core.backendSecret || '';
    if (!this.login || !this.secret) return;
    var headers = core.modules.api.createSignature(this.login,
                                                   this.secret,
                                                   this.method,
                                                   this.hostname,
                                                   this.path,
                                                   { type: this.headers['content-type'], checksum: this.checksum });
    for (var p in headers) this.headers[p] = headers[p];
}

// Drop root privileges and switch to regular user
core.dropPrivileges = function()
{
    if (process.getuid() == 0 && this.uid) {
        logger.debug('init: switching to', this.uid, this.gid);
        try { process.setgid(this.gid); } catch(e) { logger.error('setgid:', this.gid, e); }
        try { process.setuid(this.uid); } catch(e) { logger.error('setuid:', this.uid, e); }
    }
}

