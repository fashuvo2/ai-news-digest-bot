export default function Home() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: "600px", margin: "auto" }}>
      <h1>🤖 AI News Digest Bot</h1>
      <p>
        This app runs a scheduled digest of the latest AI news, summarised in Bengali and
        delivered to Telegram twice daily.
      </p>
      <ul>
        <li>
          <strong>Health check:</strong>{" "}
          <a href="/api/health">/api/health</a>
        </li>
        <li>
          <strong>Digest endpoint (POST only):</strong> <code>/api/digest</code>
        </li>
      </ul>
      <p style={{ color: "#666", fontSize: "0.875rem" }}>
        The digest endpoint requires an <code>Authorization: Bearer &lt;CRON_SECRET&gt;</code> header.
      </p>
    </main>
  );
}
