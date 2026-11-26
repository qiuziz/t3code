// Packaging signs the built app for the macOS build host.
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const STABLE_IDENTITY = "T3 Code Custom Mac Signing";
const SIGNING_DIR = (process.env.T3CODE_MAC_SIGNING_DIR ?? "").trim() || os.tmpdir();
const STABLE_KEY_PATH = path.join(SIGNING_DIR, "t3code-custom-desktop-signing.key");
const STABLE_CERT_PATH = `${STABLE_KEY_PATH}.pem`;
const STABLE_KEYCHAIN = path.join(SIGNING_DIR, "t3code-custom-desktop-signing.keychain-db");
// Non-empty because macOS rejects an empty-password PKCS#12 from OpenSSL as a bad MAC, and a
// passwordless keychain can make SecurityAgent prompt instead of failing.
const STABLE_PASSWORD = "t3code-custom-signing";
// A headless runner has nobody to answer a keychain prompt, so never wait forever.
const COMMAND_TIMEOUT_MS = 120_000;
const OPENSSL_CONFIG = `
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3
[dn]
CN = ${STABLE_IDENTITY}
O = T3 Code Custom Builds
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
`;

const run = (args, failure) => {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(-400);
    throw new Error(detail === "" ? failure : `${failure}: ${detail}`);
  }
};

const capture = (args) => {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
  });
  return result.error === undefined && result.status === 0 ? result.stdout.trim() : "";
};

// An ad-hoc signature is keyed to each build's CDHash, so Full Disk Access and Keychain
// ACLs reset on every release. A self-signed certificate with a fixed key gives a stable
// designated requirement (`identifier "com.qiuz.t3code" and certificate leaf = H"..."`)
// across releases, which keeps TCC grants and lets Squirrel accept in-app updates.
function prepareSigningKeychain() {
  fs.mkdirSync(SIGNING_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(STABLE_KEYCHAIN)) {
    run(
      ["security", "create-keychain", "-p", STABLE_PASSWORD, STABLE_KEYCHAIN],
      "Failed to create the desktop signing keychain.",
    );
  }
  run(
    ["security", "unlock-keychain", "-p", STABLE_PASSWORD, STABLE_KEYCHAIN],
    "Failed to unlock the desktop signing keychain.",
  );
}

function ensureStableSigningIdentity() {
  // Ask the keychain directly: the identity need not be the default or a "valid" identity yet.
  const imported = capture([
    "security",
    "find-certificate",
    "-c",
    STABLE_IDENTITY,
    "-k",
    STABLE_KEYCHAIN,
  ]);
  if (fs.existsSync(STABLE_KEYCHAIN) && imported !== "") return;

  const p12Path = `${STABLE_KEY_PATH}.p12`;
  if (!fs.existsSync(STABLE_KEY_PATH) || !fs.existsSync(STABLE_CERT_PATH)) {
    const configPath = `${STABLE_KEY_PATH}.cnf`;
    fs.writeFileSync(configPath, OPENSSL_CONFIG, { mode: 0o600 });
    run(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:4096",
        "-nodes",
        "-sha256",
        "-days",
        "397",
        "-keyout",
        STABLE_KEY_PATH,
        "-out",
        STABLE_CERT_PATH,
        "-config",
        configPath,
      ],
      "Failed to create the self-signed certificate.",
    );
  }
  if (!fs.existsSync(p12Path)) {
    // codesign needs the private key, which a bare certificate import does not carry.
    run(
      [
        "openssl",
        "pkcs12",
        "-export",
        // macOS Security.framework rejects OpenSSL 3's PBES2/AES-256 PKCS#12 as a bad MAC.
        "-legacy",
        "-inkey",
        STABLE_KEY_PATH,
        "-in",
        STABLE_CERT_PATH,
        "-out",
        p12Path,
        "-passout",
        `pass:${STABLE_PASSWORD}`,
      ],
      "Failed to bundle the self-signed certificate with its key.",
    );
  }

  run(
    [
      "security",
      "import",
      p12Path,
      STABLE_KEYCHAIN,
      "-k",
      STABLE_KEYCHAIN,
      "-P",
      STABLE_PASSWORD,
      "-T",
      "/usr/bin/codesign",
      "-A",
    ],
    "Failed to import the self-signed certificate.",
  );
  // Without the partition list codesign cannot use the key headlessly and prompts instead.
  run(
    [
      "security",
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      STABLE_PASSWORD,
      STABLE_KEYCHAIN,
    ],
    "Failed to authorize codesign for the self-signed key.",
  );
}

/** Run `task` with the signing keychain as the default, then restore the user's default. */
function withSigningKeychain(task) {
  const previousDefault = capture(["security", "default-keychain", "-d", "user"])
    .split("\n")[0]
    .trim()
    .replace(/^"|"$/g, "");
  // The search list is left alone: changing it can make SecurityAgent prompt for the login
  // keychain on a headless runner, which is what hung the first build.
  run(
    ["security", "default-keychain", "-s", STABLE_KEYCHAIN],
    "Failed to select the desktop signing keychain.",
  );
  try {
    return task();
  } finally {
    if (previousDefault) {
      run(
        ["security", "default-keychain", "-s", previousDefault],
        "Failed to restore the default keychain.",
      );
    }
  }
}

module.exports = async (context) => {
  await require("./prepare-server-compile-cache.cjs")(context);
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // Only CI opts in: a stable identity needs its own keychain as the default, which must
  // never happen in a developer session. Local builds keep the ad-hoc signature.
  const signAdHoc = () => {
    run(["codesign", "--force", "--deep", "--sign", "-", appPath], "Ad-hoc signing failed");
    run(["codesign", "--verify", "--verbose=2", appPath], "Ad-hoc signature verification failed");
  };

  if (!process.env.T3CODE_MAC_SIGNING_DIR) {
    signAdHoc();
    console.log(`[sign] Ad-hoc signed ${appPath}`);
    return;
  }

  // Import while the keychain is not the default: that is the headless-friendly path, and
  // SecurityAgent never has to authorize the login keychain.
  prepareSigningKeychain();
  ensureStableSigningIdentity();
  withSigningKeychain(() => {
    run(
      ["codesign", "--force", "--deep", "--sign", STABLE_IDENTITY, appPath],
      "Stable self-signing failed",
    );
    run(["codesign", "--verify", "--verbose=2", appPath], "Signature verification failed");
  });

  const designated = capture(["codesign", "-dr", "-", appPath]);
  if (!designated) throw new Error("Could not read designated requirement after signing.");
  console.log(`[sign] Signed ${appPath} with ${STABLE_IDENTITY}`);
  console.log(designated);
};
