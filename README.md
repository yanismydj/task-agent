[very alpha!] TaskAgent is the pursuit of Kaizen in software. It inverts the human-agent relationship: instead of humans directing coding agents, coding agents request human input when needed.
It acts as an assistant PM, keeping coding agents busy and productive. It has two core responsibilities:

1. **Ticket Refinement** — Proactively improves tickets by asking clarifying questions, filling in implementation details, and ensuring work specifications match end-user intent.
2. **Coding Agent Orchestration** — Assigns work to coding agents, monitors progress, and manages their lifecycle.

<img width="1072" height="617" alt="task-ss" src="https://github.com/user-attachments/assets/e4209f18-ad60-4ecf-bb20-1adc9f771dd4" />

## Getting Started

### Prerequisites

**Node.js** (v20.0.0 or higher)
```bash
node --version
# Expected: v20.x.x or higher
```

**Package Manager** (any of the following)
- npm (comes with Node.js)
- yarn (`npm install -g yarn`)
- pnpm (`npm install -g pnpm`)

**SQLite** — Installed automatically via `better-sqlite3`. No manual installation required.

**External Services**
- [Linear](https://linear.app) account with API access
- [Anthropic](https://console.anthropic.com) API key
- [GitHub](https://github.com) repository for agent PRs

### Installation

Clone the repository and install dependencies:

```bash
# Clone
git clone https://github.com/your-org/task-agent.git
cd task-agent

# Install with npm
npm install

# Or with yarn
yarn install

# Or with pnpm
pnpm install
```

Expected output:
```
added 150 packages in 8s
```

### Quick Start with Interactive Setup (Recommended)

The `setup` command provides a guided setup experience that configures everything you need:

```bash
npm run setup
```

This interactive CLI will:
1. Check prerequisites (Node.js, npm)
2. Create `.env` from `.env.example`
3. Guide you through Linear OAuth setup
4. Configure your Anthropic API key
5. Set up your target repository
6. Generate repository context summary
7. Run the OAuth authorization flow

Expected output:
```
╔════════════════════════════════════════════════════════════════════════╗
║                     TaskAgent Interactive Setup                        ║
╚════════════════════════════════════════════════════════════════════════╝

✓ Node.js: v20.10.0
✓ npm: 10.2.3

→ Setting up environment...
```

### Manual Setup

If you prefer manual configuration:

1. **Copy environment template**
   ```bash
   cp .env.example .env
   ```

2. **Configure required variables in `.env`**
   ```bash
   # Linear OAuth (create app at https://linear.app/settings/api/applications)
   LINEAR_CLIENT_ID=your-client-id
   LINEAR_CLIENT_SECRET=your-client-secret
   LINEAR_TEAM_ID=your-team-id

   # Anthropic API
   ANTHROPIC_API_KEY=sk-ant-xxxx

   # Target repository
   AGENTS_WORK_DIR=/path/to/your/repo
   GITHUB_REPO=owner/repo-name
   ```

3. **Run OAuth authorization**
   ```bash
   npm run auth
   ```

   Expected output:
   ```
   Opening browser for Linear OAuth authorization...
   Waiting for callback on http://localhost:3456/oauth/callback
   ✓ Authorization successful! Token saved.
   ```

### Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

Expected output:
```
> task-agent@0.1.0 build
> tsc
```

### Running the Development Server

Start TaskAgent in development mode with hot-reload:

```bash
npm run dev
```

Expected output:
```
[12:00:00] INFO: TaskAgent daemon starting...
[12:00:00] INFO: Connected to Linear API
[12:00:00] INFO: Webhook server listening on port 4847
[12:00:01] INFO: Initial sync complete - found 12 tickets
[12:00:01] INFO: TaskAgent daemon ready
Server running on http://localhost:4847
```

### Deployment Options

| Option | Use Case | Configuration |
|--------|----------|---------------|
| **Local daemon** | Development, testing | `npm run dev` |
| **Production build** | Self-hosted | `npm run build && npm start` |
| **Webhooks** | Real-time updates | Set `WEBHOOK_ENABLED=true` + ngrok |

For webhook setup in development:
```bash
# Terminal 1: Start ngrok
ngrok http 4847

# Terminal 2: Start TaskAgent
npm run dev
```

Then configure the ngrok URL in Linear: Settings → API → Webhooks → New Webhook.

### Verify Installation

Run the type checker to ensure everything is set up correctly:

```bash
npm run typecheck
```

Expected output (no errors):
```
> task-agent@0.1.0 typecheck
> tsc --noEmit
```

---

## Ticket Refinement

TaskAgent regularly scans all tickets to identify those ready for work or needing clarification. It leverages coding agents' planning mode to surface ambiguities and preempt design decisions.

When improving tickets, TaskAgent:
- Uses existing codebase and ticket corpus to fill gaps autonomously
- Falls back to asking the end user via Linear comments when information is unavailable
- Breaks large-scope tickets into sub-issues to improve coding agent outcomes
- Provides regular progress updates and surfaces persistent blockers

## Coding Agent Orchestration

TaskAgent triages tickets and converts them into well-structured prompts using best practices. It manages up to 5 coding agents (with plans to scale to dozens), which can run in the cloud, locally, or mixed.

**Work Assignment:**
- TaskAgent determines ticket readiness based on context — no specific Linear state required
- Tickets are tagged with the assigned coding agent to prevent conflicts
- Priority order from the task management tool is respected

**Lifecycle Management:**
- TaskAgent manages all ticket states, including closing completed work
- On coding agent failure: adds a note to the ticket and retries
- After repeated failures: puts ticket on hold and escalates to human

**Configuration Options:**
- Auto-merge PRs or require human review (configurable per org)
- Enforce org conventions like feature branches and PR workflows

## Communication & State

**Human Interaction:**
- All communication flows through Linear (comments, tagging end users)
- Humans monitor the Linear inbox for questions and blockers
- Future: potential Slack or email integration

**State Persistence:**
- All state lives in Linear
- TaskAgent may use a dedicated Linear project for internal state tracking

## Initial Implementation

- Task Management: Linear
- Coding Agent: Claude Code
- Designed to be tool-agnostic in the future
