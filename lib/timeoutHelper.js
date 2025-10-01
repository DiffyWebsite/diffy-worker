const DEFAULT_MULTIPLIER = 3;

const resolveTimeoutWithNeedIncrease = (needIncrease, baseTimeout) => {
  const multiplier = DEFAULT_MULTIPLIER;

  if (!needIncrease || needIncrease === false) {
    return baseTimeout;
  }

  return Math.round(baseTimeout * multiplier);
};

module.exports = {
  resolveTimeoutWithNeedIncrease,
};
