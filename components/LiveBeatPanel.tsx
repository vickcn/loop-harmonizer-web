"use client";

type Props = {
  targetBpm: number;
  transitionBeats: number;
  onTargetBpmChange: (bpm: number) => void;
  onTransitionBeatsChange: (beats: number) => void;
  onApply: () => void;
};

export function LiveBeatPanel({ targetBpm, transitionBeats, onTargetBpmChange, onTransitionBeatsChange, onApply }: Props) {
  return (
    <div className="card grid">
      <div>
        <h2 style={{ margin: 0 }}>即時切 Beat</h2>
        <p className="small">按下套用後，不瞬間跳拍，會依設定 beat 數線性緩衝過去。</p>
      </div>
      <div className="row">
        <label className="row">
          <span className="label">目標 BPM</span>
          <input className="input" type="number" value={targetBpm} onChange={(e) => onTargetBpmChange(Number(e.target.value) || 120)} />
        </label>
        <label className="row">
          <span className="label">緩衝拍數</span>
          <select className="input" value={transitionBeats} onChange={(e) => onTransitionBeatsChange(Number(e.target.value))}>
            <option value={4}>4 beats</option>
            <option value={8}>8 beats</option>
            <option value={16}>16 beats</option>
          </select>
        </label>
        <button className="btn primary" onClick={onApply}>線性切過去</button>
      </div>
    </div>
  );
}
