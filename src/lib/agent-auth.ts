import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

const TOKEN_PREFIX = "luigi_vps_";
const DIGEST_PREFIX = "sha256:";

export function hashAgentToken(token: string) {
  return `${DIGEST_PREFIX}${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

export function issueAgentCredentials() {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    agentId: randomUUID(),
    token,
    tokenDigest: hashAgentToken(token),
  };
}
