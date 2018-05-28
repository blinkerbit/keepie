// pgBoot.js - an example keepie "client" with a pg db
// Copyright (C) 2018 by Nic Ferrier

const fs = require('./fsasync.js');
const { URL } = require('url');
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Transform } = require("stream");
const net = require('net');
const path = require("path");

const FormData = require('form-data');
const fetch = require("node-fetch");
const express = require("express");
const bodyParser = require("body-parser");
const multer  = require('multer')

const { Client } = require('pg');
const sqlInit = require("./sqlapply.js");

const app = express();
const upload = multer()

function getFreePort () {
    let server = net.createServer(function(sock) { sock.close(); });
    return new Promise(function (resolve, reject) {
        try {
            let listener = server.listen(0, "127.0.0.1", function () {
                let address = listener.address();
                server.close();
                resolve(address);
            });
        }
        catch (e) {
            reject(e);
        }
    });
}


Array.prototype.forEachAsync = async function (fn) {
    for (let t of this) { await fn(t) }
};

Array.prototype.mapAsync = async function (fn) {
    let result = [];
    for (let t of this) { result.push(await fn(t)); }
    return result;
};

Array.prototype.filterAsync = async function (fn) {
    let result = [];
    for (let t of this) {
        let include = await fn(t);
        if (include) {
            result.push(t);
        }
    }
    return result;
};

async function findPathDir(exe, pathVar) {
    pathVar = pathVar !== undefined ? pathVar : process.env["PATH"];
    let pathParts = pathVar.split(path.delimiter);
    let existsModes = fs.constants.R_OK;
    let existing = await pathParts
        .filterAsync(async p => await fs.promises.exists(p, existsModes));
    let lists = await existing.mapAsync(
        async p => [p, await fs.promises.readdir(p)]
    );
    let exePlaces = lists.filter(n => n[1].find(s => s==exe || s==exe + ".exe") !== undefined);
    if (exePlaces.length > 0) {
        let [place, list] = exePlaces[0];
        return place;
    }
}


function eventToHappen(eventFn) {
    return new Promise((resolve, reject) => {
        eventFn(resolve);
    });
}

function grep (regex, fn) {
    return new Transform({
        transform(chunk, encoding, callback) {
            let dataBuf = chunk.toString();
            dataBuf.split("\n").forEach(line => {
                let result = regex.exec(line);
                if (result != null) {
                    fn(result);
                }
            });
            this.push(dataBuf);
            callback();
        }
    });
}

async function startDb(pgPath, dbDir) {
    // Get a spare socket
    let listenerAddress = await getFreePort();
    let socketNumber = "" + listenerAddress.port;
                
    // rewrite the port in postgresql.conf
    let config = dbDir + "/postgresql.conf";
    let file = await fs.promises.readFile(config);
    let portChanged = file.replace(
            /^[#]*port = .*/gm, "port = " + socketNumber
    );

    let runDir = dbDir + "/run";
    let sockDirChanged = portChanged.replace(
            /^[#]*unix_socket_directories = .*/gm,
        "unix_socket_directories = '" + runDir + "'"
    );
    await fs.promises.writeFile(config, sockDirChanged);
    await fs.promises.writeFile(dbDir + "/port", socketNumber);

    let postgresPath = pgPath + "/postgres";
    let startChild = spawn(postgresPath, ["-D", dbDir]);

    startChild.stdout.pipe(process.stdout);
    startChild.stderr
        .pipe(grep(/is (ready) to accept connections/,
                   (res => startChild.emit("accepting", res))))
        .pipe(process.stderr);

    let onConnectAccept = proc => startChild.on("accepting", proc);
    let found = await eventToHappen(onConnectAccept);

    let [_, ready] = found;
    if (ready != "ready") {
        throw new Error("not ready");
    }

    let dbConfig = {
        user: process.env["USER"],
        host: "localhost",
        port: socketNumber,
        database: "postgres"
    };
    sqlInit.initDb(__dirname + "/sql-scripts", dbConfig);
    //await sqlInit.end();
    console.log("keepie-pg:: db started and initialized.");
}

async function makePg(serviceName, password, pgBinDir) {
    // Do the postgres init after the response has gone back
    try {
        // Do Pg init
        let exists = await fs.promises.exists(pgBinDir);
        let path = process.env["PATH"] + ":" + ubuntuPgPath;
        let pgExeRoot = await findPathDir("initdb", path);
        
        let pgPath = pgExeRoot + "/initdb";
        let dbDir = __dirname + "/dbdir";
        let dbdirExists = await fs.promises.exists(dbDir);
        if (dbdirExists) {
            // Boot the db
            startDb(pgExeRoot, dbDir);
        }
        else {
            let listenerAddress = await getFreePort();
            let socketNumber = "" + listenerAddress.port;

            // You must supply a valid socket number
            let portEnv = { "PGPORT":  socketNumber };
            let env = { env: portEnv };

            let initdbPath = pgPath;
            console.log("initdbPath", initdbPath);
            let child = spawn(initdbPath, ["-D", dbDir], env);
            child.stdout.pipe(process.stdout);
            child.stderr.pipe(process.stderr);

            let onExit = proc => child.on("exit", proc);
            await eventToHappen(onExit);

            let runDir = dbDir + "/run";
            fs.promises.mkdir(runDir);

            // Boot it!
            startDb(pgExeRoot, dbDir);
        }
    }
    catch (e) {
        console.log("keepie pg -- db error", e);
    }
}

const ubuntuPgPath = "/usr/lib/postgresql/10/bin";

// What other guesses can we make?
async function guessPgBin() {
    let exec = require("util").promisify(require("child_process").exec);
    let lsbExe = await findPathDir("lsb_release");
    if (lsbExe != undefined) {
        // let ubuntuPgPath = "/usr/lib/postgresql/10/bin";
        let { stdout, stderr } = await exec("lsb_release -a");
        if (stdout.indexOf("Ubuntu") > -1) {
            console.log("pgBoot running on an Ubuntu");
            return ubuntuPgPath;
        }
    }
    let sandboxPg = path.join("/sandbox", "pgsql", "bin");
    let sandboxed = await findPathDir("pg_ctl", sandboxPg);
    if (sandboxed) {
        return sandboxPg;
    }
}

exports.boot = function (portToListen, options) {
    let opts = options != undefined ? options : {};
    let rootDir = opts.rootDir != undefined ? opts.rootDir : __dirname + "/www";
    let secretPath = opts.secretPath != undefined ? opts.secretPath : "/pg/keepie-secret/";
    let serviceName = opts.serviceName != undefined ? opts.serviceName : "pg-demo";
    let pgBinDir = opts.pgBinDir != undefined ? opts.pgBinDir : guessPgBin();

    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({extended: true}));

    app.post(secretPath, upload.array(), async function (req, response) {
        let data = req.body;
        let { name, password } = data;
        console.log("received authorization for", name);
        if (name !== serviceName || password === undefined) {
            response.sendStatus(400);
            return;
        }

        // And send back the response
        response.sendStatus(204);
        let onFinish = finisher => response.on("finish", finisher);
        await eventToHappen(onFinish);

        // Now make the pg
        makePg(name, password, pgBinDir);
    });

    app.post("/keepie-request", async function (req, response) {
        let receiptUrl = req.get("x-receipt-url");
        console.log("received internal keepie request to authorize", receiptUrl);
        let responseEnd = block => response.on("finish", block);
        response.sendStatus(204);
        await eventToHappen(responseEnd);

        console.log("keepie response ended - processing request");
        let fd = new FormData();
        fd.append("password", "Secret1234567!");
        fd.append("name", serviceName);
        let authorizationReceiptUrl = "http://localhost:" + app.port + secretPath;
        console.log("keepie authorization sending to", authorizationReceiptUrl);
        fd.submit(authorizationReceiptUrl);
    });

    // Standard app callback stuff
    let appCallback = opts.appCallback;
    if (typeof(appCallback) === "function") {
        appCallback(app);
    }

    let listener = app.listen(portToListen, "localhost", async function () {
        let addr = listener.address();
        app.port = addr.port;

        let listenerCallback = opts.listenerCallback;
        if (typeof(listenerCallback) === "function") {
            listenerCallback(listener.address());
        }

        console.log("keepie pg listening on ", app.port);

        // Where do we receive passwords from keepie?
        let passwordReceiptUrl =
            "http://" + addr.address + ":" + addr.port + secretPath;

        // What address do we call keepie on? by default this server (for dev)
        let defaultKeepieUrl = process.env["KEEPIEURL"];
        if (defaultKeepieUrl == undefined || defaultKeepieUrl == "") {
            defaultKeepieUrl =
                "http://" + addr.address + ":" + addr.port + "/keepie-request";
        }

        // Allow it to be defined in the opts
        let keepieUrl = opts.keepieUrl != undefined ? opts.keepieUrl : defaultKeepieUrl;

        // And get the keepie response
        console.log("fetching keepie auth from", keepieUrl, "to", passwordReceiptUrl);
        let keepieResponse = await fetch(keepieUrl,{
            method: "POST",
            headers: { "X-Receipt-Url": passwordReceiptUrl }
        });
        console.log("keepie status", keepieResponse.status);
    });
};

if (require.main === module) {
    try {
        let port = parseInt(process.argv.slice(2)[0])
        exports.boot(port);
    }
    catch (e) {
        console.log("couldn't start... port?", e);
    }
}
else {
    // Required as a module; that's ok, exports will be fine.
}

// pg.js ends here
