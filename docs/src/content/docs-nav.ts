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
  { href: "/docs/plugin", label: "Plugin" },
  {
    label: "Self-hosting",
    items: [
      { href: "/docs/self-hosting/ios", label: "iOS" },
      { href: "/docs/self-hosting/android", label: "Android" },
    ],
  },
];
