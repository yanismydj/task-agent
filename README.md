# TaskAgent

TaskAgent is the pursuit of Kaizen in software. It inverts the human-agent relationship: instead of humans directing coding agents, coding agents request human input when needed.

It acts as an assistant PM, keeping coding agents busy and productive. It has two core responsibilities:

1. **Ticket Refinement** — Proactively improves tickets by asking clarifying questions, filling in implementation details, and ensuring work specifications match end-user intent.
2. **Coding Agent Orchestration** — Assigns work to coding agents, monitors progress, and manages their lifecycle.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      TaskAgent Daemon                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │   Linear    │  │   Readiness  │  │   Agent Pool      │  │
│  │   Poller    │→ │   Analyzer   │→ │   Manager         │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
│         │              (Claude)            │               │
│         ↓                                  ↓               │
│  ┌─────────────┐                   ┌───────────────────┐  │
│  │  Scheduler  │←──────────────────│   Agent Workers   │  │
│  │  (HITL)     │                   │   (Claude Code)   │  │
│  └─────────────┘                   └───────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                                   │
         ↓                                   ↓
    ┌─────────┐                    ┌─────────────────┐
    │ Linear  │                    │  Git Worktrees  │
    │   API   │                    │  (per ticket)   │
    └─────────┘                    └─────────────────┘
```

### Components

- **Linear Poller**: Periodically fetches tickets from Linear
- **Readiness Analyzer**: Uses Claude API to evaluate ticket readiness (0-100 score)
- **Scheduler**: Human-in-the-loop work assignment with approval workflow
- **Agent Pool**: Manages concurrent Claude Code agent processes
- **Worktree Manager**: Creates isolated git worktrees per ticket

## Quick Start

### Prerequisites

- Node.js 20+
- Claude Code CLI installed and authenticated
- Linear API key
- Anthropic API key

### Installation

```bash
git clone <repo>
cd task-agent
npm install
cp .env.example .env
# Edit .env with your API keys
```

### Configuration

Create a `.env` file:

```bash
# Linear API Configuration
LINEAR_API_KEY=lin_api_xxxx          # Your Linear API key
LINEAR_TEAM_ID=your-team-id          # Linear team ID
LINEAR_PROJECT_ID=                    # Optional: filter to specific project

# Anthropic API Configuration
ANTHROPIC_API_KEY=sk-ant-xxxx        # Your Anthropic API key
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Agent Configuration
AGENTS_MAX_CONCURRENT=5              # Max parallel agents (1-20)
AGENTS_WORK_DIR=/path/to/target/repo # Repository for agents to work in
AGENTS_TIMEOUT_MINUTES=60            # Agent timeout
AGENTS_MAX_RETRIES=2                 # Retries before escalation

# Daemon Configuration
DAEMON_POLL_INTERVAL_SECONDS=30      # How often to check Linear
```

### Running

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

## How It Works

### Human-in-the-Loop Approval

TaskAgent does NOT auto-assign work. Instead:

1. Evaluates all tickets, ranks by `priority × readiness score`
2. Posts a comment: *"I'd like to start work on this. Here's my analysis... Reply 'yes' to approve."*
3. Waits for human response (yes/no/approve/reject)
4. Only on approval does the agent start working

This builds trust and keeps humans informed.

### Ticket Readiness Criteria

TaskAgent evaluates tickets on:

| Criteria | Description |
|----------|-------------|
| Clear acceptance criteria | Does it define what "done" looks like? |
| Achievable scope | Can it be completed in a single PR? |
| No blocking questions | Are there unanswered ambiguities? |
| Sufficient context | References to files, patterns, examples? |
| No external dependencies | Can work start immediately? |

Tickets receive a readiness score (0-100). Only "ready" tickets are proposed for work.

### Agent Lifecycle

```
IDLE → ASSIGNED → WORKING → COMPLETED
                     ↓
              (on timeout/error)
                     ↓
                 RETRYING → FAILED (escalate)
```

- **IDLE**: Agent available for work
- **ASSIGNED**: Worktree created, ready to start
- **WORKING**: Claude Code process running
- **COMPLETED**: Work done, PR created
- **FAILED**: After max retries, escalated to human

### Git Worktree Isolation

Each agent works in an isolated git worktree:

```
/path/to/repo/                      # Base repository
└── .task-agent/
    └── worktrees/
        ├── eng-123/                # Worktree for ENG-123
        └── eng-456/                # Worktree for ENG-456
```

This prevents conflicts between concurrent agents.

## Ticket Refinement

TaskAgent regularly scans all tickets to identify those ready for work or needing clarification. It leverages coding agents' planning mode to surface ambiguities and preempt design decisions.

When improving tickets, TaskAgent:
- Uses existing codebase and ticket corpus to fill gaps autonomously
- Falls back to asking the end user via Linear comments when information is unavailable
- Breaks large-scope tickets into sub-issues to improve coding agent outcomes
- Provides regular progress updates and surfaces persistent blockers

## Coding Agent Orchestration

TaskAgent triages tickets and converts them into well-structured prompts using best practices. It manages up to 5 coding agents (with plans to scale to dozens), which can run locally or in the cloud.

**Work Assignment:**
- TaskAgent determines ticket readiness based on context — no specific Linear state required
- Tickets are tagged with `task-agent` label to prevent conflicts
- Priority order from Linear is respected

**Lifecycle Management:**
- TaskAgent manages agent states and reports progress to Linear
- On agent failure: adds a note to the ticket and retries (up to max retries)
- After repeated failures: removes label and escalates to human

**PR Workflow:**
- Agents create draft PRs for human review
- PR links are posted as comments on the Linear ticket

## Communication & State

**Human Interaction:**
- All communication flows through Linear (comments, tagging end users)
- Humans monitor the Linear inbox for approval requests and blockers
- Future: potential Slack or email integration

**State Persistence:**
- All state lives in Linear (labels, comments)
- Agent state is ephemeral (in-memory during daemon lifecycle)

## Project Structure

```
src/
├── index.ts              # Entry point, daemon lifecycle
├── config.ts             # Zod-validated configuration
├── linear/
│   ├── client.ts         # Linear SDK wrapper
│   ├── poller.ts         # Ticket polling loop
│   └── types.ts          # Linear-specific types
├── analyzer/
│   └── readiness.ts      # Ticket readiness evaluation (Claude API)
├── agents/
│   ├── pool.ts           # Agent pool manager
│   ├── worker.ts         # Individual agent lifecycle
│   ├── worktree.ts       # Git worktree management
│   └── types.ts          # Agent state types
├── orchestrator/
│   └── scheduler.ts      # Work assignment with HITL approval
└── utils/
    └── logger.ts         # Pino structured logging
```

## Technology Stack

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js 20+
- **Linear SDK**: @linear/sdk
- **Claude Analysis**: @anthropic-ai/sdk
- **Claude Execution**: Claude Code CLI
- **Logging**: Pino (structured JSON)
- **Config Validation**: Zod

## Future Considerations

- Auto-approval mode (trust TaskAgent to assign without asking)
- Ticket breakdown into sub-issues
- Multi-repo support
- Cloud agent execution (containers)
- Metrics and observability dashboard
- Slack/email notifications
