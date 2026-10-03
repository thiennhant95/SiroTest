# OIDC SSO — configuration guide (P2, config-only)

> HONEST STATUS: OIDC is **configuration shape + protocol helpers only** in
> this build (`apps/server/src/rbac.ts`: `readOidcConfig`,
> `validateOidcConfig`, `buildOidcLoginUrl`, `discoverOidcIssuer`,
> `exchangeOidcCode`, `decodeJwtPayloadUnsafe`). It is **OFF by default**,
> **Bearer auth remains primary**, and the flow has **NOT been verified
> against a real IdP** — verifying live requires an operator-supplied IdP
> (Keycloak / Authentik / Entra ID / Google / …). Do not enable
> `OIDC_ENABLED=1` in production until the live checklist below is green.

## 1. Environment shape

| Variable | Required | Example |
|---|---|---|
| `OIDC_ENABLED` | no (`1` to enable) | `1` |
| `OIDC_ISSUER` | yes when enabled | `https://sso.example.com/realms/studio` |
| `OIDC_CLIENT_ID` | yes when enabled | `playwright-studio` |
| `OIDC_CLIENT_SECRET` | yes (code exchange) | *(vault-only, never log)* |
| `OIDC_REDIRECT_URI` | yes when enabled | `https://studio.example.com/api/v1/auth/oidc/callback` |
| `OIDC_SCOPES` | no (default below) | `openid email profile` |

```bash
OIDC_ENABLED=1
OIDC_ISSUER=https://sso.example.com/realms/studio
OIDC_CLIENT_ID=playwright-studio
OIDC_CLIENT_SECRET=…              # vault/secret manager only
OIDC_REDIRECT_URI=https://studio.example.com/api/v1/auth/oidc/callback
OIDC_SCOPES="openid email profile"
```

Validate offline (no network): `validateOidcConfig(readOidcConfig())`
must return `[]`. There is no callback route yet — adding one is a separate
task (it must verify the JWT signature against the IdP JWKS first).

## 2. Protocol (what the helpers do)

1. **Discovery** — `GET {issuer}/.well-known/openid-configuration`
   → `discoverOidcIssuer()` returns `authorization_endpoint`,
   `token_endpoint`, `userinfo_endpoint?`, `jwks_uri`.
2. **Login URL** — `buildOidcLoginUrl(cfg, authorizationEndpoint, state, nonce)`
   builds `…?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…&nonce=…`.
   `state` (CSRF) and `nonce` (replay) MUST be random per request and
   validated on callback.
3. **Code exchange** — `exchangeOidcCode(tokenEndpoint, {code, clientId,
   clientSecret, redirectUri})` POSTs `grant_type=authorization_code` and
   returns the `id_token`.
4. **Verify BEFORE session** — fetch `jwks_uri`, verify the `id_token`
   signature + `iss` + `aud == OIDC_CLIENT_ID` + `exp` + `nonce`. Only then
   map `email`/`sub` to a `User` row (create-or-link) and mint the existing
   Bearer credential. `decodeJwtPayloadUnsafe` is shape-inspection ONLY.

## 3. Live-verification checklist (needs a real IdP)

- [ ] `validateOidcConfig` passes with production env.
- [ ] Discovery document fetch succeeds from the server network.
- [ ] Login URL redirects to the IdP and returns `?code=&state=`.
- [ ] Code exchange returns an `id_token`; JWKS signature verification passes.
- [ ] `aud`/`iss`/`exp`/`nonce` checks enforced; wrong-issuer tokens rejected.
- [ ] `email` claim maps to exactly one `User`; unknown users follow the
      operator's allowlist policy (never auto-admin).
- [ ] `OIDC_CLIENT_SECRET` never appears in logs, WS events, audit details,
      or error bodies (reuse the secret-redaction tests as a template).
- [ ] Safe introspection: `GET /api/v1/auth/oidc/status` shows
      `verifiedAgainstLiveIdp: true` only after this list is green
      (currently hardcoded `false`).

## 4. Role mapping (proposal, not enforced)

IdP groups → studio roles: map one group to `admin`, one to
`developer`, default to project-level `viewer` membership granted by a
project owner inside the app. Global `viewer` stays read-only
(`requireGlobalWriter` in `rbac.ts`); project writes additionally require
`requireRole(projectId, 'editor')`.
