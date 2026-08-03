export type LatestRefreshSequence = {
  begin: () => number;
  applyIfLatest: (generation: number, apply: () => void) => boolean;
};

export function createLatestRefreshSequence(): LatestRefreshSequence {
  let latestGeneration = 0;

  return {
    begin() {
      latestGeneration += 1;
      return latestGeneration;
    },
    applyIfLatest(generation, apply) {
      if (generation !== latestGeneration) return false;
      apply();
      return true;
    },
  };
}
