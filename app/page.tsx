import Link from "next/link";

const TOOLS = [
  {
    href: "/studio",
    title: "節拍器 Studio",
    desc: "節拍器同步、音檔載入、Tempo 時間軸、即時切 Beat、Tap Tempo。",
    icon: "🥁",
    ready: true,
  },
];

export default function IndexPage() {
  return (
    <main className="container layout">
      <header className="col-full" style={{ textAlign: "center", padding: "48px 0 24px" }}>
        <h1 className="title" style={{ fontSize: "2.2rem" }}>Loop Harmonizer</h1>
        <p className="subtitle">選擇工具開始使用</p>
      </header>

      <div className="col-full" style={{ display: "flex", flexWrap: "wrap", gap: 20, justifyContent: "center" }}>
        {TOOLS.map((tool) => (
          tool.ready ? (
            <Link key={tool.href} href={tool.href} style={{ textDecoration: "none" }}>
              <div className="card" style={{ width: 260, cursor: "pointer", transition: "border-color .15s" }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
              >
                <div style={{ fontSize: 40, marginBottom: 12 }}>{tool.icon}</div>
                <h2 style={{ margin: "0 0 8px", fontSize: "1.1rem" }}>{tool.title}</h2>
                <p className="small" style={{ margin: 0 }}>{tool.desc}</p>
              </div>
            </Link>
          ) : (
            <div key={tool.href} className="card" style={{ width: 260, opacity: 0.45 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>{tool.icon}</div>
              <h2 style={{ margin: "0 0 8px", fontSize: "1.1rem" }}>{tool.title}</h2>
              <p className="small" style={{ margin: 0 }}>{tool.desc}</p>
              <p className="small" style={{ margin: "8px 0 0", color: "var(--accent)" }}>即將推出</p>
            </div>
          )
        ))}
      </div>
    </main>
  );
}
