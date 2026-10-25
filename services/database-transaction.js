'use strict';

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
  try {
    target.error('[DB] transaction rollback failed; connection discarded', safeErrorCode(rollbackError));
    if (destroyError) target.error('[DB] transaction connection destroy failed', safeErrorCode(destroyError));
  } catch (_) {
  }
}

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
