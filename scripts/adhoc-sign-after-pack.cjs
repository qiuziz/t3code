// Packaging signs the built app for the macOS build host.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// electron-builder's appId (scripts/build-desktop-artifact.ts).
const APP_ID = "com.qiuz.t3code";
// Ad-hoc signatures otherwise derive their requirement from each build's CDHash, so Full Disk
// Access and keychain ACLs reset on every release and Squirrel rejects the next update. An
// explicit identifier-only requirement stays identical across builds; a certificate would too,
// but importing its private key into a keychain needs an interactive session CI does not have.
const DESIGNATED_REQUIREMENT = `designated => identifier "${APP_ID}"`;

const run = (args, failure) => {
  const result = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
  if (result.status !== 0) throw new Error(failure);
};

module.exports = async (context) => {
  await require("./prepare-server-compile-cache.cjs")(context);
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  run(
    [
      "codesign",
      "--force",
      "--deep",
      "--sign",
      "-",
      "--identifier",
      APP_ID,
      "-r",
      `=${DESIGNATED_REQUIREMENT}`,
      appPath,
    ],
    "Signing with a stable designated requirement failed",
  );
  run(
    [
      "codesign",
      "--verify",
      "--verbose=2",
      // -R is the test requirement; --requirements only applies while signing.
      "-R",
      `=identifier "${APP_ID}"`,
      appPath,
    ],
    "Signature verification failed",
  );
  console.log(`[sign] Signed ${appPath} with ${DESIGNATED_REQUIREMENT}`);
};
