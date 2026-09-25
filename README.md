# x-chatgpt-plugin
Included
X OAuth 2.0 Authorization Code + PKCE
Encrypted X access/refresh-token storage using AES-256-GCM
Short-lived OAuth tokens for ChatGPT
ChatGPT Action-compatible OpenAPI specification
POST /v1/x/posts for publishing
GET /v1/x/me for identifying the connected account
X token refresh handling
OAuth authorization/consent flow
Single-use, expiring authorization codes
Redirect-URI allowlisting
SQLite persistence
Dockerfile + Docker Compose
.env.example
Production-hardening notes

The implementation uses X API v2 user-context authentication for posting; X documents OAuth 2.0 Authorization Code with PKCE as a user-context mechanism, and API access/rate limits depend on the applicable X access level.

Deployment flow
User
 │
 ├── /connect/x
 │       │
 │       └── X OAuth
 │
 ▼
Your service
 │
 ├── encrypted X tokens
 │
 └── OAuth server for ChatGPT
          │
          ▼
       ChatGPT Action
          │
          │ POST /v1/x/posts
          ▼
       Your service
          │
          │ Bearer X user token
          ▼
       X API v2
One important setup step

After deploying the service, configure the ChatGPT Action with:

OpenAPI:
https://YOUR_DOMAIN/openapi.yaml

Authorization:
OAuth 2.0 / Authorization Code

Authorization URL:
https://YOUR_DOMAIN/oauth/authorize

Token URL:
https://YOUR_DOMAIN/oauth/token

Client ID:
CHATGPT_CLIENT_ID

Client Secret:
CHATGPT_CLIENT_SECRET

Scope:
x.post

ChatGPT will provide the OAuth callback URL when you configure the Action. Put that exact callback URL into CHATGPT_ALLOWED_REDIRECT_URIS.

The X application itself needs its OAuth callback set to:

https://YOUR_DOMAIN/auth/x/callback

and the X OAuth scopes used by the implementation are:

tweet.read
tweet.write
users.read
offline.access

For production, I would additionally add a real application login, CSRF protection around the consent UI, secret-manager integration, audit logs, rate limiting, and an explicit disconnect/revoke flow. OpenAI's current tooling model supports external authenticated tools, and OAuth credentials should be handled by the application's server rather than exposed to the client.

X Developer Platform

OpenAI API documentation
