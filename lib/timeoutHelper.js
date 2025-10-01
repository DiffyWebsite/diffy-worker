const DEFAULT_MULTIPLIER = 2;

const coerceTimeout = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();

    if (trimmed === 'false' || trimmed === 'off' || trimmed === 'no') {
      return null;
    }

    if (trimmed === 'true' || trimmed === 'on' || trimmed === 'yes') {
      return null;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
};

const resolveTimeoutWithNeedIncrease = (needIncrease, baseTimeout, options = {}) => {
  const multiplierCandidate = typeof options.multiplier === 'number' && Number.isFinite(options.multiplier)
    ? options.multiplier
    : DEFAULT_MULTIPLIER;
  const multiplier = multiplierCandidate > 0 ? multiplierCandidate : DEFAULT_MULTIPLIER;

  if (!needIncrease || needIncrease === false) {
    return baseTimeout;
  }

  let timeout = null;

  if (typeof needIncrease === 'object' && needIncrease !== null) {
    timeout = coerceTimeout(
      needIncrease.protocolTimeout ?? needIncrease.timeout ?? needIncrease.value ?? null
    );

    if (timeout === null && typeof needIncrease.multiplier === 'number' && Number.isFinite(needIncrease.multiplier)) {
      const adjustedMultiplier = needIncrease.multiplier > 0 ? needIncrease.multiplier : multiplier;
      timeout = Math.round(baseTimeout * adjustedMultiplier);
    }
  } else {
    timeout = coerceTimeout(needIncrease);
  }

  if (timeout === null) {
    // Treat truthy flags (e.g. boolean true or string 'true') as enable with multiplier
    return Math.round(baseTimeout * multiplier);
  }

  return timeout <= baseTimeout ? baseTimeout : timeout;
};

module.exports = {
  resolveTimeoutWithNeedIncrease,
};
