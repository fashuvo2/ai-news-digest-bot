export const metadata = {
  title: "AI News Digest Bot",
  description: "Automated Bengali AI news digest delivered via Telegram",
};

export default function RootLayout({ children }) {
  return (
    <html lang="bn">
      <body>{children}</body>
    </html>
  );
}
