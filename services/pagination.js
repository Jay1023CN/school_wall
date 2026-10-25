'use strict';

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPagination(query, options) {
  const config = options || {};
  const defaultPage = toPositiveInt(config.defaultPage, 1);
  const defaultLimit = toPositiveInt(config.defaultLimit, 20);
  const maxPage = Math.max(defaultPage, toPositiveInt(config.maxPage, 100000));
  const maxLimit = Math.max(defaultLimit, toPositiveInt(config.maxLimit, 100));
  const page = Math.min(toPositiveInt(query && query.page, defaultPage), maxPage);
  const requestedLimit = toPositiveInt(query && query.limit, defaultLimit);
  const limit = Math.min(requestedLimit, maxLimit);

  return {
    page,
    limit,
    offset: (page - 1) * limit
  };
}

module.exports = { getPagination };
