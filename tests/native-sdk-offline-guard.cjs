/* eslint-disable @typescript-eslint/no-require-imports */
const net = require("node:net");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0];
  const host = options && typeof options === "object" ? options.host : normalized[1];
  // Only the test's WSS listener and the production loopback metadata server.
  if (host !== "127.0.0.1") throw Error("offline_native_outbound_forbidden");
  return Reflect.apply(connect, this, args);
};
