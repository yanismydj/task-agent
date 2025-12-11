[very alpha!] TaskAgent is the pursuit of Kaizen in software. It inverts the human-agent relationship: instead of humans directing coding agents, coding agents request human input when needed.
It acts as an assistant PM, keeping coding agents busy and productive. It has two core responsibilities:

1. **Ticket Refinement** — Proactively improves tickets by asking clarifying questions, filling in implementation details, and ensuring work specifications match end-user intent.
2. **Coding Agent Orchestration** — Assigns work to coding agents, monitors progress, and manages their lifecycle.

<img width="1072" height="617" alt="task-ss" src="https://github.com/user-attachments/assets/e4209f18-ad60-4ecf-bb20-1adc9f771dd4" />

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
