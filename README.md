# TaskAgent

[very alpha!] TaskAgent is the pursuit of Kaizen in software. It inverts the human-agent relationship: instead of humans directing coding agents, coding agents request human input when needed. It acts as an assistant PM, keeping coding agents busy and productive. It has two core responsibilities:

**Ticket Refinement** — Proactively improves tickets by asking clarifying questions, filling in implementation details, and ensuring work specifications match end-user intent.

**Coding Agent Orchestration** — Assigns work to coding agents, monitors progress, and manages their lifecycle.

<!-- Screenshot: Application overview -->
<!-- TODO: Add screenshot here -->

## Setup

```bash
npm install
npm run setup
```

The interactive setup will configure Linear OAuth, Anthropic API access, and your target repository.

<!-- Screenshot: Setup screen -->
<!-- TODO: Add setup screen screenshot here -->

## Usage

Start the daemon:
```bash
npm run dev
```

TaskAgent monitors Linear tickets, refines them with clarifying questions, and assigns work to coding agents. All communication happens through Linear comments.

## How It Works

**Ticket Refinement:**
- Scans tickets to identify work-ready items and clarifications needed
- Uses codebase context to fill gaps autonomously
- Asks end users via Linear when information is missing
- Breaks large tickets into sub-issues for better outcomes

**Agent Orchestration:**
- Assigns tickets to coding agents based on readiness
- Manages up to 5 agents (scalable to dozens)
- Retries on failure, escalates to humans after repeated failures
- Respects priority order from Linear

**State & Communication:**
- All state lives in Linear (labels, comments, dedicated state project)
- Humans interact via Linear inbox
- PRs can auto-merge or require review (configurable)

## Implementation

Built on Linear + Claude Code, designed to be tool-agnostic.
