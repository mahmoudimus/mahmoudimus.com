---
Title: Using Windows MCP with Codex, Pi, and Claude Code
Date: 2026-11-15
Category: tools
Tags: til, windows, mcp, codex, pi, claude-code, desktop-automation
Classification: til
Excerpt: I connected Codex, Pi, and Claude Code to a Windows desktop and learned why a healthy server is only the beginning.
---

Today I learned how to connect Codex, Pi, and Claude Code to the same Windows desktop through MCP. The detail that surprised me: the server needs to run in the **signed-in desktop session**. A background process in Session 0 can look healthy while seeing none of my windows.

I started with an installed Windows MCP server exposing an authenticated, streamable HTTP endpoint at `/mcp`. I use a different bearer token for each machine and keep tokens out of repositories, screenshots, and command-line arguments.

## Pick a reachable endpoint

For a Windows machine with an SSH server, I use a local tunnel to keep the MCP endpoint off the network:

```sh
ssh -N -L 127.0.0.1:9000:127.0.0.1:8765 user@windows-host.example.test
```

The examples below then use `http://127.0.0.1:9000/mcp`. The Windows MCP server must listen on the Windows machine's loopback port `8765`; the SSH connection supplies the encrypted network path. If you instead expose a server directly on a LAN, give the agents its HTTPS URL, require authentication, and verify that the *effective* firewall policy limits who can connect. A firewall command returning success does not prove its rule is active. Turning Windows Firewall off is not an installation procedure.

I load the token into the agent's environment before starting it. One interactive shell option is:

```sh
read -rs WINDOWS_MCP_TOKEN
export WINDOWS_MCP_TOKEN
```

Enter the token when prompted. For regular use, load it from your operating system's credential store. On macOS, a GUI application launched earlier may not inherit a later shell export; restart it after arranging for the token to be present in its launch environment.

## Codex

I added the server to `~/.codex/config.toml`:

```toml
[mcp_servers.windows-desktop]
url = "http://127.0.0.1:9000/mcp"
bearer_token_env_var = "WINDOWS_MCP_TOKEN"
startup_timeout_sec = 30.0
```

Start a new Codex session and check `codex mcp list`. Codex reads the token from the environment rather than storing it in the TOML file. The [Codex MCP documentation](https://developers.openai.com/codex/mcp) describes the configuration and CLI. If Codex runs somewhere other than your laptop, `127.0.0.1` means *that environment*, so put the tunnel or endpoint where Codex actually runs.

## Pi

For a Pi installation that supports `pi mcp`, I registered the same endpoint:

```sh
pi mcp add windows-desktop \
  --url http://127.0.0.1:9000/mcp \
  --bearer-token-env-var WINDOWS_MCP_TOKEN
pi mcp list --json
```

The list should say `connected` and show the Windows tools. Start a new Pi session after changing MCP configuration or extensions. If the server connects but its tools never appear, check that your Pi build has MCP enabled; an extension exclusion such as `-builtin:mcp` can suppress it. Pi installations differ, so confirm the available flags with `pi mcp --help` before copying the command.

## Claude Code

Claude Code supports environment-variable expansion in a project `.mcp.json`, so I added this to a **trusted local project** and kept the token outside it:

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

I ask the agent to take a screenshot, click a harmless control, and type into a disposable text field. Then I look for each effect in a fresh screenshot. A successful MCP tool receipt proves that a request returned; it does not prove Windows accepted the input. Finally, lock or sign out of Windows and check that the tool reports the desktop as unavailable rather than pretending the old screen is still live.

I learned to distinguish three common failure signatures:

- **Timeout:** the endpoint is unreachable. Check the tunnel, listener, route, and effective firewall policy.
- **401 Unauthorized:** the server was reached, but the bearer token is missing or wrong.
- **Invalid host header:** the server rejected the URL's HTTP `Host` value. Configure the server's accepted hostnames or use the proper HTTPS origin; do not rely on every MCP client allowing a custom `Host` header.

Once one agent connects, I use the same reachable URL with each other client’s supported authentication configuration. I still check a fresh screenshot and an observable input effect in the intended Windows session.
