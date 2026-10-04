# Shared 21st MCP authentication

Observed: all local agents use `~/.local/bin/21st-mcp`. Its September 22 CLI
token receives HTTP 401 from MCP initialize, tools/list, and CLI get_usage.
The wrapper sends that token on every proxy launch. The proxy falls back to
OAuth; its 21st cache has client/verifier state but no retained tokens.

Use the installed proxy, one stable URL, and one persistent cache. Remove the
rejected CLI credential from MCP requests. Request offline access and the refresh
grant so a completed OAuth login can be reused. Preserve existing caches and
other MCP servers. No automatic paid tool calls.

Verify the shell and exact proxy arguments without credentials, then initialize
the live MCP connection and list tools after browser consent. Authentication
requires the user's browser approval; do not claim success from an open page.

Verified after consent: initialize succeeded and tools/list returned 34 tools.
Access and refresh tokens were retained under the URL-only OAuth cache key.
A second fresh proxy initialized successfully without browser authorization.
The launcher regression check confirms no API-key header and a refresh grant.
