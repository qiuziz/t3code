// Packaging signs the built app for the macOS build host.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// electron-builder's appId (scripts/build-desktop-artifact.ts).
const APP_ID = "com.qiuz.t3code";
// Ad-hoc signatures otherwise derive their requirement from each build's CDHash, so Full Disk
// Access and keychain ACLs reset on every release and Squirrel rejects the next update. An
// explicit identifier-only requirement stays identical across builds; a certificate would too,
// but importing its private key into a keychain needs an interactive session CI does not have.
const DESIGNATED_REQUIREMENT = `designated => identifier "${APP_ID}"`;

const MACHO_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

const isMachO = (filePath) => {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return bytesRead === 4 && MACHO_MAGICS.has(buf.readUInt32BE(0));
  } catch {
    return false;
  }
};

// Sign inner Mach-O binaries and nested bundles bottom-up instead of `codesign --deep`,
// which leaves nested frameworks/helpers failing Squirrel's strict nested validation.
const collectNestedTargets = (appPath) => {
  const bundles = [];
  const machos = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        if (entry.name.endsWith(".framework") || entry.name.endsWith(".app") || entry.name.endsWith(".xpc")) {
          if (full !== appPath) bundles.push(full);
        }
      } else if (entry.isFile() && isMachO(full)) {
        machos.push(full);
      }
    }
  };

  walk(path.join(appPath, "Contents"));

  const bundleMainExes = new Set();
  for (const bundlePath of [appPath, ...bundles]) {
    const macosDir = path.join(bundlePath, "Contents", "MacOS");
    if (!fs.existsSync(macosDir)) continue;
    for (const file of fs.readdirSync(macosDir)) {
      bundleMainExes.add(path.join(macosDir, file));
    }
  }

  const innerMachos = machos.filter((filePath) => !bundleMainExes.has(filePath));
  bundles.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  return { innerMachos, bundles };
};

const run = (args, failure) => {
  const result = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
  if (result.status !== 0) throw new Error(failure);
};

module.exports = async (context) => {
  await require("./prepare-server-compile-cache.cjs")(context);
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const { innerMachos, bundles } = collectNestedTargets(appPath);

  for (const machoPath of innerMachos) {
    run(["codesign", "--force", "--sign", "-", machoPath], `Signing nested binary failed: ${machoPath}`);
  }
  for (const bundlePath of bundles) {
    run(["codesign", "--force", "--sign", "-", bundlePath], `Signing nested bundle failed: ${bundlePath}`);
  }
  run(
    [
      "codesign",
      "--force",
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
      "--deep",
      "--strict",
      "--verbose=2",
      // -R is the test requirement; --requirements only applies while signing.
      "-R",
      `=identifier "${APP_ID}"`,
      appPath,
    ],
    "Signature verification failed",
  );
  console.log(`[sign] Signed ${appPath} with ${DESIGNATED_REQUIREMENT} (${innerMachos.length} binaries, ${bundles.length} nested bundles)`);
};
