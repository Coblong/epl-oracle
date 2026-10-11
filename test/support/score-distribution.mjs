export function scoreDistribution(weights={'2_1':1}) {
  const probabilities = {};
  for(let home=0;home<=6;home++) for(let away=0;away<=6;away++) {
    const key=`${home}_${away}`;
    probabilities[key]=weights[key] ?? 0;
  }
  return probabilities;
}

export function scoreAnswer(weights={'2_1':1},choice='2_1') {
  return {answers:{score:{choice,probabilities:scoreDistribution(weights)}}};
}
