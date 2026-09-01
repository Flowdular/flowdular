DELETE FROM auth_membership_scopes WHERE scope IN (
  'sandbox.access.use',
  'sandbox.access.manage',
  'sandbox.sessions.read',
  'sandbox.preview.data',
  'sandbox.modules.eject'
);
