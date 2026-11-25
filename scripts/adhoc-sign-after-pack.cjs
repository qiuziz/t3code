// Packaging signs the built app for the macOS build host.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// This fork ships unsigned. electron-builder then leaves the Electron template's stale
// signature on the bundle, which macOS reports as "code has no resources but signature
// indicates they must be present"; Apple Silicon will not launch such an app reliably.
// Sign ad-hoc instead, after the compile-cache hook has written its files.
module.exports = async (context) => {
  await require("./prepare-server-compile-cache.cjs")(context);
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const run = (args, failure) => {
    const result = spawnSync("codesign", args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(failure);
  };
  run(["--force", "--deep", "--sign", "-", appPath], "Ad-hoc signing failed");
  run(["--verify", "--verbose=2", appPath], "Ad-hoc signature verification failed");
  console.log(`[adhoc-sign] Signed ${appPath}`);
};
