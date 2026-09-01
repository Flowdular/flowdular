# security-review

Read-only review of a module, package or pull request against `.ai/skills/auth-security-review/SKILL.md`. The reviewer writes no production code; findings go back to the author with a severity, a location, a concrete failure scenario, the rule violated and the fix. Gates are the read-only greps and the tests the skill lists.

Run it for every change that adds or changes an endpoint, a scope, a token, a credential, or a CLI capability, and before a sandbox eject of a module that other tenants will use.
