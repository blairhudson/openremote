type DocsNavLink = {
  href: string;
  label: string;
};

type DocsNavGroup = {
  label: string;
  items: DocsNavLink[];
};

export const docsNavItems: (DocsNavLink | DocsNavGroup)[] = [
  { href: "/docs/installation", label: "Installation" },
  { href: "/docs/getting-started", label: "Getting started" },
  { href: "/docs/plugin", label: "OpenCode Plugin" },
  { href: "/docs/gateway", label: "OpenRemote Gateway" },
  { href: "/docs/remote-tunnels", label: "Remote tunnels" },
  { href: "/docs/dev-servers", label: "Dev servers" },
  {
    label: "Self-hosting",
    items: [
      { href: "/docs/self-hosting/ios", label: "iOS" },
      { href: "/docs/self-hosting/android", label: "Android" },
    ],
  },
];
