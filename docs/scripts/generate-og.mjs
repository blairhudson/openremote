import sharp from "sharp";

const width = 1200;
const height = 630;

const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#151718"/>
  <path d="M0 0h1200v630H0z" fill="url(#grid)" opacity="0.55"/>
  <circle cx="198" cy="78" r="310" fill="#20A7C9" opacity="0.12"/>
  <circle cx="864" cy="28" r="260" fill="#F0FF00" opacity="0.08"/>
  <rect x="64" y="64" width="1072" height="502" fill="#242728" stroke="#343738" stroke-width="2"/>
  <rect x="64" y="64" width="10" height="502" fill="#20A7C9"/>
  <g transform="translate(104 106) scale(1.9)">
    <g transform="scale(5)">
      <g fill="#A8A8A8">
        <path d="M0 0h3v1H0zM0 1h1v3H0zM2 1h1v3H2zM0 4h3v1H0z"/>
        <path transform="translate(3.8 0)" d="M0 0h4v1H0zM0 1h1v4H0zM3 1h1v1H3zM0 2h3v1H0z"/>
        <path transform="translate(8.6 0)" d="M0 0h4v1H0zM0 1h1v3H0zM0 2h3v1H0zM0 4h4v1H0z"/>
        <path transform="translate(13.4 0)" d="M0 0h1v5H0zM1 0h2v1H1zM3 1h1v4H3z"/>
      </g>
      <g fill="#D0D0D0">
        <path transform="translate(18.2 0)" d="M0 0h3v1H0zM0 1h1v4H0zM3 1h1v1H3zM0 2h3v1H0zM2 3h1v1H2zM3 4h1v1H3z"/>
        <path transform="translate(23 0)" d="M0 0h4v1H0zM0 1h1v3H0zM0 2h3v1H0zM0 4h4v1H0z"/>
        <path transform="translate(27.8 0)" d="M0 0h1v5H0zM1 0h1v1H1zM2 1h1v1H2zM3 0h1v1H3zM4 0h1v5H4z"/>
        <path transform="translate(33.6 0)" d="M0 0h3v1H0zM0 1h1v3H0zM2 1h1v3H2zM0 4h3v1H0z"/>
        <path transform="translate(37.4 0)" d="M0 0h5v1H0zM2 1h1v4H2z"/>
        <path transform="translate(43.2 0)" d="M0 0h4v1H0zM0 1h1v3H0zM0 2h3v1H0zM0 4h4v1H0z"/>
      </g>
    </g>
  </g>
  <text x="104" y="230" fill="#F0FF00" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="28" font-weight="800" letter-spacing="4">REMOTE FOR OPENCODE</text>
  <text x="104" y="300" fill="#D0D0D0" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="52" font-weight="900">Control desktop</text>
  <text x="104" y="360" fill="#D0D0D0" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="52" font-weight="900">coding sessions</text>
  <text x="104" y="420" fill="#D0D0D0" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="52" font-weight="900">from your phone.</text>
  <text x="104" y="478" fill="#A8A8A8" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="24">Chat, run shell commands, switch models, and approve</text>
  <text x="104" y="514" fill="#A8A8A8" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="24">permissions over your local network.</text>
  <g transform="translate(768 142)">
    <rect width="286" height="286" fill="#151718" stroke="#343738" stroke-width="2"/>
    <g transform="translate(-0.5 -0.5) scale(.28)">
      <g transform="translate(176 272)">
        <rect x="0" y="0" width="96" height="96" fill="#A8A8A8"/><rect x="96" y="0" width="96" height="96" fill="#A8A8A8"/><rect x="192" y="0" width="96" height="96" fill="#A8A8A8"/><rect x="0" y="96" width="96" height="96" fill="#A8A8A8"/><rect x="192" y="96" width="96" height="96" fill="#A8A8A8"/><rect x="0" y="192" width="96" height="96" fill="#A8A8A8"/><rect x="192" y="192" width="96" height="96" fill="#A8A8A8"/><rect x="0" y="288" width="96" height="96" fill="#A8A8A8"/><rect x="192" y="288" width="96" height="96" fill="#A8A8A8"/><rect x="0" y="384" width="96" height="96" fill="#A8A8A8"/><rect x="96" y="384" width="96" height="96" fill="#A8A8A8"/><rect x="192" y="384" width="96" height="96" fill="#A8A8A8"/>
      </g>
      <g transform="translate(464 272)">
        <rect x="0" y="0" width="96" height="96" fill="#D0D0D0"/><rect x="96" y="0" width="96" height="96" fill="#D0D0D0"/><rect x="192" y="0" width="96" height="96" fill="#D0D0D0"/><rect x="0" y="96" width="96" height="96" fill="#D0D0D0"/><rect x="288" y="96" width="96" height="96" fill="#D0D0D0"/><rect x="0" y="192" width="96" height="96" fill="#D0D0D0"/><rect x="96" y="192" width="96" height="96" fill="#D0D0D0"/><rect x="192" y="192" width="96" height="96" fill="#D0D0D0"/><rect x="0" y="288" width="96" height="96" fill="#D0D0D0"/><rect x="192" y="288" width="96" height="96" fill="#D0D0D0"/><rect x="0" y="384" width="96" height="96" fill="#D0D0D0"/><rect x="288" y="384" width="96" height="96" fill="#D0D0D0"/>
      </g>
    </g>
  </g>
  <defs>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M28 0H0v28" stroke="#FFFFFF" stroke-opacity="0.035"/>
    </pattern>
  </defs>
</svg>`;

await sharp(Buffer.from(svg)).jpeg({ quality: 92, mozjpeg: true }).toFile("public/og-image.jpg");
