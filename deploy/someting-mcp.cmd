@echo off
ssh -i %USERPROFILE%\.ssh\allio_hetzner root@95.217.223.133 "cd /opt/someting && docker compose exec -T control-plane node dist/mcp.js"
