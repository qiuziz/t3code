// Runs before main.cjs, and therefore before the desktop backend is spawned. Defaults only:
// a launch environment that already sets a proxy keeps it, so `open --env ...` stays optional
// instead of required.
const DEFAULT_PROXY_URL = "http://127.0.0.1:7897";
const DEFAULT_NO_PROXY =
  "localhost,127.0.0.1,::1,.local,.58corp.com,.58dns.org,.anjuke.com,.qiuz.site";

// The backend is a separate Node process that reads this at its own startup.
process.env.NODE_USE_ENV_PROXY = "1";
if (!process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = DEFAULT_PROXY_URL;
if (!process.env.HTTP_PROXY && !process.env.http_proxy) process.env.HTTP_PROXY = DEFAULT_PROXY_URL;
if (!process.env.NO_PROXY) process.env.NO_PROXY = DEFAULT_NO_PROXY;
if (!process.env.no_proxy) process.env.no_proxy = DEFAULT_NO_PROXY;
// Telemetry stays off in every process this app starts.
process.env.T3CODE_TELEMETRY_ENABLED = "0";
// This fork installs beside the official app. Give it its own Electron profile so the two do
// not fight over the single-instance lock (the official app owns the plain userData directory).
if (!process.env.T3CODE_DESKTOP_USER_DATA_SUFFIX) {
  process.env.T3CODE_DESKTOP_USER_DATA_SUFFIX = "-custom";
}

require("./compileCache.cjs");
require("./main.cjs");
