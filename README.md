# usage-band

A mod for Claude Code and the Claude desktop app's Code tab. It adds a two-line band above the prompt box:

- **Top line:** how full the context window is, the prompt cache's state (in use, warm, cooling or cold, with time left and how much of the last turn's input the cache served), and when your plan windows reset.
- **Second line:** one thin bar per plan window, such as the all-models week and a model's own week, with percent used and a tick marking how far through the window you are in time.

Bars are green below 70%, yellow from 70% and red from 90%.

## Install

At the prompt of a terminal session:

```
/plugin install usage-band --marketplace ripteqdavid/claude-usage-band
```

From a shell:

```
claude plugin install usage-band --marketplace ripteqdavid/claude-usage-band
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ripteqdavid/claude-usage-band`, then Add plugin.

Answer `y` to add the marketplace, then pick the user scope so the band shows in every session started afterwards.

## What it reads

- Context fill comes from the session itself.
- Plan windows come from Anthropic's usage endpoint, asked at start, after each turn and every five minutes. The request uses the session's own Claude login, which the app attaches; the mod never sees the credential. Without a Claude subscription login the bars do not appear.
- Cache state is an estimate: it is timed from the end of the last turn against a one-hour cache lifetime, which the app does not report. A session on the five-minute cache will read warm when it is not.
