# KLIVO CRM

Everything for crm.getklivo.com in one repo, on branch `klivo-v16.3.0` (based on upstream tag v16.3.0).

| What | Where |
|---|---|
| Frappe CRM code + our fixes (B1 product totals on the server, B2 status times in site timezone, B3 lead conversion recorded) | the repo itself, as separate commits on top of v16.3.0 |
| Docker image the server runs | `.github/workflows/klivo-image.yml` builds `ghcr.io/dhruvkhator/crm:<TAG>` on every push to `klivo-*` |
| Claude MCP connector (mcp-crm.getklivo.com) | `mcp/` (see `mcp/README.md`) |

## Update the CRM on the server
1. Push to this branch (or change `TAG` in the workflow for a new version). Wait for the "KLIVO image" action.
2. On the server: set the image in `/root/klivo_crm-compose.yml`, then
   `sudo bash -c "cd /root && docker compose -p klivo_crm -f /root/klivo_crm-compose.yml up -d"`
   and `sudo docker exec klivo_crm-backend-1 bench --site crm.getklivo.com migrate`.

## Update the connector
Copy `mcp/` to `~/klivo-crm-mcp` on the server and run `sudo docker compose up -d --build` there.

## Taking upstream updates
`git fetch upstream --tags`, then rebase/merge our branch onto the new tag. `mcp/` and the `klivo-*` files never conflict with upstream.
