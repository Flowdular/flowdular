DELETE FROM auth_membership_scopes WHERE scope IN (
  'agents.providers.read',
  'agents.providers.manage',
  'agents.providers.test',
  'agents.skills.read',
  'agents.skills.manage'
);
