'use strict';

// A connection whose rollback failed may still have an unknown transaction
// state.  Never return that connection to the pool: mysql2's destroy() removes
// it from the pool, and the marker also protects test doubles/adapters that do
// not expose destroy().
const DISCARD_MARKER = Symbol('discardedTransactionConnection');

function isDiscarded(connection) {
  return Boolean(connection && connection[DISCARD_MARKER]);
}

function safeErrorCode(error) {
  return error && typeof error.code === 'string' && error.code.length <= 64
    ? error.code
    : 'ROLLBACK_FAILED';
}

function logRollbackFailure(logger, rollbackError, destroyError) {
  const target = logger && typeof logger.error === 'function' ? logger : console;
  // Codes are deliberately the only error data logged here.  Error messages
  // can contain SQL, request bodies, or other secrets from driver adapters.
  try {
    target.error('[DB] transaction rollback failed; connection discarded', safeErrorCode(rollbackError));
    if (destroyError) target.error('[DB] transaction connection destroy failed', safeErrorCode(destroyError));
  } catch (_) {
    // Logging must never replace the original transaction error.
  }
}

/**
 * Roll back a failed transaction without replacing the original error.
 *
 * Returns true when rollback completed.  On rollback failure it returns false,
 * marks the connection as discarded, and calls destroy() when available.  The
 * caller must skip release() whenever isDiscarded(connection) is true.
 */
async function rollbackOrDiscard(connection, originalError, logger = console) {
  void originalError;
  if (!connection || isDiscarded(connection)) return false;
  try {
    await connection.rollback();
    return true;
  } catch (rollbackError) {
    connection[DISCARD_MARKER] = true;
    let destroyError = null;
    if (typeof connection.destroy === 'function') {
      try {
        await connection.destroy();
      } catch (error) {
        destroyError = error;
      }
    }
    logRollbackFailure(logger, rollbackError, destroyError);
    return false;
  }
}

function releaseConnection(connection) {
  if (!connection || isDiscarded(connection)) return false;
  connection.release();
  return true;
}

module.exports = { rollbackOrDiscard, isDiscarded, releaseConnection };
