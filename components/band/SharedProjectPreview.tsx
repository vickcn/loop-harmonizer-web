import type { ProjectShareManifest } from "@/lib/sharing/shareTypes";

export function SharedProjectPreview({ manifest }: { manifest: ProjectShareManifest }) {
  const totalBytes = manifest.songs.flatMap((song) => song.artifacts).reduce((sum, item) => sum + item.sizeBytes, 0);
  return <div className="grid shared-project-preview">
    <div><strong>{manifest.project.name}</strong><div className="small">發布版本 {manifest.publishedRevisionId} · {manifest.songs.length} 首歌曲</div></div>
    <ul>{manifest.songs.slice().sort((a, b) => a.entry.order - b.entry.order).map((song) => <li key={song.entry.entryId}><strong>{song.entry.displayName}</strong><span className="small">{song.artifacts.length} 軌 · {(song.artifacts.reduce((sum, item) => sum + item.sizeBytes, 0) / 1048576).toFixed(1)} MiB</span></li>)}</ul>
    <p className="small">分軌總量約 {(totalBytes / 1048576).toFixed(1)} MiB；匯入時只保存 Metadata，播放時才按需下載。</p>
  </div>;
}
