import packageJson from "../package.json";

const releaseTag = process.env.TAG ?? process.env.GITHUB_REF_NAME;

if (releaseTag === undefined || releaseTag.trim() === "") {
  throw new Error("Expected TAG or GITHUB_REF_NAME to contain the release tag.");
}

const normalizedTagVersion = releaseTag.trim().replace(/^v/, "");

if (normalizedTagVersion !== packageJson.version) {
  throw new Error(
    `Release tag version ${releaseTag} does not match package.json version ${packageJson.version}.`,
  );
}

console.log(`Release tag ${releaseTag} matches package.json version ${packageJson.version}.`);
