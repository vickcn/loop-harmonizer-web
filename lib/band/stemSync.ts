type GroupedStemTrack = {
  id: string;
  stemMetadata?: {
    sourceGroupId: string;
  };
};

export function getLinkedStemTrackIds(
  tracks: GroupedStemTrack[],
  trackId: string,
): string[] {
  const sourceGroupId = tracks.find((track) => track.id === trackId)?.stemMetadata?.sourceGroupId;
  if (!sourceGroupId) return [trackId];
  return tracks
    .filter((track) => track.stemMetadata?.sourceGroupId === sourceGroupId)
    .map((track) => track.id);
}
