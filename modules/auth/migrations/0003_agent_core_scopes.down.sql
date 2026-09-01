DELETE FROM auth_membership_scopes WHERE scope IN (
  'agents.definitions.read',
  'agents.definitions.manage',
  'agents.runs.read',
  'agents.runs.execute'
);
