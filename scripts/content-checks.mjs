// Content checks shared by every validator (artifacts and notes). One list, so
// a pattern added for one content type cannot silently miss the other — both
// end up on the same sites.

export const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["Cloudflare API token assignment", /\bCLOUDFLARE_API_TOKEN\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/i],
  ["generic bearer token", /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["OpenAI API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
];

// Labels of the secret patterns found in `content` (hard errors for callers).
export function findSecrets(content) {
  return secretPatterns.filter(([, pattern]) => pattern.test(content)).map(([label]) => label);
}

// Machine-local references that make no sense on a hosted page (warnings).
export function findLocalReferences(content) {
  const found = [];
  if (/file:\/\/|(?:^|["'(])\/Users\/|(?:^|["'(])\/home\//m.test(content)) {
    found.push("a local absolute path");
  }
  if (/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i.test(content)) {
    found.push("a localhost URL");
  }
  return found;
}
