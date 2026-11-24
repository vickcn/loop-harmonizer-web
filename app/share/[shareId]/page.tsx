import Link from "next/link";
import "../../mixer-themes.css";
import { SharedProjectImportDialog } from "@/components/band/SharedProjectImportDialog";

export default async function SharedProjectPage({ params, searchParams }: { params: Promise<{ shareId: string }>; searchParams: Promise<{ file?: string }> }) {
  const { shareId } = await params;
  const { file = "" } = await searchParams;
  return <main className="container layout band-mixer-page"><div className="col-full"><Link href="/band-mixer" className="small">← 返回歌曲混音器</Link></div><div className="col-full"><SharedProjectImportDialog shareId={shareId} pointerFileId={file} /></div></main>;
}
