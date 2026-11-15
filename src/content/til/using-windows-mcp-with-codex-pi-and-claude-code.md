---
Title: Using Windows MCP with Codex, Pi, and Claude Code
Date: 2026-11-15
Category: tools
Tags: til, windows, mcp, codex, pi, claude-code, desktop-automation
Classification: til
Excerpt: Connect three coding agents to one authenticated Windows desktop MCP server, and verify that screenshots and input really work.
---

A Windows MCP server lets an agent inspect and operate a Windows desktop through the Model Context Protocol. The useful setup is one server running in the **signed-in desktop session**, with Codex, Pi, and Claude Code connecting to that same endpoint. A server running as a background service in Session 0 may be healthy as a process while seeing none of the user's windows.

This is a client setup guide. It assumes the Windows MCP server is already installed and exposes an authenticated, streamable HTTP endpoint at `/mcp`. Use a different bearer token for each Windows machine. Do not put a token in a repository, article, screenshot, or command-line argument.

## Pick a reachable endpoint

For a Windows machine with an SSH server, a local tunnel keeps the MCP endpoint off the network:

```sh
ssh -N -L 127.0.0.1:9000:127.0.0.1:8765 user@windows-host.example.test
```

The examples below then use `http://127.0.0.1:9000/mcp`. The Windows MCP server must listen on the Windows machine's loopback port `8765`; the SSH connection supplies the encrypted network path. If you instead expose a server directly on a LAN, give the agents its HTTPS URL, require authentication, and verify that the *effective* firewall policy limits who can connect. A firewall command returning success does not prove its rule is active. Turning Windows Firewall off is not an installation procedure.

Load the token into the agent's environment before starting the agent. One interactive shell option is:

```sh
read -rs WINDOWS_MCP_TOKEN
export WINDOWS_MCP_TOKEN
```

Enter the token when prompted. For regular use, load it from your operating system's credential store. On macOS, a GUI application launched earlier may not inherit a later shell export; restart it after arranging for the token to be present in its launch environment.

## Codex

Add a server to `~/.codex/config.toml`:

```toml
[mcp_servers.windows-desktop]
url = "http://127.0.0.1:9000/mcp"
bearer_token_env_var = "WINDOWS_MCP_TOKEN"
startup_timeout_sec = 30.0
```

Start a new Codex session and check `codex mcp list`. Codex reads the token from the environment rather than storing it in the TOML file. The [Codex MCP documentation](https://developers.openai.com/codex/mcp) describes the configuration and CLI. If Codex runs somewhere other than your laptop, `127.0.0.1` means *that environment*, so put the tunnel or endpoint where Codex actually runs.

## Pi

For a Pi installation that supports `pi mcp`, register the same endpoint:

```sh
pi mcp add windows-desktop \
  --url http://127.0.0.1:9000/mcp \
  --bearer-token-env-var WINDOWS_MCP_TOKEN
pi mcp list --json
```

The list should say `connected` and show the Windows tools. Start a new Pi session after changing MCP configuration or extensions. If the server connects but its tools never appear, check that your Pi build has MCP enabled; an extension exclusion such as `-builtin:mcp` can suppress it. Pi installations differ, so confirm the available flags with `pi mcp --help` before copying the command.

## Claude Code

Claude Code supports environment-variable expansion in a project `.mcp.json`. Add this file to a **trusted local project**; keep the token itself outside the project:

```json
{
  "mcpServers": {
    "windows-desktop": {
      "type": "http",
      "url": "http://127.0.0.1:9000/mcp",
      "headers": {
        "Authorization": "Bearer ${WINDOWS_MCP_TOKEN}"
      }
    }
  }
}
```

Restart Claude Code in that project, approve the project MCP configuration when prompted, then inspect `claude mcp list` or `/mcp`. Claude Code's [MCP guide](https://code.claude.com/docs/en/mcp) documents HTTP servers, project trust, and variable expansion. A missing or empty token can make the connection fail even though the JSON is valid.

## Verify the desktop, not just the connection

Use the agent to take a screenshot, click a harmless control, and type into a disposable text field. Observe each effect in a fresh screenshot. A successful MCP tool receipt proves that a request returned; it does not prove Windows accepted the input. Finally, lock or sign out of Windows and check that the tool reports the desktop as unavailable rather than pretending the old screen is still live.

Three common failure signatures are worth separating:

- **Timeout:** the endpoint is unreachable. Check the tunnel, listener, route, and effective firewall policy.
- **401 Unauthorized:** the server was reached, but the bearer token is missing or wrong.
- **Invalid host header:** the server rejected the URL's HTTP `Host` value. Configure the server's accepted hostnames or use the proper HTTPS origin; do not rely on every MCP client allowing a custom `Host` header.

When one agent works, the other two should use the same reachable URL and their own supported authentication configuration. The remaining test is always the same: a fresh screen and an observed input effect in the intended Windows session.
