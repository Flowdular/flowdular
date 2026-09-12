/**
 * The id exports.core holds this module's member list under: the module id
 * followed by the list key, which is the namespace rule its catalogue enforces.
 *
 * It lives here rather than next to the declaration so the screen that starts a
 * job and the server that declares the list name one string, without the client
 * bundle importing `@flowdular/server` to read it.
 */
export const MEMBER_EXPORT_LIST_ID = 'users.core.members';
