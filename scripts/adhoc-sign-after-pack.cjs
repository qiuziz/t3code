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
// Non-empty because macOS rejects an empty-password PKCS#12 from OpenSSL as a bad MAC.
const STABLE_P12_PASSWORD = "t3code-custom-signing";
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
  const result = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
  if (result.status !== 0) throw new Error(failure);
};

const capture = (args) => {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
};

// An ad-hoc signature is keyed to each build's CDHash, so Full Disk Access and Keychain
// ACLs reset on every release. A self-signed certificate with a fixed key gives a stable
// designated requirement (`identifier "com.qiuz.t3code" and certificate leaf = H"..."`)
// across releases, which keeps TCC grants and lets Squirrel accept in-app updates.
function ensureStableSigningIdentity() {
  fs.mkdirSync(SIGNING_DIR, { recursive: true, mode: 0o700 });
  const identities = // Not `-v`: a self-signed identity is usable for signing but is not a "valid" identity.
    capture(["security", "find-identity", "-p", "codesigning"]);
  if (identities.includes(`"${STABLE_IDENTITY}"`)) return;

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
        `pass:${STABLE_P12_PASSWORD}`,
      ],
      "Failed to bundle the self-signed certificate with its key.",
    );
  }

  if (!fs.existsSync(STABLE_KEYCHAIN)) {
    run(
      ["security", "create-keychain", "-p", "", STABLE_KEYCHAIN],
      "Failed to create the desktop signing keychain.",
    );
  }
  run(
    ["security", "unlock-keychain", "-p", "", STABLE_KEYCHAIN],
    "Failed to unlock the desktop signing keychain.",
  );
  run(
    [
      "security",
      "import",
      p12Path,
      STABLE_KEYCHAIN,
      "-k",
      STABLE_KEYCHAIN,
      "-P",
      STABLE_P12_PASSWORD,
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
      "",
      STABLE_KEYCHAIN,
    ],
    "Failed to authorize codesign for the self-signed key.",
  );
}

/** Run `task` with the signing keychain visible to codesign, then restore the user's setup. */
function withSigningKeychain(task) {
  const previousSearch = capture(["security", "list-keychains", "-d", "user"])
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  run(
    ["security", "list-keychains", "-d", "user", "-s", STABLE_KEYCHAIN, ...previousSearch],
    "Failed to add the desktop signing keychain to the search list.",
  );
  try {
    return task();
  } finally {
    // codesign finds identities through the search list; the default keychain stays untouched.
    if (previousSearch.length > 0) {
      run(
        ["security", "list-keychains", "-d", "user", "-s", ...previousSearch],
        "Failed to restore the keychain search list.",
      );
    }
  }
}

module.exports = async (context) => {
  await require("./prepare-server-compile-cache.cjs")(context);
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // Only CI opts in: a stable identity needs its own keychain in the search list, which must
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

  withSigningKeychain(() => {
    ensureStableSigningIdentity();
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
