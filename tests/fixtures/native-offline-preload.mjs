import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
let attempts = 0;
function blocked() { attempts++; throw new Error("Offline delivery fixture forbids network access."); }
globalThis.fetch = blocked;
http.request = http.get = https.request = https.get = blocked;
net.connect = net.createConnection = tls.connect = blocked;
syncBuiltinESMExports();
process.on("exit", () => { process.stderr.write(`NATIVE_NETWORK_ATTEMPTS:${attempts}\n`); if (attempts) process.exitCode = 1; });
