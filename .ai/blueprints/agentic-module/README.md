# agentic-module

The shape of a case module: people open a case, an agent gathers and reads the facts, the module computes what must be exact, a document closes the case and nothing leaves the workspace before a person approves it. An underwriter checking a company, a developer pricing apartments in a district and a finance team screening a vendor all build this shape. It is documentation only: a sandbox session still runs as `new-module@1.0.0` or `edit-module@1.0.0`, and this blueprint names what such a session adds when its spec declares `research`, `adapters` or `templates`.

The five steps, each owned by one layer:

1. **The agent reads.** A module-owned business agent (`business-agent-design`) reads the case record through the module's own read tools and outside sources through `research.core` (`research.search`, `research.fetch`, behind the owner's `research.core.allowAgents` consent). Data from another system arrives before the run through a source adapter (`integration-adapter`), never through the agent.
2. **Evidence is cited.** Every finding the agent keeps is stored through a module tool that takes `evidenceIds`, checks them with `research.evidence.v1` and attaches them to the `evidenceOwner` record, so the record lists its sources (`agent-tool-design`, section 6).
3. **Numbers are computed by an action.** A score, a premium or a price is a module action over stored inputs and a versioned rule; the agent passes references and never writes a figure.
4. **A document comes at the end.** The spec's `templates[]` entry names the body in `templates/<name>.md` and the record it renders from. The module registers the body through `documents.templates.v1` and renders it for the case record, which keeps the PDF or DOCX as an attachment and names the template version it came from.
5. **Approval before the result leaves.** A workflow (`workflow-development`) ends with a `human-approval` node before any step that sends the result out: a sink adapter push, a notification to someone outside the workspace, or a shared document.

A workflow ties them together: `input` (the case), `agent` (research and findings), `action` (the computation), `validator` or `agent-decision` (every finding cites evidence), `human-approval`, then `action` (the push or the document). In a sandbox session every adapter and the research section run on recorded fixtures only.

Files here describe the contract; `blueprint.json` is validated by `pnpm flowdular blueprint validate --all` and the others are checked to exist.
