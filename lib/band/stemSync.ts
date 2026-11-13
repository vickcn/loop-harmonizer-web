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

/** 量測同歌分軌播放位置最大偏移，供 ScriptProcessor 同步限制診斷。 */
export function calculateStemOffsetSpread(positions: Record<string, number>): number {
  const values = Object.values(positions);
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}
