// TEMPORARY: proves the security gate fails on a new blocking finding.
// Bearer flags this as javascript_lang_logger_leak (PII in a log line).
// Reverted in the next commit.
export function logSignup(user) {
  console.log(`signup ${user.email}`);
}
