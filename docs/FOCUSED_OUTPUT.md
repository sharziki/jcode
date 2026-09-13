# Focused output

Focused-output mode keeps the chat viewport quiet while preserving the complete
session transcript. It shows prompts, final assistant responses, errors, and
the latest direct command result. Reasoning, tool calls, system notices, and
other progress cards stay stored but hidden.

Enable it in `~/.jcode/config.toml`:

```toml
[display]
focused_output = true
```

While a turn runs, one animated `Generating…` row replaces the live tool and
reasoning stream. Press `Ctrl+T` to reveal the full transcript, then press it
again to return to focused output. Queue mode remains available with `Alt+Q`.
