export function fixtureFreshness(updatedAt,now=Date.now()) {
  const updated=Date.parse(updatedAt);
  const stale=!Number.isFinite(updated) || now-updated>24*60*60*1000;
  return {stale,updatedAt:updatedAt??null,message:stale?'Fixture and result updates are delayed. Showing the last available data.':''};
}
