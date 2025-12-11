# TaskAgent Development Guidelines

## Critical Rules

1. **NEVER run `npm run dev` yourself** - The daemon connects to Linear and Anthropic APIs with real credentials. Always let the human start and monitor the daemon.

2. **NEVER commit `.env`** - Contains API keys. Only commit `.env.example`.

3. **Use Beads for task tracking** - This project uses Beads (`bd`) for issue management. Use `bd create`, `bd ready`, `bd close` instead of TodoWrite.

## Project Structure

```
src/
├── index.ts              # Daemon entry point
├── config.ts             # Zod-validated configuration
├── linear/               # Linear SDK integration
│   ├── client.ts         # API wrapper
│   ├── poller.ts         # Ticket polling
│   ├── state.ts          # State management via labels + state project
│   └── types.ts          # TypeScript types
├── analyzer/
│   └── readiness.ts      # Claude API ticket evaluation
├── agents/               # Claude Code agent management
│   ├── pool.ts           # Agent pool
│   ├── worker.ts         # Individual agent lifecycle
│   └── worktree.ts       # Git worktree isolation
├── orchestrator/
│   └── scheduler.ts      # Work assignment with HITL approval
└── utils/
    ├── logger.ts         # Pino structured logging
    └── process.ts        # Child process helpers
```

## Key Commands

```bash
npm run typecheck    # Type checking (safe to run)
npm run build        # Build TypeScript (safe to run)
npm run dev          # DO NOT RUN - let human do this
```

## State Management

TaskAgent stores state in Linear:
- **Labels on tickets**: `readiness:XX`, `ta:working`, `ta:eval:timestamp`
- **State project**: "TaskAgent State" contains daemon status, agent sessions, and error reports

## Anthropic Model Support

- Use `claude-sonnet-4-5` or newer for structured outputs support
- Legacy models (`claude-sonnet-4-20250514`) work but use JSON parsing fallback
- Model is configured via `ANTHROPIC_MODEL` in `.env`

## Error Handling

Errors are automatically reported to Linear as issues in the "TaskAgent State" project. Check there for runtime errors.
