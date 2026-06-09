# EvilQuest Native Client OAuth Login

This is the login path for approved external native clients such as EvilLite.

Base URL:

```text
https://evilquest.net
```

## Registered Clients

Use the client ID EvilQuest has assigned to your build:

| Client | `client_id` | Scope |
| --- | --- | --- |
| EvilLite official | `evillite` | `game` |
| EvilLite approved dev builds | `evillite-dev` | `game` |

No client secret is used. This is OAuth 2.0 Authorization Code with PKCE S256.
The `client_id` is public and identifies which integration the user authorized. It does not prove the binary is an official build.

## Loopback Callback, Not Local Dev

The redirect URI is a temporary callback listener opened by the native client on the player's own computer:

```text
http://127.0.0.1:<random-port>/cb
http://localhost:<random-port>/cb
```

This is not an EvilQuest development server and does not require access to any EvilQuest local/dev environment. The browser logs in at `https://evilquest.net`, then redirects the one-time authorization code back to the fan client's temporary local listener. The host and path must match. The port may vary.

## Login Flow

1. Generate:

```text
state        = random CSRF string
code_verifier = random 43-128 char PKCE verifier using A-Z a-z 0-9 . _ ~ -
code_challenge = BASE64URL(SHA256(code_verifier))
device_id    = UUID v4, persisted for this install
```

2. Start a loopback HTTP listener on the redirect URI, for example:

```text
http://127.0.0.1:49152/cb
```

3. Open the system browser to:

```text
GET https://evilquest.net/oauth/authorize
  ?response_type=code
  &client_id=evillite
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcb
  &code_challenge=<code_challenge>
  &code_challenge_method=S256
  &state=<state>
  &scope=game
```

The user logs in on EvilQuest in the real browser. reCAPTCHA runs there.

4. Browser redirects to:

```text
http://127.0.0.1:49152/cb?code=<code>&state=<state>
```

Verify `state` before continuing.

5. Exchange the code from the native/main process:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
client_id=evillite&
code=<code>&
redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcb&
code_verifier=<code_verifier>&
device_id=<uuid-v4>
```

Important: make this request from native/main process or another HTTP client that does not send a foreign browser `Origin` header.

Successful response:

```json
{
  "access_token": "<evilquest-session-token>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "<refresh-token>",
  "scope": "game",
  "client_id": "evillite",
  "username": "player"
}
```

Also store the returned cookies from `Set-Cookie`:

```text
eq_ws_session=...
eq_device_id=...
```

Those cookies are required for HTTP auth checks and WebSocket upgrades.

## Refresh

Refresh tokens rotate. Store the new refresh token and discard the old one.

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&
client_id=evillite&
refresh_token=<refresh-token>&
device_id=<same-uuid-v4>
```

The response shape is the same as the first token exchange and includes a new `refresh_token`.

## Revoke

```http
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded

client_id=evillite&
token=<access-or-refresh-token>
```

## Device Key Registration

Before opening the game WebSocket, create and persist an ECDSA P-256 signing key for this install.

Register the public JWK:

```http
POST /api/device-key
Authorization: Bearer <access_token>
Cookie: eq_ws_session=<...>; eq_device_id=<uuid-v4>
Content-Type: application/json

{ "publicKey": <public-jwk> }
```

The private key stays on the user's device. The game WebSocket handshake uses it to sign the server challenge.

## WebSockets

Open game and chat sockets with the access token as a WebSocket subprotocol:

```text
Sec-WebSocket-Protocol: auth.<access_token>
Cookie: eq_ws_session=<...>; eq_device_id=<uuid-v4>
Origin: https://evilquest.net
```

Endpoints:

```text
wss://evilquest.net/ws/game
wss://evilquest.net/ws/chat
```

The production server enforces allowed WebSocket origins. If your runtime lets you set an Origin header, use `https://evilquest.net`. A renderer page with an `app://` or `file://` Origin will be rejected.

The game socket sends a crypto challenge first. Complete the game protocol handshake:

1. Receive the server crypto challenge.
2. Generate an ECDH key pair for this connection.
3. Build the shared handshake transcript.
4. Sign the transcript with the persisted ECDSA P-256 device private key.
5. Send the crypto response.
6. Use the derived cipher keys for subsequent game frames.

EvilQuest can provide the current binary game protocol details separately. OAuth only gets you an authenticated session; it does not replace the game protocol.

## Notes

- reCAPTCHA is only on `/oauth/authorize`; the native app never handles it.
- Access tokens are EvilQuest session tokens and currently last 1 hour.
- `game` scope does not grant staff, moderator, or admin privileges, even if the account has them on the website.
- Refresh tokens currently last 30 days and rotate on every refresh.
- A new OAuth login/refresh replaces the previous active session for the account, matching the normal single-session game model.
- `device_id` must be a UUID v4 and must stay stable for the install.
