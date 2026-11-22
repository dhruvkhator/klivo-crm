# KLIVO CRM MCP

A remote MCP server (Streamable HTTP) that lets Claude (claude.ai web, mobile and Desktop) work with the KLIVO Frappe CRM at `https://crm.getklivo.com`.

- URL for the Claude connector: `https://mcp-crm.getklivo.com/mcp`
- Login: Frappe CRM's own OAuth2. Each person signs in with **their own CRM account**, and Frappe applies that account's permissions to everything Claude does.
- Only CRM users with the **Claude Access** role can connect (set in the OAuth Client's *Allowed Roles*).
- 40 tools. There are no delete tools.
  - **Records:** search, list_records, count_records, group_count, get_record, create_record, update_record, describe_doctype, get_linked_records, list_doctypes, whoami
  - **Sales:** get_activities (timeline), create_deal, convert_lead_to_deal, deal contacts (get/add/remove/set primary), contact deals, contact emails/phones, add_note, create_task, call logs
  - **Comms:** send_email (needs an outgoing Email Account in the CRM), list_emails, render_email_template, add_comment, WhatsApp (get/send/template; needs the WhatsApp app)
  - **Team:** list_users, get_assignees, assign, unassign, get_notifications, mark_notifications_read, get_dashboard, get_chart

## How auth works

```
claude.ai ──(discovery)──> mcp-crm.getklivo.com/.well-known/...   (this server publishes it; Frappe v15 does not)
claude.ai ──(login, PKCE)─> crm.getklivo.com OAuth (Frappe)        (user logs in, clicks Allow)
claude.ai ──Bearer token──> mcp-crm.getklivo.com/mcp
                              └─ checks the token with Frappe (introspect: active + issued to our client; get_logged_user)
                              └─ calls /api/resource/... with the same token, so it runs as that user
```

There is no database and nothing secret in this service. Tokens live in Frappe ("OAuth Bearer Token"). To revoke someone's access, remove their **Claude Access** role or revoke their tokens there.

## Configuration (env)

| Var | Example |
|---|---|
| `PUBLIC_URL` | `https://mcp-crm.getklivo.com` |
| `FRAPPE_URL` | `https://crm.getklivo.com` |
| `OAUTH_CLIENT_ID` | Client ID of the "Claude" OAuth Client in Frappe |
| `PORT` | `8000` |

## Local dev (Windows / macOS)

Needs Node 22 or newer.

```bash
npm install
cp .env.example .env      # Windows PowerShell: copy .env.example .env
npm run dev               # http://localhost:8000
npm run typecheck
```

## Deploy (on the Lightsail box)

This runs as a separate compose project (`klivo_mcp`) on the CRM's Docker network. Traefik provides HTTPS.

```bash
sudo docker compose up -d --build      # build + start
sudo docker compose logs -f            # watch logs
```

If the CRM network or Traefik certificate resolver has a different name, set `CRM_NETWORK=... CERT_RESOLVER=...` before `docker compose`.

Never run `down -v` against the CRM project (`klivo_crm`).
