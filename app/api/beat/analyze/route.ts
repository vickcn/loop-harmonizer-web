import { NextRequest, NextResponse } from "next/server";
import { BeatAnalyzeRequest, BeatAnalyzeResponse } from "@/lib/types";
import { calculateTapBpm, calculateTapConfidence } from "@/lib/tapTempo";

function roundBpm(bpm: number) {
  return Math.round(bpm * 10) / 10;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as BeatAnalyzeRequest;
  const detected = body.rawDetectedBpm ?? calculateTapBpm(body.tapTimes) ?? body.currentTimelineBpm;
  const confidence = calculateTapConfidence(body.tapTimes);

  // M0：遠端先做簡單修正。之後可在這裡接 AI / 規則引擎 / 帳號資料庫。
  const suggestedBpm = roundBpm(detected);
  const response: BeatAnalyzeResponse = {
    suggestedBpm,
    confidence: Math.round(confidence * 100) / 100,
    transition: {
      mode: "linear",
      beats: body.requiredTaps >= 8 ? 8 : 4
    }
  };

  return NextResponse.json(response);
}
