import { createHash } from "node:crypto";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "./config.js";

const OAUTH = `${config.frappeUrl}/api/method/frappe.integrations.oauth2`;

/**
 * Login is done by Frappe's own OAuth2 provider; this server only *publishes* the
 * discovery document (Frappe v15 doesn't) and *checks* the tokens Claude sends.
 *
 * Frappe v15 quirks this metadata works around:
 * - it never checks client_secret, so the client is public and PKCE (S256) protects the flow;
 * - its token endpoint breaks on HTTP Basic client auth, so we only advertise "none" / "client_secret_post".
 */
export const oauthMetadata: OAuthMetadata = {
  issuer: config.publicUrl,
  authorization_endpoint: `${OAUTH}.authorize`,
  token_endpoint: `${OAUTH}.get_token`,
  revocation_endpoint: `${OAUTH}.revoke_token`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  scopes_supported: ["all", "openid"],
};

// Verified tokens are trusted for this long before we ask Frappe again.
const CACHE_SECONDS = 60;
const cache = new Map<string, AuthInfo>();

export const frappeTokenVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = createHash("sha256").update(token).digest("hex");
    const now = Math.floor(Date.now() / 1000);
    const hit = cache.get(key);
    if (hit && (hit.expiresAt ?? 0) > now) return hit;
    cache.delete(key);

    let introspection: any;
    let whoami: Response;
    try {
      [introspection, whoami] = await Promise.all([
        fetch(`${OAUTH}.introspect_token`, {
          method: "POST",
          body: new URLSearchParams({ token, token_type_hint: "access_token" }),
          signal: AbortSignal.timeout(10_000),
        }).then((r) => r.json()),
        // Authoritative check: Frappe itself resolves the bearer token to a user (or Guest).
        fetch(`${config.frappeUrl}/api/method/frappe.auth.get_logged_user`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        }),
      ]);
    } catch (err) {
      console.error("token verification: Frappe unreachable", err);
      throw new ServerError("Could not reach the CRM to verify the token");
    }

    if (!introspection?.active) throw new InvalidTokenError("Token is not active");
    // Only accept tokens issued to the "Claude" OAuth Client, not to any other Frappe OAuth app.
    if (introspection.client_id !== config.oauthClientId) {
      throw new InvalidTokenError("Token was issued to a different OAuth client");
    }

    const user = whoami.ok ? ((await whoami.json()) as { message?: string }).message : undefined;
    if (!user || user === "Guest") throw new InvalidTokenError("Token is invalid or expired");

    const info: AuthInfo = {
      token,
      clientId: introspection.client_id,
      scopes: String(introspection.scope ?? "").split(/\s+/).filter(Boolean),
      // We re-verify with Frappe every CACHE_SECONDS; Frappe enforces the real expiry on each API call.
      expiresAt: now + CACHE_SECONDS,
      extra: { user },
    };

    if (cache.size > 500) cache.clear();
    cache.set(key, info);
    return info;
  },
};
