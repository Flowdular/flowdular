# Procedures compatibility plan

This note accompanies the draft `agents.core` 0.8.0 specification. It changes
the business product term from **Skills** to **Procedures**. Coding-agent skill
catalogs in `.ai/skills` and `.agents/skills` are unrelated and keep their
current names.

## Canonical 0.8 contract

| Concern             | Canonical procedure contract                                                                 | Compatibility surface                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Domain              | `AgentProcedure`, `AgentProcedureStatus`, `AgentProcedureSnapshot`, `AgentRevisionProcedure` | Deprecated `AgentSkill*` type aliases                                                  |
| Agent configuration | `procedureIds`                                                                               | Deprecated `skillIds` accepted and returned during the compatibility window            |
| Retained run data   | `procedureSnapshots` and `procedures` in executable revisions                                | Deprecated `skillSnapshots` and `skills` projections of the same immutable values      |
| Collection response | `procedures`                                                                                 | Deprecated `skills` field containing the same records                                  |
| Mutations           | `/api/agent-procedures`, `/update`, `/archive`, `/delete`; response envelope `procedure`     | Existing `/api/agent-skills` routes and `skill` envelope call the same service methods |
| Client route        | `agent-procedures`                                                                           | `agent-skills` remains a hidden deep-link alias                                        |
| Permission labels   | Procedures                                                                                   | `agents.skills.read` and `agents.skills.manage` identifiers remain stable              |
| Persistence         | Procedure repository and service method names                                                | Existing `agent_skills`, assignment, and snapshot tables remain the physical storage   |
| Audit display       | Procedure                                                                                    | Historical `agent-skill.*` action and subject identifiers remain unchanged             |

Canonical and deprecated routes must share validation, authorization, CSRF,
tenant isolation, optimistic concurrency, lifecycle checks, and audit writes.
Calling both surfaces with the same id cannot create duplicate resources or
independent revision histories.

## Data safety

Version 0.8 does not rename or copy database tables. A name-only schema rewrite
would make rollback to an older binary unsafe and would add no data capability.
The repository treats the existing tables as a private compatibility detail.
Existing ids, assignments, retained revision JSON, run snapshots, migration
checksums, and audit hashes stay byte-for-byte intact.

The persisted permission ids also remain stable because tenant grants live in
`auth.core`. Product labels and descriptions say Procedures, while authorization
continues to evaluate the existing ids. A future permission-id migration would
need a separate cross-module specification and dual-grant rollout.

## Compatibility window

The skill-named HTTP routes, JSON fields, and exported TypeScript aliases remain
deprecated for the full 0.x line. New Flowdular clients use only the procedure
contract. Removal requires a major contract version, repository-wide consumer
search, and an explicit migration guide.

Physical table names and historical audit identifiers may remain indefinitely.
They are not user-facing and changing them would weaken rollback and evidence
integrity.

## Verification required before approval can land

1. Existing fixtures created before 0.8 list, update, archive, execute,
   and delete the same records through the procedure API without a data copy.
2. Canonical and deprecated mutation routes enforce identical 401, 403, CSRF,
   tenant, validation, conflict, and lifecycle behavior.
3. Agent execution snapshots the selected procedure revision and required tools,
   including an agent stored previously with skill-named assignments.
4. The Procedures navigation, form, table, empty state, confirmation dialogs,
   agent definition form, and accessibility labels contain no product-facing
   use of Skill.
5. English and Polish bundles have identical keys, and the former deep link
   resolves to the Procedures view without a second navigation item.
